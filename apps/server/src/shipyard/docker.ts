import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, relative, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Where the sandbox sees the project workspace. */
export const SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
export const DEFAULT_SANDBOX_IMAGE = "node:22-bookworm";
/** Engine API version; 1.41 (Docker 20.10) has everything used here. */
const API = "/v1.41";

export class DockerError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Where the sandbox engine listens: a unix socket (Docker, or rootless Podman's
 * Docker-compatible API socket), or a remote Docker or Podman host over TCP, ideally with TLS
 * client certificates.
 */
export type DockerEndpoint =
  | { kind: "socket"; socketPath: string }
  | {
      kind: "tcp";
      host: string;
      port: number;
      /** PEM strings; with them the connection is HTTPS and the server certificate is checked. */
      tls?: { ca?: string | undefined; cert: string; key: string } | undefined;
    };

/** Parse `unix:///path`, `tcp://host:port` or a bare socket path (DOCKER_HOST style). */
export function parseDockerHost(value: string): DockerEndpoint | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("/")) return { kind: "socket", socketPath: v };
  if (v.startsWith("unix://")) {
    const path = v.slice("unix://".length);
    return path.startsWith("/") ? { kind: "socket", socketPath: path } : null;
  }
  const m = /^(?:tcp|https?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(v);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 2376;
  if (port < 1 || port > 65535) return null;
  return { kind: "tcp", host: (m[1] as string).replace(/^\[|\]$/g, ""), port };
}

/**
 * The endpoint from the environment, following Docker's own conventions: DOCKER_HOST
 * (`unix://` or `tcp://`), DOCKER_TLS_VERIFY and DOCKER_CERT_PATH (ca.pem, cert.pem, key.pem),
 * else DOCKER_SOCKET, else /var/run/docker.sock.
 */
export function endpointFromEnv(env: NodeJS.ProcessEnv = process.env): DockerEndpoint {
  const parsed = env.DOCKER_HOST ? parseDockerHost(env.DOCKER_HOST) : null;
  if (parsed?.kind === "tcp") {
    const certPath = env.DOCKER_CERT_PATH;
    const verify = env.DOCKER_TLS_VERIFY && env.DOCKER_TLS_VERIFY !== "0";
    if (certPath && verify) {
      const read = (f: string) => readFileSync(join(certPath, f), "utf8");
      return {
        ...parsed,
        tls: { ca: read("ca.pem"), cert: read("cert.pem"), key: read("key.pem") },
      };
    }
    return parsed;
  }
  if (parsed) return parsed;
  return { kind: "socket", socketPath: env.DOCKER_SOCKET || DEFAULT_DOCKER_SOCKET };
}

/** "unix:///var/run/docker.sock", "tcp://nas.lan:2376 (TLS)": for messages, never secrets. */
export function describeEndpoint(e: DockerEndpoint): string {
  if (e.kind === "socket") return `unix://${e.socketPath}`;
  const host = e.host.includes(":") ? `[${e.host}]` : e.host;
  return `tcp://${host}:${e.port}${e.tls ? " (TLS)" : ""}`;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  running: boolean;
  labels: Record<string, string>;
  mounts: Array<{ source: string; destination: string }>;
}

/**
 * A minimal Docker Engine API client over a unix socket or TCP (optionally TLS): just what the
 * Shipyard sandboxes need. Podman's Docker-compatible API works too. No dependency on dockerode.
 */
export class DockerClient {
  readonly endpoint: DockerEndpoint;

  constructor(endpoint: DockerEndpoint | string = DEFAULT_DOCKER_SOCKET) {
    this.endpoint =
      typeof endpoint === "string" ? { kind: "socket", socketPath: endpoint } : endpoint;
  }

  /** Engine name and versions from GET /version (Docker or Podman). */
  async version(timeoutMs = 5000): Promise<{
    engine: string;
    version: string;
    apiVersion: string;
    os: string;
  }> {
    const res = await this.#call("GET", "/version", undefined, timeoutMs);
    ensureOk(res, "read its version");
    const v = json(res) as {
      Version?: string;
      ApiVersion?: string;
      Os?: string;
      Arch?: string;
      Components?: Array<{ Name?: string; Version?: string }> | null;
    };
    const podman = (v.Components ?? []).find((c) => /podman/i.test(c.Name ?? ""));
    return {
      engine: podman ? "Podman" : "Docker",
      version: podman?.Version ?? v.Version ?? "unknown",
      apiVersion: v.ApiVersion ?? "unknown",
      os: [v.Os, v.Arch].filter(Boolean).join("/"),
    };
  }

