import { isAbsolute } from "node:path";
import type {
  SandboxCheckDto,
  SandboxEndpointDto,
  UpdateSandboxEndpointRequest,
} from "@shipmate/core";
import { type Db, secrets, settings as settingsTable } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq, inArray } from "drizzle-orm";
import { HttpError } from "../auth.js";
import type { SettingsService } from "../services/settings.js";
import {
  checkSandbox,
  DockerClient,
  type DockerEndpoint,
  describeEndpoint,
  parseDockerHost,
} from "./docker.js";

/** The owner's sandbox endpoint, stored under one settings key; TLS PEMs live in the vault. */
const KEY = "shipyard.sandbox";
const PEMS = {
  ca: "shipyard:sandbox:tls-ca",
  cert: "shipyard:sandbox:tls-cert",
  key: "shipyard:sandbox:tls-key",
};
type PemName = keyof typeof PEMS;

interface Stored {
  mode: "socket" | "tcp";
  socketPath?: string | null;
  host?: string | null;
  workspacesPath?: string | null;
}

/** The endpoint in effect, plus the workspaces path on that host when one is set. */
export interface ResolvedEndpoint {
  endpoint: DockerEndpoint;
  workspacesPath: string | null;
}

/**
 * Sandbox endpoint settings: the environment gives a default, the owner can point the Shipyard
 * at rootless Podman's socket or a remote Docker/Podman host instead.
 */
export class SandboxEndpointStore {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly vault: SecretVault,
    private readonly fromEnv: ResolvedEndpoint,
  ) {}

  async resolve(): Promise<ResolvedEndpoint> {
    const stored = await this.settings.getJson<Stored>(KEY);
    if (!stored) return this.fromEnv;
    return this.#build(stored, await this.#pems());
  }

  async dto(effective: DockerEndpoint): Promise<SandboxEndpointDto> {
    const stored = await this.settings.getJson<Stored>(KEY);
    const pems = await this.#pems();
    return {
      mode: stored?.mode ?? "env",
      socketPath: stored?.mode === "socket" ? (stored.socketPath ?? null) : null,
      host: stored?.mode === "tcp" ? (stored.host ?? null) : null,
      tls: { ca: Boolean(pems.ca), cert: Boolean(pems.cert), key: Boolean(pems.key) },
      workspacesPath: stored?.workspacesPath ?? null,
      effective: describeEndpoint(effective),
      fromEnv: describeEndpoint(this.fromEnv.endpoint),
    };
  }

  /** Validate and save; returns the endpoint to switch to. */
  async save(req: UpdateSandboxEndpointRequest): Promise<ResolvedEndpoint> {
    if (req.mode === "env") {
      await this.db.delete(settingsTable).where(eq(settingsTable.key, KEY));
      await this.db.delete(secrets).where(inArray(secrets.ref, Object.values(PEMS)));
      return this.fromEnv;
    }
    const stored = validate(req);
    const pems = mergePems(await this.#pems(), req);
    const resolved = this.#build(stored, pems);
    for (const name of Object.keys(PEMS) as PemName[]) {
      const value = req[pemField(name)];
      if (value === undefined) continue;
      if (value === "" || stored.mode !== "tcp") await this.#deletePem(name);
      else await this.#setPem(name, value);
    }
    if (stored.mode !== "tcp") {
      await this.db.delete(secrets).where(inArray(secrets.ref, Object.values(PEMS)));
    }
    await this.settings.setJson(KEY, stored);
    return resolved;
  }

  /** Try settings without saving them. Omitted TLS files fall back to the stored ones. */
  async test(req: UpdateSandboxEndpointRequest): Promise<SandboxCheckDto> {
    const resolved =
      req.mode === "env"
        ? this.fromEnv
        : this.#build(validate(req), mergePems(await this.#pems(), req));
    const check = await checkSandbox(new DockerClient(resolved.endpoint));
    return { ...check, warnings: warningsFor(resolved) };
  }

  #build(stored: Stored, pems: Partial<Record<PemName, string>>): ResolvedEndpoint {
    const workspacesPath = stored.workspacesPath || null;
    if (stored.mode === "socket") {
      return {
        endpoint: { kind: "socket", socketPath: stored.socketPath || "/var/run/docker.sock" },
        workspacesPath,
      };
    }
    const parsed = parseDockerHost(stored.host ?? "");
    if (parsed?.kind !== "tcp") throw new HttpError(400, "host: use tcp://host:port");
    if (Boolean(pems.cert) !== Boolean(pems.key)) {
      throw new HttpError(
        400,
        "tls: a client certificate needs its key, and the key its certificate",
      );
    }
    const tls = pems.cert && pems.key ? { ca: pems.ca, cert: pems.cert, key: pems.key } : undefined;
    return { endpoint: { ...parsed, tls }, workspacesPath };
  }

  async #pems(): Promise<Partial<Record<PemName, string>>> {
    const rows = await this.db
      .select()
      .from(secrets)
      .where(inArray(secrets.ref, Object.values(PEMS)));
    const out: Partial<Record<PemName, string>> = {};
    for (const name of Object.keys(PEMS) as PemName[]) {
      const row = rows.find((r) => r.ref === PEMS[name]);
      if (row) out[name] = this.vault.decrypt(row.ciphertext);
    }
    return out;
  }

  async #setPem(name: PemName, value: string) {
    const ciphertext = this.vault.encrypt(value.trim());
    await this.db
      .insert(secrets)
      .values({ ref: PEMS[name], ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
  }

  async #deletePem(name: PemName) {
    await this.db.delete(secrets).where(eq(secrets.ref, PEMS[name]));
  }
}

