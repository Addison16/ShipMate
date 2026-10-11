import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkSandbox,
  DockerClient,
  describeEndpoint,
  endpointFromEnv,
  parseDockerHost,
} from "./docker.js";
import { warningsFor } from "./endpoint.js";

describe("sandbox endpoints from DOCKER_HOST and friends", () => {
  it("parses unix sockets, tcp hosts and rejects the rest", () => {
    expect(parseDockerHost("unix:///run/user/1000/podman/podman.sock")).toEqual({
      kind: "socket",
      socketPath: "/run/user/1000/podman/podman.sock",
    });
    expect(parseDockerHost("/var/run/docker.sock")).toEqual({
      kind: "socket",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseDockerHost("tcp://nas.lan:2376")).toEqual({
      kind: "tcp",
      host: "nas.lan",
      port: 2376,
    });
    expect(parseDockerHost("tcp://10.0.0.5")).toMatchObject({ host: "10.0.0.5", port: 2376 });
    expect(parseDockerHost("tcp://[::1]:2375")).toMatchObject({ host: "::1", port: 2375 });
    expect(parseDockerHost("ssh://me@nas")).toBeNull();
    expect(parseDockerHost("unix://relative.sock")).toBeNull();
    expect(parseDockerHost("tcp://nas:99999")).toBeNull();
    expect(parseDockerHost("tcp://nas/../x")).toBeNull();
    expect(parseDockerHost("")).toBeNull();
  });

  it("follows Docker's env conventions, falling back to DOCKER_SOCKET and the default", () => {
    expect(endpointFromEnv({})).toEqual({ kind: "socket", socketPath: "/var/run/docker.sock" });
    expect(endpointFromEnv({ DOCKER_SOCKET: "/x.sock" })).toEqual({
      kind: "socket",
      socketPath: "/x.sock",
    });
    expect(endpointFromEnv({ DOCKER_HOST: "unix:///p.sock", DOCKER_SOCKET: "/x.sock" })).toEqual({
      kind: "socket",
      socketPath: "/p.sock",
    });
    const certs = mkdtempSync(join(tmpdir(), "shipmate-certs-"));
    writeFileSync(join(certs, "ca.pem"), "CA");
    writeFileSync(join(certs, "cert.pem"), "CERT");
    writeFileSync(join(certs, "key.pem"), "KEY");
    expect(
      endpointFromEnv({
        DOCKER_HOST: "tcp://nas:2376",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: certs,
      }),
    ).toEqual({
      kind: "tcp",
      host: "nas",
      port: 2376,
      tls: { ca: "CA", cert: "CERT", key: "KEY" },
    });
    expect(endpointFromEnv({ DOCKER_HOST: "tcp://nas:2375", DOCKER_CERT_PATH: certs })).toEqual({
      kind: "tcp",
      host: "nas",
      port: 2375,
    });
  });

  it("describes endpoints without secrets and warns about plain TCP", () => {
    const tls = { kind: "tcp" as const, host: "nas", port: 2376, tls: { cert: "C", key: "K" } };
    expect(describeEndpoint(tls)).toBe("tcp://nas:2376 (TLS)");
    expect(describeEndpoint({ kind: "tcp", host: "::1", port: 2375 })).toBe("tcp://[::1]:2375");
    expect(warningsFor({ endpoint: tls, workspacesPath: "/mnt/shipmate/workspaces" })).toEqual([]);
    const plain = warningsFor({
      endpoint: { kind: "tcp", host: "nas", port: 2375 },
      workspacesPath: null,
    });
    expect(plain).toHaveLength(2);
    expect(plain[0]).toContain("no TLS");
    expect(
      warningsFor({ endpoint: { kind: "socket", socketPath: "/s" }, workspacesPath: null }),
    ).toEqual([]);
  });
});

/** Enough of the Engine API for ping, version and an inspect. */
function engine(kind: "docker" | "podman") {
  return (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/_ping") return res.end("OK");
    if (req.url === "/v1.41/version") {
      return res.end(
        JSON.stringify(
          kind === "podman"
            ? {
                Version: "5.2.0",
                ApiVersion: "1.41",
                Os: "linux",
                Arch: "amd64",
                Components: [{ Name: "Podman Engine", Version: "5.2.0" }],
              }
            : { Version: "27.3.1", ApiVersion: "1.47", Os: "linux", Arch: "arm64" },
        ),
      );
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "nope" }));
  };
}