  /** An HTTP request to the engine, over the socket or TCP (TLS when certificates are set). */
  #request(
    options: {
      method: string;
      path: string;
      headers: Record<string, string | number>;
      timeout?: number;
    },
    onResponse: (res: IncomingMessage) => void,
  ): ClientRequest {
    const e = this.endpoint;
    if (e.kind === "socket")
      return httpRequest({ ...options, socketPath: e.socketPath }, onResponse);
    if (e.tls) {
      return httpsRequest(
        {
          ...options,
          host: e.host,
          port: e.port,
          cert: e.tls.cert,
          key: e.tls.key,
          ...(e.tls.ca ? { ca: e.tls.ca } : {}),
          rejectUnauthorized: true,
        },
        onResponse,
      );
    }
    return httpRequest({ ...options, host: e.host, port: e.port }, onResponse);
  }

  /** True when the daemon answers; never throws. */
  async ping(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await this.#call("GET", "/_ping", undefined, timeoutMs);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  async imageExists(image: string): Promise<boolean> {
    const res = await this.#call("GET", `/images/${encodeURIComponent(image)}/json`);
    if (res.status === 404) return false;
    ensureOk(res, "inspect image");
    return true;
  }

  /** Pull an image; resolves when the pull has finished (the API streams progress). */
  async pullImage(image: string): Promise<void> {
    const [name, tag] = splitImage(image);
    const q = new URLSearchParams({ fromImage: name, tag });
    const res = await this.#call("POST", `/images/create?${q}`, undefined, 15 * 60_000);
    ensureOk(res, `pull ${image}`);
    // Errors during a pull arrive as JSON lines in a 200 response.
    for (const line of res.body.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { error?: string };
        if (msg.error) throw new DockerError(500, `could not pull ${image}: ${msg.error}`);
      } catch (err) {
        if (err instanceof DockerError) throw err;
      }
    }
  }

  async ensureImage(image: string): Promise<void> {
    if (!(await this.imageExists(image))) await this.pullImage(image);
  }

  async createContainer(name: string, spec: Record<string, unknown>): Promise<string> {
    const res = await this.#call(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      spec,
    );
    ensureOk(res, "create container");
    return (json(res) as { Id: string }).Id;
  }

  async startContainer(id: string): Promise<void> {
    const res = await this.#call("POST", `/containers/${encodeURIComponent(id)}/start`);
    if (res.status === 304) return;
    ensureOk(res, "start container");
  }

  async stopContainer(id: string, seconds = 5): Promise<void> {
    const res = await this.#call(
      "POST",
      `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`,
      undefined,
      (seconds + 30) * 1000,
    );
    if (res.status === 304 || res.status === 404) return;
    ensureOk(res, "stop container");
  }

  async removeContainer(id: string, force = true): Promise<void> {
    const res = await this.#call(
      "DELETE",
      `/containers/${encodeURIComponent(id)}?force=${force ? "true" : "false"}&v=true`,
    );
    if (res.status === 404) return;
    ensureOk(res, "remove container");
  }

  /** Inspect by id or name; null when there is no such container. */
  async inspectContainer(idOrName: string): Promise<ContainerInfo | null> {
    const res = await this.#call("GET", `/containers/${encodeURIComponent(idOrName)}/json`);
    if (res.status === 404) return null;
    ensureOk(res, "inspect container");
    const c = json(res) as {
      Id: string;
      Name: string;
      Config?: { Image?: string; Labels?: Record<string, string> | null };
      State?: { Running?: boolean };
      Mounts?: Array<{ Source?: string; Destination?: string }> | null;
    };
    return {
      id: c.Id,
      name: c.Name.replace(/^\//, ""),
      image: c.Config?.Image ?? "",
      running: Boolean(c.State?.Running),
      labels: c.Config?.Labels ?? {},
      mounts: (c.Mounts ?? []).map((m) => ({
        source: m.Source ?? "",
        destination: m.Destination ?? "",
      })),
    };
  }

  async execCreate(
    containerId: string,
    options: { cmd: string[]; workdir?: string; env?: string[] },
  ): Promise<string> {
    const res = await this.#call("POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: options.cmd,
      ...(options.workdir ? { WorkingDir: options.workdir } : {}),
      ...(options.env ? { Env: options.env } : {}),
    });
    ensureOk(res, "create exec");
    return (json(res) as { Id: string }).Id;
  }

  /**
   * Start an exec and stream its demultiplexed output. Resolves when the stream ends (the
   * command exited, or `signal` aborted the request).
   */
  execStart(
    execId: string,
    onData: (data: Buffer, stream: "stdout" | "stderr") => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ Detach: false, Tty: false });
      const req = this.#request(
        {
          method: "POST",
          path: `${API}/exec/${encodeURIComponent(execId)}/start`,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          if ((res.statusCode ?? 500) >= 300) {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              reject(
                new DockerError(
                  res.statusCode ?? 500,
                  `start exec: ${errorText(Buffer.concat(chunks))}`,
                ),
              ),
            );
            return;
          }
          const demux = new StreamDemuxer(onData);
          res.on("data", (chunk: Buffer) => demux.push(chunk));
          res.on("end", () => resolve());
          res.on("close", () => resolve());
          res.on("error", () => resolve());
        },
      );
      const onAbort = () => req.destroy();
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => (signal?.aborted ? resolve() : reject(err)));
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      req.end(body);
    });
  }

  async execInspect(execId: string): Promise<{ running: boolean; exitCode: number | null }> {
    const res = await this.#call("GET", `/exec/${encodeURIComponent(execId)}/json`);
    ensureOk(res, "inspect exec");
    const e = json(res) as { Running?: boolean; ExitCode?: number | null };
    return { running: Boolean(e.Running), exitCode: e.ExitCode ?? null };
  }

  /** Run a command to completion and collect its output (used for housekeeping like kills). */
  async run(
    containerId: string,
    cmd: string[],
  ): Promise<{ exitCode: number | null; output: string }> {
    const id = await this.execCreate(containerId, { cmd });
    const chunks: Buffer[] = [];
    await this.execStart(id, (d) => chunks.push(d));
    const { exitCode } = await this.#waitExit(id);
    return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
  }

  async #waitExit(execId: string): Promise<{ exitCode: number | null }> {
    // The stream can close a moment before the daemon records the exit code.
    for (let i = 0; i < 50; i++) {
      const s = await this.execInspect(execId);
      if (!s.running) return { exitCode: s.exitCode };
      await new Promise((r) => setTimeout(r, 20 + i * 10));
    }
    return { exitCode: null };
  }

  waitExit(execId: string) {
    return this.#waitExit(execId);
  }

  #call(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs = 60_000,
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const req = this.#request(
        {
          method,
          path: path === "/_ping" ? path : `${API}${path}`,
          headers: body
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
            : {},
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
      req.on("error", reject);
      req.end(body);
    });
  }
}

