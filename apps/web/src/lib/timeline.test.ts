import type { MessageDto, ServerEvent } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  initialTimeline,
  type TimelineAction,
  type TimelineState,
  timelineReducer,
} from "./timeline.js";

const CID = "c1";
const captain = { slug: "captain", name: "Captain" };
const galley = { slug: "galley", name: "Galley" };

function run(events: ServerEvent[], start?: TimelineState): TimelineState {
  let s = start ?? timelineReducer(initialTimeline, { type: "open", conversationId: CID });
  for (const event of events) s = timelineReducer(s, { type: "event", event } as TimelineAction);
  return s;
}

function crewMessage(
  id: string,
  crew: { slug: string; name: string },
  content: string,
  meta: MessageDto["meta"] = null,
): MessageDto {
  return {
    id,
    conversationId: CID,
    role: "assistant",
    content,
    author: { kind: "crew", ...crew },
    meta,
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

describe("timelineReducer", () => {
  it("accumulates deltas and tool chips per stream", () => {
    const s = run([
      { type: "status", conversationId: CID, busy: true },
      { type: "stream_start", conversationId: CID, streamId: "s1", crew: captain },
      { type: "delta", conversationId: CID, streamId: "s1", text: "Hel" },
      {
        type: "tool",
        conversationId: CID,
        streamId: "s1",
        phase: "start",
        toolCallId: "t1",
        toolName: "web_fetch",
        summary: "example.com",
      },
      {
        type: "tool",
        conversationId: CID,
        streamId: "s1",
        phase: "end",
        toolCallId: "t1",
        toolName: "web_fetch",
        summary: "404",
        isError: true,
      },
      { type: "delta", conversationId: CID, streamId: "s1", text: "lo" },
    ]);
    expect(s.busy).toBe(true);
    expect(s.items).toHaveLength(1);
    const item = s.items[0];
    expect(item?.kind).toBe("stream");
    if (item?.kind !== "stream") return;
    expect(item.text).toBe("Hello");
    expect(item.tools).toEqual([
      { id: "t1", name: "web_fetch", summary: "404", running: false, isError: true },
    ]);
  });

  it("ignores events for other conversations", () => {
    const s = run([
      { type: "stream_start", conversationId: "other", streamId: "x", crew: captain },
      { type: "status", conversationId: "other", busy: true },
    ]);
    expect(s.items).toEqual([]);
    expect(s.busy).toBe(false);
  });

  it("replaces a finished stream with the persisted message in place", () => {
    const s = run([
      { type: "stream_start", conversationId: CID, streamId: "s1", crew: captain },
      { type: "delta", conversationId: CID, streamId: "s1", text: "Asking Galley" },
      { type: "stream_end", conversationId: CID, streamId: "s1" },
      { type: "handoff", conversationId: CID, from: captain, to: galley, task: "plan dinner" },
      { type: "stream_start", conversationId: CID, streamId: "s2", crew: galley },
      { type: "delta", conversationId: CID, streamId: "s2", text: "Pasta" },
      {
        type: "message",
        conversationId: CID,
        message: crewMessage("m1", captain, "Asking Galley"),
      },
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["message", "handoff", "stream"]);
    expect(s.items[0]?.key).toBe("m:m1");
  });

  it("drops the live hand-off line when the persisted reply carries its own", () => {
    const s = run([
      { type: "handoff", conversationId: CID, from: captain, to: galley, task: "plan dinner" },
      { type: "stream_start", conversationId: CID, streamId: "s2", crew: galley },
      { type: "stream_end", conversationId: CID, streamId: "s2" },
      {
        type: "message",
        conversationId: CID,
        message: crewMessage("m2", galley, "Pasta", {
          handoff: { from: captain, to: galley, task: "plan dinner" },
        }),
      },
    ]);
    expect(s.items.map((i) => i.key)).toEqual(["m:m2"]);
  });

  it("dedupes messages already loaded and keeps live items after a load", () => {
    let s = timelineReducer(initialTimeline, { type: "open", conversationId: CID });
    s = run(
      [{ type: "message", conversationId: CID, message: crewMessage("m1", captain, "hi") }],
      s,
    );
    s = timelineReducer(s, {
      type: "loaded",
      conversationId: CID,
      messages: [crewMessage("m0", captain, "older"), crewMessage("m1", captain, "hi")],
    });
    expect(s.items.map((i) => i.key)).toEqual(["m:m0", "m:m1"]);
    s = run(
      [{ type: "message", conversationId: CID, message: crewMessage("m1", captain, "hi") }],
      s,
    );
    expect(s.items).toHaveLength(2);
  });

  it("marks open streams done when the conversation goes idle", () => {
    const s = run([
      { type: "status", conversationId: CID, busy: true },
      { type: "stream_start", conversationId: CID, streamId: "s1", crew: captain },
      { type: "delta", conversationId: CID, streamId: "s1", text: "Half a reply" },
      { type: "stream_start", conversationId: CID, streamId: "s2", crew: galley },
      { type: "status", conversationId: CID, busy: false },
    ]);
    expect(s.busy).toBe(false);
    // The stream with text stays, finished; the one that never said anything goes.
    expect(s.items).toHaveLength(1);
    expect(s.items[0]?.kind === "stream" && s.items[0].done).toBe(true);
  });

  it("drops a stream that ends without text instead of leaving an empty box", () => {
    // The Captain hands off before writing anything, then answers after Galley.
    const s = run([
      { type: "stream_start", conversationId: CID, streamId: "s1", crew: captain },
      { type: "stream_end", conversationId: CID, streamId: "s1" },
      { type: "handoff", conversationId: CID, from: captain, to: galley, task: "plan dinner" },
      { type: "stream_start", conversationId: CID, streamId: "s2", crew: galley },
      { type: "delta", conversationId: CID, streamId: "s2", text: "Pasta" },
      { type: "stream_end", conversationId: CID, streamId: "s2" },
      { type: "message", conversationId: CID, message: crewMessage("m2", galley, "Pasta") },
      { type: "stream_start", conversationId: CID, streamId: "s3", crew: captain },
      { type: "delta", conversationId: CID, streamId: "s3", text: "Galley says pasta" },
      { type: "stream_end", conversationId: CID, streamId: "s3" },
      {
        type: "message",
        conversationId: CID,
        message: crewMessage("m3", captain, "Galley says pasta"),
      },
    ]);
    expect(s.items.map((i) => i.key)).toEqual(["h:1", "m:m2", "m:m3"]);
  });

  it("records errors for this conversation and global ones", () => {
    expect(run([{ type: "error", message: "boom" }]).error).toBe("boom");
    expect(run([{ type: "error", conversationId: "other", message: "x" }]).error).toBeNull();
  });
});
