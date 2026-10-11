import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthDto } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkApiKey } from "./health/checks.js";
import { compareVersions, ReleaseChecker } from "./health/releases.js";
import {
  dockerApiVersion,
  manualCommands,
  splitImageRef,
  tagFollows,
  Updater,
} from "./health/updater.js";
import { DockerClient } from "./shipyard/docker.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const listen = async (server: Server) => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const close = (server: Server | undefined) =>
  new Promise((r) => (server ? server.close(r) : r(undefined)));

describe("versions and image tags", () => {
  it("compares semver", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc.10", "2.0.0-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("nonsense", "1.0.0")).toBe(0);
  });

  it("knows which tags move to a new release", () => {
    expect(splitImageRef("ghcr.io/addison16/shipmate:1.0")).toEqual({
      repo: "ghcr.io/addison16/shipmate",
      tag: "1.0",
    });
    expect(splitImageRef("localhost:5000/shipmate")).toEqual({
      repo: "localhost:5000/shipmate",
      tag: "latest",
    });
    expect(splitImageRef("shipmate@sha256:abc").tag).toBeNull();
    expect(tagFollows("latest", "1.2.0")).toBe(true);
    expect(tagFollows("edge", null)).toBe(true);
    expect(tagFollows("1", "1.2.0")).toBe(true);
    expect(tagFollows("1", "2.0.0")).toBe(false);
    expect(tagFollows("1.1", "1.1.4")).toBe(true);
    expect(tagFollows("1.0", "1.1.0")).toBe(false);
    expect(tagFollows("1.0.0", "1.1.0")).toBe(false);
    expect(tagFollows(null, "1.1.0")).toBe(false);
  });

  it("writes manual update commands", () => {
    expect(manualCommands(null, { latest: null, current: "1.0.0" })).toEqual([
      "docker compose pull shipmate",
      "docker compose up -d shipmate",
    ]);
    const compose = {
      id: "abc",
      name: "shipmate-shipmate-1",
      image: "ghcr.io/addison16/shipmate:1.0.0",
      running: true,
      labels: {
        "com.docker.compose.project.working_dir": "/srv/ship mate",
        "com.docker.compose.service": "shipmate",
      },
      mounts: [],
    };
    expect(manualCommands(compose, { latest: "1.1.0", current: "1.0.0" })).toEqual([
      "# The image is pinned to :1.0.0. Change it to :1.1.0 in docker-compose.yml first.",
      "cd '/srv/ship mate'",
      "docker compose pull shipmate",
      "docker compose up -d shipmate",
    ]);
    const plain = { ...compose, name: "Shipmate", labels: {}, image: "ghcr.io/addison16/shipmate" };
    expect(manualCommands(plain, { latest: "1.1.0", current: "1.0.0" })[0]).toBe(
      "docker pull ghcr.io/addison16/shipmate:latest",
    );
  });
});

describe("release check", () => {
  it("caches, tolerates failures and can be turned off", async () => {
    let calls = 0;
    let fail = false;
    let now = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      expect(url).toBe("https://gh.test/repos/Addison16/ShipMate/releases/latest");
      if (fail) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({
          tag_name: "v1.2.0",
          name: "Shipmate 1.2",
          html_url: "https://github.com/Addison16/ShipMate/releases/tag/v1.2.0",
          published_at: "2026-10-01T00:00:00Z",
        }),
      );
    }) as typeof fetch;
    const checker = new ReleaseChecker({
      current: "1.0.0",
      enabled: true,
      apiBase: "https://gh.test/",
      fetchImpl,
      now: () => now,
    });
    const first = await checker.check();
    expect(first).toMatchObject({
      enabled: true,
      updateAvailable: true,
      error: null,
      latest: { version: "1.2.0", name: "Shipmate 1.2" },
    });
    await checker.check();
    expect(calls).toBe(1);

    // A failed refresh keeps the last good answer and says why.
    fail = true;
    const failed = await checker.check(true);
    expect(calls).toBe(2);
    expect(failed.latest?.version).toBe("1.2.0");
    expect(failed.error).toBe("Could not reach GitHub (offline?)");
    now += 20 * 60_000; // failures are retried sooner than successes
    await checker.check();
    expect(calls).toBe(3);

    const off = new ReleaseChecker({ current: "1.0.0", enabled: false, fetchImpl });
    expect(await off.check(true)).toMatchObject({ enabled: false, latest: null });
    expect(calls).toBe(3);
  });
});

