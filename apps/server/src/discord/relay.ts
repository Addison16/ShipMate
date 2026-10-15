import type { ApprovalDecision, ApprovalDto, ServerEvent } from "@shipmate/core";
import { loadPictures, type Picture, type ReadFile, replyPictures } from "../chat/pictures.js";
import {
  answerTyped,
  cardDetail,
  cardTitle,
  approvalButtons as chatButtons,
  decideCard,
  outcomeText,
  parseAction,
  type RelayApprovals,
  type TypedAnswer,
} from "../chat/relay.js";
import {
  type BotButton,
  DISCORD_FILE_LIMIT,
  DISCORD_FILES_PER_MESSAGE,
  type DiscordClientPort,
  type DiscordEvent,
  type DiscordWebhook,
} from "./port.js";
import { DISCORD_LIMIT, splitMessage } from "./split.js";

/** Discord's typing indicator lasts about ten seconds, so refresh it a little sooner. */
export const TYPING_REFRESH_MS = 8_000;
const DETAIL_LIMIT = 900;
const BUTTON_PREFIX = "shipmate:approval:";

/** Where a Shipmate conversation lives in Discord. */
export interface RelayTarget {
  channelId: string;
  /** The linked person the conversation belongs to; mentioned on replies. */
  discordUserId: string;
}

export interface RelayLookup {
  /** Null when the conversation is not a Discord one. */
  target(conversationId: string): Promise<RelayTarget | null>;
  /** The channel's webhook, so crew post under their own names; null to post as the bot. */
  webhook(channelId: string): Promise<DiscordWebhook | null>;
  /** The Shipmate user linked to this Discord account, reloaded each time. */
  userByDiscordId(discordUserId: string): Promise<{ id: string } | null>;
  userName(userId: string): Promise<string>;
  /** A stored file's bytes, for a reply's pictures; omit to post text only. */
  readFile?: ReadFile;
}

export type { RelayApprovals };

interface Card {
  conversationId: string;
  channelId: string;
  messageId: string;
  userId: string;
  userName: string;
  summary: string;
  crewName: string;
  /** A question's answers, in button order. */
  options?: string[];
}

type ButtonEvent = Extract<DiscordEvent, { type: "button" }>;

/**
 * Carries a person's Bridge events into Discord: crew replies through the channel's webhook,
 * typing while the crew works, hand-off lines, errors, and approval cards with buttons. Work
 * for one conversation runs in order, so a reply never overtakes the hand-off before it.
 */
export class DiscordRelay {
  #queues = new Map<string, Promise<void>>();
  #typing = new Map<string, NodeJS.Timeout>();
  /** Approval id → conversation id, recorded as soon as the request arrives. */
  #cardConversation = new Map<string, string>();
  #cards = new Map<string, Card>();

  constructor(
    private readonly port: DiscordClientPort,
    private readonly lookup: RelayLookup,
    private readonly approvals: RelayApprovals,
    private readonly log: (message: string, err?: unknown) => void = () => {},
  ) {}

