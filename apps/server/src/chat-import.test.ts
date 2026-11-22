import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Importing chats", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let kid = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST", url: string, body?: unknown, cookie = owner) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const chat = (id: string, title: string) => ({
    externalId: id,
    title,
    createdAt: "2024-03-01T10:00:00.000Z",
    updatedAt: "2024-03-02T08:00:00.000Z",
    messages: [
      { role: "user", text: "How long do I boil an egg?", at: "2024-03-01T10:00:00.000Z" },
      // Same time as the question: order must still hold.
      {
        role: "assistant",
        text: "Seven minutes for a jammy yolk.",
        at: "2024-03-01T10:00:00.000Z",
      },
      { role: "user", text: "   ", at: "2024-03-01T10:01:00.000Z" },
      { role: "user", text: "And hard boiled?", at: "not a date" },
    ],
  });

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

  it("adds the chats to the list with their own dates, in order", async () => {
    const res = await api("POST", "/api/conversations/import", {
      source: "chatgpt",
      chats: [chat("a1", "Boiling eggs"), { ...chat("a2", "Nothing said"), messages: [] }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ imported: 1, skipped: 1 });

    const list = (await api("GET", "/api/conversations")).json().conversations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      title: "Boiling eggs",
      importedFrom: "chatgpt",
      archived: false,
      updatedAt: "2024-03-02T08:00:00.000Z",
    });

    const msgs = (await api("GET", `/api/conversations/${list[0].id}/messages`)).json().messages;
    expect(msgs.map((m: { content: string }) => m.content)).toEqual([
      "How long do I boil an egg?",
      "Seven minutes for a jammy yolk.",
      "And hard boiled?",
    ]);
    expect(msgs[0].author).toMatchObject({ kind: "user", name: "Addison" });
    expect(msgs[1].author).toEqual({ kind: "crew", slug: "imported-chatgpt", name: "ChatGPT" });
  });

  it("skips chats already imported, per person and per app", async () => {
    const again = await api("POST", "/api/conversations/import", {
      source: "chatgpt",
      chats: [chat("a1", "Boiling eggs"), chat("a3", "New one")],
    });
    expect(again.json()).toEqual({ imported: 1, skipped: 1 });
    // The same id from the other app is a different chat.
    const claude = await api("POST", "/api/conversations/import", {
      source: "claude",
      archive: true,
      chats: [chat("a1", "From Claude")],
    });
    expect(claude.json()).toEqual({ imported: 1, skipped: 0 });
    const list = (await api("GET", "/api/conversations")).json().conversations;
    expect(list.find((c: { title: string }) => c.title === "From Claude")).toMatchObject({
      archived: true,
      importedFrom: "claude",
    });
    // Someone else importing the same file gets their own copies and sees only those.
    const theirs = await api(
      "POST",
      "/api/conversations/import",
      { source: "chatgpt", chats: [chat("a1", "Boiling eggs")] },
      kid,
    );
    expect(theirs.json()).toEqual({ imported: 1, skipped: 0 });
    expect(
      (await api("GET", "/api/conversations", undefined, kid)).json().conversations,
    ).toHaveLength(1);
  });

  it("can be found by search", async () => {
    const res = await api("GET", "/api/conversations/search?q=jammy");
    const titles = res
      .json()
      .results.map((r: { conversation: { title: string } }) => r.conversation.title);
    expect(titles).toContain("Boiling eggs");
  });

  it("gives the agent the end of the earlier chat", async () => {
    const list = (await api("GET", "/api/conversations")).json().conversations;
    const eggs = list.find((c: { title: string }) => c.title === "Boiling eggs");
    const recap = await t.app.services.chatImport.recap(eggs.id, "chatgpt", "Addison");
    expect(recap).toContain("## Earlier chat from ChatGPT");
    expect(recap).toContain("Addison: How long do I boil an egg?");
    expect(recap).toContain("ChatGPT: Seven minutes for a jammy yolk.");
    expect(
      await t.app.services.chatImport.recap(crypto.randomUUID(), "chatgpt", "Addison"),
    ).toBeNull();
    // After Start fresh the agents forget what is above, the imported part included.
    expect((await api("POST", `/api/conversations/${eggs.id}/reset`)).statusCode).toBe(200);
    expect(await t.app.services.chatImport.recap(eggs.id, "chatgpt", "Addison")).toBeNull();
  });

  it("refuses bad input and people who are not signed in", async () => {
    expect(
      (await api("POST", "/api/conversations/import", { source: "other", chats: [] })).statusCode,
    ).toBe(400);
    expect(
      (
        await api(
          "POST",
          "/api/conversations/import",
          { source: "chatgpt", chats: [chat("z", "t")] },
          "",
        )
      ).statusCode,
    ).toBe(401);
  });
});
