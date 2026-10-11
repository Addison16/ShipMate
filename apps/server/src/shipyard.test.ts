import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ProjectDto, ServerEvent } from "@shipmate/core";
import { conversations, projectEvents, secrets } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testApp } from "./testing.js";

/** Its own database: the Shipyard suite wipes it, so it never shares one with other suites. */
const db = process.env.TEST_DATABASE_URL_SHIPYARD ?? process.env.TEST_DATABASE_URL;
const TOKEN = "github_pat_ShipyardTestToken_0123456789";

describe.skipIf(!db)("Shipmate phase 3: the Shipyard", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  let github: Server;
  const gh: Array<{ method: string; url: string; auth: string; body: unknown }> = [];
  const root = mkdtempSync(join(tmpdir(), "shipmate-shipyard-"));
  const saved = { ...process.env };

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("timed out");
  };
  const messagesOf = async (id: string) =>
    (await api("GET", `/api/conversations/${id}/messages`)).json().messages as Array<{
      role: string;
      content: string;
    }>;

  beforeAll(async () => {
    // A bare repo standing in for github.com, and a fake GitHub REST API.
    const bare = join(root, "acme", "app.git");
    const seed = join(root, "seed");
    mkdirSync(seed, { recursive: true });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      });
    git(root, "init", "--bare", "-b", "main", bare);
    git(seed, "init", "-b", "main");
    writeFileSync(join(seed, "README.md"), "app\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "first");
    git(seed, "push", `file://${bare}`, "main");

    github = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        const url = req.url ?? "";
        gh.push({
          method: req.method ?? "",
          url,
          auth: String(req.headers.authorization ?? ""),
          body: text ? JSON.parse(text) : undefined,
        });
        const send = (payload: unknown, status = 200) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const pr = {
          number: 7,
          title: "Fix the thing",
          state: "open",
          draft: false,
          merged_at: null,
          html_url: "https://github.com/acme/app/pull/7",
          head: { ref: "fix/12-thing", sha: "abc123" },
          base: { ref: "main" },
          user: { login: "shipmate-bot" },
          updated_at: "2026-10-11T00:00:00Z",
          body: "Fixes #12",
        };
        if (url.startsWith("/repos/acme/app/pulls?")) return send([pr]);
        if (url === "/repos/acme/app/pulls" && req.method === "POST") {
          return send({ ...pr, number: 7 }, 201);
        }
        if (url === "/repos/acme/app/commits/abc123/status") {
          return send({ statuses: [{ context: "ci/test", state: "failure" }] });
        }
        if (url.startsWith("/repos/acme/app/commits/abc123/check-runs")) {
          return send({
            check_runs: [{ name: "lint", status: "completed", conclusion: "success" }],
          });
        }
        if (url.startsWith("/repos/acme/app/issues?")) {
          return send([
            {
              number: 12,
              title: "It breaks",
              state: "open",
              html_url: "https://github.com/acme/app/issues/12",
              labels: [{ name: "bug" }],
              user: { login: "kid" },
              updated_at: "2026-10-11T00:00:00Z",
            },
            { ...pr, labels: [], pull_request: {} },
          ]);
        }
        if (url === "/repos/acme/app/issues/12") {
          return send({
            number: 12,
            title: "It breaks",
            state: "open",
            html_url: "https://github.com/acme/app/issues/12",
            body: "Steps: run it.",
            labels: [{ name: "bug" }],
            user: { login: "kid" },
            updated_at: "2026-10-11T00:00:00Z",
          });
        }
        if (url === "/repos/acme/app") return send({ default_branch: "main" });
        send({ message: "Not Found" }, 404);
      });
    });
    await new Promise<void>((r) => github.listen(0, "127.0.0.1", r));
    const port = (github.address() as AddressInfo).port;

    process.env.DOCKER_SOCKET = join(root, "no-docker.sock");
    process.env.SHIPMATE_GITHUB_API = `http://127.0.0.1:${port}`;
    process.env.SHIPMATE_GITHUB_URL = `file://${root}`;
    t = await testApp(db as string);

    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });

  afterAll(async () => {
    await t?.app.close();
    await new Promise((r) => github?.close(r));
    for (const k of ["DOCKER_SOCKET", "SHIPMATE_GITHUB_API", "SHIPMATE_GITHUB_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  let gp: ProjectDto;
  let local: ProjectDto;

  it("reports the Shipyard unavailable without Docker and seeds the Shipwright", async () => {
    const res = (await api("GET", "/api/shipyard")).json();
    expect(res.status).toMatchObject({ available: false, sandboxImage: "node:22-bookworm" });
    expect(res.status.reason).toContain("no socket at unix://");
    expect(res.status.endpoint).toBe(`unix://${join(root, "no-docker.sock")}`);
    expect(res.projects).toEqual([]);
    const crew = (await api("GET", "/api/crew")).json().crew;
    expect(crew.find((c: { slug: string }) => c.slug === "shipwright")).toMatchObject({
      name: "Shipwright",
      status: "active",
    });
  });

  it("lets the owner point the Shipyard at another sandbox engine", async () => {
    const fake = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/_ping") return res.end("OK");
      if (req.url === "/v1.41/version") {
        return res.end(
          JSON.stringify({
            Version: "5.2.0",
            ApiVersion: "1.41",
            Components: [{ Name: "Podman Engine", Version: "5.2.0" }],
          }),
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });
    const sock = join(root, "podman.sock");
    await new Promise<void>((r) => fake.listen(sock, r));
    try {
      const initial = (await api("GET", "/api/shipyard/sandbox")).json().sandbox;
      expect(initial).toMatchObject({
        mode: "env",
        effective: `unix://${join(root, "no-docker.sock")}`,
      });
      expect((await api("GET", "/api/shipyard/sandbox", undefined, memberCookie)).statusCode).toBe(
        403,
      );
      expect(
        (
          await api(
            "PUT",
            "/api/shipyard/sandbox",
            { mode: "socket", socketPath: sock },
            memberCookie,
          )
        ).statusCode,
      ).toBe(403);

      // Test without saving: works, and nothing changes yet.
      const check = (
        await api("POST", "/api/shipyard/sandbox/test", { mode: "socket", socketPath: sock })
      ).json().check;
      expect(check).toEqual({
        ok: true,
        endpoint: `unix://${sock}`,
        engine: "Podman 5.2.0",
        error: null,
        warnings: [],
      });
      expect((await api("GET", "/api/shipyard")).json().status.available).toBe(false);
      const bad = await api("POST", "/api/shipyard/sandbox/test", {
        mode: "tcp",
        host: "ssh://nas",
      });
      expect(bad.statusCode).toBe(400);
      const plain = (
        await api("POST", "/api/shipyard/sandbox/test", { mode: "tcp", host: "tcp://127.0.0.1:1" })
      ).json().check;
      expect(plain.ok).toBe(false);
      expect(plain.warnings.join(" ")).toContain("no TLS");

      // Save: the Shipyard uses it straight away.
      const saved = (
        await api("PUT", "/api/shipyard/sandbox", { mode: "socket", socketPath: sock })
      ).json().sandbox;
      expect(saved).toMatchObject({
        mode: "socket",
        socketPath: sock,
        effective: `unix://${sock}`,
      });
      expect((await api("GET", "/api/shipyard")).json().status).toMatchObject({
        available: true,
        endpoint: `unix://${sock}`,
      });

      // TLS files are stored encrypted, never returned; half a key pair is refused.
      const KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----";
      const CERT = "-----BEGIN CERTIFICATE-----\nCERTMATERIAL\n-----END CERTIFICATE-----";
      expect(
        (
          await api("PUT", "/api/shipyard/sandbox", {
            mode: "tcp",
            host: "tcp://nas:2376",
            tlsKey: KEY,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await api("PUT", "/api/shipyard/sandbox", {
            mode: "tcp",
            host: "tcp://nas:2376",
            tlsKey: "nope",
          })
        ).statusCode,
      ).toBe(400);
      const tcp = await api("PUT", "/api/shipyard/sandbox", {
        mode: "tcp",
        host: "tcp://nas:2376",
        tlsCert: CERT,
        tlsKey: KEY,
        workspacesPath: "/mnt/shipmate/workspaces",
      });
      expect(tcp.statusCode).toBe(200);
      expect(tcp.body).not.toContain("SECRETKEYMATERIAL");
      expect(tcp.json().sandbox).toMatchObject({
        mode: "tcp",
        host: "tcp://nas:2376",
        tls: { ca: false, cert: true, key: true },
        workspacesPath: "/mnt/shipmate/workspaces",
        effective: "tcp://nas:2376 (TLS)",
      });
      const stored = await t.app.db.select().from(secrets);
      expect(stored.filter((r) => r.ref.startsWith("shipyard:sandbox:"))).toHaveLength(2);
      expect(JSON.stringify(stored)).not.toContain("SECRETKEYMATERIAL");

      // Back to the environment: TLS files are removed.
      const env = (await api("PUT", "/api/shipyard/sandbox", { mode: "env" })).json().sandbox;
      expect(env).toMatchObject({ mode: "env", tls: { cert: false, key: false } });
      expect((await api("GET", "/api/shipyard")).json().status.available).toBe(false);
      const left = await t.app.db.select().from(secrets);
      expect(left.some((r) => r.ref.startsWith("shipyard:sandbox:"))).toBe(false);
    } finally {
      fake.closeAllConnections();
      await new Promise((r) => fake.close(r));
    }
  });

  it("creates projects (admin only) and never returns the token", async () => {
    const denied = await api(
      "POST",
      "/api/shipyard/projects",
      { name: "App", provider: "github", repo: "acme/app" },
      memberCookie,
    );
    expect(denied.statusCode).toBe(403);
    expect(
      (await api("POST", "/api/shipyard/projects", { name: "App", provider: "github" })).statusCode,
    ).toBe(400);

    const res = await api("POST", "/api/shipyard/projects", {
      name: "Acme App",
      provider: "github",
      repo: "acme/app",
      token: TOKEN,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(TOKEN);
    gp = res.json().project;
    expect(gp).toMatchObject({
      slug: "acme-app",
      provider: "github",
      repo: "acme/app",
      crewSlug: "shipwright",
      hasToken: true,
      workspace: { cloned: false, branch: null, dirty: null },
      sandbox: { status: "unavailable", image: "node:22-bookworm" },
      createdBy: { name: "Addison" },
    });
    expect(gp.webhookUrl).toBe(`http://localhost:3000/api/hooks/github/${gp.id}`);
    expect(gp.webhookSecret).toMatch(/^[0-9a-f]{48}$/);

    // Stored encrypted.
    const rows = await t.app.db.select().from(secrets);
    expect(rows.some((r) => r.ref.startsWith("shipyard:"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);

    // Members can read, but not the webhook secret.
    const asMember = await api("GET", `/api/shipyard/projects/${gp.id}`, undefined, memberCookie);
    expect(asMember.json().project).toMatchObject({ webhookUrl: null, webhookSecret: null });
    const list = await api("GET", "/api/shipyard", undefined, memberCookie);
    expect(list.body).not.toContain(gp.webhookSecret as string);
    expect(list.body).not.toContain(TOKEN);

    // Duplicate explicit slug.
    const dup = await api("POST", "/api/shipyard/projects", {
      name: "x",
      slug: "acme-app",
      provider: "local",
    });
    expect(dup.statusCode).toBe(409);
  });

  it("creates a local project with a workspace folder", async () => {
    const res = await api("POST", "/api/shipyard/projects", {
      name: "Garden Notes!",
      provider: "local",
    });
    local = res.json().project;
    expect(local).toMatchObject({
      slug: "garden-notes",
      provider: "local",
      repo: null,
      hasToken: false,
      webhookUrl: null,
      webhookSecret: null,
    });
    expect(existsSync(join(t.config.dirs.workspaces, "garden-notes"))).toBe(true);
    expect((await api("POST", `/api/shipyard/projects/${local.id}/clone`)).statusCode).toBe(400);
  });

  it("updates projects: clears and sets the token, admin only", async () => {
    expect(
      (await api("PATCH", `/api/shipyard/projects/${gp.id}`, { name: "Nope" }, memberCookie))
        .statusCode,
    ).toBe(403);
    let p = (await api("PATCH", `/api/shipyard/projects/${gp.id}`, { token: "" })).json().project;
    expect(p.hasToken).toBe(false);
    p = (
      await api("PATCH", `/api/shipyard/projects/${gp.id}`, { token: TOKEN, name: "Acme" })
    ).json().project;
    expect(p).toMatchObject({ hasToken: true, name: "Acme" });
    const bad = await api("PATCH", `/api/shipyard/projects/${gp.id}`, { crewSlug: "nobody" });
    expect(bad.statusCode).toBe(400);
  });

  it("clones on the host and refuses the sandbox without Docker", async () => {
    const res = await api("POST", `/api/shipyard/projects/${gp.id}/clone`);
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toMatchObject({
      defaultBranch: "main",
      workspace: { cloned: true, branch: "main", dirty: false },
    });
    const sb = await api("POST", `/api/shipyard/projects/${gp.id}/sandbox`, { action: "start" });
    expect(sb.statusCode).toBe(503);
    expect(sb.json().error).toMatch(/^the Shipyard needs a sandbox engine/);
    expect(
      (
        await api(
          "POST",
          `/api/shipyard/projects/${gp.id}/sandbox`,
          { action: "start" },
          memberCookie,
        )
      ).statusCode,
    ).toBe(403);
  });

  it("lists pulls with check state and issues without PRs", async () => {
    const pulls = (
      await api("GET", `/api/shipyard/projects/${gp.id}/pulls`, undefined, memberCookie)
    ).json().pulls;
    expect(pulls).toEqual([
      expect.objectContaining({
        number: 7,
        state: "open",
        branch: "fix/12-thing",
        checks: "failure",
      }),
    ]);
    const issues = (await api("GET", `/api/shipyard/projects/${gp.id}/issues?state=all`)).json()
      .issues;
    expect(issues.map((i: { number: number }) => i.number)).toEqual([12]);
    expect(issues[0].labels).toEqual(["bug"]);
    expect(gh.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect((await api("GET", `/api/shipyard/projects/${local.id}/pulls`)).statusCode).toBe(400);
  });

  it("starts a flow in a new project conversation; the shell never runs on the host", async () => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: memberCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    const marker = join(t.config.dirs.workspaces, "garden-notes", "ran-on-host");
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}` })]),
      fauxAssistantMessage("Here is the plan."),
    ]);
    const res = await api(
      "POST",
      `/api/shipyard/projects/${local.id}/flows`,
      { flow: "plan", notes: "Add a watering schedule" },
      memberCookie,
    );
    expect(res.statusCode).toBe(200);
    const { conversationId } = res.json();
    await until(() => events.some((e) => e.type === "approval_request"));
    const req = events.find((e) => e.type === "approval_request");
    if (req?.type !== "approval_request") throw new Error("no approval request");
    expect(req.approval).toMatchObject({ toolName: "bash", crew: { slug: "shipwright" } });
    ws.send(JSON.stringify({ type: "approve", approvalId: req.approval.id, decision: "allow" }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();

    const toolEnd = events.find((e) => e.type === "tool" && e.phase === "end");
    expect(toolEnd).toMatchObject({ toolName: "bash", isError: true });
    expect(toolEnd?.type === "tool" ? toolEnd.summary : "").toContain("Docker socket");
    expect(existsSync(marker)).toBe(false);

    const list = (await api("GET", "/api/conversations", undefined, memberCookie)).json()
      .conversations;
    const conv = list.find((c: { id: string }) => c.id === conversationId);
    expect(conv).toMatchObject({
      kind: "direct",
      crewSlug: "shipwright",
      surface: "web",
      projectId: local.id,
    });
    expect(conv.title).toMatch(/^Plan: Add a watering schedule/);
    const msgs = (
      await api("GET", `/api/conversations/${conversationId}/messages`, undefined, memberCookie)
    ).json().messages;
    expect(msgs[0].content).toContain("Add a watering schedule");
    expect(msgs.at(-1).content).toBe("Here is the plan.");

    // Flows that need GitHub refuse a local project; target is required where it matters.
    expect(
      (await api("POST", `/api/shipyard/projects/${local.id}/flows`, { flow: "triage" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await api("POST", `/api/shipyard/projects/${gp.id}/flows`, { flow: "fix_issue" }))
        .statusCode,
    ).toBe(400);

    // An empty project conversation for chat.
    const empty = (await api("POST", `/api/shipyard/projects/${gp.id}/conversations`)).json()
      .conversation;
    expect(empty).toMatchObject({ projectId: gp.id, crewSlug: "shipwright", kind: "direct" });
  });

  let prConversation = "";

  it("fixes an issue: titles the conversation and follows the PR it opens", async () => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("open_pull_request", {
          title: "Fix the thing",
          body: "Fixes #12",
          head: "fix/12-thing",
        }),
      ]),
      fauxAssistantMessage("Opened #7."),
    ]);
    const res = await api("POST", `/api/shipyard/projects/${gp.id}/flows`, {
      flow: "fix_issue",
      target: 12,
    });
    expect(res.statusCode).toBe(200);
    prConversation = res.json().conversationId;
    await until(() => events.some((e) => e.type === "approval_request"));
    const req = events.find((e) => e.type === "approval_request");
    if (req?.type !== "approval_request") throw new Error("no approval request");
    expect(req.approval.toolName).toBe("open_pull_request");
    ws.send(JSON.stringify({ type: "approve", approvalId: req.approval.id, decision: "allow" }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();

    const [conv] = await t.app.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, prConversation));
    expect(conv?.title).toBe("Fix #12: It breaks");
    const msgs = await messagesOf(prConversation);
    expect(msgs[0]?.content).toContain("Steps: run it.");
    expect(msgs[0]?.content).not.toContain(TOKEN);

    const created = gh.find((c) => c.method === "POST" && c.url === "/repos/acme/app/pulls");
    expect(created?.body).toMatchObject({ head: "fix/12-thing", base: "main" });
    expect((created?.body as { body?: string } | undefined)?.body).toContain(
      "\n\n---\n_Opened by Shipwright on Shipmate_",
    );
    const events2 = (await api("GET", `/api/shipyard/projects/${gp.id}/events`)).json().events;
    expect(events2[0]).toMatchObject({
      kind: "shipmate.pr_opened",
      conversationId: prConversation,
    });
    expect(events2[0].summary).toContain("#7");
  });

  it("checks webhook signatures, dedupes deliveries and routes PR events", async () => {
    const hook = (body: object, event: string, delivery: string, secret = gp.webhookSecret) => {
      const raw = JSON.stringify(body);
      return t.app.inject({
        method: "POST",
        url: `/api/hooks/github/${gp.id}`,
        payload: raw,
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": delivery,
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret as string)
            .update(raw)
            .digest("hex")}`,
        },
      });
    };
    expect((await hook({ zen: "hi" }, "ping", "d-0", "wrong")).statusCode).toBe(401);
    const unsigned = await t.app.inject({
      method: "POST",
      url: `/api/hooks/github/${gp.id}`,
      payload: { zen: "hi" },
      headers: { "x-github-event": "ping", "x-github-delivery": "d-x" },
    });
    expect(unsigned.statusCode).toBe(401);
    expect((await hook({ zen: "hi" }, "ping", "d-1")).json()).toEqual({ ok: true });
    expect((await hook({ zen: "hi" }, "ping", "d-1")).statusCode).toBe(200);
    const pings = await t.app.db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.deliveryId, "d-1"));
    expect(pings).toHaveLength(1);
    expect(pings[0]?.summary).toBe("GitHub webhook connected");

    // A failed check suite on the PR the crew opened comes back to its conversation.
    const before = (await messagesOf(prConversation)).length;
    t.faux.setResponses([fauxAssistantMessage("Looking at the failing tests.")]);
    const failed = await hook(
      {
        action: "completed",
        check_suite: {
          conclusion: "failure",
          head_branch: "fix/12-thing",
          pull_requests: [{ number: 7 }],
        },
        sender: { login: "github-actions" },
      },
      "check_suite",
      "d-2",
    );
    expect(failed.statusCode).toBe(200);
    await until(async () => (await messagesOf(prConversation)).length > before);
    expect((await messagesOf(prConversation)).at(-1)?.content).toBe(
      "Looking at the failing tests.",
    );
    const [routed] = await t.app.db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.deliveryId, "d-2"));
    expect(routed?.conversationId).toBe(prConversation);

    // Events on PRs Shipmate did not open are stored but not routed.
    await hook(
      {
        action: "created",
        issue: { number: 99, pull_request: {} },
        comment: { body: "hello" },
      },
      "issue_comment",
      "d-3",
    );
    const [other] = await t.app.db
      .select()
      .from(projectEvents)
      .where(eq(projectEvents.deliveryId, "d-3"));
    expect(other?.conversationId).toBeNull();
    expect(other?.summary).toBe("Comment on PR #99");

    // Webhooks for unknown projects.
    const missing = await t.app.inject({
      method: "POST",
      url: "/api/hooks/github/00000000-0000-0000-0000-000000000000",
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(missing.statusCode).toBe(404);
    // JSON parsing still works on ordinary routes.
    expect(
      (await api("PATCH", `/api/shipyard/projects/${gp.id}`, { name: "Acme App" })).json().project
        .name,
    ).toBe("Acme App");
  });

  it("deletes projects (admin only) and keeps the workspace", async () => {
    expect(
      (await api("DELETE", `/api/shipyard/projects/${gp.id}`, undefined, memberCookie)).statusCode,
    ).toBe(403);
    expect((await api("DELETE", `/api/shipyard/projects/${gp.id}`)).json()).toEqual({ ok: true });
    expect((await api("GET", `/api/shipyard/projects/${gp.id}`)).statusCode).toBe(404);
    expect(existsSync(join(t.config.dirs.workspaces, "acme-app", ".git"))).toBe(true);
    const rows = await t.app.db.select().from(secrets);
    expect(rows.some((r) => r.ref.startsWith(`shipyard:${gp.id}`))).toBe(false);
  });
});
