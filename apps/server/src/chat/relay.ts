import type { ApprovalDecision, ApprovalDto, ServerEvent } from "@shipmate/core";

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
  /** For a question, "allow" is one of its answers and "deny" skips it. */
  decision: ApprovalDecision;
}

export interface ApprovalCard {
  /** One line, already shortened. */
  summary: string;
  /** The tool input (or a question's numbered choices), shortened, with code fences defused. */
  detail: string;
  crewName: string;
  buttons: ApprovalButton[];
  /** A crew member's question: one button per answer, then Skip. */
  question?: boolean;
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
  decide(userId: string, approvalId: string, decision: ApprovalDecision, answer?: string): void;
}

const ACTION_PREFIX = "ap:";
const DETAIL_LIMIT = 900;

/**
 * Short enough for Telegram's 64-byte callback data. A question's answers are `o0`, `o1`, ...
 */
export const approvalActionId = (approvalId: string, decision: ApprovalDecision | `o${number}`) =>
  `${ACTION_PREFIX}${approvalId}:${decision}`;

interface Card {
  chatId: string;
  messageRef: string;
  userId: string;
  userName: string;
  summary: string;
  crewName: string;
  /** A question's answers, in button order. */
  options?: string[];
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
          const summary = oneLine(cardTitle(a), 300);
          const detail = cardDetail(a).replaceAll("```", "ʼʼʼ");
          const shown =
            detail.length > DETAIL_LIMIT ? `${detail.slice(0, DETAIL_LIMIT)}\n…` : detail;
          const messageRef = await this.sink.postApproval(t, {
            summary,
            detail: shown,
            crewName: a.crew.name,
            buttons: approvalButtons(a),
            ...(a.question ? { question: true } : {}),
          });
          this.#cards.set(a.id, {
            chatId: t.chatId,
            messageRef,
            userId,
            userName,
            summary,
            crewName: a.crew.name,
            ...(a.question ? { options: a.question.options.map((o) => o.label) } : {}),
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
            outcomeText(card, event.decision, event.answer),
          );
        });
        return;
      }
      default:
        return;
    }
  }

  /** A crew member's words outside any conversation (a finished watch's result). */
  post(t: ChatTarget, crew: CrewRef, text: string): void {
    this.#enqueue(`post:${t.chatId}`, () => this.sink.postCrew(t, crew, text, false));
  }

  /**
   * A click on an approval card by `externalUserId`. Returns what to tell the clicker, or null
   * when the answer was taken (or the click was not on an approval card).
   */
  async click(externalUserId: string, actionId: string): Promise<string | null> {
    if (!actionId.startsWith(ACTION_PREFIX)) return null;
    const [approvalId, action] = actionId.slice(ACTION_PREFIX.length).split(":");
    const parsed = approvalId && action ? parseAction(action) : null;
    if (!approvalId || !parsed) return null;
    const card = this.#cards.get(approvalId);
    if (!card) return "This request is no longer waiting for an answer.";
    const clicker = await this.lookup.userByExternalId(externalUserId);
    if (clicker?.id !== card.userId) return `Only ${card.userName} can answer this.`;
    try {
      decideCard(this.approvals, card, approvalId, parsed);
    } catch {
      return "This request is no longer waiting for an answer.";
    }
    return null;
  }

  /**
   * A typed answer ("approve", "deny", "always") from `userId` in `chatId`, where approval cards
   * may be waiting. Answers the newest card of theirs there. Not handled when the text is not an
   * answer or no card waits in the chat, so it goes to the crew as usual.
   */
  answer(chatId: string, userId: string, text: string): TypedAnswer {
    return answerTyped(
      [...this.#cards.entries()].filter(([, c]) => c.chatId === chatId),
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

export type TypedAnswer = { handled: false } | { handled: true; reply: string | null };

/**
 * Words people type to answer an approval card. Only read while a card waits in that chat; the
 * crew member is paused on it then, so "yes" or "no" there can only mean the card.
 */
export function parseApprovalReply(text: string): ApprovalDecision | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/^[!/]/, "")
    .replace(/[.!\s]+$/, "");
  if (/^(approve|approved|allow|allow once|yes|y|ok|okay|go ahead|👍|✅)$/u.test(t)) return "allow";
  if (/^(deny|denied|no|n|reject|decline|don't|dont|👎|⛔|❌)$/u.test(t)) return "deny";
  if (/^(always|always allow|approve always)$/.test(t)) return "always";
  return null;
}

/**
 * What typed text means for a question card: a choice's number or label picks it, "skip"
 * skips, and anything else is the person's own answer (the crew member is paused on it).
 */
export function parseQuestionReply(
  text: string,
  options: readonly string[],
): { decision: "allow"; answer: string } | { decision: "deny" } {
  const t = text.trim();
  const plain = t.toLowerCase().replace(/[.!\s]+$/, "");
  if (/^[!/]?skip$/.test(plain)) return { decision: "deny" };
  const n = /^\d$/.test(plain) ? Number(plain) : 0;
  const picked = options[n - 1] ?? options.find((o) => o.toLowerCase() === plain);
  return { decision: "allow", answer: picked ?? t };
}

/** Shared by the chat relays: answer the newest of the person's cards among `cards`. */
export function answerTyped<C extends { userId: string; options?: string[] }>(
  cards: Array<[string, C]>,
  userId: string,
  text: string,
  decide: (approvalId: string, decision: ApprovalDecision, answer?: string) => void,
): TypedAnswer {
  // Shared channels hold one conversation per person: someone else's "ok" or "no" is a
  // message to their own crew conversation, not an answer to this person's card.
  const mine = cards.filter(([, c]) => c.userId === userId);
  const newest = mine[mine.length - 1];
  if (!newest) return { handled: false };
  const options = newest[1].options;
  const reply = options ? parseQuestionReply(text, options) : null;
  const decision = reply?.decision ?? parseApprovalReply(text);
  if (!decision) return { handled: false };
  try {
    decide(newest[0], decision, reply && "answer" in reply ? reply.answer : undefined);
  } catch {
    return { handled: true, reply: "This request is no longer waiting for an answer." };
  }
  // The card itself changes to show the outcome.
  return { handled: true, reply: null };
}

export function approvalButtons(
  a: Pick<ApprovalDto, "id" | "crew" | "question" | "everyTime">,
): ApprovalButton[] {
  if (a.question) {
    return [
      ...a.question.options.map((o, i) => ({
        actionId: approvalActionId(a.id, `o${i}`),
        label: o.label.slice(0, 60),
        decision: "allow" as const,
      })),
      { actionId: approvalActionId(a.id, "deny"), label: "Skip", decision: "deny" },
    ];
  }
  if (a.everyTime) {
    return [
      { actionId: approvalActionId(a.id, "allow"), label: "Approve", decision: "allow" },
      { actionId: approvalActionId(a.id, "deny"), label: "Decline", decision: "deny" },
    ];
  }
  return [
    { actionId: approvalActionId(a.id, "allow"), label: "Allow once", decision: "allow" },
    {
      actionId: approvalActionId(a.id, "always"),
      label: `Always allow for ${a.crew.name}`.slice(0, 60),
      decision: "always",
    },
    { actionId: approvalActionId(a.id, "deny"), label: "Deny", decision: "deny" },
  ];
}

/** The card's heading: the request, or "<crew> asks: <question>". */
export function cardTitle(a: Pick<ApprovalDto, "summary" | "crew" | "question">): string {
  return a.question ? `❓ ${a.crew.name} asks: ${a.question.text}` : a.summary;
}

/** The card's body: the tool input, or the question's numbered choices. */
export function cardDetail(a: Pick<ApprovalDto, "detail" | "question">): string {
  if (!a.question) return a.detail;
  return [
    ...a.question.options.map((o, i) => `${i + 1}. ${o.label}${o.detail ? ` (${o.detail})` : ""}`),
    "Tap one, or type your own answer.",
  ].join("\n");
}

/** A button's action: allow/always/deny, or a question's answer by index. */
export function parseAction(action: string): ApprovalDecision | { option: number } | null {
  if (action === "allow" || action === "always" || action === "deny") return action;
  const m = /^o(\d)$/.exec(action);
  return m ? { option: Number(m[1]) } : null;
}

/** Answer a card from a click; throws when it is no longer waiting. */
export function decideCard(
  approvals: RelayApprovals,
  card: { userId: string; options?: string[] },
  approvalId: string,
  action: ApprovalDecision | { option: number },
): void {
  if (typeof action === "string") {
    approvals.decide(card.userId, approvalId, action);
    return;
  }
  const answer = card.options?.[action.option];
  if (answer === undefined) throw new Error("no such answer");
  approvals.decide(card.userId, approvalId, "allow", answer);
}

export function outcomeText(
  card: { userName: string; crewName: string; options?: string[] },
  decision: ApprovalDecision | "expired",
  answer?: string,
): string {
  if (card.options) {
    if (decision === "expired") return "⌛ Nobody answered in time.";
    if (decision === "deny") return `⏭️ ${card.userName} skipped this.`;
    return `💬 ${card.userName}: ${oneLine(answer ?? "", 300)}`;
  }
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