function pemField(name: PemName): "tlsCa" | "tlsCert" | "tlsKey" {
  return name === "ca" ? "tlsCa" : name === "cert" ? "tlsCert" : "tlsKey";
}

function mergePems(
  stored: Partial<Record<PemName, string>>,
  req: UpdateSandboxEndpointRequest,
): Partial<Record<PemName, string>> {
  const out = { ...stored };
  for (const name of Object.keys(PEMS) as PemName[]) {
    const value = req[pemField(name)];
    if (value === undefined) continue;
    if (value === "") delete out[name];
    else {
      assertPem(name, value);
      out[name] = value.trim();
    }
  }
  return out;
}

function assertPem(name: PemName, value: string) {
  const label = name === "ca" ? "tlsCa" : name === "cert" ? "tlsCert" : "tlsKey";
  const ok =
    value.length <= 32_000 &&
    (name === "key"
      ? /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
      : /-----BEGIN CERTIFICATE-----/.test(value));
  if (!ok) {
    throw new HttpError(
      400,
      `${label}: paste the PEM text (${name === "key" ? "-----BEGIN PRIVATE KEY-----" : "-----BEGIN CERTIFICATE-----"} …)`,
    );
  }
}

function validate(req: UpdateSandboxEndpointRequest): Stored {
  const workspacesPath = req.workspacesPath?.trim() || null;
  if (workspacesPath && (!isAbsolute(workspacesPath) || /[\0:]/.test(workspacesPath))) {
    throw new HttpError(400, "workspacesPath: use an absolute path on the sandbox host");
  }
  if (req.mode === "socket") {
    const socketPath = req.socketPath?.trim() || "/var/run/docker.sock";
    if (!isAbsolute(socketPath) || socketPath.length > 300 || socketPath.includes("\0")) {
      throw new HttpError(400, "socketPath: use an absolute path, e.g. /run/podman/podman.sock");
    }
    return { mode: "socket", socketPath, workspacesPath };
  }
  const host = req.host?.trim() ?? "";
  if (parseDockerHost(host)?.kind !== "tcp") {
    throw new HttpError(400, "host: use tcp://host:port, e.g. tcp://nas.lan:2376");
  }
  return { mode: "tcp", host, workspacesPath };
}

/** Advice for setups that work but are risky or likely to trip over bind mounts. */
export function warningsFor(r: ResolvedEndpoint): string[] {
  const out: string[] = [];
  if (r.endpoint.kind === "tcp" && !r.endpoint.tls) {
    out.push(
      "This connection has no TLS: anyone who can reach that port controls the host. Use TLS client certificates (usually port 2376) unless the network is private to you.",
    );
  }
  if (r.endpoint.kind === "tcp" && !r.workspacesPath) {
    out.push(
      "Set the workspaces path: the remote host has to see Shipmate's workspaces folder (for example over NFS) to mount it into sandboxes.",
    );
  }
  return out;
}
