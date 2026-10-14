import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { conversations } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeSlackPort } from "./slack/fake.js";
import { SLACK_LINK_HINT } from "./slack/service.js";
import { emitCrewPicture, TINY_PNG, testApp } from "./testing.js";

/** Its own database: the tests wipe it, and other suites run on theirs at the same time. */
const db = process.env.TEST_DATABASE_URL_SLACK ?? process.env.TEST_DATABASE_URL;

const PERSON = "U0PERSON";
const KID = "U0KID";
const STRANGER = "U0STRANGER";
const CAPTAIN_CH = "C0CAPTAIN";
const SECRET_CH = "G0SECRET";
const DM = "D0PERSON";

describe.skipIf(!db)("Slack bridge", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const port = new FakeSlackPort();
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
  const postsIn = (channelId: string) => port.posts.filter((p) => p.channelId === channelId);

  beforeAll(async () => {
    t = await testApp(db as string, { slackPort: port });
    port.addChannel(CAPTAIN_CH, "captain");
    port.addChannel(SECRET_CH, "secret", { private: true });
    port.addChannel(DM, "dm");
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

  it("connects with both tokens and never returns them", async () => {
    const before = (await api("GET", "/api/slack", undefined, memberCookie)).json().slack;
    expect(before).toMatchObject({ configured: false, connected: false, hasBotToken: false });

    const { BOT_TOKEN, APP_TOKEN } = FakeSlackPort;
    expect((await api("PUT", "/api/slack", { botToken: BOT_TOKEN }, memberCookie)).statusCode).toBe(
      403,
    );
    expect((await api("PUT", "/api/slack", { botToken: APP_TOKEN })).statusCode).toBe(400);
    expect((await api("PUT", "/api/slack", { appToken: BOT_TOKEN })).statusCode).toBe(400);

    const half = (await api("PUT", "/api/slack", { botToken: BOT_TOKEN })).json().slack;
    expect(half).toMatchObject({
      configured: false,
      hasBotToken: true,
      hasAppToken: false,
      connected: false,
      error: "Add the app-level token (xapp-…) to connect.",
    });

    const res = await api("PUT", "/api/slack", { appToken: APP_TOKEN });
    expect(res.body).not.toContain(BOT_TOKEN);
    expect(res.body).not.toContain(APP_TOKEN);
    expect(res.json().slack).toMatchObject({
      configured: true,
      connected: true,
      error: null,
      teamId: "T0FAKE",
      teamName: "Test Harbor",
      botUserId: "U0BOT",
    });
    expect(res.json().slack.channels).toContainEqual({
      crewSlug: "captain",
      crewName: "Captain",
      channelId: null,
      channelName: null,
    });
  });

  it("binds crew members to existing channels", async () => {
    const url = "/api/slack/channels/captain";
    expect((await api("PUT", url, { channelId: CAPTAIN_CH }, memberCookie)).statusCode).toBe(403);
    expect((await api("PUT", url, { channelId: "#captain" })).statusCode).toBe(400);
    expect((await api("PUT", url, { channelId: "C0MISSING" })).statusCode).toBe(400);
    const priv = await api("PUT", url, { channelId: SECRET_CH });
    expect(priv.statusCode).toBe(400);
    expect(priv.json().error).toMatch(/invite the app/i);

    const bound = (await api("PUT", url, { channelId: CAPTAIN_CH })).json().slack;
    expect(port.joined).toEqual([CAPTAIN_CH]);
    expect(bound.channels).toContainEqual({
      crewSlug: "captain",
      crewName: "Captain",
      channelId: CAPTAIN_CH,
      channelName: "captain",
    });
    const taken = await api("PUT", "/api/slack/channels/shipwright", { channelId: CAPTAIN_CH });
    expect(taken.statusCode).toBe(409);
  });

  it("links accounts with a code, by slash command or !link", async () => {
    const issued = (await api("POST", "/api/slack/link")).json();
    expect(issued.instructions).toContain(`/shipmate link ${issued.code}`);
    expect(await port.command(PERSON, `link ${issued.code}`)).toMatch(/^Linked to Addison/);
    expect((await api("GET", "/api/auth/me")).json().user.slackUserId).toBe(PERSON);
    expect(await port.command(PERSON, `link ${issued.code}`)).toMatch(/not valid or has expired/);
    expect(await port.command(PERSON, "help")).toMatch(/^Usage/);

    const kidCode = (await api("POST", "/api/slack/link", undefined, memberCookie)).json().code;
    port.message(CAPTAIN_CH, KID, `!link ${kidCode}`);
    await until(() =>
      port.ephemerals.some((e) => e.userId === KID && e.text.includes("Linked to Kid")),
    );
  });

  it("runs the crew member and posts under its own name, mentioning the person", async () => {
    t.faux.setResponses([fauxAssistantMessage("Aye, <all> hands & **accounted** for.")]);
    port.message(CAPTAIN_CH, PERSON, "status report");
    await until(() => postsIn(CAPTAIN_CH).some((p) => p.text.includes("hands")));
    const post = postsIn(CAPTAIN_CH).find((p) => p.text.includes("hands"));
    expect(post).toMatchObject({
      username: "Captain",
      text: `<@${PERSON}> Aye, &lt;all&gt; hands &amp; *accounted* for.`,
    });
    const rows = await t.app.db
      .select()
      .from(conversations)
      .where(eq(conversations.surface, "slack"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: `${CAPTAIN_CH}:${PERSON}:captain`,
      kind: "bridge",
    });

    // Long replies are split; only the first piece mentions the person.
    t.faux.setResponses([fauxAssistantMessage(`${"a".repeat(3000)}\n\n${"b".repeat(3000)}`)]);
    port.message(CAPTAIN_CH, PERSON, "write a lot");
    await until(() => postsIn(CAPTAIN_CH).some((p) => p.text === "b".repeat(3000)));
    const parts = postsIn(CAPTAIN_CH).slice(-2);
    expect(parts[0]?.text).toBe(`<@${PERSON}> ${"a".repeat(3000)}`);
    expect(parts.every((p) => p.username === "Captain")).toBe(true);
  });

  it("answers direct messages to the app as the Captain", async () => {
    t.faux.setResponses([fauxAssistantMessage("Hello from the bridge.")]);
    port.message(DM, PERSON, "hi");
    await until(() => postsIn(DM).some((p) => p.text.includes("Hello from")));
    expect(postsIn(DM).at(-1)).toMatchObject({
      username: "Captain",
      text: "Hello from the bridge.",
    });
  });

  it("uploads a reply's pictures after its text, and posts a picture-only reply", async () => {
    await emitCrewPicture(t.app, "slack", "Here is the chart.");
    await until(() => port.uploads.length > 0);
    expect(postsIn(DM).at(-1)).toMatchObject({ text: "Here is the chart.", username: "Captain" });
    const first = port.uploads[0];
    expect(first?.channelId).toBe(DM);
    expect(first?.initialComment).toBeUndefined();
    expect(first?.files.map((f) => f.name)).toEqual(["chart.png"]);
    expect(first?.files[0]?.data.equals(TINY_PNG)).toBe(true);

    const posts = port.posts.length;
    await emitCrewPicture(t.app, "slack", "  ");
    await until(() => port.uploads.length > 1);
    expect(port.posts.length).toBe(posts);
    expect(port.uploads[1]).toMatchObject({ channelId: DM, initialComment: "*Captain*" });
    expect(port.uploads[1]?.files).toHaveLength(1);
  });

  it("hints once to unlinked people and ignores bots, edits and unbound channels", async () => {
    const before = port.ephemerals.length;
    port.message(CAPTAIN_CH, STRANGER, "hello?");
    await until(() => port.ephemerals.length > before);
    expect(port.ephemerals.at(-1)).toEqual({
      channelId: CAPTAIN_CH,
      userId: STRANGER,
      text: SLACK_LINK_HINT,
    });
    port.message(CAPTAIN_CH, STRANGER, "hello??");
    port.message(CAPTAIN_CH, "U0OTHERBOT", "beep", { botId: "B1" });
    port.message(CAPTAIN_CH, PERSON, "edited", { subtype: "message_changed" });
    port.message("C0RANDOM", PERSON, "not a crew channel");
    const posts = port.posts.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(port.ephemerals.length).toBe(before + 1);
    expect(port.posts.length).toBe(posts);
  });

  it("asks for approval with buttons; only the requesting person may answer", async () => {
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo shipmate-ok" })]),
      fauxAssistantMessage("Ran it."),
    ]);
    port.message(CAPTAIN_CH, PERSON, "run the check");
    await until(() => port.posts.some((p) => p.blocks?.length));
    const card = port.posts.find((p) => p.blocks?.length);
    if (!card) throw new Error("no card");
    expect(JSON.stringify(card.blocks)).toContain("echo shipmate-ok");
    expect(card.text).toContain(`<@${PERSON}>`);
    const actions = card.blocks?.[1] as {
      elements: { action_id: string; text: { text: string } }[];
    };
    expect(actions.elements.map((e) => e.text.text)).toEqual([
      "Allow once",
      "Always allow for Captain",
      "Deny",
    ]);

    // A second message while the crew is busy is turned away.
    const busyTs = port.message(CAPTAIN_CH, PERSON, "hurry up");
    await until(() => port.reactions.some((r) => r.ts === busyTs));
    expect(port.reactions.find((r) => r.ts === busyTs)?.emoji).toBe("hourglass_flowing_sand");
    expect(port.ephemerals.at(-1)?.text).toMatch(/still answering/);

    const allow = actions.elements[0]?.action_id ?? "";
    expect(await port.press(KID, CAPTAIN_CH, card.ts, allow)).toBe("Only Addison can answer this.");
    expect(await port.press(PERSON, CAPTAIN_CH, card.ts, allow)).toBe("acknowledged");
    await until(() => port.updates.some((u) => u.ts === card.ts));
    const update = port.updates.find((u) => u.ts === card.ts);
    expect(update?.text).toContain("Addison allowed it once");
    expect(JSON.stringify(update?.blocks)).not.toContain("actions");
    await until(() => postsIn(CAPTAIN_CH).some((p) => p.text.includes("Ran it.")));
  });

  it("shows a dropped connection, unlinks and disconnects", async () => {
    port.drop("Slack rejected the app-level token (xapp-…).");
    await until(async () => {
      const s = (await api("GET", "/api/slack")).json().slack;
      return !s.connected && s.error?.includes("app-level token");
    });
    expect((await api("DELETE", "/api/slack/link")).json()).toEqual({ ok: true });
    expect((await api("GET", "/api/auth/me")).json().user.slackUserId).toBeNull();
    expect((await api("DELETE", "/api/slack", undefined, memberCookie)).statusCode).toBe(403);
    expect((await api("DELETE", "/api/slack")).json()).toEqual({ ok: true });
    const after = (await api("GET", "/api/slack")).json().slack;
    expect(after).toMatchObject({ configured: false, hasBotToken: false, connected: false });
  });
});
