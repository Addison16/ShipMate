import type { ApprovalDto, MessageDto, ServerEvent } from "@shipmate/core";

/**
 * Pure state for one open conversation: persisted messages interleaved with live streams and
 * hand-off lines, in arrival order. A finished stream stays on screen until the persisted
 * message from the same crew member arrives, which then takes its place.
 */

export interface ToolChip {
  id: string;
  name: string;
  summary: string;
  running: boolean;
  isError: boolean;
}

export interface Handoff {
  from: { slug: string; name: string };
  to: { slug: string; name: string };
  task: string;
}

export type TimelineItem =
  | { kind: "message"; key: string; message: MessageDto }
  | {
      kind: "stream";
      key: string;
      streamId: string;
      crew: { slug: string; name: string };
      text: string;
      tools: ToolChip[];
      done: boolean;
    }
  | ({ kind: "handoff"; key: string } & Handoff)
  /** An approval request, placed where it arrived; its live state lives in lib/approvals. */
  | { kind: "approval"; key: string; approval: ApprovalDto };

export interface TimelineState {
  conversationId: string | null;
  items: TimelineItem[];
  busy: boolean;
  error: string | null;
  /** The provider's raw text behind a short `error`, for "More details". */
  errorDetail: string | null;
  seq: number;
}

export type TimelineAction =
  | { type: "open"; conversationId: string | null }
  | { type: "loaded"; conversationId: string; messages: MessageDto[] }
  | { type: "event"; event: ServerEvent }
  | { type: "dismissError" };

export const initialTimeline: TimelineState = {
  conversationId: null,
  items: [],
  busy: false,
  error: null,
  errorDetail: null,
  seq: 0,
};

const msgItem = (message: MessageDto): TimelineItem => ({
  kind: "message",
  key: `m:${message.id}`,
  message,
});

/** Reads `meta.handoff` from a persisted message, if it has a well-formed one. */
export function messageHandoff(message: MessageDto): Handoff | null {
  const h = message.meta?.handoff;
  if (!h || typeof h !== "object") return null;
  const { from, to, task } = h as Record<string, unknown>;
  const party = (p: unknown) =>
    p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string"
      ? {
          slug: String((p as { slug?: unknown }).slug ?? ""),
          name: (p as { name: string }).name,
        }
      : typeof p === "string"
        ? { slug: p, name: p }
        : null;
  const f = party(from);
  const t = party(to);
  if (!f || !t) return null;
  return { from: f, to: t, task: typeof task === "string" ? task : "" };
}

function updateStream(
  items: TimelineItem[],
  streamId: string,
  fn: (s: Extract<TimelineItem, { kind: "stream" }>) => TimelineItem,
): TimelineItem[] {
  return items.map((it) => (it.kind === "stream" && it.streamId === streamId ? fn(it) : it));
}

/**
 * A finished stream that never said anything gets no saved message (the server only stores
 * replies with text), so it would sit on screen as an empty box with typing dots. This happens
 * whenever a crew member hands off, asks the Captain or asks a question before writing a word.
 */
function dropEmpty(items: TimelineItem[]): TimelineItem[] {
  return items.filter((it) => it.kind !== "stream" || !it.done || it.text.trim() !== "");
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "open":
      if (action.conversationId === state.conversationId) return state;
      return { ...initialTimeline, conversationId: action.conversationId, seq: state.seq };
    case "loaded": {
      if (action.conversationId !== state.conversationId) return state;
      // Keep anything live that arrived while loading, minus messages we now have.
      const ids = new Set(action.messages.map((m) => m.id));
      const live = state.items.filter((it) => it.kind !== "message" || !ids.has(it.message.id));
      return { ...state, items: [...action.messages.map(msgItem), ...live] };
    }
    case "dismissError":
      return { ...state, error: null, errorDetail: null };
    case "event":
      return applyEvent(state, action.event);
    default:
      return state;
  }
}