describe("API key checks", () => {
  let server: Server;
  let base = "";
  const seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      const good =
        req.headers["x-api-key"] === "good" ||
        req.headers.authorization === "Bearer good" ||
        (req.url ?? "").includes("key=good");
      res.writeHead(good ? 200 : (req.url ?? "").startsWith("/v1beta") ? 400 : 401);
      res.end("{}");
    });
    base = await listen(server);
  });
  afterAll(() => close(server));

  it("uses free endpoints and reports refused keys", async () => {
    expect(await checkApiKey("anthropic", "good", { base })).toEqual({
      status: "ok",
      detail: "Reachable, key accepted",
    });
    expect(seen.at(-1)).toMatchObject({
      url: "/v1/models?limit=1",
      headers: { "anthropic-version": "2023-06-01" },
    });
    expect((await checkApiKey("openai", "bad", { base })).status).toBe("fail");
    expect(seen.at(-1)?.url).toBe("/v1/models");
    expect((await checkApiKey("google", "bad", { base })).detail).toBe("The key was refused (400)");
    expect((await checkApiKey("openrouter", "good", { base })).status).toBe("ok");
    expect(seen.at(-1)?.url).toBe("/api/v1/key");
    const down = await checkApiKey("xai", "good", { base: "http://127.0.0.1:9" });
    expect(down).toEqual({ status: "fail", detail: "Cannot reach http://127.0.0.1:9" });
  });
});

/** A fake Docker daemon: ping, inspect, image, create and start (any API version prefix). */
function fakeDocker(selfAt: (socket: string) => Record<string, unknown> | null) {
  const socket = join(mkdtempSync(join(tmpdir(), "shipmate-dock-")), "docker.sock");
  const self = selfAt(socket);
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const url = (req.url ?? "").replace(/^\/v1\.\d+/, "");
    calls.push({ method: req.method ?? "", url, body: text ? JSON.parse(text) : undefined });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (url === "/_ping") {
      res.writeHead(200, { "Api-Version": "1.51" });
      return res.end("OK");
    }
    if (url === "/containers/shipmate-test/json") {
      return self ? send(200, self) : send(404, { message: "no such container" });
    }
    if (url.startsWith("/images/")) return send(200, {});
    if (url.startsWith("/containers/create")) return send(201, { Id: "helper1" });
    if (url === "/containers/helper1/start") return send(204);
    send(404, { message: `unexpected ${url}` });
  });
  return {
    calls,
    socket,
    start: () => new Promise<void>((r) => server.listen(socket, r)),
    stop: () => close(server),
  };
}

/** Shipmate's container as Docker reports it, with the host socket mounted at `socket`. */
const container = (image: string) => (socket: string) => ({
  Id: "abc",
  Name: "/shipmate-shipmate-1",
  Config: {
    Image: image,
    Labels: {
      "com.docker.compose.project.working_dir": "/srv/shipmate",
      "com.docker.compose.service": "shipmate",
    },
  },
  State: { Running: true },
  Mounts: [{ Source: "/run/user/1000/docker.sock", Destination: socket }],
});

