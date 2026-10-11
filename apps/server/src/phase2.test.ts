import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Shipmate phase 2: approvals, skills, watches, MCP, audit", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
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

  const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    t = await testApp(db as string, { watches: false });
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    ownerCookie = cookieOf(setup);
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
  });

  it("pauses the shell for approval: allow, deny, then always allow", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => {
      const e = JSON.parse(raw.toString()) as ServerEvent;
      events.push(e);
    });
    const turn = async (text: string, decision: "allow" | "deny" | "always" | null) => {
      events.length = 0;
      t.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "echo shipmate-ok" })]),
        fauxAssistantMessage("Done."),
      ]);
      ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text }));
      if (decision) {
        await until(() => events.some((e) => e.type === "approval_request"));
        const req = events.find((e) => e.type === "approval_request");
        if (req?.type !== "approval_request") throw new Error("no request");
        expect(req.approval).toMatchObject({ toolName: "bash", crew: { slug: "captain" } });
        expect((await api("GET", "/api/approvals")).json().approvals).toHaveLength(1);
        // Approvals belong to the person who started the turn.
        expect(
          (await api("GET", "/api/approvals", undefined, memberCookie)).json().approvals,
        ).toEqual([]);
        ws.send(JSON.stringify({ type: "approve", approvalId: req.approval.id, decision }));
      }
      await until(() => events.some((e) => e.type === "status" && !e.busy));
      return events.some((e) => e.type === "approval_request");
    };

    await turn("run it", "allow");
    await turn("again", "deny");
    await turn("and again", "always");
    const manifest = readFileSync(join(t.config.dirs.crew, "captain", "crew.yaml"), "utf8");
    expect(manifest).toMatch(/allow:[\s\S]*bash/);
    // Now allowed without asking.
    expect(await turn("once more", null)).toBe(false);
    ws.terminate();

    const audit = (await api("GET", "/api/audit?crew=captain")).json().events;
    const bash = audit
      .filter((e: { action: string }) => e.action === "bash")
      .map((e: { decision: string }) => e.decision);
    expect(bash).toEqual(["auto", "always", "denied", "approved"]);
    // Members see only their own events.
    expect((await api("GET", "/api/audit", undefined, memberCookie)).json().events).toEqual([]);
  });

  it("keeps crew-written skills pending until approved", async () => {
    const mine = await api("POST", "/api/skills", {
      scope: "user",
      content: "---\nname: my-notes\ndescription: how I like notes\n---\n\nBullets.",
    });
    expect(mine.json().skill).toMatchObject({ status: "active", author: "user" });
    const denied = await api(
      "POST",
      "/api/skills",
      { scope: "instance", content: "---\nname: x\ndescription: y\n---\nz" },
      memberCookie,
    );
    expect(denied.statusCode).toBe(403);

    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("create_skill", {
          name: "weekly-plan",
          description: "plan the week",
          instructions: "1. Ask. 2. Plan.",
        }),
      ]),
      fauxAssistantMessage("Saved."),
    ]);
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "save that" }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    expect(events.some((e) => e.type === "skills_changed")).toBe(true);

    const skills = (await api("GET", "/api/skills")).json().skills;
    const plan = skills.find((s: { name: string }) => s.name === "weekly-plan");
    expect(plan).toMatchObject({ status: "pending", scope: "crew", author: "captain" });
    expect(
      (await api("POST", `/api/skills/${plan.id}/approve`, undefined, memberCookie)).statusCode,
    ).toBe(403);
    const approved = await api("POST", `/api/skills/${plan.id}/approve`);
    expect(approved.json().skill.status).toBe("active");
    // The member does not see the owner's personal skill.
    const theirs = (await api("GET", "/api/skills", undefined, memberCookie)).json().skills;
    expect(theirs.map((s: { name: string }) => s.name)).toEqual(["weekly-plan"]);
  });

  it("runs watches now and from a webhook, and lists their runs", async () => {
    const bad = await api("POST", "/api/watches", {
      name: "x",
      crewSlug: "captain",
      prompt: "p",
      trigger: { kind: "cron", expression: "not a cron" },
    });
    expect(bad.statusCode).toBe(400);

    const created = await api("POST", "/api/watches", {
      name: "Morning brief",
      crewSlug: "captain",
      prompt: "Write the morning brief.",
      trigger: { kind: "cron", expression: "0 7 * * *", timezone: "UTC" },
    });
    expect(created.statusCode).toBe(200);
    const watch = created.json().watch;
    expect(watch.nextRunAt).toBeNull(); // the scheduler is off in tests
    // Members cannot change someone else's watch.
    expect(
      (await api("PATCH", `/api/watches/${watch.id}`, { enabled: false }, memberCookie)).statusCode,
    ).toBe(403);

    t.faux.setResponses([fauxAssistantMessage("Sunny, three meetings.")]);
    const started = await api("POST", `/api/watches/${watch.id}/run`);
    expect(started.json().run).toMatchObject({ status: "running", cause: "manual" });
    let run = started.json().run;
    await until(async () => {
      run = (await api("GET", `/api/watches/${watch.id}/runs`)).json().runs[0];
      return run.status !== "running";
    });
    expect(run).toMatchObject({ status: "succeeded", output: "Sunny, three meetings." });
    const transcript = (
      await api("GET", `/api/conversations/${run.conversationId}/messages`)
    ).json().messages;
    expect(transcript.at(-1).content).toBe("Sunny, three meetings.");

    const hook = (
      await api("POST", "/api/watches", {
        name: "On deploy",
        crewSlug: "captain",
        prompt: "Summarize the deploy.",
        trigger: { kind: "webhook" },
      })
    ).json().watch;
    expect(hook.webhookUrl).toMatch(/\/api\/hooks\/watches\//);
    const path = new URL(hook.webhookUrl).pathname;
    const wrong = await t.app.inject({
      method: "POST",
      url: `/api/hooks/watches/${hook.id}/nope`,
      payload: { ok: 1 },
    });
    expect(wrong.statusCode).toBe(404);
    t.faux.setResponses([fauxAssistantMessage("Deploy went fine.")]);
    const fired = await t.app.inject({ method: "POST", url: path, payload: { version: "1.2" } });
    expect(fired.statusCode).toBe(200);
    expect(fired.json().run.cause).toBe("webhook");
    await until(async () => {
      const r = (await api("GET", `/api/watches/${hook.id}/runs`)).json().runs[0];
      return r.status === "succeeded";
    });
    const listed = (await api("GET", "/api/watches")).json().watches;
    expect(listed.map((w: { name: string }) => w.name).sort()).toEqual([
      "Morning brief",
      "On deploy",
    ]);
  });

  it("installs catalog MCP servers, stores secrets and assigns them to crew", async () => {
    const list = (await api("GET", "/api/mcp")).json().servers;
    expect(list.find((s: { id: string }) => s.id === "time")).toMatchObject({
      tier: "core",
      installed: true,
      ready: true,
    });
    expect(list.find((s: { id: string }) => s.id === "todoist").installed).toBe(false);

    expect(
      (await api("POST", "/api/mcp/todoist/install", undefined, memberCookie)).statusCode,
    ).toBe(403);
    const installed = (await api("POST", "/api/mcp/todoist/install")).json().server;
    expect(installed).toMatchObject({ installed: true, ready: false });
    const withKey = await api("PUT", "/api/mcp/todoist/secrets", {
      values: { TODOIST_API_KEY: "td-secret" },
    });
    expect(withKey.json().server.ready).toBe(true);
    expect(withKey.body).not.toContain("td-secret");
    const bogus = await api("PUT", "/api/mcp/todoist/secrets", { values: { OTHER: "x" } });
    expect(bogus.statusCode).toBe(400);

    const assigned = (await api("PUT", "/api/mcp/todoist/crews", { crews: ["captain"] })).json()
      .server;
    expect(assigned.crews).toEqual(["captain"]);
    expect((await api("GET", "/api/crew/captain")).json().crew.mcp).toContain("todoist");

    const custom = await api("POST", "/api/mcp/custom", {
      id: "my-tools",
      name: "My tools",
      transport: "http",
      url: "https://tools.example.com/mcp",
      secrets: [{ env: "TOKEN" }],
    });
    expect(custom.json().server).toMatchObject({ tier: "custom", ready: false });

    await api("DELETE", "/api/mcp/todoist");
    expect((await api("GET", "/api/crew/captain")).json().crew.mcp).not.toContain("todoist");
    const after = (await api("GET", "/api/mcp")).json().servers;
    expect(after.find((s: { id: string }) => s.id === "todoist").secrets[0].set).toBe(false);
    const audit = (await api("GET", "/api/audit")).json().events;
    expect(audit.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["mcp.install", "mcp.custom", "mcp.uninstall"]),
    );
  });

  it("hides private crew members from people who do not own them", async () => {
    const created = await api("POST", "/api/crew", {
      slug: "diary",
      manifestYaml: "name: Diary\nrole: private journal\nmodel: faux/m\nvisibility: private",
      persona: "# Diary",
    });
    expect(created.statusCode).toBe(200);
    const theirs = (await api("GET", "/api/crew", undefined, memberCookie)).json().crew;
    expect(theirs.map((c: { slug: string }) => c.slug)).not.toContain("diary");
    expect((await api("GET", "/api/crew/diary", undefined, memberCookie)).statusCode).toBe(404);
    expect((await api("GET", "/api/crew/diary/memory", undefined, memberCookie)).statusCode).toBe(
      404,
    );
    expect(
      (await api("POST", "/api/conversations", { kind: "direct", crewSlug: "diary" }, memberCookie))
        .statusCode,
    ).toBe(404);
    expect((await api("GET", "/api/crew/diary")).statusCode).toBe(200);
  });

  it("applies account changes to open sockets and stores usage before a turn ends", async () => {
    const users = (await api("GET", "/api/users")).json().users;
    const kid = users.find((u: { role: string }) => u.role === "member");
    const conv = (await api("POST", "/api/conversations", {}, memberCookie)).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: memberCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));

    t.faux.setResponses([fauxAssistantMessage("Hi.")]);
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "hello" }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    const usage = (await api("GET", "/api/usage", undefined, memberCookie)).json();
    expect(usage.totals.calls).toBe(1);

    // A cap set after the socket opened still applies to it.
    await api("PATCH", `/api/users/${kid.id}`, { monthlyCapCents: 0 });
    events.length = 0;
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "again" }));
    await until(() => events.some((e) => e.type === "error"));
    expect(events.find((e) => e.type === "error")).toMatchObject({
      message: expect.stringMatching(/monthly usage cap/),
    });
    ws.terminate();
  });
});
