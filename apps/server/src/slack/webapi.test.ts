import { describe, expect, it } from "vitest";
import { escapeMrkdwn, slackIcon, toMrkdwn } from "./format.js";
import type { SlackEvent } from "./port.js";
import type { SocketLike } from "./socket.js";
import { SlackWebApi } from "./webapi.js";

class Socket implements SocketLike {
  sent: string[] = [];
  #message: ((event: { data: unknown }) => void)[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === "message") this.#message.push(listener);
  }
  receive(envelope: object) {
    for (const l of this.#message) l({ data: JSON.stringify(envelope) });
  }
}

function setup(answers: Record<string, object> = {}) {
  const calls: { method: string; auth: string | null; body: URLSearchParams }[] = [];
  const responded: { url: string; body: unknown }[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://hooks.slack.test/")) {
      responded.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    }
    const method = url.replace("https://slack.test/api/", "");
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      auth: headers.get("authorization"),
      body: new URLSearchParams(String(init?.body)),
    });
    const answer = answers[method] ??
      {
        "auth.test": { ok: true, team_id: "T1", team: "Harbor", user_id: "UBOT" },
        "apps.connections.open": { ok: true, url: "wss://socket.test/1" },
        "chat.postMessage": { ok: true, ts: "1.0001" },
      }[method] ?? { ok: true };
    return Response.json(answer);
  }) as typeof fetch;
  const socket = new Socket();
  const api = new SlackWebApi({
    fetch: fetchStub,
    apiBase: "https://slack.test/api",
    createSocket: () => {
      queueMicrotask(() => socket.receive({ type: "hello" }));
      return socket;
    },
  });
  const events: SlackEvent[] = [];
  api.listen((e) => events.push(e));
  return { api, calls, responded, socket, events };
}

describe("SlackWebApi", () => {
  it("checks the bot token, opens Socket Mode with the app token and posts as a crew member", async () => {
    const { api, calls } = setup();
    expect(await api.connect("xoxb-1", "xapp-1")).toEqual({
      teamId: "T1",
      teamName: "Harbor",
      botUserId: "UBOT",
    });
    expect(api.connected).toBe(true);
    expect(calls.map((c) => [c.method, c.auth])).toEqual([
      ["auth.test", "Bearer xoxb-1"],
      ["apps.connections.open", "Bearer xapp-1"],
    ]);
    expect(
      await api.postMessage("C1", {
        text: "hi",
        username: "Galley",
        iconEmoji: ":cook:",
        blocks: [],
      }),
    ).toBe("1.0001");
    const post = calls.at(-1)?.body;
    expect(post?.get("username")).toBe("Galley");
    expect(post?.get("icon_emoji")).toBe(":cook:");
    expect(post?.get("blocks")).toBe("[]");
    expect(post?.has("icon_url")).toBe(false);
    await api.disconnect();
    expect(api.connected).toBe(false);
  });

  it("names the token Slack rejected", async () => {
    await expect(
      setup({ "auth.test": { ok: false, error: "invalid_auth" } }).api.connect("xoxb-x", "xapp-x"),
    ).rejects.toThrow("Slack rejected the bot token (xoxb-…).");
    await expect(
      setup({ "apps.connections.open": { ok: false, error: "invalid_auth" } }).api.connect(
        "xoxb-x",
        "xapp-x",
      ),
    ).rejects.toThrow(/app-level token/);
  });

  it("turns envelopes into events, dropping Slack's retries of the same event", async () => {
    const { api, socket, events, responded } = setup();
    await api.connect("xoxb-1", "xapp-1");
    const message = {
      envelope_id: "e1",
      type: "events_api",
      payload: {
        event_id: "Ev1",
        event: {
          type: "message",
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          ts: "1.1",
          text: "hi",
        },
      },
    };
    socket.receive(message);
    socket.receive({ ...message, envelope_id: "e2", retry_attempt: 1 });
    expect(socket.sent).toEqual([
      JSON.stringify({ envelope_id: "e1" }),
      JSON.stringify({ envelope_id: "e2" }),
    ]);
    expect(events).toEqual([
      {
        type: "message",
        channelId: "C1",
        channelType: "channel",
        userId: "U1",
        ts: "1.1",
        text: "hi",
        botId: null,
        subtype: null,
      },
    ]);

    socket.receive({
      envelope_id: "e3",
      type: "slash_commands",
      payload: {
        command: "/shipmate",
        text: "link 123456",
        user_id: "U1",
        channel_id: "C1",
        response_url: "https://hooks.slack.test/cmd",
      },
    });
    socket.receive({
      envelope_id: "e4",
      type: "interactive",
      payload: {
        type: "block_actions",
        user: { id: "U1" },
        channel: { id: "C1" },
        container: { message_ts: "1.2" },
        actions: [{ action_id: "ap:x:allow" }],
        response_url: "https://hooks.slack.test/act",
      },
    });
    expect(events.slice(1).map((e) => e.type)).toEqual(["command", "button"]);
    const command = events[1];
    if (command?.type !== "command") throw new Error("expected a command");
    expect(command).toMatchObject({ userId: "U1", channelId: "C1", text: "link 123456" });
    await command.respond("Linked");
    expect(responded).toEqual([
      {
        url: "https://hooks.slack.test/cmd",
        body: { response_type: "ephemeral", replace_original: false, text: "Linked" },
      },
    ]);
    expect(events[2]).toMatchObject({ actionId: "ap:x:allow", messageTs: "1.2", userId: "U1" });
  });
});

describe("Slack formatting", () => {
  it("escapes and converts Markdown to mrkdwn outside code", () => {
    expect(escapeMrkdwn("<@U1> & <!here>")).toBe("&lt;@U1&gt; &amp; &lt;!here&gt;");
    expect(toMrkdwn("# Plan\n**Bold** and [docs](https://x.test/a?b=1&c=2)")).toBe(
      "*Plan*\n*Bold* and <https://x.test/a?b=1&amp;c=2|docs>",
    );
    expect(toMrkdwn("`**x** <y>`\n```\n**z**\n```")).toBe("`**x** &lt;y&gt;`\n```\n**z**\n```");
  });

  it("uses https images and :emoji: names as icons", () => {
    expect(slackIcon("https://img.test/a.png")).toEqual({ iconUrl: "https://img.test/a.png" });
    expect(slackIcon(":anchor:")).toEqual({ iconEmoji: ":anchor:" });
    expect(slackIcon("⚓")).toEqual({});
    expect(slackIcon(null)).toEqual({});
  });
});
