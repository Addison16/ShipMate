import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { conversations } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Sharing a chat as a link", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let kid = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST" | "DELETE", url: string, body?: unknown, cookie = owner) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: cookie ? { cookie } : {},
    });
  const until = async (check: () => Promise<boolean> | boolean) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  const say = async (conversationId: string, text: string, reply: string) => {
    t.faux.setResponses([fauxAssistantMessage(reply)]);
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: owner } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId, text }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    await until(async () => {
      const [c] = await t.app.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      return c?.turnStartedAt === null;
    });
    ws.terminate();
  };

  beforeAll(async () => {
    t = await testApp(db as string);
    owner = cookieOf(
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
    kid = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("shows the chat up to the moment it was shared, to anyone with the link", async () => {
    const chat = (await api("POST", "/api/conversations", {})).json().conversation;
    await say(chat.id, "A good soup for a cold day?", "Leek and potato.");
    expect((await api("GET", `/api/conversations/${chat.id}/share`)).json().share).toBeNull();

    const { share } = (await api("POST", `/api/conversations/${chat.id}/share`)).json();
    expect(share.token).toMatch(/^[\w-]{32}$/);
    const listed = (await api("GET", "/api/conversations")).json().conversations;
    expect(listed.find((c: { id: string }) => c.id === chat.id).shared).toBe(true);

    // No cookie at all.
    const seen = await api("GET", `/api/shared/${share.token}`, undefined, "");
    expect(seen.statusCode).toBe(200);
    expect(seen.headers["cache-control"]).toBe("no-store");
    const body = seen.json();
    expect(body).toMatchObject({ title: "A good soup for a cold day?", sharedBy: "Addison" });
    expect(
      body.messages.map((m: { role: string; content: string }) => [m.role, m.content]),
    ).toEqual([
      ["user", "A good soup for a cold day?"],
      ["assistant", "Leek and potato."],
    ]);
    // Words only: no ids, files or tool details.
    expect(Object.keys(body.messages[0]).sort()).toEqual(["content", "createdAt", "name", "role"]);

    // What is said afterwards stays out until the link is updated.
    await say(chat.id, "And my bank PIN is 4321", "I will not repeat that.");
    const after = (await api("GET", `/api/shared/${share.token}`, undefined, "")).json();
    expect(after.messages).toHaveLength(2);
    expect((await api("GET", `/api/conversations/${chat.id}/share`)).json().share.newer).toBe(2);

    const again = (await api("POST", `/api/conversations/${chat.id}/share`)).json().share;
    expect(again.token).toBe(share.token);
    expect(
      (await api("GET", `/api/shared/${share.token}`, undefined, "")).json().messages,
    ).toHaveLength(4);
  });

  it("stops working when sharing is stopped or the chat is deleted", async () => {
    const chat = (await api("POST", "/api/conversations", {})).json().conversation;
    await say(chat.id, "Hello", "Hi.");
    const { share } = (await api("POST", `/api/conversations/${chat.id}/share`)).json();
    expect((await api("DELETE", `/api/conversations/${chat.id}/share`)).statusCode).toBe(200);
    expect((await api("GET", `/api/shared/${share.token}`, undefined, "")).statusCode).toBe(404);
    // A new link is a new secret.
    const next = (await api("POST", `/api/conversations/${chat.id}/share`)).json().share;
    expect(next.token).not.toBe(share.token);
    await api("DELETE", `/api/conversations/${chat.id}`);
    expect((await api("GET", `/api/shared/${next.token}`, undefined, "")).statusCode).toBe(404);
    expect((await api("GET", "/api/shared/nope", undefined, "")).statusCode).toBe(404);
  });

  it("is only the owner's to share, and never a private chat", async () => {
    const chat = (await api("POST", "/api/conversations", {})).json().conversation;
    for (const method of ["GET", "POST", "DELETE"] as const) {
      expect(
        (await api(method, `/api/conversations/${chat.id}/share`, undefined, kid)).statusCode,
      ).toBe(404);
    }
    const secret = (await api("POST", "/api/conversations", { private: true })).json().conversation;
    expect((await api("POST", `/api/conversations/${secret.id}/share`)).statusCode).toBe(400);
  });
});
