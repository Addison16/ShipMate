import type {
  BridgeLinkCode,
  TelegramChatDto,
  TelegramSeenChatDto,
  TelegramStatusDto,
} from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import { conversations, type Db, telegramChats, users } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import {
  BridgeListeners,
  BridgeStore,
  bridgeLog,
  deliver,
  LinkedAccounts,
  outcomeText,
} from "../chat/core.js";
import {
  type ApprovalButton,
  type ApprovalCard,
  ChatRelay,
  type ChatSink,
  type ChatTarget,
} from "../chat/relay.js";
import { splitMessage } from "../chat/split.js";
import type { ApprovalService } from "../services/approvals.js";
import type { CrewService } from "../services/crew.js";
import { escapeHtml, TELEGRAM_LIMIT, toTelegramHtml } from "./format.js";
import {
  TelegramError,
  type TelegramEvent,
  type TelegramIdentity,
  type TelegramPort,
} from "./port.js";

const BOT_REF = "telegram:bot";
/** Telegram's typing indicator lasts five seconds. */
export const TELEGRAM_TYPING_MS = 4_500;
const SEEN_MAX = 20;

export const TELEGRAM_LINK_HINT =
  "I don't know who you are yet. In Shipmate, open Chat bridges → Telegram (under Manage), press “Get a link code”, then send /link with the code here.";
export const TELEGRAM_UNMAPPED =
  "This chat is not connected to a crew member yet. A Shipmate admin can connect it on the Telegram page.";

export interface TelegramServiceDeps {
  db: Db;
  vault: SecretVault;
  crew: CrewService;
  bridge: Bridge;
  approvals: ApprovalService;
  port: TelegramPort;
  log?: (message: string, err?: unknown) => void;
}

type MessageEvent = Extract<TelegramEvent, { type: "message" }>;

/**
 * The Telegram bridge: one bot per instance over long polling. Each chat (group or DM) is
 * mapped to a crew member (DMs default to the Captain); since the bot has one name, replies
 * start with the speaking crew member's name. Messages from linked people become turns in a
 * conversation per chat and person; their Bridge events come back through a ChatRelay.
 */
