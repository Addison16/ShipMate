import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { conversations } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeTelegramPort } from "./telegram/fake.js";
import { TELEGRAM_LINK_HINT, TELEGRAM_UNMAPPED } from "./telegram/service.js";
import { testApp } from "./testing.js";

/** Its own database: the tests wipe it, and other suites run on theirs at the same time. */
const db = process.env.TEST_DATABASE_URL_TELEGRAM ?? process.env.TEST_DATABASE_URL;

const PERSON = "5001";
const KID = "5002";
const STRANGER = "5003";
const GROUP = "-1001000000001";

describe.skipIf(!db)("Telegram bridge", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const port = new FakeTelegramPort();
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
  const sentTo = (chatId: string) => port.sent.filter((m) => m.chatId === chatId);

  beforeAll(async () => {
    t = await testApp(db as string, { telegramPort: port });
    port.addChat(GROUP, "Crew deck");
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
  });

  it("connects with a bot token and never returns it", async () => {
    const before = (await api("GET", "/api/telegram", undefined, memberCookie)).json().telegram;
    expect(before).toMatchObject({ configured: false, connected: false, botUsername: null });

    const token = FakeTelegramPort.TOKEN;
    expect((await api("PUT", "/api/telegram", { botToken: token }, memberCookie)).statusCode).toBe(
      403,
    );
    expect((await api("PUT", "/api/telegram", { botToken: "nope" })).statusCode).toBe(400);
    const bad = (
      await api("PUT", "/api/telegram", { botToken: "1:AAwrongwrongwrongwrongwrong" })
    ).json().telegram;
    expect(bad).toMatchObject({
      configured: true,
      connected: false,
      error: "Telegram rejected the bot token.",
    });

    const res = await api("PUT", "/api/telegram", { botToken: token });
    expect(res.body).not.toContain(token);
    expect(res.json().telegram).toMatchObject({
      configured: true,
      connected: true,
      error: null,
      botUsername: "shipmate_test_bot",
      botUrl: "https://t.me/shipmate_test_bot",
      chats: [],
    });
  });

  it("links accounts with a code, by /start or /link", async () => {
    const issued = (await api("POST", "/api/telegram/link")).json();
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(issued.instructions).toContain(`/link ${issued.code}`);
    expect(issued.instructions).toContain(`https://t.me/shipmate_test_bot?start=${issued.code}`);

    port.message(PERSON, PERSON, `/start ${issued.code}`);
    await until(() => sentTo(PERSON).some((m) => m.html.includes("Linked to Addison")));
    expect((await api("GET", "/api/auth/me")).json().user.telegramUserId).toBe(PERSON);

    // One Telegram account belongs to one person.
    const kidCode = (await api("POST", "/api/telegram/link", undefined, memberCookie)).json().code;
    port.message(PERSON, PERSON, `/link ${kidCode}`);
    await until(() => sentTo(PERSON).some((m) => m.html.includes("already linked to Addison")));

    // A command for another bot in the group is not ours.
    const kidCode2 = (await api("POST", "/api/telegram/link", undefined, memberCookie)).json().code;
    const before = port.sent.length;
    port.message(GROUP, KID, `/link@some_other_bot ${kidCode2}`);
    await new Promise((r) => setTimeout(r, 100));
    expect(port.sent.length).toBe(before);

    // In a group the message holding the code is deleted.
    const msgId = port.message(GROUP, KID, `/link@shipmate_test_bot ${kidCode2}`);
    await until(() => sentTo(GROUP).some((m) => m.html.includes("Linked to Kid")));
    expect(port.deleted).toContainEqual({ chatId: GROUP, messageId: msgId });
    expect((await api("GET", "/api/auth/me", undefined, memberCookie)).json().user).toMatchObject({
      telegramUserId: KID,
    });
  });

  it("answers a DM as the Captain, with the crew name first", async () => {
    t.faux.setResponses([fauxAssistantMessage("Aye, all **hands** accounted for.")]);
    port.message(PERSON, PERSON, "status report");
    await until(() => sentTo(PERSON).some((m) => m.html.includes("accounted for")));
    const reply = sentTo(PERSON).find((m) => m.html.includes("accounted for"));
    expect(reply?.html).toBe("<b>Captain</b>\nAye, all <b>hands</b> accounted for.");
    expect(reply?.replyTo).toBeUndefined();
    expect(port.typingCalls).toContain(PERSON);
    const rows = await t.app.db
      .select()
      .from(conversations)
      .where(eq(conversations.surface, "telegram"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: `${PERSON}:${PERSON}:captain`, kind: "bridge" });
  });

  it("asks an admin to map a group, then answers there as that crew member", async () => {
    port.message(GROUP, PERSON, "anyone here?");
    await until(() => sentTo(GROUP).some((m) => m.html === TELEGRAM_UNMAPPED));
    port.message(GROUP, PERSON, "hello?");
    await new Promise((r) => setTimeout(r, 100));
    expect(sentTo(GROUP).filter((m) => m.html === TELEGRAM_UNMAPPED)).toHaveLength(1);

    const status = (await api("GET", "/api/telegram")).json().telegram;
    expect(status.seenChats).toContainEqual({
      chatId: GROUP,
      title: "Crew deck",
      kind: "supergroup",
    });

    const url = `/api/telegram/chats/${GROUP}`;
    expect((await api("PUT", url, { crewSlug: "shipwright" }, memberCookie)).statusCode).toBe(403);
    expect((await api("PUT", url, { crewSlug: "nobody" })).statusCode).toBe(404);
    const mapped = (await api("PUT", url, { crewSlug: "shipwright" })).json().telegram;
    expect(mapped.chats).toEqual([
      { chatId: GROUP, title: "Crew deck", crewSlug: "shipwright", crewName: "Shipwright" },
    ]);
    expect(mapped.seenChats.map((c: { chatId: string }) => c.chatId)).not.toContain(GROUP);

    const long = `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`;
    t.faux.setResponses([fauxAssistantMessage(long)]);
    const asked = port.message(GROUP, PERSON, "write a lot");
    await until(() => sentTo(GROUP).some((m) => m.html === "b".repeat(3000)));
    const parts = sentTo(GROUP).slice(-2);
    expect(parts[0]).toMatchObject({
      html: `<b>Shipwright</b>\n${"a".repeat(3000)}`,
      replyTo: asked,
    });
    expect(parts[1]?.replyTo).toBeUndefined();
  });

  it("hints once to unlinked accounts and ignores bots", async () => {
    const before = sentTo(GROUP).length;
    port.message(GROUP, STRANGER, "hello?");
    await until(() => sentTo(GROUP).length > before);
    expect(sentTo(GROUP).at(-1)?.html).toBe(TELEGRAM_LINK_HINT);
    port.message(GROUP, STRANGER, "hello??");
    port.message(GROUP, "9999", "beep", { bot: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(sentTo(GROUP).length).toBe(before + 1);
  });

  it("asks for approval with buttons; only the requesting person may answer", async () => {
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo shipmate-ok" })]),
      fauxAssistantMessage("Ran it."),
    ]);
    port.message(PERSON, PERSON, "run the check");
    await until(() => port.sent.some((m) => m.buttons?.length));
    const card = port.sent.find((m) => m.buttons?.length);
    if (!card) throw new Error("no card");
    expect(card.html).toContain("echo shipmate-ok");
    expect(card.buttons?.flat().map((b) => b.text)).toEqual([
      "Allow once",
      "Deny",
      "Always allow for Captain",
    ]);
    for (const b of card.buttons?.flat() ?? []) {
      expect(Buffer.byteLength(b.data)).toBeLessThanOrEqual(64);
    }

    // A second message while the crew is busy is turned away.
    port.message(PERSON, PERSON, "hurry up");
    await until(() => sentTo(PERSON).some((m) => m.html.includes("still answering")));

    const allow = card.buttons?.[0]?.[0]?.data ?? "";
    expect(await port.press(KID, PERSON, card.id, allow)).toBe("Only Addison can answer this.");
    expect(await port.press(PERSON, PERSON, card.id, allow)).toBeNull();
    await until(() => port.edits.some((e) => e.messageId === card.id));
    const edit = port.edits.find((e) => e.messageId === card.id);
    expect(edit?.buttons).toEqual([]);
    expect(edit?.html).toContain("Addison allowed it once");
    await until(() => sentTo(PERSON).some((m) => m.html.includes("Ran it.")));
    expect(await port.press(PERSON, PERSON, card.id, allow)).toBe(
      "This request is no longer waiting for an answer.",
    );
  });

  it("shows a dropped connection, unlinks and disconnects", async () => {
    port.drop("Telegram rejected the bot token.");
    await until(async () => {
      const s = (await api("GET", "/api/telegram")).json().telegram;
      return !s.connected && s.error === "Telegram rejected the bot token.";
    });
    expect((await api("DELETE", "/api/telegram/link")).json()).toEqual({ ok: true });
    expect((await api("GET", "/api/auth/me")).json().user.telegramUserId).toBeNull();
    expect((await api("DELETE", "/api/telegram", undefined, memberCookie)).statusCode).toBe(403);
    expect((await api("DELETE", "/api/telegram")).json()).toEqual({ ok: true });
    const after = (await api("GET", "/api/telegram")).json().telegram;
    expect(after).toMatchObject({ configured: false, connected: false, error: null });
  });
});
