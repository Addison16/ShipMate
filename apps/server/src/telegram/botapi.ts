import {
  type TelegramChatInfo,
  type TelegramChatKind,
  TelegramError,
  type TelegramEvent,
  type TelegramFile,
  type TelegramFileOptions,
  type TelegramIdentity,
  type TelegramOutgoing,
  type TelegramPort,
} from "./port.js";

/** An error answer from the Bot API, with its code. */
export class TelegramApiError extends TelegramError {
  constructor(
    readonly code: number,
    message: string,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
  }
}

interface ApiAnswer<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface RawChat {
  id: number;
  type: TelegramChatKind;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface RawUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: RawChat;
    from?: { id: number; is_bot: boolean };
    text?: string;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

export interface BotApiOptions {
  fetch?: typeof fetch;
  /** Default https://api.telegram.org. */
  apiBase?: string;
  /** Long-poll timeout in seconds (default 25). */
  pollTimeout?: number;
  /** Wait before polling again after the n-th failure in a row. */
  backoffMs?: (attempt: number) => number;
}

const MAX_RETRY_AFTER_S = 30;

/**
 * The Telegram Bot API over fetch: getUpdates long polling (works behind NAT, no public URL),
 * and sendMessage and friends with parse_mode HTML. Flood-control answers (429) are waited out
 * once for sends; polling backs off on errors and stops only when the token is rejected.
 */
export class TelegramBotApi implements TelegramPort {
  connected = false;
  #token = "";
  #offset = 0;
  #abort: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #handler: (event: TelegramEvent) => void = () => {};
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #pollTimeout: number;
  readonly #backoff: (attempt: number) => number;

  constructor(options: BotApiOptions = {}) {
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#base = (options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
    this.#pollTimeout = options.pollTimeout ?? 25;
    this.#backoff = options.backoffMs ?? ((n) => Math.min(60_000, 1_000 * 2 ** Math.min(n, 6)));
  }

  listen(handler: (event: TelegramEvent) => void) {
    this.#handler = handler;
  }

  async connect(token: string): Promise<TelegramIdentity> {
    await this.disconnect();
    this.#token = token;
    let me: { id: number; username?: string; first_name: string };
    try {
      me = await this.#call("getMe");
    } catch (err) {
      if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
        throw new TelegramError("Telegram rejected the bot token.");
      }
      throw err;
    }
    // Long polling and a webhook cannot both be on.
    await this.#call("deleteWebhook", { drop_pending_updates: false });
    this.connected = true;
    const abort = new AbortController();
    this.#abort = abort;
    this.#loop = this.#poll(abort.signal);
    return { id: String(me.id), username: me.username ?? "", name: me.first_name };
  }

  async disconnect() {
    this.connected = false;
    this.#abort?.abort();
    this.#abort = null;
    await this.#loop?.catch(() => {});
    this.#loop = null;
  }

