import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerClient, muxFrame, Sandbox, StreamDemuxer, sandboxPath } from "./docker.js";

describe("StreamDemuxer", () => {
  it("splits stdout and stderr frames, including frames split across chunks", () => {
    const out: Array<[string, string]> = [];
    const d = new StreamDemuxer((data, stream) => out.push([stream, data.toString()]));
    const all = Buffer.concat([
      muxFrame(1, "hello "),
      muxFrame(2, "oops\n"),
      muxFrame(1, Buffer.alloc(0)),
      muxFrame(1, "world\n"),
    ]);
    // Feed one byte at a time: headers and payloads straddle every boundary.
    for (let i = 0; i < all.length; i++) d.push(all.subarray(i, i + 1));
    expect(out).toEqual([
      ["stdout", "hello "],
      ["stderr", "oops\n"],
      ["stdout", "world\n"],
    ]);
  });
});

describe("sandboxPath", () => {
  it("maps host workspace paths to /workspace", () => {
    expect(sandboxPath("/data/workspaces/app", "/data/workspaces/app")).toBe("/workspace");
    expect(sandboxPath("/data/workspaces/app", "/data/workspaces/app/src/lib")).toBe(
      "/workspace/src/lib",
    );
    expect(sandboxPath("/data/workspaces/app", "/etc")).toBe("/workspace");
    expect(sandboxPath("/data/workspaces/app", "/data/workspaces/app-other")).toBe("/workspace");
  });
});

/** A fake Docker daemon on a unix socket: just enough of the Engine API for an exec. */
function fakeDocker() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const execs = new Map<
    string,
    { cmd: string[]; workdir: string; env: string[]; running: boolean; exitCode: number | null }
  >();
  let n = 0;
  const held: ServerResponse[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    const url = req.url ?? "";
    calls.push({ method: req.method ?? "", url, body });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (url === "/_ping") return res.end("OK");
    let m = /^\/v1\.41\/containers\/([^/]+)\/exec$/.exec(url);
    if (m && req.method === "POST") {
      const id = `exec${++n}`;
      execs.set(id, {
        cmd: body.Cmd,
        workdir: body.WorkingDir,
        env: body.Env ?? [],
        running: false,
        exitCode: null,
      });
      return send(201, { Id: id });
    }
    m = /^\/v1\.41\/exec\/([^/]+)\/start$/.exec(url);
    if (m) {
      const e = execs.get(m[1] as string);
      if (!e) return send(404, { message: "no such exec" });
      res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" });
      const script = e.cmd.join(" ");
      if (script.includes("sleep-forever")) {
        e.running = true;
        res.write(muxFrame(1, "started\n"));
        held.push(res);
        return;
      }
      if (script.includes("/proc/")) {
        // The kill helper: end every held stream, like killing the processes would.
        for (const h of held.splice(0)) h.end();
        for (const x of execs.values())
          if (x.running) Object.assign(x, { running: false, exitCode: 137 });
        e.exitCode = 0;
        return res.end();
      }
      res.write(muxFrame(1, "out line\n"));
      res.write(muxFrame(2, "err line\n"));
      e.exitCode = 3;
      return res.end();
    }
    m = /^\/v1\.41\/exec\/([^/]+)\/json$/.exec(url);
    if (m) {
      const e = execs.get(m[1] as string);
      return send(200, { Running: e?.running ?? false, ExitCode: e?.exitCode ?? null });
    }
    m = /^\/v1\.41\/containers\/([^/]+)\/json$/.exec(url);
    if (m) {
      if (m[1] === "missing") return send(404, { message: "No such container" });
      return send(200, {
        Id: "c1",
        Name: "/shipmate-app",
        Config: { Image: "node:22-bookworm", Labels: { "shipmate.project": "p1" } },
        State: { Running: true },
        Mounts: [{ Source: "/srv/data", Destination: "/data" }],
      });
    }
    send(404, { message: `unhandled ${req.method} ${url}` });
  };
  return { calls, execs, handler };
}

describe("DockerClient and Sandbox over a fake socket", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipmate-docker-"));
  const socketPath = join(dir, "docker.sock");
  const fake = fakeDocker();
  let server: Server;
  const docker = new DockerClient(socketPath);

  beforeAll(async () => {
    server = createServer((req, res) => void fake.handler(req, res));
    await new Promise<void>((r) => server.listen(socketPath, r));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("pings, and reports false when there is no daemon", async () => {
    expect(await docker.ping()).toBe(true);
    expect(await new DockerClient(join(dir, "nope.sock")).ping()).toBe(false);
  });

  it("inspects containers and maps 404 to null", async () => {
    const c = await docker.inspectContainer("shipmate-app");
    expect(c).toMatchObject({
      id: "c1",
      name: "shipmate-app",
      running: true,
      labels: { "shipmate.project": "p1" },
      mounts: [{ source: "/srv/data", destination: "/data" }],
    });
    expect(await docker.inspectContainer("missing")).toBeNull();
  });

  it("runs bash -lc in /workspace, streams output and returns the exit code", async () => {
    const sandbox = new Sandbox(docker, "/data/workspaces/app", async () => "c1");
    const out: string[] = [];
    const { exitCode } = await sandbox.exec("npm test", "/data/workspaces/app/pkg", {
      onData: (d) => out.push(d.toString()),
    });
    expect(exitCode).toBe(3);
    expect(out.join("")).toBe("out line\nerr line\n");
    const exec = [...fake.execs.values()].at(-1);
    expect(exec?.cmd).toEqual(["bash", "-lc", "npm test"]);
    expect(exec?.workdir).toBe("/workspace/pkg");
    // Only the kill marker: nothing from Shipmate's environment reaches the sandbox.
    expect(exec?.env).toHaveLength(1);
    expect(exec?.env[0]).toMatch(/^SHIPMATE_EXEC=[0-9a-f-]{36}$/);
  });

  it("kills the command on abort and reports it as aborted", async () => {
    const sandbox = new Sandbox(docker, "/data/workspaces/app", async () => "c1");
    const ac = new AbortController();
    const out: string[] = [];
    const run = sandbox.exec("sleep-forever", "/data/workspaces/app", {
      onData: (d) => out.push(d.toString()),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await expect(run).rejects.toThrow("aborted");
    expect(out.join("")).toBe("started\n");
    // The kill helper ran inside the container, matching the exec's marker.
    await new Promise((r) => setTimeout(r, 100));
    const marker = [...fake.execs.values()].find((e) => e.cmd.includes("sleep-forever"))?.env[0];
    const kill = [...fake.execs.values()].find((e) => e.cmd.join(" ").includes("/proc/"));
    expect(kill?.cmd.join(" ")).toContain(marker as string);
  });

  it("times out", async () => {
    const sandbox = new Sandbox(docker, "/data/workspaces/app", async () => "c1");
    await expect(
      sandbox.exec("sleep-forever", "/data/workspaces/app", { onData: () => {}, timeout: 0.2 }),
    ).rejects.toThrow("timeout:0.2");
  });

  it("refuses to start when already aborted", async () => {
    const sandbox = new Sandbox(docker, "/w", async () => {
      throw new Error("should not start");
    });
    const ac = new AbortController();
    ac.abort();
    await expect(sandbox.exec("x", "/w", { onData: () => {}, signal: ac.signal })).rejects.toThrow(
      "aborted",
    );
  });
});