function applyEvent(state: TimelineState, ev: ServerEvent): TimelineState {
  if (ev.type === "approval_request") {
    const a = ev.approval;
    if (!a.conversationId || a.conversationId !== state.conversationId) return state;
    if (state.items.some((it) => it.kind === "approval" && it.approval.id === a.id)) return state;
    return {
      ...state,
      items: [...state.items, { kind: "approval", key: `a:${a.id}`, approval: a }],
    };
  }
  if (ev.type === "error") {
    if (ev.conversationId && ev.conversationId !== state.conversationId) return state;
    return { ...state, error: ev.message, errorDetail: ev.detail ?? null };
  }
  if (!("conversationId" in ev) || ev.conversationId !== state.conversationId) return state;

  switch (ev.type) {
    case "message": {
      const m = ev.message;
      if (state.items.some((it) => it.kind === "message" && it.message.id === m.id)) return state;
      // A saved note about a failed reply takes over from the error shown live.
      if (m.meta?.turnError === true) {
        return { ...state, error: null, errorDetail: null, items: [...state.items, msgItem(m)] };
      }
      let items = state.items;
      if (m.author.kind === "crew") {
        const slug = m.author.slug;
        // Replace the oldest finished stream from this crew member in place.
        let idx = items.findIndex((it) => it.kind === "stream" && it.done && it.crew.slug === slug);
        if (idx < 0) idx = items.findIndex((it) => it.kind === "stream" && it.crew.slug === slug);
        if (messageHandoff(m)) {
          // The persisted message carries its own hand-off line; drop the live one.
          const h = items.findIndex((it) => it.kind === "handoff" && it.to.slug === slug);
          if (h >= 0) {
            items = items.filter((_, i) => i !== h);
            if (idx > h) idx--;
          }
        }
        if (idx >= 0) {
          items = [...items];
          items[idx] = msgItem(m);
          return { ...state, items };
        }
      }
      return { ...state, items: [...items, msgItem(m)] };
    }
    case "stream_start":
      if (state.items.some((it) => it.kind === "stream" && it.streamId === ev.streamId)) {
        return state;
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "stream",
            key: `s:${ev.streamId}`,
            streamId: ev.streamId,
            crew: ev.crew,
            text: "",
            tools: [],
            done: false,
          },
        ],
      };
    case "delta":
      return {
        ...state,
        items: updateStream(state.items, ev.streamId, (s) => ({ ...s, text: s.text + ev.text })),
      };
    case "tool":
      return {
        ...state,
        items: updateStream(state.items, ev.streamId, (s) => {
          const existing = s.tools.find((t) => t.id === ev.toolCallId);
          const chip: ToolChip = {
            id: ev.toolCallId,
            name: ev.toolName,
            summary: ev.summary || existing?.summary || "",
            running: ev.phase === "start",
            isError: Boolean(ev.isError),
          };
          const tools = existing
            ? s.tools.map((t) => (t.id === ev.toolCallId ? chip : t))
            : [...s.tools, chip];
          return { ...s, tools };
        }),
      };
    case "stream_end":
      return {
        ...state,
        items: dropEmpty(
          updateStream(state.items, ev.streamId, (s) => ({
            ...s,
            done: true,
            tools: s.tools.map((t) => ({ ...t, running: false })),
          })),
        ),
      };
    case "handoff": {
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        items: [
          ...state.items,
          { kind: "handoff", key: `h:${seq}`, from: ev.from, to: ev.to, task: ev.task },
        ],
      };
    }
    case "live":
      return applyLive(state, ev);
    case "status":
      return {
        ...state,
        busy: ev.busy,
        // When work stops, any stream that never ended is finished.
        items: ev.busy
          ? state.items
          : dropEmpty(state.items.map((it) => (it.kind === "stream" ? { ...it, done: true } : it))),
      };
    default:
      return state;
  }
}

/**
 * Catch up with a turn that ran while this page was closed or offline: replies in progress show
 * with everything written so far, and bubbles the server has already finished (their saved
 * messages are loaded or on their way) go.
 */
function applyLive(
  state: TimelineState,
  ev: Extract<ServerEvent, { type: "live" }>,
): TimelineState {
  const live = new Map(
    ev.items.flatMap((it) => (it.kind === "stream" ? [[it.streamId, it] as const] : [])),
  );
  let items = state.items.flatMap((it): TimelineItem[] => {
    if (it.kind !== "stream") return [it];
    const now = live.get(it.streamId);
    return now ? [{ ...it, text: now.text, tools: now.tools, done: false }] : [];
  });
  let seq = state.seq;
  for (const it of ev.items) {
    if (it.kind === "stream") {
      if (items.some((x) => x.kind === "stream" && x.streamId === it.streamId)) continue;
      items = [
        ...items,
        {
          kind: "stream",
          key: `s:${it.streamId}`,
          streamId: it.streamId,
          crew: it.crew,
          text: it.text,
          tools: it.tools,
          done: false,
        },
      ];
    } else {
      const same = (x: TimelineItem) =>
        x.kind === "handoff" &&
        x.from.slug === it.from.slug &&
        x.to.slug === it.to.slug &&
        x.task === it.task;
      if (items.some(same)) continue;
      seq++;
      items = [
        ...items,
        { kind: "handoff", key: `h:${seq}`, from: it.from, to: it.to, task: it.task },
      ];
    }
  }
  return { ...state, seq, busy: ev.busy, items };
}
