import type { ApprovalDecision, ServerEvent } from "@shipmate/core";

/** Where a Shipmate conversation lives in a chat app. */
export interface ChatTarget {
  /** The chat or channel id. */
  chatId: string;
  /** The linked person's account id on that surface. */
  externalUserId: string;
}

export interface CrewRef {
  slug: string;
  name: string;
}

export interface ApprovalButton {
  /** Opaque id the chat app sends back on a click (see approvalActionId). */
  actionId: string;
  label: string;
  decision: ApprovalDecision;
}

export interface ApprovalCard {
  /** One line, already shortened. */
  summary: string;
  /** The tool input, shortened, with code fences defused. */
  detail: string;
  crewName: string;
  buttons: ApprovalButton[];
}

/** How one chat app shows the relay's posts. Each method may throw; the relay logs it. */
export interface ChatSink {
  /** A crew member's words; `mention` addresses the person on the first piece. */
  postCrew(t: ChatTarget, crew: CrewRef, text: string, mention: boolean): Promise<void>;
  postHandoff(t: ChatTarget, from: CrewRef, to: CrewRef, task: string): Promise<void>;
  postError(t: ChatTarget, message: string): Promise<void>;
  /** Returns a reference to the posted card (a message id), for editing it later. */
  postApproval(t: ChatTarget, card: ApprovalCard): Promise<string>;
  /** Replace the card with its outcome and remove the buttons. */
  resolveApproval(
    chatId: string,
    messageRef: string,
    summary: string,
    outcome: string,
  ): Promise<void>;
  /** Show "typing…"; omit when the app has no such thing for bots. */
  typing?(chatId: string): Promise<void>;
}

export interface ChatRelayLookup {
  /** Null when the conversation does not live on this surface. */
  target(conversationId: string): Promise<ChatTarget | null>;
  /** The Shipmate user linked to this account, reloaded each time. */
  userByExternalId(externalUserId: string): Promise<{ id: string } | null>;
  userName(userId: string): Promise<string>;
}

export interface RelayApprovals {
  decide(userId: string, approvalId: string, decision: ApprovalDecision): void;
}

const ACTION_PREFIX = "ap:";
const DETAIL_LIMIT = 900;

/** Short enough for Telegram's 64-byte callback data. */
export const approvalActionId = (approvalId: string, decision: ApprovalDecision) =>
  `${ACTION_PREFIX}${approvalId}:${decision}`;

interface Card {
  chatId: string;
  messageRef: string;
  userId: string;
  userName: string;
  summary: string;
  crewName: string;
}

/**
 * Carries a person's Bridge events into a chat app (Telegram, Slack): crew replies, typing
 * while the crew works, hand-off lines, errors, and approval cards with buttons. Work for one
 * conversation runs in order, so a reply never overtakes the hand-off before it. The Discord
 * bridge has its own relay with webhook specifics; this is the same flow behind a ChatSink.
 */
export class ChatRelay {
  #queues = new Map<string, Promise<void>>();
  #typing = new Map<string, NodeJS.Timeout>();
  #cardConversation = new Map<string, string>();
  #cards = new Map<string, Card>();

  constructor(
    private readonly sink: ChatSink,
    private readonly lookup: ChatRelayLookup,
    private readonly approvals: RelayApprovals,
    private readonly options: {
      log?: (message: string, err?: unknown) => void;
      /** How often to refresh the typing indicator. */
      typingRefreshMs?: number;
    } = {},
  ) {}

