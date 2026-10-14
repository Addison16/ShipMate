import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Shipmate server", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";

  beforeAll(async () => {
    t = await testApp(db as string);
  });
  afterAll(async () => {
    await t?.app.close();
  });

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

  it("runs first-time setup once and seeds the renamed Captain", async () => {
    const me = await api("GET", "/api/auth/me", undefined, "");
    expect(me.json()).toEqual({ user: null, setupRequired: true });
    const res = await api(
      "POST",
      "/api/setup",
      {
        email: "Owner@Example.com",
        displayName: "Addison",
        password: "correct horse",
        captainName: "Skipper",
      },
      "",
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe("owner");
    ownerCookie = cookieOf(res);
    const again = await api(
      "POST",
      "/api/setup",
      { email: "second@example.com", displayName: "x", password: "12345678" },
      "",
    );
    expect(again.statusCode).toBe(409);
    const crew = (await api("GET", "/api/crew")).json().crew;
    // The Captain plus the Shipwright (the Shipyard's default coder) and the Bosun (its reviewer).
    expect(crew.map((c: { slug: string }) => c.slug).sort()).toEqual([
      "bosun",
      "captain",
      "shipwright",
    ]);
    expect(crew.find((c: { slug: string }) => c.slug === "captain")).toMatchObject({
      slug: "captain",
      name: "Skipper",
      captain: true,
      status: "active",
    });
  });

  it("marks the sign-in cookie Secure only when the browser came in over https", async () => {
    const login = (headers: Record<string, string>) =>
      t.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "owner@example.com", password: "correct horse" },
        headers,
      });
    // Plain http at a LAN address: a Secure cookie would be dropped and sign-in would do nothing.
    const http = await login({});
    expect(http.statusCode).toBe(200);
    expect(String(http.headers["set-cookie"])).not.toMatch(/Secure/);
    // Through a trusted proxy that terminated https.
    const https = await login({ "x-forwarded-proto": "https" });
    expect(String(https.headers["set-cookie"])).toMatch(/Secure/);
    const wrong = await t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.com", password: "nope" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe("Wrong email or password.");
  });

  it("requires sign-in and enforces roles", async () => {
    expect((await api("GET", "/api/crew", undefined, "")).statusCode).toBe(401);
    const created = await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    expect(created.statusCode).toBe(200);
    const login = await api(
      "POST",
      "/api/auth/login",
      { email: "kid@example.com", password: "password1" },
      "",
    );
    const memberCookie = cookieOf(login);
    expect((await api("GET", "/api/users", undefined, memberCookie)).statusCode).toBe(403);
    expect((await api("POST", "/api/providers", { kind: "ollama" }, memberCookie)).statusCode).toBe(
      403,
    );
    const bad = await api(
      "POST",
      "/api/auth/login",
      { email: "kid@example.com", password: "nope" },
      "",
    );
    expect(bad.statusCode).toBe(401);
  });

  it("keeps appearance preferences per user", async () => {
    const before = (await api("GET", "/api/auth/me")).json().user;
    expect(before.preferences).toEqual({ themeMode: "auto", colorTheme: "harbor" });
    expect(
      (await api("PATCH", "/api/auth/preferences", { themeMode: "dark" }, "")).statusCode,
    ).toBe(401);
    const res = await api("PATCH", "/api/auth/preferences", { themeMode: "dark" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.preferences).toEqual({ themeMode: "dark", colorTheme: "harbor" });
    const both = await api("PATCH", "/api/auth/preferences", { colorTheme: "coral-reef" });
    expect(both.json().user.preferences).toEqual({ themeMode: "dark", colorTheme: "coral-reef" });
    expect((await api("PATCH", "/api/auth/preferences", { colorTheme: "plaid" })).statusCode).toBe(
      400,
    );
    // Another user's preferences are untouched.
    const login = await api(
      "POST",
      "/api/auth/login",
      { email: "kid@example.com", password: "password1" },
      "",
    );
    const kid = (await api("GET", "/api/auth/me", undefined, cookieOf(login))).json().user;
    expect(kid.preferences).toEqual({ themeMode: "auto", colorTheme: "harbor" });
  });

  it("stores provider keys encrypted and never returns them", async () => {
    const res = await api("POST", "/api/providers", { kind: "anthropic", apiKey: "sk-ant-secret" });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toMatchObject({ kind: "anthropic", hasSecret: true });
    expect(res.body).not.toContain("sk-ant-secret");
    const models = (await api("GET", "/api/models")).json().models;
    expect(
      models.find((m: { ref: string }) => m.ref === "anthropic/claude-sonnet-5-5")?.available,
    ).toBe(true);
    await api("DELETE", `/api/providers/${res.json().provider.id}`);
    const ollama = await api("POST", "/api/providers", { kind: "ollama", models: ["qwen3:8b"] });
    expect(ollama.json().provider.baseUrl).toBe("http://localhost:11434/v1");
    const kinds = (await api("GET", "/api/providers")).json().kinds;
    expect(kinds.find((k: { kind: string }) => k.kind === "claude-code-cli").auth).toBe("external");
    const cli = await api("POST", "/api/providers", { kind: "claude-code-cli" });
    expect(cli.statusCode).toBe(400);
  });

  it("validates crew edits", async () => {
    const res = await api("PUT", "/api/crew/captain", {
      manifestYaml: "name: x\nrole: y\nmodel: nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/model/);
  });

  it("lets every crew member follow the crew default model", async () => {
    // New crew start on the default; it resolves to the Settings model when they run.
    const made = await api("POST", "/api/crew", {
      slug: "spotter",
      name: "Spotter",
      role: "watches the horizon",
      persona: "# Lookout",
    });
    expect(made.statusCode).toBe(200);
    expect(made.json().crew.model).toBe("default");
    const own = await api("POST", "/api/crew", {
      slug: "rigger",
      name: "Rigger",
      role: "ropes",
      model: "faux/m",
      persona: "# Rigger",
    });
    expect(own.json().crew.model).toBe("faux/m");
    const moved = (await api("POST", "/api/crew/use-default-model")).json().changed as string[];
    expect(moved).toContain("rigger");
    expect(moved).not.toContain("spotter");
    expect((await api("GET", "/api/crew/rigger")).json().crew.manifestYaml).toMatch(
      /^model: default$/m,
    );
    expect((await api("POST", "/api/crew/use-default-model")).json().changed).toEqual([]);
    for (const slug of ["spotter", "rigger"]) await api("DELETE", `/api/crew/${slug}`);
  });

  it("streams a Bridge turn with recruiting, delegation, memory and usage", async () => {
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    const waitIdle = () =>
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const last = events.filter((e) => e.type === "status").at(-1);
          if (last && last.type === "status" && !last.busy) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });

    // Turn 1: the Captain recruits Galley and remembers a preference.
    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("recruit_crew_member", {
          slug: "galley",
          name: "Galley",
          role: "meal planning",
          persona: "# Galley\nYou plan meals.",
        }),
        fauxToolCall("remember", { name: "diet", description: "vegetarian", body: "No meat." }),
      ]),
      fauxAssistantMessage("Galley is aboard, pending your review."),
    ]);
    ws.send(
      JSON.stringify({
        type: "send",
        conversationId: conv.id,
        text: "I need meal plans; I'm vegetarian",
      }),
    );
    await waitIdle();
    expect(events.some((e) => e.type === "crew_changed")).toBe(true);
    const galley = (await api("GET", "/api/crew/galley")).json().crew;
    expect(galley.status).toBe("pending_review");

    // Delegating to a crew member awaiting review fails inside the tool; approve and retry.
    expect((await api("POST", "/api/crew/galley/approve")).json().crew.status).toBe("active");
    events.length = 0;
    let captainContext = "";
    t.faux.setResponses([
      (context) => {
        captainContext = JSON.stringify(context.messages);
        return fauxAssistantMessage([
          fauxText("Asking Galley."),
          fauxToolCall("delegate", { crew: "galley", task: "Plan Tuesday dinner, vegetarian" }),
        ]);
      },
      fauxAssistantMessage("Tuesday: lentil curry."),
      fauxAssistantMessage("Galley suggests lentil curry."),
    ]);
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "What's for Tuesday?" }));
    await waitIdle();
    ws.terminate();

    // The Captain sees who is aboard, on which model at what price, and to delegate by default.
    expect(captainContext).toMatch(
      /galley: Galley, meal planning \(model faux\/m \(crew default\), /,
    );
    expect(captainContext).toContain("## Coordinating");
    expect(captainContext).toContain("Then supervise");

    const handoff = events.find((e) => e.type === "handoff");
    expect(handoff).toMatchObject({ from: { slug: "captain" }, to: { slug: "galley" } });
    const deltas = events
      .filter((e) => e.type === "delta")
      .map((e) => (e.type === "delta" ? e.text : ""))
      .join("");
    expect(deltas).toContain("lentil curry");

    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(
      messages.map(
        (m: { author: { name: string }; content: string }) => `${m.author.name}: ${m.content}`,
      ),
    ).toEqual([
      "Addison: I need meal plans; I'm vegetarian",
      "Skipper: Galley is aboard, pending your review.",
      "Addison: What's for Tuesday?",
      "Skipper: Asking Galley.",
      "Galley: Tuesday: lentil curry.",
      "Skipper: Galley suggests lentil curry.",
    ]);

    const memory = (await api("GET", "/api/crew/captain/memory")).json();
    expect(memory.mine.map((m: { name: string }) => m.name)).toEqual(["diet"]);

    const usage = (await api("GET", "/api/usage?scope=all")).json();
    expect(usage.totals.calls).toBe(5);
    expect(usage.byUser[0].displayName).toBe("Addison");
    expect(usage.byCrew.map((c: { slug: string }) => c.slug).sort()).toEqual(["captain", "galley"]);
    const conversations = (await api("GET", "/api/conversations")).json().conversations;
    expect(conversations[0].title).toBe("I need meal plans; I'm vegetarian");
  });

  it("lets a delegated crew member ask the Captain mid-task", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    const idle = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const last = events.filter((e) => e.type === "status").at(-1);
        if (last && last.type === "status" && !last.busy) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });

    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("delegate", { crew: "galley", task: "Plan Friday" })]),
      fauxAssistantMessage([
        fauxToolCall("ask_captain", { question: "Friday is a party. Spicy or mild?" }),
      ]),
      // The Captain answers in its consult session while its main one waits on the delegate.
      fauxAssistantMessage("Mild; there are kids coming."),
      fauxAssistantMessage("Friday: mild bean chili."),
      fauxAssistantMessage("Galley planned a mild chili."),
    ]);
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "Plan Friday" }));
    await idle;
    ws.terminate();

    const handoffs = events.flatMap((e) =>
      e.type === "handoff" ? [`${e.from.slug}>${e.to.slug}`] : [],
    );
    expect(handoffs).toEqual(["captain>galley", "galley>captain"]);
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(
      messages.map(
        (m: { author: { name: string }; content: string }) => `${m.author.name}: ${m.content}`,
      ),
    ).toEqual([
      "Addison: Plan Friday",
      "Skipper: Mild; there are kids coming.",
      "Galley: Friday: mild bean chili.",
      "Skipper: Galley planned a mild chili.",
    ]);
  });

  it("runs helper agents side by side for a crew member that has them", async () => {
    const yaml = (await api("GET", "/api/crew/galley")).json().crew.manifestYaml as string;
    const on = await api("PUT", "/api/crew/galley", {
      manifestYaml: yaml.replace(/^helpers: false$/m, "helpers: true"),
    });
    expect(on.statusCode).toBe(200);
    const conv = (
      await api("POST", "/api/conversations", { kind: "direct", crewSlug: "galley" })
    ).json().conversation;
    const before = (await api("GET", "/api/usage?scope=all")).json().totals.calls as number;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    const idle = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const last = events.filter((e) => e.type === "status").at(-1);
        if (last && last.type === "status" && !last.busy) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });

    t.faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("helper", { task: "Find a soup" }),
        fauxToolCall("helper", { task: "Find a salad" }),
      ]),
      fauxAssistantMessage("Found one."),
      fauxAssistantMessage("Found another."),
      fauxAssistantMessage("Soup and salad it is."),
    ]);
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "Plan lunch" }));
    await idle;
    ws.terminate();

    expect(events.find((e) => e.type === "error")).toBeUndefined();
    const helperChips = events.filter(
      (e) => e.type === "tool" && e.phase === "end" && e.toolName === "helper" && !e.isError,
    );
    expect(helperChips).toHaveLength(2);
    // Helpers report to the crew member; only its own reply lands in the conversation.
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(messages.map((m: { content: string }) => m.content)).toEqual([
      "Plan lunch",
      "Soup and salad it is.",
    ]);
    // Every helper call is metered to the crew member.
    const usage = (await api("GET", "/api/usage?scope=all")).json();
    expect(usage.totals.calls - before).toBe(4);
    await api("PUT", "/api/crew/galley", { manifestYaml: yaml });
    await api("DELETE", `/api/conversations/${conv.id}`);
  });

  it("keeps one direct chat per crew member and can start it fresh", async () => {
    const first = (
      await api("POST", "/api/conversations", { kind: "direct", crewSlug: "galley", reuse: true })
    ).json().conversation;
    const again = (
      await api("POST", "/api/conversations", { kind: "direct", crewSlug: "galley", reuse: true })
    ).json().conversation;
    expect(again.id).toBe(first.id);
    // Without reuse, a new chat is still possible.
    const other = (
      await api("POST", "/api/conversations", { kind: "direct", crewSlug: "galley" })
    ).json().conversation;
    expect(other.id).not.toBe(first.id);
    await api("DELETE", `/api/conversations/${other.id}`);

    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    const idleAfter = (count: number) =>
      new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const done = events.filter((e) => e.type === "status" && !e.busy).length;
          if (done >= count) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });
    t.faux.setResponses([fauxAssistantMessage("Soup tonight.")]);
    ws.send(JSON.stringify({ type: "send", conversationId: first.id, text: "Dinner?" }));
    await idleAfter(1);

    const list = (await api("GET", "/api/conversations")).json().conversations;
    expect(list.find((c: { id: string }) => c.id === first.id).preview).toBe("Soup tonight.");

    const reset = await api("POST", `/api/conversations/${first.id}/reset`);
    expect(reset.statusCode).toBe(200);
    expect(reset.json().message).toMatchObject({
      role: "system",
      content: "Fresh start. Galley won't remember the messages above.",
      meta: { sessionReset: true },
    });
    expect(events.some((e) => e.type === "message" && e.message.meta?.sessionReset)).toBe(true);

    // The next turn starts a new session; the messages before the reset stay.
    t.faux.setResponses([fauxAssistantMessage("Hello again.")]);
    ws.send(JSON.stringify({ type: "send", conversationId: first.id, text: "Hi" }));
    await idleAfter(2);
    ws.terminate();
    const messages = (await api("GET", `/api/conversations/${first.id}/messages`)).json().messages;
    expect(messages.map((m: { content: string }) => m.content)).toEqual([
      "Dinner?",
      "Soup tonight.",
      "Fresh start. Galley won't remember the messages above.",
      "Hi",
      "Hello again.",
    ]);
    const after = (await api("GET", "/api/conversations")).json().conversations;
    expect(after.find((c: { id: string }) => c.id === first.id).preview).toBe("Hello again.");
  });

  it("blocks sending once a monthly cap is reached", async () => {
    const users = (await api("GET", "/api/users")).json().users;
    const owner = users.find((u: { role: string }) => u.role === "owner");
    await api("PATCH", `/api/users/${owner.id}`, { monthlyCapCents: 0 });
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const error = new Promise<ServerEvent>((resolve) =>
      ws.on("message", (raw: Buffer) => {
        const e = JSON.parse(raw.toString()) as ServerEvent;
        if (e.type === "error") resolve(e);
      }),
    );
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "hi" }));
    expect(await error).toMatchObject({ message: expect.stringMatching(/monthly usage cap/) });
    ws.terminate();
  });
});
