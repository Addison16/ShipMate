import type {
  TelegramChatInfo,
  TelegramChatKind,
  TelegramEvent,
  TelegramIdentity,
  TelegramOutgoing,
  TelegramPort,
} from "./port.js";
import { TelegramError } from "./port.js";

/**
 * An in-memory Telegram for tests: chats it knows, a record of everything the bot sent, and
 * helpers that simulate people writing and pressing buttons.
 */
export class FakeTelegramPort implements TelegramPort {
  static readonly TOKEN = "123456789:AAFakeTelegramTokenForTests_000";
  readonly me: TelegramIdentity = {
    id: "123456789",
    username: "shipmate_test_bot",
    name: "Shipmate",
  };
  connected = false;
  chats = new Map<string, TelegramChatInfo>();
  sent: (TelegramOutgoing & { chatId: string; id: number })[] = [];
  edits: (TelegramOutgoing & { chatId: string; messageId: number })[] = [];
  answers: { callbackId: string; text: string | null }[] = [];
  deleted: { chatId: string; messageId: number }[] = [];
  typingCalls: string[] = [];
  #handler: (event: TelegramEvent) => void = () => {};
  #seq = 100;

  async connect(token: string): Promise<TelegramIdentity> {
    if (token !== FakeTelegramPort.TOKEN)
      throw new TelegramError("Telegram rejected the bot token.");
    this.connected = true;
    return this.me;
  }
  async disconnect() {
    this.connected = false;
  }
  listen(handler: (event: TelegramEvent) => void) {
    this.#handler = handler;
  }
  async sendMessage(chatId: string, message: TelegramOutgoing) {
    this.#seq += 1;
    this.sent.push({ ...message, chatId, id: this.#seq });
    return this.#seq;
  }
  async editMessage(chatId: string, messageId: number, message: TelegramOutgoing) {
    this.edits.push({ ...message, chatId, messageId });
  }
  async answerCallback(callbackId: string, text: string | null) {
    this.answers.push({ callbackId, text });
  }
  async deleteMessage(chatId: string, messageId: number) {
    this.deleted.push({ chatId, messageId });
  }
  async typing(chatId: string) {
    this.typingCalls.push(chatId);
  }
  async chatInfo(chatId: string) {
    return this.chats.get(chatId) ?? null;
  }

  // ---------- simulating people ----------

  addChat(id: string, title: string, kind: TelegramChatKind = "supergroup") {
    this.chats.set(id, { id, title, kind });
    return id;
  }

  /** Someone writes in a chat. Returns the message id. */
  message(chatId: string, fromId: string, text: string, options: { bot?: boolean } = {}): number {
    this.#seq += 1;
    const chat = this.chats.get(chatId);
    this.#handler({
      type: "message",
      chatId,
      chatKind: chat?.kind ?? (chatId.startsWith("-") ? "supergroup" : "private"),
      chatTitle: chat?.title ?? `chat ${chatId}`,
      messageId: this.#seq,
      fromId,
      fromIsBot: options.bot ?? false,
      text,
    });
    return this.#seq;
  }

  /** A button press; resolves with the notice shown to the presser (null for a plain ack). */
  press(fromId: string, chatId: string, messageId: number, data: string): Promise<string | null> {
    this.#seq += 1;
    const callbackId = `cb${this.#seq}`;
    this.#handler({ type: "callback", callbackId, fromId, chatId, messageId, data });
    return new Promise((resolve) => {
      const check = () => {
        const a = this.answers.find((x) => x.callbackId === callbackId);
        if (a) resolve(a.text);
        else setTimeout(check, 5);
      };
      check();
    });
  }

  /** Polling died (e.g. the token was revoked). */
  drop(error: string) {
    this.connected = false;
    this.#handler({ type: "disconnected", error });
  }
}