describe("DockerClient over TCP and TLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipmate-tls-"));
  let plain: Server;
  let tls: Server;
  let socket: Server;
  const pem = (f: string) => readFileSync(join(dir, f), "utf8");
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });

  beforeAll(async () => {
    // A throwaway CA, a server certificate for 127.0.0.1 and a client certificate.
    ssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca-key.pem",
      "-out",
      "ca.pem",
      "-days",
      "1",
      "-subj",
      "/CN=test-ca",
    );
    for (const name of ["server", "client", "rogue"]) {
      ssl(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${name}-key.pem`,
        "-out",
        `${name}.csr`,
        "-subj",
        `/CN=${name}`,
      );
    }
    writeFileSync(join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1\n");
    writeFileSync(join(dir, "client.ext"), "extendedKeyUsage=clientAuth\n");
    ssl(
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca-key.pem",
      "-CAcreateserial",
      "-out",
      "server.pem",
      "-days",
      "1",
      "-extfile",
      "server.ext",
    );
    ssl(
      "x509",
      "-req",
      "-in",
      "client.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca-key.pem",
      "-CAcreateserial",
      "-out",
      "client.pem",
      "-days",
      "1",
      "-extfile",
      "client.ext",
    );
    // Self-signed: not issued by the CA the server trusts.
    ssl(
      "x509",
      "-req",
      "-in",
      "rogue.csr",
      "-signkey",
      "rogue-key.pem",
      "-out",
      "rogue.pem",
      "-days",
      "1",
    );

    plain = createServer(engine("podman"));
    tls = createTlsServer(
      {
        key: pem("server-key.pem"),
        cert: pem("server.pem"),
        ca: pem("ca.pem"),
        requestCert: true,
        rejectUnauthorized: true,
      },
      engine("docker"),
    );
    socket = createServer(engine("docker"));
    await Promise.all([
      new Promise<void>((r) => plain.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => tls.listen(0, "127.0.0.1", r)),
      new Promise<void>((r) => socket.listen(join(dir, "podman.sock"), r)),
    ]);
  });
  afterAll(async () => {
    for (const s of [plain, tls, socket]) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  });

  const port = (s: Server) => (s.address() as AddressInfo).port;

  it("talks to a plain TCP engine and recognizes Podman", async () => {
    const client = new DockerClient({ kind: "tcp", host: "127.0.0.1", port: port(plain) });
    expect(await client.ping()).toBe(true);
    expect(await client.version()).toEqual({
      engine: "Podman",
      version: "5.2.0",
      apiVersion: "1.41",
      os: "linux/amd64",
    });
    expect(await checkSandbox(client)).toEqual({
      ok: true,
      endpoint: `tcp://127.0.0.1:${port(plain)}`,
      engine: "Podman 5.2.0",
      error: null,
    });
  });

  it("connects with a client certificate the server trusts", async () => {
    const client = new DockerClient({
      kind: "tcp",
      host: "127.0.0.1",
      port: port(tls),
      tls: { ca: pem("ca.pem"), cert: pem("client.pem"), key: pem("client-key.pem") },
    });
    expect(await checkSandbox(client)).toMatchObject({ ok: true, engine: "Docker 27.3.1" });
  });

  it("fails closed: an unknown server CA or an untrusted client certificate", async () => {
    const noCa = new DockerClient({
      kind: "tcp",
      host: "127.0.0.1",
      port: port(tls),
      tls: { cert: pem("client.pem"), key: pem("client-key.pem") },
    });
    const a = await checkSandbox(noCa);
    expect(a.ok).toBe(false);
    expect(a.error).toContain("TLS handshake");
    expect(a.error).not.toContain("BEGIN");

    const rogue = new DockerClient({
      kind: "tcp",
      host: "127.0.0.1",
      port: port(tls),
      tls: { ca: pem("ca.pem"), cert: pem("rogue.pem"), key: pem("rogue-key.pem") },
    });
    expect((await checkSandbox(rogue)).ok).toBe(false);
  });

  it("explains a missing socket or a closed port", async () => {
    const missing = await checkSandbox(new DockerClient(join(dir, "missing.sock")));
    expect(missing).toMatchObject({ ok: false, engine: null });
    expect(missing.error).toContain("no socket at unix://");
    const closed = await checkSandbox(
      new DockerClient({ kind: "tcp", host: "127.0.0.1", port: 1 }),
    );
    expect(closed.error).toContain("nothing is listening at tcp://127.0.0.1:1");
    const ok = await checkSandbox(new DockerClient(join(dir, "podman.sock")));
    expect(ok).toMatchObject({ ok: true, engine: "Docker 27.3.1" });
  });
});
