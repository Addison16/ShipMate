import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { conversations } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Keys for other apps", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let kid = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
    headers: Record<string, string> = { cookie: owner },
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers,
    });
  const withKey = (token: string) => ({ authorization: `Bearer ${token}` });
  const makeKey = async (name: string, cookie = owner) =>
    (await api("POST", "/api/keys", { name }, { cookie })).json() as {
      key: { id: string; hint: string; lastUsedAt: string | null };
      token: string;
    };
  const idle = async (id: string) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const [c] = await t.app.db.select().from(conversations).where(eq(conversations.id, id));
      if (c?.turnStartedAt === null) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    t = await testApp(db as string);
    owner = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        {},
      ),
    );
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    kid = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, {}),
    );
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("shows a key once and lists only its start", async () => {
    const made = await makeKey("Siri");
    expect(made.token).toMatch(/^shipmate_[\w-]{40,}$/);
    expect(made.key.hint).toBe(made.token.slice(0, 13));
    const listed = (await api("GET", "/api/keys")).json().keys;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(made.token);
    // Each person sees only their own keys.
    expect((await api("GET", "/api/keys", undefined, { cookie: kid })).json().keys).toHaveLength(0);
    expect(
      (await api("DELETE", `/api/keys/${made.key.id}`, undefined, { cookie: kid })).statusCode,
    ).toBe(404);
  });

  it("answers a message and carries the chat on", async () => {
    const { token, key } = await makeKey("Home Assistant");
    t.faux.setResponses([fauxAssistantMessage("The porch light is on.")]);
    const first = await api(
      "POST",
      "/api/v1/ask",
      { message: "Is the porch light on?" },
      withKey(token),
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "done", reply: "The porch light is on." });
    const chatId = first.json().chatId as string;
    await idle(chatId);

    t.faux.setResponses([fauxAssistantMessage("Turned it off.")]);
    const second = await api("POST", "/api/v1/ask", { message: "Turn it off" }, withKey(token));
    expect(second.json()).toMatchObject({ chatId, reply: "Turned it off." });
    await idle(chatId);

    expect((await api("GET", `/api/v1/chats/${chatId}`, undefined, withKey(token))).json()).toEqual(
      {
        status: "done",
        chatId,
        reply: "Turned it off.",
      },
    );

    t.faux.setResponses([fauxAssistantMessage("Fresh start.")]);
    const fresh = await api(
      "POST",
      "/api/v1/ask",
      { message: "Hello", newChat: true },
      withKey(token),
    );
    expect(fresh.json().chatId).not.toBe(chatId);
    await idle(fresh.json().chatId);

    // The person sees these chats in their own list, and the key shows as used.
    const mine = (await api("GET", "/api/conversations")).json().conversations;
    expect(mine.filter((c: { surface: string }) => c.surface === "api")).toHaveLength(2);
    const listed = (await api("GET", "/api/keys")).json().keys;
    expect(listed.find((k: { id: string }) => k.id === key.id).lastUsedAt).not.toBeNull();
  });

  it("gives back 'working' when the reply takes longer than the wait", async () => {
    const { token } = await makeKey("Slow");
    t.faux.setResponses([
      async () => {
        await new Promise((r) => setTimeout(r, 1500));
        return fauxAssistantMessage("Done at last.");
      },
    ]);
    const res = await api(
      "POST",
      "/api/v1/ask",
      { message: "Do the long thing", waitSeconds: 1, newChat: true },
      withKey(token),
    );
    expect(res.json()).toMatchObject({ status: "working", reply: null });
    const chatId = res.json().chatId as string;
    await idle(chatId);
    expect(
      (await api("GET", `/api/v1/chats/${chatId}`, undefined, withKey(token))).json(),
    ).toMatchObject({ status: "done", reply: "Done at last." });
  });

  it("lets a key do nothing else", async () => {
    const { token } = await makeKey("Script");
    const other = await makeKey("Kid's", kid);
    // No key, a wrong key, a removed key.
    expect((await api("POST", "/api/v1/ask", { message: "hi" }, {})).statusCode).toBe(401);
    expect(
      (await api("POST", "/api/v1/ask", { message: "hi" }, withKey("shipmate_nope"))).statusCode,
    ).toBe(401);
    // The rest of the app does not take keys.
    for (const url of ["/api/conversations", "/api/keys", "/api/users", "/api/auth/sessions"]) {
      expect((await api("GET", url, undefined, withKey(token))).statusCode).toBe(401);
    }
    // One key cannot read a chat another key started.
    t.faux.setResponses([fauxAssistantMessage("For the kid only.")]);
    const theirs = await api("POST", "/api/v1/ask", { message: "secret" }, withKey(other.token));
    await idle(theirs.json().chatId);
    expect(
      (await api("GET", `/api/v1/chats/${theirs.json().chatId}`, undefined, withKey(token)))
        .statusCode,
    ).toBe(404);
    expect(
      (await api("GET", "/api/v1/chats/not-an-id", undefined, withKey(token))).statusCode,
    ).toBe(404);
    // Unknown agent.
    expect(
      (await api("POST", "/api/v1/ask", { message: "hi", agent: "nobody" }, withKey(token)))
        .statusCode,
    ).toBe(404);
    expect((await api("GET", "/api/v1/agents", undefined, withKey(token))).json().agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "captain" })]),
    );
    // A removed key stops working at once.
    await api("DELETE", `/api/keys/${other.key.id}`, undefined, { cookie: kid });
    expect(
      (await api("POST", "/api/v1/ask", { message: "hi" }, withKey(other.token))).statusCode,
    ).toBe(401);
  });
});
