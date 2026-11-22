import type { MessageDto, ServerEvent, TaskDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  initialTasks,
  isLongResult,
  openSummary,
  sinceShort,
  type TasksState,
  taskInChat,
  taskMessage,
  taskState,
  tasksOf,
  tasksReducer,
  toolWords,
} from "./tasks.js";
import { initialTimeline, timelineReducer } from "./timeline.js";

const scout = { slug: "scout", name: "Scout" };

function task(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "t1",
    number: 1,
    title: "Compare three vacuums",
    prompt: "Compare three robot vacuums under $400.",
    crew: scout,
    status: "running",
    parentConversationId: "main",
    conversationId: "task-chat-1",
    resultPreview: null,
    error: null,
    createdAt: "2026-11-22T10:00:00.000Z",
    startedAt: "2026-11-22T10:00:01.000Z",
    finishedAt: null,
    ...over,
  };
}

function apply(events: ServerEvent[], start: TasksState = initialTasks): TasksState {
  return events.reduce((s, event) => tasksReducer(s, { type: "event", event }), start);
}

function message(meta: MessageDto["meta"], content = ""): MessageDto {
  return {
    id: "m1",
    conversationId: "main",
    role: "system",
    content,
    author: { kind: "system" },
    meta,
    createdAt: "2026-11-22T10:00:00.000Z",
  } as MessageDto;
}

