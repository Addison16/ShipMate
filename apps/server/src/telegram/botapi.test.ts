import { describe, expect, it } from "vitest";
import { TelegramBotApi } from "./botapi.js";
import { escapeHtml, toTelegramHtml } from "./format.js";
import type { TelegramEvent } from "./port.js";

type Answer = object | ((params: Record<string, unknown>) => object | Promise<object>);

function setup(answers: Record<string, Answer[]>) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").at(-1) ?? "";
    const params =
      init?.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    calls.push({ method, params });
    const queue = answers[method] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) {
      // Hold the long poll open until the test disconnects.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const body = typeof next === "function" ? await next(params) : next;
    return Response.json(body);
  }) as typeof fetch;
  const api = new TelegramBotApi({
    fetch: fetchStub,
    apiBase: "https://tg.test",
    backoffMs: () => 5,
  });
  const events: TelegramEvent[] = [];
  api.listen((e) => events.push(e));
  return { api, calls, events };
}

const me = { ok: true, result: { id: 42, username: "ship_bot", first_name: "Shipmate" } };
const until = async (check: () => boolean) => {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("TelegramBotApi", () => {
  it("polls getUpdates, advancing the offset past each update", async () => {
    const { api, calls, events } = setup({
      getMe: [me],
      deleteWebhook: [{ ok: true, result: true }],
      getUpdates: [
        {
          ok: true,
          result: [
            {
              update_id: 10,
              message: {
                message_id: 1,
                chat: { id: -100, type: "supergroup", title: "Deck" },
                from: { id: 7, is_bot: false },
                text: "hi",
              },
            },
            {
              update_id: 11,
              callback_query: {
                id: "cb",
                from: { id: 7 },
                data: "ap:x:allow",
                message: { message_id: 2, chat: { id: -100 } },
              },
            },
          ],
        },
        { ok: false, error_code: 502, description: "Bad Gateway" },
        // Then hold the poll open.
      ],
    });
    // After the error, later polls hang until disconnect.
    expect(await api.connect("1:abc")).toEqual({
      id: "42",
      username: "ship_bot",
      name: "Shipmate",
    });
    await until(() => calls.filter((c) => c.method === "getUpdates").length >= 3);
    const polls = calls.filter((c) => c.method === "getUpdates");
    expect(polls[0]?.params).toMatchObject({
      offset: 0,
      allowed_updates: ["message", "callback_query"],
    });
    expect(polls[1]?.params.offset).toBe(12);
    expect(polls[2]?.params.offset).toBe(12);
    expect(events).toEqual([
      {
        type: "message",
        chatId: "-100",
        chatKind: "supergroup",
        chatTitle: "Deck",
        messageId: 1,
        fromId: "7",
        fromIsBot: false,
        text: "hi",
      },
      {
        type: "callback",
        callbackId: "cb",
        fromId: "7",
        chatId: "-100",
        messageId: 2,
        data: "ap:x:allow",
      },
    ]);
    await api.disconnect();
    expect(api.connected).toBe(false);
  });

  it("rejects a bad token, and stops polling when the token is revoked", async () => {
    const bad = setup({ getMe: [{ ok: false, error_code: 401, description: "Unauthorized" }] });
    await expect(bad.api.connect("1:bad")).rejects.toThrow("Telegram rejected the bot token.");

    const revoked = setup({
      getMe: [me],
      deleteWebhook: [{ ok: true, result: true }],
      getUpdates: [{ ok: false, error_code: 401, description: "Unauthorized" }],
    });
    await revoked.api.connect("1:abc");
    await until(() => revoked.events.length > 0);
    expect(revoked.events).toEqual([
      { type: "disconnected", error: "Telegram rejected the bot token." },
    ]);
    expect(revoked.api.connected).toBe(false);
  });

  it("sends HTML with inline buttons and replies", async () => {
    const { api, calls } = setup({
      getMe: [me],
      deleteWebhook: [{ ok: true, result: true }],
      sendMessage: [{ ok: true, result: { message_id: 99 } }],
    });
    await api.connect("1:abc");
    const id = await api.sendMessage("-100", {
      html: "<b>Captain</b>\nhi",
      buttons: [[{ text: "Allow once", data: "ap:x:allow" }]],
      replyTo: 5,
    });
    expect(id).toBe(99);
    expect(calls.find((c) => c.method === "sendMessage")?.params).toMatchObject({
      chat_id: "-100",
      text: "<b>Captain</b>\nhi",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Allow once", callback_data: "ap:x:allow" }]] },
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
    });
    await api.disconnect();
  });

  it("uploads photos as multipart, and sends a photo Telegram turns down as a document", async () => {
    const { api, calls } = setup({
      getMe: [me],
      deleteWebhook: [{ ok: true, result: true }],
      sendPhoto: [
        { ok: true, result: { message_id: 7 } },
        { ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" },
      ],
      sendDocument: [{ ok: true, result: { message_id: 8 } }],
    });
    await api.connect("1:abc");
    const file = { name: "chart.png", mimeType: "image/png", data: Buffer.from([1, 2, 3]) };
    expect(
      await api.sendFile("-100", file, { as: "photo", captionHtml: "<b>Captain</b>", replyTo: 5 }),
    ).toBe(7);
    const photo = calls.find((c) => c.method === "sendPhoto")?.params ?? {};
    expect(photo).toMatchObject({ chat_id: "-100", caption: "<b>Captain</b>", parse_mode: "HTML" });
    expect(JSON.parse(String(photo.reply_parameters))).toEqual({
      message_id: 5,
      allow_sending_without_reply: true,
    });
    const blob = photo.photo as File;
    expect(blob.name).toBe("chart.png");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(file.data);

    expect(await api.sendFile("-100", file, { as: "photo" })).toBe(8);
    const doc = calls.find((c) => c.method === "sendDocument")?.params ?? {};
    expect((doc.document as File).name).toBe("chart.png");
    expect(doc.photo).toBeUndefined();
    await api.disconnect();
  });
});

describe("Telegram formatting", () => {
  it("escapes everything, then renders code and bold", () => {
    expect(escapeHtml("<a href='x'>&</a>")).toBe("&lt;a href='x'&gt;&amp;&lt;/a&gt;");
    expect(toTelegramHtml("<script> & **bold** `x<y`")).toBe(
      "&lt;script&gt; &amp; <b>bold</b> <code>x&lt;y</code>",
    );
    expect(toTelegramHtml("Run:\n```bash\necho **hi** <ok>\n```\ndone")).toBe(
      "Run:\n<pre>echo **hi** &lt;ok&gt;</pre>\ndone",
    );
    // An unclosed fence stays plain text.
    expect(toTelegramHtml("```oops <b>")).toBe("```oops &lt;b&gt;");
  });
});