describe("one-click update", () => {
  it("explains when there is no Docker socket", async () => {
    const updater = new Updater(new DockerClient("/nonexistent/docker.sock"), {
      current: "1.0.0",
      container: "shipmate-test",
    });
    const plan = await updater.plan("1.1.0");
    expect(plan).toMatchObject({ oneClick: false, container: null });
    expect(plan.reason).toMatch(/^No Docker socket at \/nonexistent\/docker\.sock/);
    expect(plan.commands).toContain("docker compose pull shipmate");
    await expect(updater.run("1.1.0")).rejects.toThrow(/No Docker socket/);
  });

  it("refuses a pinned version tag and shows commands instead", async () => {
    const docker = fakeDocker(container("ghcr.io/addison16/shipmate:1.0.0"));
    await docker.start();
    try {
      const updater = new Updater(new DockerClient(docker.socket), {
        current: "1.0.0",
        container: "shipmate-test",
      });
      const plan = await updater.plan("1.1.0");
      expect(plan.oneClick).toBe(false);
      expect(plan.reason).toMatch(/:1\.0\.0 is pinned/);
      expect(plan.commands[0]).toMatch(/Change it to :1\.1\.0/);
      expect(plan.commands).toContain("cd /srv/shipmate");
    } finally {
      await docker.stop();
    }
  });

  it("leaves NAS-managed containers to the NAS", async () => {
    const unraid = container("ghcr.io/addison16/shipmate:latest");
    const docker = fakeDocker((socket) => {
      const c = unraid(socket);
      return {
        ...c,
        Config: { ...c.Config, Labels: { "net.unraid.docker.managed": "dockerman" } },
      };
    });
    await docker.start();
    try {
      const updater = new Updater(new DockerClient(docker.socket), {
        current: "1.0.0",
        container: "shipmate-test",
      });
      const plan = await updater.plan("1.1.0");
      expect(plan.oneClick).toBe(false);
      expect(plan.reason).toMatch(/^Unraid manages this container/);
      expect(plan.commands[0]).toMatch(/Apply Update/);
    } finally {
      await docker.stop();
    }
  });

  it("starts a one-shot helper that recreates Shipmate's container", async () => {
    const docker = fakeDocker(container("ghcr.io/addison16/shipmate:latest"));
    await docker.start();
    try {
      expect(await dockerApiVersion(docker.socket)).toBe("1.51");
      const updater = new Updater(new DockerClient(docker.socket), {
        current: "1.0.0",
        container: "shipmate-test",
      });
      const plan = await updater.plan("1.1.0");
      expect(plan).toMatchObject({
        oneClick: true,
        container: "shipmate-shipmate-1",
        updaterImage: "containrrr/watchtower:latest",
      });
      const { helper } = await updater.run("1.1.0");
      expect(helper).toMatch(/^shipmate-updater-/);
      const create = docker.calls.find((c) => c.url.startsWith("/containers/create"));
      expect(create?.url).toBe(`/containers/create?name=${helper}`);
      expect(create?.body).toEqual({
        Image: "containrrr/watchtower:latest",
        Cmd: ["--run-once", "--cleanup", "shipmate-shipmate-1"],
        Env: ["DOCKER_API_VERSION=1.51"],
        Labels: { "io.shipmate.updater": "1" },
        HostConfig: {
          AutoRemove: true,
          // The host's socket, found from Shipmate's own mount.
          Binds: ["/run/user/1000/docker.sock:/var/run/docker.sock"],
        },
      });
      expect(docker.calls.at(-1)).toMatchObject({
        method: "POST",
        url: "/containers/helper1/start",
      });
    } finally {
      await docker.stop();
    }
  });
});

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("the Health page", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let github: Server;
  let models: Server;
  let modelsUrl = "";
  let ownerCookie = "";
  let adminCookie = "";
  let memberCookie = "";
  const saved = { ...process.env };

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST", url: string, body?: unknown, cookie = ownerCookie) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const health = async (cookie = ownerCookie) =>
    (await api("GET", "/api/health", undefined, cookie)).json().health as HealthDto;
  const byId = (h: HealthDto, id: string) => h.checks.find((c) => c.id === id);

  beforeAll(async () => {
    github = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          tag_name: "v1.2.0",
          name: "Shipmate 1.2",
          html_url: "https://github.com/Addison16/ShipMate/releases/tag/v1.2.0",
          published_at: "2026-10-01T00:00:00Z",
        }),
      );
    });
    models = createServer((req, res) => {
      res.writeHead(req.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "tiny" }] }));
    });
    process.env.SHIPMATE_GITHUB_API = await listen(github);
    modelsUrl = await listen(models);
    process.env.DOCKER_SOCKET = join(mkdtempSync(join(tmpdir(), "shipmate-")), "none.sock");
    t = await testApp(db as string, { env: { SHIPMATE_UPDATE_CHECK: "on" } });
    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
        "",
      ),
    );
    for (const role of ["admin", "member"]) {
      await api("POST", "/api/users", {
        email: `${role}@example.com`,
        displayName: role,
        password: "password1",
        role,
      });
    }
    const login = async (email: string) =>
      cookieOf(await api("POST", "/api/auth/login", { email, password: "password1" }, ""));
    adminCookie = await login("admin@example.com");
    memberCookie = await login("member@example.com");
  });
  afterAll(async () => {
    process.env = saved;
    await t?.app.close();
    await close(github);
    await close(models);
  });

  it("shows the version, a newer release and the checks", async () => {
    expect((await api("GET", "/api/health", undefined, memberCookie)).statusCode).toBe(403);
    const h = await health(adminCookie);
    expect(h.version).toBe("1.0.0");
    expect(h.release).toMatchObject({
      enabled: true,
      updateAvailable: true,
      latest: {
        version: "1.2.0",
        url: "https://github.com/Addison16/ShipMate/releases/tag/v1.2.0",
      },
    });
    expect(byId(h, "database")).toMatchObject({ status: "ok", hint: null });
    expect(byId(h, "migrations")?.status).toBe("ok");
    expect(byId(h, "providers")).toMatchObject({
      status: "fail",
      hint: expect.stringMatching(/Providers/),
    });
    expect(byId(h, "sandbox")).toMatchObject({ status: "warn", group: "Shipyard" });
    expect(byId(h, "disk")?.detail).toMatch(/free of/);
    expect(byId(h, "backups")).toMatchObject({
      status: "warn",
      detail: "None yet; the nightly backup runs at 03:00 UTC",
    });
    // Unconfigured bridges are left out rather than shown as problems.
    expect(h.checks.some((c) => c.id.startsWith("bridge:"))).toBe(false);
    expect(h.update.oneClick).toBe(false);
    expect(h.update.reason).toMatch(/No Docker socket/);
    expect(h.update.commands).toEqual([
      "docker compose pull shipmate",
      "docker compose up -d shipmate",
    ]);
  });

  it("checks each provider without a model call", async () => {
    const res = await api("POST", "/api/providers", {
      kind: "openai-compatible",
      label: "Basement",
      baseUrl: `${modelsUrl}/v1`,
      models: ["tiny", "huge"],
    });
    const id = res.json().provider.id;
    let h = await health();
    expect(byId(h, `provider:${id}`)).toMatchObject({
      status: "warn",
      detail: "Reachable, but it does not serve huge",
    });
    await t.app.inject({
      method: "PATCH",
      url: `/api/providers/${id}`,
      payload: { models: ["tiny"] },
      headers: { cookie: ownerCookie },
    });
    h = await health();
    expect(byId(h, `provider:${id}`)).toMatchObject({ status: "ok", name: "Basement" });
    expect(byId(h, "providers")).toBeUndefined();

    await t.app.inject({
      method: "PATCH",
      url: `/api/providers/${id}`,
      payload: { baseUrl: "http://127.0.0.1:9/v1" },
      headers: { cookie: ownerCookie },
    });
    expect(byId(await health(), `provider:${id}`)).toMatchObject({
      status: "fail",
      detail: "Cannot reach http://127.0.0.1:9/v1",
    });
  });

  it("lets only the owner start an update, after confirming", async () => {
    expect(
      (await api("POST", "/api/health/update", { confirm: true }, adminCookie)).statusCode,
    ).toBe(403);
    expect((await api("POST", "/api/health/update", {})).statusCode).toBe(400);
    const res = await api("POST", "/api/health/update", { confirm: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/No Docker socket/);
  });

  it("keeps /healthz open for Docker healthchecks", async () => {
    const res = await t.app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: "1.0.0" });
  });
});
