import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { conversations } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeDiscordPort } from "./discord/fake.js";
import { LINK_HINT } from "./discord/service.js";
import { testApp } from "./testing.js";

/** Its own database: the tests wipe it, and other suites run on theirs at the same time. */
const db = process.env.TEST_DATABASE_URL_DISCORD ?? process.env.TEST_DATABASE_URL;

const PERSON = "200000000000000001";
const KID = "200000000000000002";
const STRANGER = "200000000000000003";

describe.skipIf(!db)("Discord bridge", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const port = new FakeDiscordPort();
  let ownerCookie = "";
  let memberCookie = "";
  let captainChannel = "";
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
    t = await testApp(db as string, { discordPort: port });
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
    const before = (await api("GET", "/api/discord", undefined, memberCookie)).json().discord;
    expect(before).toMatchObject({ configured: false, connected: false, inviteUrl: null });

    expect((await api("PUT", "/api/discord", { botToken: "x" }, memberCookie)).statusCode).toBe(
      403,
    );
    const bad = (await api("PUT", "/api/discord", { botToken: "nope" })).json().discord;
    expect(bad).toMatchObject({
      configured: true,
      connected: false,
      error: "Discord rejected the bot token.",
    });

    const res = await api("PUT", "/api/discord", { botToken: FakeDiscordPort.TOKEN });
    expect(res.body).not.toContain(FakeDiscordPort.TOKEN);
    expect(res.json().discord).toMatchObject({
      configured: true,
      connected: true,
      error: null,
      applicationId: port.applicationId,
      guildId: port.guild.id,
      guildName: port.guild.name,
    });
    expect(res.json().discord.channels).toContainEqual({
      crewSlug: "captain",
      crewName: "Captain",
      channelId: null,
      channelName: null,
      webhook: false,
    });
    expect(res.json().discord.inviteUrl).toMatch(
      new RegExp(
        `^https://discord\\.com/oauth2/authorize\\?client_id=${port.applicationId}&scope=bot%20applications\\.commands&permissions=\\d+$`,
      ),
    );
    expect(port.commandsRegistered).toContain(port.guild.id);
  });

  it("syncs a channel and webhook per crew member, idempotently", async () => {
    expect((await api("POST", "/api/discord/sync", undefined, memberCookie)).statusCode).toBe(403);
    const first = (await api("POST", "/api/discord/sync")).json().discord;
    const captain = (d: { channels: { crewSlug: string; channelId: string }[] }) =>
      d.channels.find((c) => c.crewSlug === "captain");
    expect(captain(first)).toEqual({
      crewSlug: "captain",
      crewName: "Captain",
      channelId: expect.any(String),
      channelName: "captain",
      webhook: true,
    });
    expect(first.channels.every((c: { webhook: boolean }) => c.webhook)).toBe(true);
    captainChannel = captain(first)?.channelId ?? "";
    const webhooks = port.webhooks.size;
    expect(webhooks).toBe(first.channels.length);
    const second = (await api("POST", "/api/discord/sync")).json().discord;
    expect(captain(second)?.channelId).toBe(captainChannel);
    expect(port.webhooks.size).toBe(webhooks);
    expect(JSON.stringify(second)).not.toContain("webhook-token");
  });

  it("links accounts with a code, by slash command or !link", async () => {
    const issued = (await api("POST", "/api/discord/link")).json();
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(issued.instructions).toContain(issued.code);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await port.slashLink(PERSON, issued.code)).toMatch(/^Linked to Addison/);
    expect((await api("GET", "/api/auth/me")).json().user.discordUserId).toBe(PERSON);
    expect(await port.slashLink(PERSON, issued.code)).toMatch(/not valid or has expired/);

    // One Discord account belongs to one person.
    const kidCode = (await api("POST", "/api/discord/link", undefined, memberCookie)).json().code;
    expect(await port.slashLink(PERSON, kidCode)).toMatch(/already linked to Addison/);

    const kidCode2 = (await api("POST", "/api/discord/link", undefined, memberCookie)).json().code;
    const msgId = port.message(captainChannel, KID, `!link ${kidCode2}`);
    await until(() => port.botMessages.some((m) => m.content.includes("Linked to Kid")));
    expect(port.deleted).toContainEqual({ channelId: captainChannel, messageId: msgId });
  });

  it("runs the crew member for a linked person and replies through the webhook", async () => {
    t.faux.setResponses([fauxAssistantMessage("Aye, all hands accounted for.")]);
    port.message(captainChannel, PERSON, "status report");
    await until(() => port.webhookPosts.some((p) => p.content.includes("all hands")));
    const post = port.webhookPosts.find((p) => p.content.includes("all hands"));
    expect(post).toMatchObject({
      channelId: captainChannel,
      username: "Captain",
      mentionUserIds: [PERSON],
      content: `<@${PERSON}> Aye, all hands accounted for.`,
    });
    expect(port.typingCalls).toContain(captainChannel);
    const rows = await t.app.db
      .select()
      .from(conversations)
      .where(eq(conversations.surface, "discord"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: `${captainChannel}:${PERSON}`, kind: "bridge" });

    // The next message continues the same conversation.
    t.faux.setResponses([fauxAssistantMessage("Still here.")]);
    port.message(captainChannel, PERSON, "you there?");
    await until(() => port.webhookPosts.some((p) => p.content.includes("Still here.")));
    expect(
      await t.app.db.select().from(conversations).where(eq(conversations.surface, "discord")),
    ).toHaveLength(1);
  });

  it("hints once to unlinked accounts and ignores bots", async () => {
    const replies = port.replies.length;
    port.message(captainChannel, STRANGER, "hello?");
    await until(() => port.replies.length > replies);
    expect(port.replies.at(-1)?.content).toBe(LINK_HINT);
    port.message(captainChannel, STRANGER, "hello??");
    port.message(captainChannel, "300000000000000009", "beep", { bot: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(port.replies.length).toBe(replies + 1);
  });

  it("asks for approval in Discord; only the requesting person may answer", async () => {
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo shipmate-ok" })]),
      fauxAssistantMessage("Ran it."),
    ]);
    port.message(captainChannel, PERSON, "run the check");
    await until(() => port.botMessages.some((m) => m.buttons?.length));
    const card = port.botMessages.find((m) => m.buttons?.length);
    if (!card) throw new Error("no card");
    expect(card.content).toContain(`<@${PERSON}>`);
    expect(card.content).toContain("echo shipmate-ok");
    expect(card.mentionUserIds).toEqual([PERSON]);
    expect(card.buttons?.map((b) => b.label)).toEqual([
      "Allow once",
      "Always allow for Captain",
      "Deny",
    ]);

    // A second message while the crew is busy is turned away.
    const busyId = port.message(captainChannel, PERSON, "hurry up");
    await until(() => port.reactions.some((r) => r.messageId === busyId));
    expect(port.reactions.find((r) => r.messageId === busyId)?.emoji).toBe("⏳");
    expect(port.replies.at(-1)?.content).toMatch(/still answering/);

    const allow = card.buttons?.[0]?.customId ?? "";
    expect(await port.click(KID, card.id, allow)).toBe("Only Addison can answer this.");
    expect(await port.click(STRANGER, card.id, allow)).toBe("Only Addison can answer this.");
    expect(await port.click(PERSON, card.id, allow)).toBe("acknowledged");
    await until(() => port.edits.some((e) => e.messageId === card.id));
    const edit = port.edits.find((e) => e.messageId === card.id);
    expect(edit?.buttons).toEqual([]);
    expect(edit?.content).toContain("Addison allowed it once");
    await until(() => port.webhookPosts.some((p) => p.content.includes("Ran it.")));
  });

  it("unlinks and disconnects", async () => {
    expect((await api("DELETE", "/api/discord/link")).json()).toEqual({ ok: true });
    expect((await api("GET", "/api/auth/me")).json().user.discordUserId).toBeNull();
    expect((await api("DELETE", "/api/discord", undefined, memberCookie)).statusCode).toBe(403);
    expect((await api("DELETE", "/api/discord")).json()).toEqual({ ok: true });
    const after = (await api("GET", "/api/discord")).json().discord;
    expect(after).toMatchObject({ configured: false, connected: false });
    expect(port.connected).toBe(false);
  });
});