  /** One of `userId`'s Bridge events. Never throws; chat app problems are logged. */
  handle(userId: string, event: ServerEvent): void {
    switch (event.type) {
      case "message": {
        const author = event.message.author;
        if (author.kind !== "crew" || !event.message.content.trim()) return;
        const crew = { slug: author.slug, name: author.name };
        this.#withTarget(event.conversationId, (t) =>
          this.sink.postCrew(t, crew, event.message.content, true),
        );
        return;
      }
      case "handoff":
        this.#withTarget(event.conversationId, (t) =>
          this.sink.postHandoff(t, event.from, event.to, oneLine(event.task, 300)),
        );
        return;
      case "status": {
        const id = event.conversationId;
        this.#enqueue(id, async () => {
          if (!event.busy) return this.#stopTyping(id);
          const t = await this.lookup.target(id);
          if (t) this.#startTyping(id, t.chatId);
        });
        return;
      }
      case "error": {
        const id = event.conversationId;
        if (!id) return;
        this.#withTarget(id, (t) => this.sink.postError(t, oneLine(event.message, 1800)));
        return;
      }
      case "approval_request": {
        const a = event.approval;
        if (!a.conversationId) return;
        const conversationId = a.conversationId;
        this.#cardConversation.set(a.id, conversationId);
        this.#withTarget(conversationId, async (t) => {
          const userName = await this.lookup.userName(userId);
          const summary = oneLine(a.summary, 300);
          const detail = a.detail.replaceAll("```", "ʼʼʼ");
          const shown =
            detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}\n…` : detail;
          const messageRef = await this.sink.postApproval(t, {
            summary,
            detail: shown,
            crewName: a.crew.name,
            buttons: approvalButtons(a.id, a.crew.name),
          });
          this.#cards.set(a.id, {
            chatId: t.chatId,
            messageRef,
            userId,
            userName,
            summary,
            crewName: a.crew.name,
          });
        });
        return;
      }
      case "approval_resolved": {
        const conversationId = this.#cardConversation.get(event.approvalId);
        if (!conversationId) return;
        this.#enqueue(conversationId, async () => {
          this.#cardConversation.delete(event.approvalId);
          const card = this.#cards.get(event.approvalId);
          if (!card) return;
          this.#cards.delete(event.approvalId);
          await this.sink.resolveApproval(
            card.chatId,
            card.messageRef,
            card.summary,
            outcomeLine(card, event.decision),
          );
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * A click on an approval card by `externalUserId`. Returns what to tell the clicker, or null
   * when the answer was taken (or the click was not on an approval card).
   */
  async click(externalUserId: string, actionId: string): Promise<string | null> {
    if (!actionId.startsWith(ACTION_PREFIX)) return null;
    const [approvalId, decision] = actionId.slice(ACTION_PREFIX.length).split(":");
    if (!approvalId || (decision !== "allow" && decision !== "always" && decision !== "deny")) {
      return null;
    }
    const card = this.#cards.get(approvalId);
    if (!card) return "This request is no longer waiting for an answer.";
    const clicker = await this.lookup.userByExternalId(externalUserId);
    if (clicker?.id !== card.userId) return `Only ${card.userName} can answer this.`;
    try {
      this.approvals.decide(card.userId, approvalId, decision);
    } catch {
      return "This request is no longer waiting for an answer.";
    }
    return null;
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

  #startTyping(conversationId: string, chatId: string) {
    const typing = this.sink.typing?.bind(this.sink);
    if (!typing || this.#typing.has(conversationId)) return;
    const tick = () => {
      typing(chatId).catch((err) => this.options.log?.("typing failed", err));
    };
    tick();
    const timer = setInterval(tick, this.options.typingRefreshMs ?? 4_000);
    timer.unref?.();
    this.#typing.set(conversationId, timer);
  }

  #stopTyping(conversationId: string) {
    clearInterval(this.#typing.get(conversationId));
    this.#typing.delete(conversationId);
  }

  #withTarget(conversationId: string, run: (t: ChatTarget) => Promise<void>) {
    this.#enqueue(conversationId, async () => {
      const t = await this.lookup.target(conversationId);
      if (t) await run(t);
    });
  }

  #enqueue(key: string, run: () => Promise<void>) {
    const next = (this.#queues.get(key) ?? Promise.resolve())
      .then(run)
      .catch((err) => this.options.log?.("could not post", err));
    this.#queues.set(key, next);
    void next.then(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
  }
}

export function approvalButtons(approvalId: string, crewName: string): ApprovalButton[] {
  return [
    { actionId: approvalActionId(approvalId, "allow"), label: "Allow once", decision: "allow" },
    {
      actionId: approvalActionId(approvalId, "always"),
      label: `Always allow for ${crewName}`.slice(0, 60),
      decision: "always",
    },
    { actionId: approvalActionId(approvalId, "deny"), label: "Deny", decision: "deny" },
  ];
}

function outcomeLine(card: Card, decision: ApprovalDecision | "expired"): string {
  return {
    allow: `✅ ${card.userName} allowed it once.`,
    always: `✅ ${card.userName} always allows this for ${card.crewName}.`,
    deny: `⛔ ${card.userName} denied it.`,
    expired: "⌛ Nobody answered in time, so it was denied.",
  }[decision];
}

export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
