import type { ApprovalDecision, ApprovalDto, ServerEvent } from "@shipmate/core";

/**
 * Pure state for pending tool approvals across the whole app. Pending cards come from
 * `approval_request` events and from GET /api/approvals (on load and after a reconnect); they
 * leave on `approval_resolved` (here, on another tab, or expired). Resolutions are remembered so
 * an inline card in a thread can show how it ended.
 */

export type Resolution = ApprovalDecision | "expired";

export interface ApprovalsState {
  /** Oldest first. */
  pending: ApprovalDto[];
  /** Ids the person has answered here and that are waiting for the server to confirm. */
  answering: string[];
  /** How each approval seen in this session ended. */
  resolved: Record<string, Resolution>;
}

export type ApprovalsAction =
  | { type: "restore"; approvals: ApprovalDto[] }
  | { type: "event"; event: ServerEvent }
  | { type: "answering"; id: string }
  | { type: "answerFailed"; id: string }
  | { type: "resolved"; id: string; decision: Resolution };

export const initialApprovals: ApprovalsState = { pending: [], answering: [], resolved: {} };

function byCreated(a: ApprovalDto, b: ApprovalDto): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

function resolve(state: ApprovalsState, id: string, decision: Resolution): ApprovalsState {
  return {
    pending: state.pending.filter((a) => a.id !== id),
    answering: state.answering.filter((x) => x !== id),
    resolved: { ...state.resolved, [id]: decision },
  };
}

export function approvalsReducer(state: ApprovalsState, action: ApprovalsAction): ApprovalsState {
  switch (action.type) {
    case "restore": {
      // The server's list is the truth for what is pending; anything we held that it no longer
      // lists was decided elsewhere or expired while we were away (outcome unknown).
      const ids = new Set(action.approvals.map((a) => a.id));
      return {
        ...state,
        pending: [...action.approvals].sort(byCreated),
        answering: state.answering.filter((id) => ids.has(id)),
      };
    }
    case "answering":
      if (state.answering.includes(action.id)) return state;
      return { ...state, answering: [...state.answering, action.id] };
    case "answerFailed":
      return { ...state, answering: state.answering.filter((x) => x !== action.id) };
    case "resolved":
      return resolve(state, action.id, action.decision);
    case "event": {
      const ev = action.event;
      if (ev.type === "approval_request") {
        if (state.resolved[ev.approval.id]) return state;
        if (state.pending.some((a) => a.id === ev.approval.id)) {
          return {
            ...state,
            pending: state.pending.map((a) => (a.id === ev.approval.id ? ev.approval : a)),
          };
        }
        return { ...state, pending: [...state.pending, ev.approval].sort(byCreated) };
      }
      if (ev.type === "approval_resolved") return resolve(state, ev.approvalId, ev.decision);
      return state;
    }
    default:
      return state;
  }
}

/** Where to go to answer an approval: its conversation, or the watch that raised it. */
export function approvalPath(a: ApprovalDto): string {
  if (a.conversationId) return `/bridge/${a.conversationId}`;
  if (a.routineId) return `/watches/${a.routineId}`;
  return "/watches";
}

/** Pending approvals for one conversation. */
export function pendingFor(state: ApprovalsState, conversationId: string): ApprovalDto[] {
  return state.pending.filter((a) => a.conversationId === conversationId);
}

export function resolutionLabel(
  r: Resolution | undefined,
  crewName: string,
  everyTime = false,
): string {
  switch (r) {
    case "allow":
      return everyTime ? "Approved" : "Allowed once";
    case "always":
      return `Always allowed for ${crewName}`;
    case "deny":
      return everyTime ? "Declined" : "Denied";
    case "expired":
      return "Expired without an answer";
    default:
      return "No longer waiting (answered elsewhere or expired)";
  }
}
