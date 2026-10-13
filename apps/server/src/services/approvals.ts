import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalDto, QuestionDto, ServerEvent } from "@shipmate/core";
import type { ApprovalAnswer } from "@shipmate/crew";
import { HttpError } from "../auth.js";
import { summarize } from "../summarize.js";

/** How long a consequential call waits for a person before it is denied. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

interface Pending {
  dto: ApprovalDto;
  userId: string;
  resolve: (answer: ApprovalAnswer, text?: string) => void;
  timer: NodeJS.Timeout;
}

/** How a question ended: the person's answer, or null when they skipped it or it expired. */
export type QuestionAnswer = string | null;

/** Longest answer kept from a person's own words. */
const ANSWER_LIMIT = 2000;

/**
 * Pending approvals live in memory: each one holds a paused tool call. They go to the person
 * who started the turn (or owns the watch), on every tab they have open.
 */
export class ApprovalService {
  #pending = new Map<string, Pending>();

  constructor(
    private readonly emit: (userId: string, event: ServerEvent) => void,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
  ) {}

  request(input: {
    userId: string;
    conversationId: string | null;
    watchId: string | null;
    crew: { slug: string; name: string };
    toolName: string;
    args: Record<string, unknown>;
    /** A plainer line for the card than the tool name and arguments. */
    summary?: string;
    /** Asked every time: the card offers Approve and Decline only. */
    everyTime?: boolean;
  }): Promise<ApprovalAnswer> {
    const dto: ApprovalDto = {
      id: randomUUID(),
      conversationId: input.conversationId,
      routineId: input.watchId,
      crew: input.crew,
      toolName: input.toolName,
      summary:
        input.summary ??
        `${input.crew.name} wants to run ${input.toolName}${summaryOf(input.args)}`,
      detail: JSON.stringify(input.args, null, 2).slice(0, 20_000),
      ...(input.everyTime ? { everyTime: true } : {}),
      createdAt: new Date().toISOString(),
    };
    return new Promise<ApprovalAnswer>((resolve) => this.#wait(dto, input.userId, resolve));
  }

  /**
   * A crew member's question with answer buttons (`ask_person`). Resolves with the answer, or
   * null when the person skips it, presses Stop, or it expires.
   */
  ask(input: {
    userId: string;
    conversationId: string | null;
    watchId: string | null;
    crew: { slug: string; name: string };
    question: QuestionDto;
  }): Promise<QuestionAnswer> {
    const dto: ApprovalDto = {
      id: randomUUID(),
      conversationId: input.conversationId,
      routineId: input.watchId,
      crew: input.crew,
      toolName: "ask_person",
      summary: input.question.text,
      detail: input.question.options
        .map((o) => `- ${o.label}${o.detail ? `: ${o.detail}` : ""}`)
        .join("\n"),
      question: input.question,
      createdAt: new Date().toISOString(),
    };
    return new Promise<QuestionAnswer>((resolve) =>
      this.#wait(dto, input.userId, (answer, text) =>
        resolve(answer === "deny" ? null : (text ?? null)),
      ),
    );
  }

  #wait(dto: ApprovalDto, userId: string, resolve: Pending["resolve"]) {
    const timer = setTimeout(() => this.#settle(dto.id, "deny", "expired"), this.timeoutMs);
    timer.unref?.();
    this.#pending.set(dto.id, { dto, userId, resolve, timer });
    this.emit(userId, { type: "approval_request", approval: dto });
  }

  list(userId: string): ApprovalDto[] {
    return [...this.#pending.values()].filter((p) => p.userId === userId).map((p) => p.dto);
  }

  /** Who a pending approval belongs to, or null when it is not waiting (any more). */
  ownerOf(id: string): string | null {
    return this.#pending.get(id)?.userId ?? null;
  }

  /** `answer` answers a question (required to answer one with "allow"); tool calls ignore it. */
  decide(userId: string, id: string, decision: ApprovalDecision, answer?: string): void {
    const p = this.#pending.get(id);
    if (!p || p.userId !== userId) throw new HttpError(404, "no pending approval with that id");
    if (!p.dto.question || decision === "deny") {
      this.#settle(id, decision, decision);
      return;
    }
    const text = answer?.trim().slice(0, ANSWER_LIMIT);
    if (!text) throw new HttpError(400, "pick an answer or type one");
    this.#settle(id, "allow", "allow", text);
  }

  /** Deny everything waiting in a conversation (the person pressed Stop). */
  cancelConversation(conversationId: string): void {
    for (const p of [...this.#pending.values()]) {
      if (p.dto.conversationId === conversationId) this.#settle(p.dto.id, "deny", "deny");
    }
  }

  hasPendingFor(watchOrConversationId: string): boolean {
    return [...this.#pending.values()].some(
      (p) =>
        p.dto.conversationId === watchOrConversationId || p.dto.routineId === watchOrConversationId,
    );
  }

  close(): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, "deny", "expired");
  }

  #settle(id: string, answer: ApprovalAnswer, shown: ApprovalDecision | "expired", text?: string) {
    const p = this.#pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    this.emit(p.userId, {
      type: "approval_resolved",
      approvalId: id,
      decision: shown,
      ...(text !== undefined ? { answer: text } : {}),
    });
    p.resolve(answer, text);
  }
}

function summaryOf(args: Record<string, unknown>): string {
  const s = summarize(args);
  return s ? `: ${s}` : "";
}