  async sendMessage(chatId: string, message: TelegramOutgoing): Promise<number> {
    const sent = await this.#send<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      ...body(message),
      ...(message.replyTo
        ? { reply_parameters: { message_id: message.replyTo, allow_sending_without_reply: true } }
        : {}),
    });
    return sent.message_id;
  }

  async sendFile(chatId: string, file: TelegramFile, options: TelegramFileOptions) {
    const form = new FormData();
    form.set("chat_id", chatId);
    if (options.captionHtml) {
      form.set("caption", options.captionHtml);
      form.set("parse_mode", "HTML");
    }
    if (options.replyTo) {
      form.set(
        "reply_parameters",
        JSON.stringify({ message_id: options.replyTo, allow_sending_without_reply: true }),
      );
    }
    const blob = new Blob([new Uint8Array(file.data)], { type: file.mimeType });
    if (options.as === "photo") {
      form.set("photo", blob, file.name);
      try {
        return (await this.#send<{ message_id: number }>("sendPhoto", form)).message_id;
      } catch (err) {
        if (!(err instanceof TelegramApiError && err.code === 400)) throw err;
        form.delete("photo");
      }
    }
    form.set("document", blob, file.name);
    return (await this.#send<{ message_id: number }>("sendDocument", form)).message_id;
  }

  async editMessage(chatId: string, messageId: number, message: TelegramOutgoing) {
    await this.#send("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      ...body(message),
    });
  }

  async answerCallback(callbackId: string, text: string | null) {
    await this.#send("answerCallbackQuery", {
      callback_query_id: callbackId,
      ...(text ? { text, show_alert: false } : {}),
    });
  }

  async deleteMessage(chatId: string, messageId: number) {
    await this.#send("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async typing(chatId: string) {
    await this.#send("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async chatInfo(chatId: string): Promise<TelegramChatInfo | null> {
    try {
      const chat = await this.#call<RawChat>("getChat", { chat_id: chatId });
      return { id: String(chat.id), title: chatTitle(chat), kind: chat.type };
    } catch (err) {
      if (err instanceof TelegramApiError && (err.code === 400 || err.code === 403)) return null;
      throw err;
    }
  }

  // ---------- polling ----------

  async #poll(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.#call<RawUpdate[]>(
          "getUpdates",
          {
            offset: this.#offset,
            timeout: this.#pollTimeout,
            allowed_updates: ["message", "callback_query"],
          },
          signal,
        );
        failures = 0;
        for (const u of updates) {
          this.#offset = Math.max(this.#offset, u.update_id + 1);
          const event = toEvent(u);
          if (event) this.#emit(event);
        }
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramApiError && err.code === 401) {
          this.connected = false;
          this.#emit({ type: "disconnected", error: "Telegram rejected the bot token." });
          return;
        }
        const wait =
          err instanceof TelegramApiError && err.retryAfter
            ? err.retryAfter * 1000
            : this.#backoff(failures);
        failures += 1;
        await sleep(wait, signal);
      }
    }
  }

  #emit(event: TelegramEvent) {
    try {
      this.#handler(event);
    } catch {
      // The listener logs its own problems.
    }
  }

  // ---------- HTTP ----------

  /** A call that waits out flood control (429) once. */
  async #send<T>(method: string, params: Record<string, unknown> | FormData): Promise<T> {
    try {
      return await this.#call<T>(method, params);
    } catch (err) {
      if (
        err instanceof TelegramApiError &&
        err.code === 429 &&
        err.retryAfter !== null &&
        err.retryAfter <= MAX_RETRY_AFTER_S
      ) {
        await sleep(err.retryAfter * 1000);
        return this.#call<T>(method, params);
      }
      throw err;
    }
  }

  async #call<T>(
    method: string,
    params: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
  ) {
    let res: Response;
    // FormData sets its own multipart content type.
    const form = params instanceof FormData;
    try {
      res = await this.#fetch(`${this.#base}/bot${this.#token}/${method}`, {
        method: "POST",
        ...(form ? {} : { headers: { "content-type": "application/json" } }),
        body: form ? params : JSON.stringify(params),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TelegramError(
        `Could not reach Telegram: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let answer: ApiAnswer<T>;
    try {
      answer = (await res.json()) as ApiAnswer<T>;
    } catch {
      throw new TelegramApiError(res.status, `Telegram answered ${res.status}.`);
    }
    if (!answer.ok || answer.result === undefined) {
      throw new TelegramApiError(
        answer.error_code ?? res.status,
        `Telegram: ${answer.description ?? `error ${res.status}`}`,
        answer.parameters?.retry_after ?? null,
      );
    }
    return answer.result;
  }
}

function body(message: TelegramOutgoing) {
  return {
    text: message.html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(message.buttons
      ? {
          reply_markup: {
            inline_keyboard: message.buttons.map((row) =>
              row.map((b) => ({ text: b.text, callback_data: b.data })),
            ),
          },
        }
      : {}),
  };
}

function chatTitle(chat: RawChat): string {
  return (
    chat.title ??
    ([chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
      chat.username ||
      String(chat.id))
  );
}

export function toEvent(u: RawUpdate): TelegramEvent | null {
  const m = u.message;
  if (m?.from) {
    return {
      type: "message",
      chatId: String(m.chat.id),
      chatKind: m.chat.type,
      chatTitle: chatTitle(m.chat),
      messageId: m.message_id,
      fromId: String(m.from.id),
      fromIsBot: m.from.is_bot,
      text: m.text ?? m.caption ?? "",
    };
  }
  const q = u.callback_query;
  if (q) {
    return {
      type: "callback",
      callbackId: q.id,
      fromId: String(q.from.id),
      chatId: q.message ? String(q.message.chat.id) : null,
      messageId: q.message?.message_id ?? null,
      data: q.data ?? "",
    };
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
