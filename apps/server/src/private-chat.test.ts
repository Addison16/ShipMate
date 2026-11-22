import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { conversations } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRIVATE_IDLE_MS } from "./bridge.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Private chats", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) =>
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
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  const row = async (id: string) =>
    (await t.app.db.select().from(conversations).where(eq(conversations.id, id)))[0];
  /** Send one message and wait for the turn to be over; returns the finished tool calls. */
  const turn = async (conversationId: string, text: string) => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    await until(async () => (await row(conversationId))?.turnStartedAt === null);
    ws.terminate();
    return events.filter((e) => e.type === "tool" && e.phase === "end");
  };
  const create = async (body: object) =>
    (await api("POST", "/api/conversations", body)).json().conversation;

  beforeAll(async () => {
    t = await testApp(db as string);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
    });
    cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("is named up front and kept out of search", async () => {
    const chat = await create({ private: true });
    expect(chat).toMatchObject({ private: true, title: "Private chat" });
    t.faux.setResponses([fauxAssistantMessage("The surprise is safe with me.")]);
    await turn(chat.id, "Planning a surprise zeppelin ride for Sam");
    // Still called "Private chat": no name is made from what was said.
    expect((await row(chat.id))?.title).toBe("Private chat");
    const found = (await api("GET", "/api/conversations/search?q=zeppelin")).json().results;
    expect(found).toHaveLength(0);
    // An ordinary chat with the same words is found.
    const open = await create({});
    t.faux.setResponses([fauxAssistantMessage("Noted.")]);
    await turn(open.id, "zeppelin museum opening hours");
    expect((await api("GET", "/api/conversations/search?q=zeppelin")).json().results).toHaveLength(
      1,
    );
  });

  it("gives the agent no way to save to memory, and tells it so", async () => {
    const chat = await create({ private: true });
    let prompt = "";
    t.faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context);
        return fauxAssistantMessage([fauxToolCall("remember", { content: "Sam likes zeppelins" })]);
      },
      fauxAssistantMessage("I could not save that."),
    ]);
    expect(await turn(chat.id, "remember that Sam likes zeppelins")).toHaveLength(0);
    expect(prompt).toContain("## Private chat");
    // It can still read what it knows, but has nothing to write with.
    expect(prompt).toContain('"name":"recall"');
    expect(prompt).not.toContain('"name":"remember"');
    expect(prompt).not.toContain('"name":"forget"');
    // The same call works in an ordinary chat.
    const open = await create({});
    t.faux.setResponses([
      (context) => {
        prompt = JSON.stringify(context);
        return fauxAssistantMessage([fauxToolCall("remember", { content: "Sam likes trains" })]);
      },
      fauxAssistantMessage("Saved."),
    ]);
    await turn(open.id, "remember that Sam likes trains");
    expect(prompt).toContain('"name":"remember"');
    expect(prompt).not.toContain("## Private chat");
  });

  it("is deleted with the agent's own record when ended", async () => {
    const chat = await create({ private: true });
    t.faux.setResponses([fauxAssistantMessage("Hello.")]);
    await turn(chat.id, "hello");
    const files = Object.values((await row(chat.id))?.sessionFiles ?? {});
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(existsSync(f), f).toBe(true);
    expect((await api("DELETE", `/api/conversations/${chat.id}`)).statusCode).toBe(200);
    expect(await row(chat.id)).toBeUndefined();
    for (const f of files) expect(existsSync(f), f).toBe(false);
  });

  it("removes the agent's record when started fresh", async () => {
    const chat = await create({ private: true });
    t.faux.setResponses([fauxAssistantMessage("Hello.")]);
    await turn(chat.id, "hello");
    const files = Object.values((await row(chat.id))?.sessionFiles ?? {});
    expect(files.length).toBeGreaterThan(0);
    expect((await api("POST", `/api/conversations/${chat.id}/reset`)).statusCode).toBe(200);
    for (const f of files) expect(existsSync(f), f).toBe(false);
    await api("DELETE", `/api/conversations/${chat.id}`);
  });

  it("leaves no record when ended during its first reply", async () => {
    // Find where this agent's records are kept.
    const probe = await create({ private: true });
    t.faux.setResponses([fauxAssistantMessage("Hello.")]);
    await turn(probe.id, "hello");
    const [known] = Object.values((await row(probe.id))?.sessionFiles ?? {});
    await api("DELETE", `/api/conversations/${probe.id}`);
    const dir = dirname(known as string);
    const before = readdirSync(dir).sort();

    const chat = await create({ private: true });
    let ended: Promise<unknown> | undefined;
    t.faux.setResponses([
      () => {
        ended = api("DELETE", `/api/conversations/${chat.id}`);
        return fauxAssistantMessage("A long answer.");
      },
    ]);
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    ws.send(JSON.stringify({ type: "send", conversationId: chat.id, text: "tell me a secret" }));
    await until(() => ended !== undefined);
    await ended;
    await until(() => !t.app.services.bridge.isBusy(chat.id));
    await new Promise((r) => setTimeout(r, 300));
    ws.terminate();
    expect(await row(chat.id)).toBeUndefined();
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("keeps a routine's shared record when one of its runs is deleted", async () => {
    const chat = await create({});
    t.faux.setResponses([fauxAssistantMessage("Hello.")]);
    await turn(chat.id, "hello");
    const files = Object.values((await row(chat.id))?.sessionFiles ?? {});
    expect(files.length).toBeGreaterThan(0);
    await t.app.db
      .update(conversations)
      .set({ surface: "watch" })
      .where(eq(conversations.id, chat.id));
    expect((await api("DELETE", `/api/conversations/${chat.id}`)).statusCode).toBe(200);
    for (const f of files) expect(existsSync(f), f).toBe(true);
  });

  it("is deleted after an hour without use, and ordinary chats are not", async () => {
    const quiet = await create({ private: true });
    const fresh = await create({ private: true });
    const open = await create({});
    const longAgo = new Date(Date.now() - PRIVATE_IDLE_MS - 60_000);
    for (const id of [quiet.id, open.id]) {
      await t.app.db
        .update(conversations)
        .set({ updatedAt: longAgo })
        .where(eq(conversations.id, id));
    }
    expect(await t.app.services.bridge.sweepPrivateChats()).toBe(1);
    expect(await row(quiet.id)).toBeUndefined();
    expect(await row(fresh.id)).toBeDefined();
    expect(await row(open.id)).toBeDefined();
  });

  it("never reuses a private chat for a direct chat", async () => {
    const crew = (await api("GET", "/api/crew")).json().crew as Array<{ slug: string }>;
    const slug = crew[0]?.slug;
    const secret = await create({ kind: "direct", crewSlug: slug, private: true });
    const next = await create({ kind: "direct", crewSlug: slug, reuse: true });
    expect(next.id).not.toBe(secret.id);
    expect(next.private).toBe(false);
  });
});