  /** One of `userId`'s Bridge events. Never throws; Discord problems are logged. */
  handle(userId: string, event: ServerEvent): void {
    switch (event.type) {
      case "message": {
        const author = event.message.author;
        if (author.kind !== "crew") return;
        const text = event.message.content.trim() ? event.message.content : "";
        const read = this.lookup.readFile;
        const pictures = read ? replyPictures(event.message) : [];
        if (!text && !pictures.length) return;
        this.#withTarget(event.conversationId, async (t) => {
          if (text) await this.#post(t, author.name, text, true);
          if (!pictures.length || !read) return;
          const loaded = await loadPictures(userId, pictures, {
            read,
            maxBytes: DISCORD_FILE_LIMIT,
            log: this.log,
          });
          if (loaded.length) await this.#postPictures(t, author.name, loaded, !text);
        });
        return;
      }
      case "handoff": {
        const line = `_${event.from.name} asked ${event.to.name}: ${oneLine(event.task, 300)}_`;
        this.#withTarget(event.conversationId, (t) => this.#post(t, event.from.name, line, false));
        return;
      }
      case "status": {
        const id = event.conversationId;
        this.#enqueue(id, async () => {
          if (!event.busy) return this.#stopTyping(id);
          const t = await this.lookup.target(id);
          if (t) this.#startTyping(id, t.channelId);
        });
        return;
      }
      case "error": {
        const id = event.conversationId;
        if (!id) return;
        this.#withTarget(id, async (t) => {
          await this.port.sendBotMessage(t.channelId, {
            content: `⚠️ ${oneLine(event.message, 1800)}`,
            mentionUserIds: [],
          });
        });
        return;
      }
      case "approval_request": {
        const a = event.approval;
        if (!a.conversationId) return;
        const conversationId = a.conversationId;
        this.#cardConversation.set(a.id, conversationId);
        this.#withTarget(conversationId, async (t) => {
          const userName = await this.lookup.userName(userId);
          const card: Omit<Card, "messageId"> = {
            conversationId,
            channelId: t.channelId,
            userId,
            userName,
            summary: oneLine(cardTitle(a), 300),
            crewName: a.crew.name,
            ...(a.question ? { options: a.question.options.map((o) => o.label) } : {}),
          };
          const detail = cardDetail(a).replaceAll("```", "ʼʼʼ");
          const shown =
            detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}\n…` : detail;
          const body = a.question ? shown : `\`\`\`json\n${shown}\n\`\`\``;
          const messageId = await this.port.sendBotMessage(t.channelId, {
            content: `<@${t.discordUserId}> **${card.summary}**\n${body}`,
            mentionUserIds: [t.discordUserId],
            buttons: approvalButtons(a),
          });
          this.#cards.set(a.id, { ...card, messageId });
        });
        return;
      }
      case "approval_resolved": {
        const conversationId = this.#cardConversation.get(event.approvalId);
        if (!conversationId) return;
        // Queued behind the card's own post, so the card exists by the time this runs.
        this.#enqueue(conversationId, async () => {
          this.#cardConversation.delete(event.approvalId);
          const card = this.#cards.get(event.approvalId);
          if (!card) return;
          this.#cards.delete(event.approvalId);
          await this.#showOutcome(card, event.decision, event.answer);
        });
        return;
      }
      default:
        return;
    }
  }

  /** A crew member's words outside any conversation (a finished watch's result). */
  post(t: RelayTarget, username: string, text: string): void {
    this.#enqueue(`post:${t.channelId}`, () => this.#post(t, username, text, true));
  }

  /** A click on an approval card. Only the person the request belongs to may answer it. */
  async button(event: ButtonEvent): Promise<void> {
    if (!event.customId.startsWith(BUTTON_PREFIX)) return;
    const [approvalId, action] = event.customId.slice(BUTTON_PREFIX.length).split(":");
    const parsed = approvalId && action ? parseAction(action) : null;
    if (!approvalId || !parsed) return;
    const card = this.#cards.get(approvalId);
    if (!card) {
      await event.reply("This request is no longer waiting for an answer.");
      return;
    }
    const clicker = await this.lookup.userByDiscordId(event.userId);
    if (clicker?.id !== card.userId) {
      await event.reply(`Only ${card.userName} can answer this.`);
      return;
    }
    try {
      decideCard(this.approvals, card, approvalId, parsed);
    } catch {
      await event.reply("This request is no longer waiting for an answer.");
      return;
    }
    await event.acknowledge();
  }

  /** A typed "approve" or "deny" in a channel with approval cards; see ChatRelay.answer. */
  answer(channelId: string, userId: string, text: string): TypedAnswer {
    return answerTyped(
      [...this.#cards.entries()].filter(([, c]) => c.channelId === channelId),
      userId,
      text,
      (id, decision, answer) => this.approvals.decide(userId, id, decision, answer),
    );
  }

  /** Resolves when everything queued so far has been sent (tests). */
  async idle(): Promise<void> {
    while (this.#queues.size) await Promise.all([...this.#queues.values()]);
  }

  /** Stop typing and forget open approval cards (the bot disconnected). */
  stop(): void {
    for (const timer of this.#typing.values()) clearInterval(timer);
    this.#typing.clear();
    this.#cards.clear();
    this.#cardConversation.clear();
  }

  async #post(t: RelayTarget, username: string, text: string, mention: boolean) {
    const webhook = await this.lookup.webhook(t.channelId);
    const prefix = mention ? `<@${t.discordUserId}> ` : "";
    const label = webhook ? "" : `**${username}:** `;
    const chunks = splitMessage(text, DISCORD_LIMIT - prefix.length - label.length);
    for (const [i, chunk] of chunks.entries()) {
      const content = i === 0 ? `${prefix}${label}${chunk}` : chunk;
      const mentionUserIds = i === 0 && mention ? [t.discordUserId] : [];
      if (webhook) {
        await this.port.sendWebhook(webhook, { content, username, mentionUserIds });
      } else {
        await this.port.sendBotMessage(t.channelId, { content, mentionUserIds });
      }
    }
  }

  /** Pictures after the text, in as few messages as Discord's limits allow. */
  async #postPictures(t: RelayTarget, username: string, pictures: Picture[], alone: boolean) {
    const webhook = await this.lookup.webhook(t.channelId);
    const batches: Picture[][] = [];
    let size = 0;
    for (const p of pictures) {
      const last = batches.at(-1);
      if (
        last &&
        last.length < DISCORD_FILES_PER_MESSAGE &&
        size + p.data.length <= DISCORD_FILE_LIMIT
      ) {
        last.push(p);
        size += p.data.length;
      } else {
        batches.push([p]);
        size = p.data.length;
      }
    }
    for (const [i, batch] of batches.entries()) {
      // A picture-only reply addresses the person, like a text reply does.
      const mention = alone && i === 0;
      const label = webhook ? "" : `**${username}:**`;
      const content = [mention ? `<@${t.discordUserId}>` : "", i === 0 ? label : ""]
        .filter(Boolean)
        .join(" ");
      const mentionUserIds = mention ? [t.discordUserId] : [];
      const files = batch.map((p) => ({ name: p.name, data: p.data }));
      if (webhook) {
        await this.port.sendWebhook(webhook, { content, username, mentionUserIds, files });
      } else {
        await this.port.sendBotMessage(t.channelId, { content, mentionUserIds, files });
      }
    }
  }

  async #showOutcome(card: Card, decision: ApprovalDecision | "expired", answer?: string) {
    const outcome = outcomeText(card, decision, answer);
    await this.port.editBotMessage(card.channelId, card.messageId, {
      content: `**${card.summary}**\n${outcome}`,
      mentionUserIds: [],
      buttons: [],
    });
  }

  #startTyping(conversationId: string, channelId: string) {
    if (this.#typing.has(conversationId)) return;
    const tick = () => {
      this.port.typing(channelId).catch((err) => this.log("typing failed", err));
    };
    tick();
    const timer = setInterval(tick, TYPING_REFRESH_MS);
    timer.unref?.();
    this.#typing.set(conversationId, timer);
  }

  #stopTyping(conversationId: string) {
    clearInterval(this.#typing.get(conversationId));
    this.#typing.delete(conversationId);
  }

  #withTarget(conversationId: string, run: (t: RelayTarget) => Promise<void>) {
    this.#enqueue(conversationId, async () => {
      const t = await this.lookup.target(conversationId);
      if (t) await run(t);
    });
  }

  #enqueue(key: string, run: () => Promise<void>) {
    const next = (this.#queues.get(key) ?? Promise.resolve())
      .then(run)
      .catch((err) => this.log("could not post to Discord", err));
    this.#queues.set(key, next);
    void next.then(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
  }
}

/** The same buttons as the chat relays, as Discord components (custom ids under 100 chars). */
export function approvalButtons(
  a: Pick<ApprovalDto, "id" | "crew" | "question" | "everyTime">,
): BotButton[] {
  return chatButtons(a).map((b) => ({
    // `ap:<id>:<action>` → `shipmate:approval:<id>:<action>`
    customId: `${BUTTON_PREFIX}${b.actionId.slice(b.actionId.indexOf(":") + 1)}`,
    label: b.label.slice(0, 80),
    style: a.question
      ? b.decision === "deny"
        ? "secondary"
        : "primary"
      : b.decision === "allow"
        ? "success"
        : b.decision === "deny"
          ? "danger"
          : "primary",
  }));
}

function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
