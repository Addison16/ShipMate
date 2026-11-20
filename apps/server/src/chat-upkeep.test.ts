import { messages } from "@shipmate/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("chat upkeep: archive and paged messages", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  let userId = "";
  const api = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const list = async () =>
    (await api("GET", "/api/conversations")).json().conversations as Array<{
      id: string;
      pinned: boolean;
      archived: boolean;
    }>;

  beforeAll(async () => {
    t = await testApp(db as string);
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
    });
    cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
    userId = setup.json().user.id;
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("archives a chat to the end of the list, unpinned, and brings it back", async () => {
    const a = (await api("POST", "/api/conversations", {})).json().conversation;
    const b = (await api("POST", "/api/conversations", {})).json().conversation;
    await api("PATCH", `/api/conversations/${a.id}`, { pinned: true });
    const archived = await api("PATCH", `/api/conversations/${a.id}`, { archived: true });
    expect(archived.json().conversation).toMatchObject({ archived: true, pinned: false });
    expect((await list()).map((c) => [c.id, c.archived])).toEqual([
      [b.id, false],
      [a.id, true],
    ]);
    const back = await api("PATCH", `/api/conversations/${a.id}`, { archived: false });
    expect(back.json().conversation.archived).toBe(false);
    expect((await api("PATCH", `/api/conversations/${a.id}`, {})).statusCode).toBe(400);
  });

  it("pages through a long chat, newest page first", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const start = Date.now() - 60_000;
    await t.app.db.insert(messages).values(
      Array.from({ length: 7 }, (_, i) => ({
        conversationId: conv.id,
        role: "user",
        content: `m${i + 1}`,
        userId,
        createdAt: new Date(start + i * 1000),
      })),
    );
    const url = `/api/conversations/${conv.id}/messages`;
    const texts = (r: { json(): { messages: Array<{ content: string }> } }) =>
      r.json().messages.map((m) => m.content);

    const newest = await api("GET", `${url}?limit=3`);
    expect(texts(newest)).toEqual(["m5", "m6", "m7"]);
    expect(newest.json().more).toBe(true);

    const middle = await api("GET", `${url}?limit=3&before=${newest.json().messages[0].id}`);
    expect(texts(middle)).toEqual(["m2", "m3", "m4"]);
    expect(middle.json().more).toBe(true);

    const oldest = await api("GET", `${url}?limit=3&before=${middle.json().messages[0].id}`);
    expect(texts(oldest)).toEqual(["m1"]);
    expect(oldest.json().more).toBe(false);

    // Without a limit, the whole chat, as before.
    const all = await api("GET", url);
    expect(texts(all)).toHaveLength(7);
    expect(all.json().more).toBe(false);
  });
});