describe("tasksReducer", () => {
  it("keeps the newest state of each task", () => {
    let s = tasksReducer(initialTasks, { type: "loaded", tasks: [task()] });
    s = apply([{ type: "task", task: task({ status: "done" }) }], s);
    expect(s.byId.t1?.status).toBe("done");
    expect(tasksOf(s, "main").map((t) => t.id)).toEqual(["t1"]);
    expect(taskInChat(s, "task-chat-1")?.id).toBe("t1");
    expect(taskInChat(s, "main")).toBeNull();
  });

  it("says what a running task is doing, and forgets it when the task ends", () => {
    const start = apply([{ type: "task", task: task() }]);
    const base = { conversationId: "task-chat-1", streamId: "s1" };
    let s = apply([{ type: "stream_start", ...base, crew: scout }], start);
    expect(s.activity["task-chat-1"]).toBe("Thinking");
    s = apply(
      [
        {
          type: "tool",
          ...base,
          toolCallId: "c1",
          toolName: "mcp__shipmate__search_web",
          phase: "start",
          summary: "",
        },
      ],
      s,
    );
    expect(s.activity["task-chat-1"]).toBe("Search web");
    const writing = apply([{ type: "delta", ...base, text: "Here" }], s);
    expect(writing.activity["task-chat-1"]).toBe("Writing the reply");
    // Each further word changes nothing, so nothing re-renders.
    expect(apply([{ type: "delta", ...base, text: " it is" }], writing)).toBe(writing);
    s = apply([{ type: "task", task: task({ status: "done" }) }], writing);
    expect(s.activity).toEqual({});
  });

  it("ignores replies in chats that are not an open task", () => {
    const start = apply([{ type: "task", task: task({ status: "done" }) }]);
    const s = apply(
      [
        { type: "delta", conversationId: "main", streamId: "s9", text: "Hi" },
        { type: "delta", conversationId: "task-chat-1", streamId: "s1", text: "Hi" },
      ],
      start,
    );
    expect(s).toBe(start);
  });

  it("orders a chat's tasks by number", () => {
    const s = tasksReducer(initialTasks, {
      type: "loaded",
      tasks: [task({ id: "b", number: 2 }), task({ id: "a", number: 1 })],
    });
    expect(tasksOf(s, "main").map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("task words", () => {
  it("names tools in plain words", () => {
    expect(toolWords("web_search")).toBe("Web search");
    expect(toolWords("mcp__files__read-file")).toBe("Read file");
    expect(toolWords("")).toBe("Working");
  });

  it("labels every state", () => {
    expect(taskState("queued").label).toBe("Waiting to start");
    expect(taskState("running").tone).toBe("working");
    expect(taskState("waiting")).toEqual({ label: "Needs you", tone: "attention" });
    expect(taskState("done").tone).toBe("good");
    expect(taskState("failed").label).toBe("Could not finish");
    expect(taskState("stopped").label).toBe("Stopped");
  });

  it("sums up what is still open", () => {
    expect(openSummary([task({ status: "done" })])).toBe("");
    expect(openSummary([task()])).toBe("1 task working");
    expect(
      openSummary([
        task({ id: "a" }),
        task({ id: "b" }),
        task({ id: "c", status: "queued" }),
        task({ id: "d", status: "waiting" }),
        task({ id: "e", status: "stopped" }),
      ]),
    ).toBe("2 tasks working · 1 waiting to start · 1 needs you");
  });

  it("tells short from long results and how long ago", () => {
    expect(isLongResult("Done.")).toBe(false);
    expect(isLongResult("x".repeat(701))).toBe(true);
    expect(isLongResult(Array(15).fill("line").join("\n"))).toBe(true);
    const now = Date.parse("2026-11-22T12:00:00.000Z");
    expect(sinceShort("2026-11-22T11:59:40.000Z", now)).toBe("just now");
    expect(sinceShort("2026-11-22T11:56:00.000Z", now)).toBe("4 min");
    expect(sinceShort("2026-11-22T10:00:00.000Z", now)).toBe("2 h");
    expect(sinceShort("2026-11-19T10:00:00.000Z", now)).toBe("3 d");
    expect(sinceShort("not a date", now)).toBe("just now");
  });
});

describe("taskMessage", () => {
  const ref = {
    id: "t1",
    number: 2,
    title: "Compare three vacuums",
    crew: scout,
    conversationId: "task-chat-1",
  };
  const captain = { slug: "captain", name: "Captain" };

  it("reads each kind of task note", () => {
    expect(
      taskMessage(message({ taskStarted: { ...ref, from: captain, prompt: "Compare them." } })),
    ).toEqual({ kind: "started", task: ref, from: captain, prompt: "Compare them." });
    expect(taskMessage(message({ task: ref }, "The result"))).toEqual({
      kind: "result",
      task: ref,
    });
    expect(
      taskMessage(message({ taskSentBack: { ...ref, from: captain, notes: "Add prices." } })),
    ).toEqual({ kind: "sentBack", task: ref, from: captain, notes: "Add prices." });
    expect(
      taskMessage(message({ taskEnded: { ...ref, status: "failed", error: "Out of budget" } })),
    ).toEqual({ kind: "ended", task: ref, error: "Out of budget" });
    expect(taskMessage(message({ taskBrief: { from: captain, text: "Compare them." } }))).toEqual({
      kind: "brief",
      from: captain,
      text: "Compare them.",
      followUp: false,
    });
  });

  it("leaves other messages and broken notes alone", () => {
    expect(taskMessage(message(null))).toBeNull();
    expect(taskMessage(message({ tools: [] }))).toBeNull();
    expect(taskMessage(message({ taskStarted: { id: "t1" } }))).toBeNull();
    expect(taskMessage(message({ task: "t1" }))).toBeNull();
  });
});

describe("a task's question in the chat it came from", () => {
  const approval = {
    id: "a1",
    conversationId: "task-chat-1",
    parentConversationId: "main",
    routineId: null,
    crew: scout,
    toolName: "ask_person",
    summary: "Which budget?",
    detail: "",
    createdAt: "2026-11-22T10:00:00.000Z",
  };
  const open = (conversationId: string) =>
    timelineReducer(timelineReducer(initialTimeline, { type: "open", conversationId }), {
      type: "event",
      event: { type: "approval_request", approval },
    });

  it("shows in the main chat and in the task's own chat, and nowhere else", () => {
    expect(open("main").items.map((it) => it.kind)).toEqual(["approval"]);
    expect(open("task-chat-1").items.map((it) => it.kind)).toEqual(["approval"]);
    expect(open("other").items).toEqual([]);
  });
});