/**
 * Splits Docker's multiplexed exec stream: frames of an 8-byte header (stream type, 3 zero
 * bytes, big-endian payload length) followed by the payload. Frames can straddle chunks.
 */
export class StreamDemuxer {
  #buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onData: (data: Buffer, stream: "stdout" | "stderr") => void) {}

  push(chunk: Buffer) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    while (this.#buf.length >= 8) {
      const type = this.#buf[0];
      const size = this.#buf.readUInt32BE(4);
      if (this.#buf.length < 8 + size) break;
      const payload = this.#buf.subarray(8, 8 + size);
      this.#buf = this.#buf.subarray(8 + size);
      if (payload.length) this.onData(Buffer.from(payload), type === 2 ? "stderr" : "stdout");
    }
  }
}

/** Build one multiplexed frame (tests and fakes). */
export function muxFrame(stream: 1 | 2, data: string | Buffer): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data) : data;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Map a host path inside the workspace to the same path under /workspace in the sandbox. */
export function sandboxPath(hostWorkspace: string, cwd: string): string {
  const rel = relative(hostWorkspace, cwd);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return SANDBOX_WORKDIR;
  return `${SANDBOX_WORKDIR}/${rel.split(sep).join("/")}`;
}

/**
 * pi's bash backend for a project: every command runs as `bash -lc <command>` inside the
 * project's sandbox container, never on the host. `ensure` starts the container on first use.
 */
export class Sandbox implements BashOperations {
  readonly #docker: () => DockerClient;

