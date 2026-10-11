import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalDto, ServerEvent } from "@shipmate/core";
import type { ApprovalAnswer } from "@shipmate/crew";
import { HttpError } from "../auth.js";
import { summarize } from "../summarize.js";

/** How long a consequential call waits for a person before it is denied. */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;

interface Pending {
  dto: ApprovalDto;
  userId: string;
  resolve: (answer: ApprovalAnswer) => void;
  timer: NodeJS.Timeout;
}

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
  }): Promise<ApprovalAnswer> {
    const dto: ApprovalDto = {
      id: randomUUID(),
      conversationId: input.conversationId,
      routineId: input.watchId,
      crew: input.crew,
      toolName: input.toolName,
      summary: `${input.crew.name} wants to run ${input.toolName}${summaryOf(input.args)}`,
      detail: JSON.stringify(input.args, null, 2).slice(0, 20_000),
      createdAt: new Date().toISOString(),
    };
    return new Promise<ApprovalAnswer>((resolve) => {
      const timer = setTimeout(() => this.#settle(dto.id, "deny", "expired"), this.timeoutMs);
      timer.unref?.();
      this.#pending.set(dto.id, { dto, userId: input.userId, resolve, timer });
      this.emit(input.userId, { type: "approval_request", approval: dto });
    });
  }

  list(userId: string): ApprovalDto[] {
    return [...this.#pending.values()].filter((p) => p.userId === userId).map((p) => p.dto);
  }

  /** Who a pending approval belongs to, or null when it is not waiting (any more). */
  ownerOf(id: string): string | null {
    return this.#pending.get(id)?.userId ?? null;
  }

  decide(userId: string, id: string, decision: ApprovalDecision): void {
    const p = this.#pending.get(id);
    if (!p || p.userId !== userId) throw new HttpError(404, "no pending approval with that id");
    this.#settle(id, decision, decision);
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

  #settle(id: string, answer: ApprovalAnswer, shown: ApprovalDecision | "expired") {
    const p = this.#pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(id);
    this.emit(p.userId, { type: "approval_resolved", approvalId: id, decision: shown });
    p.resolve(answer);
  }
}

function summaryOf(args: Record<string, unknown>): string {
  const s = summarize(args);
  return s ? `: ${s}` : "";
}
