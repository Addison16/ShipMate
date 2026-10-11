import type { ApprovalDto, ServerEvent } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  approvalPath,
  approvalsReducer,
  initialApprovals,
  pendingFor,
  resolutionLabel,
} from "./approvals.js";
import { initialTimeline, timelineReducer } from "./timeline.js";

function approval(id: string, over: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id,
    conversationId: "c1",
    routineId: null,
    crew: { slug: "galley", name: "Galley" },
    toolName: "bash",
    summary: "rm -rf build",
    detail: '{\n  "command": "rm -rf build"\n}',
    createdAt: `2026-10-11T07:00:0${id.length}.000Z`,
    ...over,
  };
}

const ev = (event: ServerEvent) => ({ type: "event" as const, event });

describe("approvalsReducer", () => {
  it("adds requests once and removes them on resolution", () => {
    let s = approvalsReducer(
      initialApprovals,
      ev({ type: "approval_request", approval: approval("a") }),
    );
    s = approvalsReducer(s, ev({ type: "approval_request", approval: approval("a") }));
    expect(s.pending.map((a) => a.id)).toEqual(["a"]);
    s = approvalsReducer(s, { type: "answering", id: "a" });
    expect(s.answering).toEqual(["a"]);
    s = approvalsReducer(s, ev({ type: "approval_resolved", approvalId: "a", decision: "always" }));
    expect(s.pending).toEqual([]);
    expect(s.answering).toEqual([]);
    expect(s.resolved.a).toBe("always");
  });

  it("treats expiry as a resolution and ignores late requests for resolved ids", () => {
    let s = approvalsReducer(
      initialApprovals,
      ev({ type: "approval_request", approval: approval("a") }),
    );
    s = approvalsReducer(
      s,
      ev({ type: "approval_resolved", approvalId: "a", decision: "expired" }),
    );
    expect(s.resolved.a).toBe("expired");
    s = approvalsReducer(s, ev({ type: "approval_request", approval: approval("a") }));
    expect(s.pending).toEqual([]);
  });

  it("restore replaces the pending list, oldest first, and keeps answering only for pending ids", () => {
    let s = approvalsReducer(
      initialApprovals,
      ev({ type: "approval_request", approval: approval("x") }),
    );
    s = approvalsReducer(s, { type: "answering", id: "x" });
    s = approvalsReducer(s, { type: "restore", approvals: [approval("bbb"), approval("a")] });
    expect(s.pending.map((a) => a.id)).toEqual(["a", "bbb"]);
    expect(s.answering).toEqual([]);
  });

  it("answerFailed re-enables the card", () => {
    let s = approvalsReducer(
      initialApprovals,
      ev({ type: "approval_request", approval: approval("a") }),
    );
    s = approvalsReducer(s, { type: "answering", id: "a" });
    s = approvalsReducer(s, { type: "answerFailed", id: "a" });
    expect(s.answering).toEqual([]);
    expect(s.pending).toHaveLength(1);
  });

  it("ignores unrelated events", () => {
    const s = approvalsReducer(initialApprovals, ev({ type: "crew_changed" }));
    expect(s).toBe(initialApprovals);
  });
});

describe("approval helpers", () => {
  it("routes to the conversation or the watch", () => {
    expect(approvalPath(approval("a"))).toBe("/bridge/c1");
    expect(approvalPath(approval("a", { conversationId: null, routineId: "w1" }))).toBe(
      "/watches/w1",
    );
  });

  it("filters by conversation and labels outcomes", () => {
    const s = approvalsReducer(initialApprovals, {
      type: "restore",
      approvals: [approval("a"), approval("bb", { conversationId: "c2" })],
    });
    expect(pendingFor(s, "c2").map((a) => a.id)).toEqual(["bb"]);
    expect(resolutionLabel("always", "Galley")).toBe("Always allowed for Galley");
    expect(resolutionLabel(undefined, "Galley")).toMatch(/No longer waiting/);
  });
});

describe("timeline approval items", () => {
  it("places an approval for the open conversation where it arrived, once", () => {
    let s = timelineReducer(initialTimeline, { type: "open", conversationId: "c1" });
    s = timelineReducer(s, {
      type: "event",
      event: {
        type: "stream_start",
        conversationId: "c1",
        streamId: "s1",
        crew: { slug: "galley", name: "Galley" },
      },
    });
    const req: ServerEvent = { type: "approval_request", approval: approval("a") };
    s = timelineReducer(s, { type: "event", event: req });
    s = timelineReducer(s, { type: "event", event: req });
    s = timelineReducer(s, {
      type: "event",
      event: { type: "approval_request", approval: approval("b", { conversationId: "other" }) },
    });
    expect(s.items.map((it) => it.kind)).toEqual(["stream", "approval"]);
  });
});