export class TelegramService {
  readonly relay: ChatRelay;
  readonly accounts: LinkedAccounts;
  readonly #store: BridgeStore;
  readonly #listeners: BridgeListeners;
  readonly #log: (message: string, err?: unknown) => void;
  #me: TelegramIdentity | null = null;
  #error: string | null = null;
  /** Chat id → crew slug. */
  #chats = new Map<string, string>();
  #seen = new Map<string, TelegramSeenChatDto>();
  #targets = new Map<string, ChatTarget | null>();
  /** "chat:person" → the person's latest message in a group, so replies quote it. */
  #lastMessage = new Map<string, number>();
  #hinted = new Set<string>();
  #toldUnmapped = new Set<string>();
  #lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TelegramServiceDeps) {
    this.#log = deps.log ?? bridgeLog("telegram");
    this.#store = new BridgeStore(deps.db, deps.vault);
    this.accounts = new LinkedAccounts(deps.db, "telegramUserId", "Telegram");
    this.relay = new ChatRelay(
      this.#sink(),
      {
        target: (id) => this.#target(id),
        userByExternalId: (id) => this.accounts.user(id),
        userName: (id) => this.#userName(id),
      },
      deps.approvals,
      { log: this.#log, typingRefreshMs: TELEGRAM_TYPING_MS },
    );
    this.#listeners = new BridgeListeners(deps.bridge, (userId, event) =>
      this.relay.handle(userId, event),
    );
    deps.port.listen((event) => {
      this.#onEvent(event).catch((err) => this.#log(`could not handle a ${event.type}`, err));
    });
  }

  // ---------- lifecycle ----------

  /** Start polling if a bot token is stored. Problems end up in status().error, never thrown. */
  start(): Promise<void> {
    return this.#serial(() => this.#connect());
  }

  stop(): Promise<void> {
    return this.#serial(() => this.#disconnect());
  }

  async #connect(): Promise<void> {
    await this.#disconnect();
    this.#error = null;
    const token = await this.#store.secret(BOT_REF);
    if (!token) return;
    try {
      this.#me = await this.deps.port.connect(token);
      await this.#loadChats();
      for (const id of await this.accounts.linkedUserIds()) this.#listeners.listen(id);
    } catch (err) {
      this.#error = plain(err);
      this.#log("could not connect", err);
      await this.#disconnect();
    }
  }

  async #disconnect(): Promise<void> {
    this.#listeners.clear();
    this.relay.stop();
    this.#me = null;
    await this.deps.port.disconnect().catch((err) => this.#log("disconnect failed", err));
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(run, run);
    this.#lock = next.catch(() => {});
    return next;
  }

  // ---------- settings ----------

  async status(): Promise<TelegramStatusDto> {
    const names = new Map((await this.deps.crew.list(true)).map((c) => [c.slug, c.name]));
    const rows = await this.deps.db.select().from(telegramChats);
    const chats: TelegramChatDto[] = rows.map((r) => ({
      chatId: r.chatId,
      title: r.title,
      crewSlug: r.crewSlug,
      crewName: names.get(r.crewSlug) ?? r.crewSlug,
    }));
    const username = this.#me?.username || null;
    return {
      configured: await this.#store.hasSecret(BOT_REF),
      connected: this.deps.port.connected,
      botUsername: username,
      botUrl: username ? `https://t.me/${username}` : null,
      error: this.#error,
      chats,
      seenChats: [...this.#seen.values()].filter((c) => !this.#chats.has(c.chatId)).reverse(),
    };
  }

  /** Store a new token, then reconnect. */
  async configure(botToken: string): Promise<TelegramStatusDto> {
    const token = botToken.trim();
    if (!/^\d+:[\w-]{20,}$/.test(token)) {
      throw new HttpError(400, "botToken: paste the token BotFather gave you (123456:ABC…)");
    }
    await this.#store.putSecret(BOT_REF, token);
    await this.#serial(() => this.#connect());
    return this.status();
  }

  /** Stop polling and forget the token. Chat mappings and links stay. */
  async forget(): Promise<void> {
    await this.#serial(async () => {
      await this.#disconnect();
      await this.#store.deleteSecret(BOT_REF);
      this.#error = null;
    });
  }

  /** Map a chat to a crew member, or unmap it with null. */
  async mapChat(chatId: string, slug: string | null): Promise<TelegramStatusDto> {
    if (slug === null) {
      await this.deps.db.delete(telegramChats).where(eq(telegramChats.chatId, chatId));
    } else {
      const crew = await this.deps.crew.row(slug);
      if (crew.status === "retired") throw new HttpError(400, `${crew.name} has retired.`);
      let title = this.#seen.get(chatId)?.title ?? null;
      if (this.deps.port.connected) {
        const info = await this.deps.port.chatInfo(chatId).catch(() => null);
        if (!info && !title) {
          throw new HttpError(
            400,
            "The bot cannot see that chat. Add the bot to the group (or message it) first.",
          );
        }
        title = info?.title ?? title;
      }
      const values = { crewSlug: crew.slug, title, updatedAt: new Date() };
      await this.deps.db
        .insert(telegramChats)
        .values({ chatId, ...values })
        .onConflictDoUpdate({ target: telegramChats.chatId, set: values });
    }
    await this.#loadChats();
    return this.status();
  }

  async #loadChats() {
    const rows = await this.deps.db.select().from(telegramChats);
    this.#chats = new Map(rows.map((r) => [r.chatId, r.crewSlug]));
  }

  // ---------- linking ----------

  issueLinkCode(user: UserRow): BridgeLinkCode {
    const { code, expiresAt } = this.accounts.codes.issue(user.id);
    const bot = this.#me?.username;
    const where = bot
      ? `to @${bot} in Telegram (or open https://t.me/${bot}?start=${code})`
      : "to the Shipmate bot in Telegram";
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      instructions: `Send /link ${code} ${where}. The code works once, for 10 minutes.`,
    };
  }

  async unlink(user: UserRow): Promise<void> {
    await this.accounts.unlink(user.id);
    this.#listeners.drop(user.id);
  }

  async linkFromTelegram(telegramUserId: string, code: string): Promise<string> {
    const { reply, user } = await this.accounts.link(telegramUserId, code);
    if (user) {
      this.#hinted.delete(telegramUserId);
      if (this.deps.port.connected) this.#listeners.listen(user.id);
    }
    return reply;
  }

  // ---------- Telegram events ----------

  async #onEvent(event: TelegramEvent): Promise<void> {
    switch (event.type) {
      case "message":
        return this.#onMessage(event);
      case "callback": {
        const reply = await this.relay.click(event.fromId, event.data);
        await this.deps.port.answerCallback(event.callbackId, reply);
        return;
      }
      case "disconnected": {
        await this.#serial(() => this.#disconnect());
        this.#error = event.error ?? "Lost the connection to Telegram.";
        return;
      }
    }
  }

  async #onMessage(m: MessageEvent): Promise<void> {
    if (m.fromIsBot) return;
    const port = this.deps.port;
    const reply = (text: string) =>
      port.sendMessage(m.chatId, { html: escapeHtml(text), replyTo: m.messageId });
    let text = m.text.trim();

    const command = /^\/([a-z_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text);
    if (command) {
      const [, name = "", bot, rest = ""] = command;
      // A command meant for another bot in the same group.
      if (bot && this.#me && bot.toLowerCase() !== this.#me.username.toLowerCase()) return;
      const arg = rest.trim();
      const code = /^(?:link[-_]?)?(\d{6})$/i.exec(arg)?.[1];
      if ((name === "link" || name === "start") && code) {
        const answer = await this.linkFromTelegram(m.fromId, code);
        if (m.chatKind !== "private") {
          await port.deleteMessage(m.chatId, m.messageId).catch(() => {});
        }
        await port.sendMessage(m.chatId, { html: escapeHtml(answer) });
        return;
      }
      if (name === "link") {
        await reply("Send /link followed by the six-digit code from Shipmate.");
        return;
      }
      if (name === "start" || name === "help") {
        const linked = await this.accounts.user(m.fromId);
        await reply(
          linked
            ? `Hello ${linked.displayName}. Write here and the crew will answer.`
            : TELEGRAM_LINK_HINT,
        );
        if (!linked) this.#hinted.add(m.fromId);
        return;
      }
      // Any other command is passed on as text.
      text = `/${name}${arg ? ` ${arg}` : ""}`;
    }

    const slug = this.#chats.get(m.chatId) ?? (m.chatKind === "private" ? CAPTAIN_SLUG : null);
    if (!this.#chats.has(m.chatId)) this.#remember(m);
    if (!slug) {
      if (this.#toldUnmapped.has(m.chatId)) return;
      this.#toldUnmapped.add(m.chatId);
      await port.sendMessage(m.chatId, { html: escapeHtml(TELEGRAM_UNMAPPED) });
      return;
    }

    const user = await this.accounts.user(m.fromId);
    if (!user) {
      if (this.#hinted.has(m.fromId)) return;
      this.#hinted.add(m.fromId);
      await reply(TELEGRAM_LINK_HINT);
      return;
    }
    if (!text) return;

    const typed = this.relay.answer(m.chatId, user.id, text);
    if (typed.handled) {
      if (typed.reply) await reply(typed.reply);
      return;
    }

    const outcome = await deliver(this.deps, {
      user,
      slug,
      text,
      surface: "telegram",
      // The crew member is part of the key: remapping a chat starts a fresh conversation.
      externalId: `${m.chatId}:${m.fromId}:${slug}`,
      title: (name) => `Telegram: ${name}`,
      onConversation: (id) => {
        this.#targets.set(id, { chatId: m.chatId, externalUserId: m.fromId });
        if (m.chatKind !== "private") this.#lastMessage.set(`${m.chatId}:${m.fromId}`, m.messageId);
      },
    });
    if (outcome.kind === "sent") return;
    if (outcome.kind === "failed" && outcome.serverError) this.#log("send failed", outcome.message);
    await reply(outcome.kind === "busy" ? `⏳ ${outcomeText(outcome)}` : outcomeText(outcome));
  }

  #remember(m: MessageEvent) {
    this.#seen.delete(m.chatId);
    this.#seen.set(m.chatId, { chatId: m.chatId, title: m.chatTitle, kind: m.chatKind });
    while (this.#seen.size > SEEN_MAX) {
      const oldest = this.#seen.keys().next().value;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
  }

  // ---------- posting ----------

  #sink(): ChatSink {
    const port = this.deps.port;
    const quoteFor = (t: ChatTarget) => this.#lastMessage.get(`${t.chatId}:${t.externalUserId}`);
    return {
      postCrew: async (t, crew, text, mention) => {
        const label = `<b>${escapeHtml(crew.name)}</b>\n`;
        const replyTo = mention ? quoteFor(t) : undefined;
        const chunks = splitMessage(text, TELEGRAM_LIMIT - crew.name.length - 1);
        for (const [i, chunk] of chunks.entries()) {
          await port.sendMessage(t.chatId, {
            html: `${i === 0 ? label : ""}${toTelegramHtml(chunk)}`,
            ...(i === 0 && replyTo ? { replyTo } : {}),
          });
        }
      },
      postHandoff: async (t, from, to, task) => {
        await port.sendMessage(t.chatId, {
          html: `<i>${escapeHtml(`${from.name} asked ${to.name}: ${task}`)}</i>`,
        });
      },
      postError: async (t, message) => {
        await port.sendMessage(t.chatId, { html: `⚠️ ${escapeHtml(message)}` });
      },
      postApproval: async (t, card: ApprovalCard) => {
        const button = (b: ApprovalButton) => ({ text: b.label, data: b.actionId });
        const allow = card.buttons.find((b) => b.decision === "allow");
        const always = card.buttons.find((b) => b.decision === "always");
        const deny = card.buttons.find((b) => b.decision === "deny");
        const replyTo = quoteFor(t);
        const id = await port.sendMessage(t.chatId, {
          // A question's choices read as text, so no <pre> block around them.
          html: card.question
            ? `<b>${escapeHtml(card.summary)}</b>\n${escapeHtml(card.detail)}`
            : `<b>${escapeHtml(card.summary)}</b>\n<pre>${escapeHtml(card.detail)}</pre>`,
          buttons: card.question
            ? card.buttons.map((b) => [button(b)])
            : [
                [allow, deny].filter((b) => b !== undefined).map(button),
                always ? [button(always)] : [],
              ].filter((row) => row.length > 0),
          ...(replyTo ? { replyTo } : {}),
        });
        return String(id);
      },
      resolveApproval: async (chatId, ref, summary, outcome) => {
        await port.editMessage(chatId, Number(ref), {
          html: `<b>${escapeHtml(summary)}</b>\n${escapeHtml(outcome)}`,
          buttons: [],
        });
      },
      typing: (chatId) => port.typing(chatId),
    };
  }

  // ---------- lookups ----------

  async #target(conversationId: string): Promise<ChatTarget | null> {
    if (this.#targets.has(conversationId)) return this.#targets.get(conversationId) ?? null;
    const [c] = await this.deps.db
      .select({ surface: conversations.surface, externalId: conversations.externalId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    let target: ChatTarget | null = null;
    if (c?.surface === "telegram" && c.externalId) {
      const [chatId, externalUserId] = c.externalId.split(":");
      if (chatId && externalUserId) target = { chatId, externalUserId };
    }
    this.#targets.set(conversationId, target);
    return target;
  }

  async #userName(id: string): Promise<string> {
    const [u] = await this.deps.db.select().from(users).where(eq(users.id, id)).limit(1);
    return u?.displayName ?? "the person who asked";
  }
}

function plain(err: unknown): string {
  if (err instanceof TelegramError) return err.message;
  return `Telegram request failed: ${err instanceof Error ? err.message : String(err)}`;
}