  constructor(
    /** A client, or a getter so a session follows endpoint changes made in Settings. */
    docker: DockerClient | (() => DockerClient),
    private readonly hostWorkspace: string,
    private readonly ensure: () => Promise<string>,
  ) {
    this.#docker = typeof docker === "function" ? docker : () => docker;
  }

  private get docker(): DockerClient {
    return this.#docker();
  }

  exec: BashOperations["exec"] = async (command, cwd, { onData, signal, timeout }) => {
    if (signal?.aborted) throw new Error("aborted");
    const containerId = await this.ensure();
    // Children inherit this marker, so an abort can find and kill the whole tree.
    const marker = `SHIPMATE_EXEC=${randomUUID()}`;
    const execId = await this.docker.execCreate(containerId, {
      cmd: ["bash", "-lc", command],
      workdir: sandboxPath(this.hostWorkspace, cwd),
      env: [marker],
    });
    const stop = new AbortController();
    let timedOut = false;
    let killing: Promise<void> | undefined;
    const kill = () => {
      stop.abort();
      killing ??= this.#kill(containerId, marker).catch(() => {});
    };
    const timer =
      timeout && timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000)
        : undefined;
    signal?.addEventListener("abort", kill, { once: true });
    try {
      await this.docker.execStart(execId, (d) => onData(d), stop.signal);
      // An abort or timeout is over once the processes are gone.
      if (killing) await killing;
      if (signal?.aborted) throw new Error("aborted");
      if (timedOut) throw new Error(`timeout:${timeout}`);
      const { exitCode } = await this.docker.waitExit(execId);
      return { exitCode };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
    }
  };

  /** Kill every process carrying this exec's marker. */
  async #kill(containerId: string, marker: string) {
    const script = `for p in /proc/[0-9]*; do grep -qsz '^${marker}$' "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`;
    await this.docker.run(containerId, ["sh", "-c", script]);
  }
}

export interface SandboxCheck {
  ok: boolean;
  /** Where Shipmate looked, e.g. "unix:///var/run/docker.sock" or "tcp://nas:2376 (TLS)". */
  endpoint: string;
  /** "Docker 27.3.1" or "Podman 5.2.0" when reachable. */
  engine: string | null;
  error: string | null;
}

/**
 * Is the sandbox engine reachable? Never throws; the health page and Settings' "Test
 * connection" both use it.
 */
export async function checkSandbox(client: DockerClient, timeoutMs = 3000): Promise<SandboxCheck> {
  const endpoint = describeEndpoint(client.endpoint);
  try {
    const v = await client.version(timeoutMs);
    return { ok: true, endpoint, engine: `${v.engine} ${v.version}`, error: null };
  } catch (err) {
    return { ok: false, endpoint, engine: null, error: connectionError(err, client.endpoint) };
  }
}

/** A plain-words reason a connection failed; certificate text is never included. */
function connectionError(err: unknown, e: DockerEndpoint): string {
  const code = (err as { code?: string }).code ?? "";
  const where = describeEndpoint(e);
  if (code === "ENOENT") return `no socket at ${where}`;
  if (code === "EACCES") return `permission denied on ${where}; check the socket's group or mode`;
  if (code === "ECONNREFUSED") return `nothing is listening at ${where}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `cannot resolve the host in ${where}`;
  if (/^ERR_(TLS|SSL)|CERT|^UNABLE_TO|^EPROTO$/.test(code)) {
    return `TLS handshake with ${where} failed (${code}); check the CA and client certificate`;
  }
  if (err instanceof DockerError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  return `${where}: ${msg.slice(0, 200)}`;
}

function splitImage(image: string): [string, string] {
  const at = image.indexOf("@");
  if (at >= 0) return [image, ""];
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return [image.slice(0, colon), image.slice(colon + 1)];
  return [image, "latest"];
}

function json(res: { body: Buffer }): unknown {
  return JSON.parse(res.body.toString("utf8"));
}

function errorText(body: Buffer): string {
  const t = body.toString("utf8");
  try {
    return (JSON.parse(t) as { message?: string }).message ?? t;
  } catch {
    return t.trim() || "no details";
  }
}

function ensureOk(res: { status: number; body: Buffer }, what: string) {
  if (res.status >= 200 && res.status < 300) return;
  throw new DockerError(res.status, `docker could not ${what}: ${errorText(res.body)}`);
}
