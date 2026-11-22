import {
  isOpenTask,
  type MessageDto,
  type ServerEvent,
  type TaskDto,
  type TaskRef,
  type TaskStatus,
} from "@shipmate/core";

/**
 * Pure state for background tasks across the app: what the Captain handed over, how each task
 * stands, and a line on what a running one is doing right now. Tasks come from GET /api/tasks
 * (on load, after a reconnect and when a chat opens) and from `task` events.
 */
export interface TasksState {
  byId: Record<string, TaskDto>;
  /** Per task chat, what its crew member is doing at this moment. */
  activity: Record<string, string>;
}

export type TasksAction =
  | { type: "loaded"; tasks: TaskDto[] }
  | { type: "event"; event: ServerEvent };

export const initialTasks: TasksState = { byId: {}, activity: {} };

const WRITING = "Writing the reply";
const THINKING = "Thinking";

/** A tool's name as a few plain words: `web_search` → "Web search". */
export function toolWords(name: string): string {
  const words = name
    .replace(/^mcp__[^_]+__/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Working";
}

export function tasksReducer(state: TasksState, action: TasksAction): TasksState {
  if (action.type === "loaded") {
    if (!action.tasks.length) return state;
    const byId = { ...state.byId };
    for (const task of action.tasks) byId[task.id] = task;
    return { ...state, byId };
  }
  const ev = action.event;
  if (ev.type === "task") {
    const byId = { ...state.byId, [ev.task.id]: ev.task };
    if (ev.task.status === "running" || !(ev.task.conversationId in state.activity)) {
      return { ...state, byId };
    }
    // Waiting or ended: whatever it was doing a moment ago no longer holds.
    const { [ev.task.conversationId]: _, ...activity } = state.activity;
    return { byId, activity };
  }
  if (ev.type !== "tool" && ev.type !== "delta" && ev.type !== "stream_start") return state;
  const id = ev.conversationId;
  const now =
    ev.type === "delta"
      ? WRITING
      : ev.type === "stream_start"
        ? (state.activity[id] ?? THINKING)
        : ev.phase === "start"
          ? toolWords(ev.toolName)
          : state.activity[id];
  // Most events change nothing (every word of a reply is one); those keep the same state.
  if (!now || state.activity[id] === now) return state;
  if (!Object.values(state.byId).some((t) => t.conversationId === id && isOpenTask(t.status))) {
    return state;
  }
  return { ...state, activity: { ...state.activity, [id]: now } };
}

/** The tasks handed over in one chat, oldest first. */
export function tasksOf(state: TasksState, parentConversationId: string): TaskDto[] {
  return Object.values(state.byId)
    .filter((t) => t.parentConversationId === parentConversationId)
    .sort((a, b) => a.number - b.number);
}

/** The task that lives in this chat, when it is a task's own chat. */
export function taskInChat(state: TasksState, conversationId: string): TaskDto | null {
  return Object.values(state.byId).find((t) => t.conversationId === conversationId) ?? null;
}

export function openTasks(tasks: TaskDto[]): TaskDto[] {
  return tasks.filter((t) => isOpenTask(t.status));
}

export type TaskTone = "working" | "attention" | "good" | "bad" | "muted";

export function taskState(status: TaskStatus): { label: string; tone: TaskTone } {
  switch (status) {
    case "queued":
      return { label: "Waiting to start", tone: "muted" };
    case "running":
      return { label: "Working", tone: "working" };
    case "waiting":
      return { label: "Needs you", tone: "attention" };
    case "done":
      return { label: "Done", tone: "good" };
    case "failed":
      return { label: "Could not finish", tone: "bad" };
    default:
      return { label: "Stopped", tone: "muted" };
  }
}

/** "2 tasks working · 1 needs you", for the line above the message box. */
export function openSummary(tasks: TaskDto[]): string {
  const open = openTasks(tasks);
  const needs = open.filter((t) => t.status === "waiting").length;
  const waiting = open.filter((t) => t.status === "queued").length;
  const working = open.length - needs - waiting;
  const parts: string[] = [];
  if (working) parts.push(`${working} ${working === 1 ? "task" : "tasks"} working`);
  if (waiting) parts.push(`${waiting} waiting to start`);
  if (needs) parts.push(`${needs} ${needs === 1 ? "needs" : "need"} you`);
  return parts.join(" · ");
}

interface Party {
  slug: string;
  name: string;
}

/** What a message says about a task, read from its `meta` (see TaskService on the server). */
export type TaskMessage =
  /** The card where the Captain handed a task over. */
  | { kind: "started"; task: TaskRef; from: Party | null; prompt: string }
  /** The crew member's result, posted in the chat the task came from. */
  | { kind: "result"; task: TaskRef }
  | { kind: "sentBack"; task: TaskRef; from: Party | null; notes: string }
  | { kind: "ended"; task: TaskRef; error: string | null }
  /** In the task's own chat: what was asked, or what was added later. */
  | { kind: "brief"; from: Party | null; text: string; followUp: boolean };

function party(value: unknown): Party | null {
  if (!value || typeof value !== "object") return null;
  const { slug, name } = value as Record<string, unknown>;
  return typeof name === "string" ? { slug: typeof slug === "string" ? slug : "", name } : null;
}

function ref(value: unknown): TaskRef | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const crew = party(v.crew);
  if (typeof v.id !== "string" || typeof v.conversationId !== "string" || !crew) return null;
  return {
    id: v.id,
    number: typeof v.number === "number" ? v.number : 0,
    title: typeof v.title === "string" ? v.title : "Task",
    crew,
    conversationId: v.conversationId,
  };
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

export function taskMessage(message: MessageDto): TaskMessage | null {
  const meta = message.meta;
  if (!meta) return null;
  const started = ref(meta.taskStarted);
  if (started) {
    const m = meta.taskStarted as Record<string, unknown>;
    return { kind: "started", task: started, from: party(m.from), prompt: str(m.prompt) };
  }
  const result = ref(meta.task);
  if (result) return { kind: "result", task: result };
  const back = ref(meta.taskSentBack);
  if (back) {
    const m = meta.taskSentBack as Record<string, unknown>;
    return { kind: "sentBack", task: back, from: party(m.from), notes: str(m.notes) };
  }
  const ended = ref(meta.taskEnded);
  if (ended) {
    const m = meta.taskEnded as Record<string, unknown>;
    return { kind: "ended", task: ended, error: str(m.error) || null };
  }
  const brief = meta.taskBrief as Record<string, unknown> | undefined;
  if (brief && typeof brief === "object" && typeof brief.text === "string") {
    return {
      kind: "brief",
      from: party(brief.from),
      text: brief.text,
      followUp: brief.followUp === true,
    };
  }
  return null;
}

/** A result this long is shown folded, with "Show all". */
export function isLongResult(text: string): boolean {
  return text.length > 700 || text.split("\n").length > 14;
}

/** "just now", "4 min", "2 h", "3 d": how long ago, in a few characters. */
export function sinceShort(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}
