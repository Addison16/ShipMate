import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { conversations, usageEvents } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Group chats", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    who = "owner",
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: who ? { cookie: cookies[who] ?? "" } : {},
    });
  const until = async (check: () => Promise<boolean> | boolean) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  const listen = async (who: string) => {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: cookies[who] ?? "" } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    return { ws, events };
  };
  const idle = (conversationId: string) =>
    until(async () => {
      const [c] = await t.app.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      return c?.turnStartedAt === null;
    });
  /** `who` sends one message; resolves when the turn is over. Returns what the model was sent. */
  const say = async (who: string, conversationId: string, text: string, reply: string) => {
    let seen = "";
    t.faux.setResponses([
      (context) => {
        seen = JSON.stringify(context);
        return fauxAssistantMessage(reply);
      },
    ]);
    const { ws, events } = await listen(who);
    ws.send(JSON.stringify({ type: "send", conversationId, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    await idle(conversationId);
    ws.terminate();
    return seen;
  };
  /** Without the notes Shipmate adds itself (e.g. which model answered). */
  const spoken = <T extends { role: string }>(all: T[]) => all.filter((m) => m.role !== "system");
  const list = async (who: string) =>
    (await api("GET", "/api/conversations", undefined, who)).json().conversations as {
      id: string;
      group: boolean;
      mine: boolean;
      preview: string | null;
    }[];

  beforeAll(async () => {
    t = await testApp(db as string);
    const first = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    cookies.owner = cookieOf(first);
    ids.owner = first.json().user.id;
    for (const name of ["kid", "guest"]) {
      const made = await api("POST", "/api/users", {
        email: `${name}@example.com`,
        displayName: name === "kid" ? "Robin" : "Guest",
        password: "password1",
        role: "member",
      });
      ids[name] = made.json().user.id;
      cookies[name] = cookieOf(
        await api(
          "POST",
          "/api/auth/login",
          { email: `${name}@example.com`, password: "password1" },
          "",
        ),
      );
    }
  });
  afterAll(async () => {
    await t?.app.close();
  });

  let chat = "";

  it("puts the chat in the list of everyone added, and tells them", async () => {
    chat = (await api("POST", "/api/conversations", {})).json().conversation.id;
    await say("owner", chat, "What shall we cook on Friday?", "Tacos?");
    expect((await list("kid")).some((c) => c.id === chat)).toBe(false);

    const kid = await listen("kid");
    const set = await api("PUT", `/api/conversations/${chat}/people`, { userIds: [ids.kid] });
    expect(set.statusCode).toBe(200);
    expect(set.json().people).toEqual([
      { id: ids.owner, name: "Addison", starter: true },
      { id: ids.kid, name: "Robin", starter: false },
    ]);
    expect(set.json().household.map((p: { name: string }) => p.name)).toEqual(["Guest", "Robin"]);
    await until(() => kid.events.some((e) => e.type === "chats_changed"));
    kid.ws.terminate();

    expect((await list("owner")).find((c) => c.id === chat)).toMatchObject({
      group: true,
      mine: true,
    });
    const theirs = (await list("kid")).find((c) => c.id === chat);
    expect(theirs).toMatchObject({ group: true, mine: false });
    // "You:" is only for the reader's own words.
    expect(theirs?.preview).toBe("Tacos?");
    // They read what was said before they joined, and see who else is here but not who could be.
    const read = await api("GET", `/api/conversations/${chat}/messages`, undefined, "kid");
    expect(spoken(read.json().messages)).toHaveLength(2);
    const people = (await api("GET", `/api/conversations/${chat}/people`, undefined, "kid")).json();
    expect(people.people).toHaveLength(2);
    expect(people.household).toEqual([]);
  });

  it("lets anyone in it write, shows it to the others, and bills the writer", async () => {
    const owner = await listen("owner");
    const seen = await say("kid", chat, "Can we have pizza instead?", "Pizza it is.");
    // The agent is told whose message this is, and still has what was said before.
    expect(seen).toContain("This message is from Robin.");
    expect(seen).toContain("Group chat between Addison, Robin.");
    expect(seen).toContain("What shall we cook on Friday?");
    // The starter's open page got the message and the reply as they happened.
    const got = spoken(owner.events.filter((e) => e.type === "message").map((e) => e.message));
    expect(got.map((m) => m.content)).toEqual(["Can we have pizza instead?", "Pizza it is."]);
    expect(got[0]?.author).toMatchObject({ kind: "user", id: ids.kid, name: "Robin" });
    owner.ws.terminate();
    const usage = await t.app.db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.userId, ids.kid ?? ""));
    expect(usage.length).toBeGreaterThan(0);

    // And back again: the next message is the starter's.
    const next = await say("owner", chat, "Fine by me.", "Friday pizza, then.");
    expect(next).toContain("This message is from Addison.");
    expect(next).toContain("Can we have pizza instead?");
  });

  it("shows a file sent in the chat to the people in it only", async () => {
    const up = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${chat}/attachments`,
      payload: Buffer.from("flour, yeast, tomatoes"),
      headers: {
        cookie: cookies.kid ?? "",
        "content-type": "application/octet-stream",
        "x-file-name": "shopping.txt",
        "x-file-type": "text/plain",
      },
    });
    expect(up.statusCode).toBe(200);
    const file = up.json().attachment?.id ?? up.json().id;
    const get = (who: string) => api("GET", `/api/attachments/${file}`, undefined, who);
    // Not sent yet: only the person who picked it.
    expect((await get("owner")).statusCode).toBe(404);
    t.faux.setResponses([fauxAssistantMessage("Got the list.")]);
    const { ws, events } = await listen("kid");
    ws.send(JSON.stringify({ type: "send", conversationId: chat, text: "", attachments: [file] }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    await idle(chat);
    ws.terminate();
    expect((await get("owner")).statusCode).toBe(200);
    expect((await get("kid")).statusCode).toBe(200);
    expect((await get("guest")).statusCode).toBe(404);
  });

  it("keeps the starter in charge and everyone else out", async () => {
    for (const [method, url, body] of [
      ["PATCH", `/api/conversations/${chat}`, { title: "Mine now" }],
      ["DELETE", `/api/conversations/${chat}`, undefined],
      ["PUT", `/api/conversations/${chat}/people`, { userIds: [ids.guest] }],
      ["POST", `/api/conversations/${chat}/share`, undefined],
      ["POST", `/api/conversations/${chat}/reset`, undefined],
    ] as const) {
      expect((await api(method, url, body, "kid")).statusCode).toBe(404);
    }
    for (const url of [
      `/api/conversations/${chat}/messages`,
      `/api/conversations/${chat}/people`,
      `/api/conversations/${chat}/context`,
    ]) {
      expect((await api("GET", url, undefined, "guest")).statusCode).toBe(404);
    }
    // Someone in the chat sees its context meter like the starter does.
    expect(
      (await api("GET", `/api/conversations/${chat}/context`, undefined, "kid")).statusCode,
    ).toBe(200);
    expect((await list("guest")).some((c) => c.id === chat)).toBe(false);
    const guest = await listen("guest");
    guest.ws.send(JSON.stringify({ type: "send", conversationId: chat, text: "let me in" }));
    await until(() => guest.events.some((e) => e.type === "error"));
    guest.ws.terminate();
    const all = (await api("GET", `/api/conversations/${chat}/messages`)).json().messages;
    expect(spoken(all)).toHaveLength(8);

    // Not for private chats, and not with made-up people.
    const secret = (await api("POST", "/api/conversations", { private: true })).json().conversation;
    expect(
      (await api("PUT", `/api/conversations/${secret.id}/people`, { userIds: [ids.kid] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await api("PUT", `/api/conversations/${chat}/people`, {
          userIds: ["00000000-0000-4000-8000-000000000000"],
        })
      ).statusCode,
    ).toBe(404);
  });

  it("ends for someone who leaves or is removed, and survives a restart", async () => {
    await t.app.services.bridge.loadGroups();
    expect((await list("kid")).find((c) => c.id === chat)).toMatchObject({ group: true });

    expect((await api("POST", `/api/conversations/${chat}/leave`)).statusCode).toBe(400);
    expect(
      (await api("POST", `/api/conversations/${chat}/leave`, undefined, "kid")).statusCode,
    ).toBe(200);
    expect((await list("kid")).some((c) => c.id === chat)).toBe(false);
    expect(
      (await api("GET", `/api/conversations/${chat}/messages`, undefined, "kid")).statusCode,
    ).toBe(404);
    // With nobody else in it, it is an ordinary chat again.
    expect((await list("owner")).find((c) => c.id === chat)).toMatchObject({ group: false });

    await api("PUT", `/api/conversations/${chat}/people`, { userIds: [ids.kid, ids.guest] });
    await api("PUT", `/api/conversations/${chat}/people`, { userIds: [ids.guest] });
    expect((await list("kid")).some((c) => c.id === chat)).toBe(false);
    expect((await list("guest")).some((c) => c.id === chat)).toBe(true);
    // The removed person's pages hear nothing more.
    const kid = await listen("kid");
    await say("owner", chat, "Guest is here now.", "Welcome.");
    expect(kid.events.some((e) => e.type === "message")).toBe(false);
    kid.ws.terminate();
  });
});
