import type { ConversationDto, CrewDto } from "@shipmate/core";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { api, errorMessage } from "../api.js";
import { useApprovals } from "../approvals.js";
import { useUser } from "../auth.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { TimelineView } from "../components/Timeline.js";
import { Badge, Button, cx, ErrorText, focusRing } from "../components/ui.js";
import { formatTime } from "../lib/format.js";
import { surfaceLabel } from "../lib/shipyard.js";
import { initialTimeline, timelineReducer } from "../lib/timeline.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { socket, useServerEvents, useSocketState } from "../ws.js";

function conversationTitle(c: ConversationDto, crew: CrewDto[]): string {
  if (c.title) return c.title;
  if (c.kind === "direct") {
    const member = crew.find((m) => m.slug === c.crewSlug);
    return `Direct: ${member?.name ?? c.crewSlug ?? "crew"}`;
  }
  return "New bridge chat";
}

/** Project names for conversations that work in a Shipyard project; fetched only when needed. */
function useProjectNames(needed: boolean): Map<string, string> {
  const projects = useResource(
    () => (needed ? api.getShipyard().then((r) => r.projects) : Promise.resolve([])),
    [needed],
  );
  return new Map((projects.data ?? []).map((p) => [p.id, p.name]));
}

function ConversationTags({
  c,
  projectNames,
  linkProject,
}: {
  c: ConversationDto;
  projectNames: Map<string, string>;
  linkProject?: boolean;
}) {
  const surface = surfaceLabel(c.surface);
  const projectName = c.projectId ? (projectNames.get(c.projectId) ?? "Project") : null;
  return (
    <>
      {surface && <Badge tone={c.surface === "discord" ? "accent" : "neutral"}>{surface}</Badge>}
      {c.projectId &&
        (linkProject ? (
          <a
            href={href(`/shipyard/${c.projectId}`)}
            title="Open the project in the Shipyard"
            className={cx(
              "inline-flex max-w-40 items-center truncate rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 hover:underline dark:bg-amber-900/50 dark:text-amber-100",
              focusRing,
            )}
          >
            {projectName}
          </a>
        ) : (
          <span className="inline-flex max-w-40 items-center truncate rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
            {projectName}
          </span>
        ))}
    </>
  );
}

export function BridgePage({ conversationId }: { conversationId: string | null }) {
  const conversations = useResource(() => api.listConversations().then((r) => r.conversations));
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  const models = useResource(() => api.listModels().then((r) => r.models));
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void crew.reload();
    if (ev.type === "message") {
      // Titles and ordering change as messages land; refetch the list, debounced.
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => void conversations.reload(), 400);
    }
  });
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const crewList = crew.data ?? [];
  const noModels = models.data !== null && !models.data.some((m) => m.available);
  const current = conversations.data?.find((c) => c.id === conversationId) ?? null;
  const projectNames = useProjectNames(
    conversations.data?.some((c) => c.projectId !== null) ?? false,
  );

  async function create(kind: "bridge" | "direct", crewSlug?: string) {
    setCreating(true);
    setCreateError(null);
    try {
      const { conversation } = await api.createConversation(
        kind === "direct" ? { kind, crewSlug } : { kind },
      );
      conversations.setData([conversation, ...(conversations.data ?? [])]);
      navigate(`/bridge/${conversation.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  const directCandidates = crewList.filter((m) => m.status === "active" && !m.captain);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {noModels && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          No model provider is configured yet, so the crew cannot answer.{" "}
          <a href={href("/providers")} className="font-medium underline underline-offset-2">
            Set up a provider
          </a>
          .
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside
          className={cx(
            "w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-72 dark:border-slate-800 dark:bg-slate-900",
            conversationId ? "hidden" : "flex",
          )}
          aria-label="Conversations"
        >
          <div className="space-y-2 border-b border-slate-200 p-3 dark:border-slate-800">
            <Button
              variant="primary"
              className="w-full"
              disabled={creating}
              onClick={() => void create("bridge")}
            >
              New bridge chat
            </Button>
            {directCandidates.length > 0 && (
              <div>
                <label htmlFor="direct-crew" className="sr-only">
                  Start a direct chat with a crew member
                </label>
                <select
                  id="direct-crew"
                  value=""
                  disabled={creating}
                  onChange={(e) => {
                    if (e.target.value) void create("direct", e.target.value);
                  }}
                  className={cx(
                    "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900",
                    focusRing,
                  )}
                >
                  <option value="">Direct chat with…</option>
                  {directCandidates.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name} ({m.role})
                    </option>
                  ))}
                </select>
              </div>
            )}
            <ErrorText>{createError}</ErrorText>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {conversations.error && <ErrorText>{conversations.error}</ErrorText>}
            {conversations.data?.length === 0 && (
              <p className="p-3 text-sm text-slate-500 dark:text-slate-400">
                No conversations yet. Start one above.
              </p>
            )}
            <ul className="space-y-0.5">
              {conversations.data?.map((c) => (
                <li key={c.id}>
                  <a
                    href={href(`/bridge/${c.id}`)}
                    aria-current={c.id === conversationId ? "page" : undefined}
                    className={cx(
                      "block rounded-md px-3 py-2",
                      focusRing,
                      c.id === conversationId
                        ? "bg-teal-700/10 dark:bg-teal-400/10"
                        : "hover:bg-slate-100 dark:hover:bg-slate-800",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {conversationTitle(c, crewList)}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                        {formatTime(c.updatedAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                      {c.kind === "bridge" ? "Bridge" : "Direct"}
                      <ConversationTags c={c} projectNames={projectNames} />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section
          className={cx("min-w-0 flex-1 flex-col", conversationId ? "flex" : "hidden md:flex")}
        >
          {conversationId ? (
            <Thread
              key={conversationId}
              conversationId={conversationId}
              conversation={current}
              title={current ? conversationTitle(current, crewList) : ""}
              tags={
                current ? (
                  <ConversationTags c={current} projectNames={projectNames} linkProject />
                ) : null
              }
              onRenamed={(c) =>
                conversations.setData(
                  (conversations.data ?? []).map((x) => (x.id === c.id ? c : x)),
                )
              }
              onDeleted={() => {
                conversations.setData(
                  (conversations.data ?? []).filter((x) => x.id !== conversationId),
                );
                navigate("/bridge");
              }}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-center">
              <div className="max-w-sm space-y-2">
                <h1 className="text-lg font-semibold">The Bridge</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Talk to your coordinator, who pulls in the right crew member for each job. Pick a
                  conversation or start a new one.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Thread({
  conversationId,
  conversation,
  title,
  tags,
  onRenamed,
  onDeleted,
}: {
  conversationId: string;
  conversation: ConversationDto | null;
  title: string;
  tags: ReactNode;
  onRenamed: (c: ConversationDto) => void;
  onDeleted: () => void;
}) {
  const user = useUser();
  const socketState = useSocketState();
  const [state, dispatch] = useReducer(timelineReducer, initialTimeline);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const approvals = useApprovals();
  // Pending approvals restored from the server (not seen arriving live) go at the end.
  const restoredApprovals = approvals.pending.filter(
    (a) =>
      a.conversationId === conversationId &&
      !state.items.some((it) => it.kind === "approval" && it.approval.id === a.id),
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useServerEvents((event) => dispatch({ type: "event", event }));

  const load = useCallback(async () => {
    dispatch({ type: "open", conversationId });
    setLoadError(null);
    try {
      const { messages } = await api.listMessages(conversationId);
      dispatch({ type: "loaded", conversationId, messages });
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload after a reconnect so nothing persisted while offline is missed.
  const seenOpen = useRef(false);
  const dropped = useRef(false);
  useEffect(() => {
    if (socketState === "open") {
      if (dropped.current) void load();
      dropped.current = false;
      seenOpen.current = true;
    } else if (seenOpen.current) {
      dropped.current = true;
    }
  }, [socketState, load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the items change
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, restoredApprovals.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function send(e?: FormEvent) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || state.busy) return;
    if (!socket.send({ type: "send", conversationId, text: body })) {
      setSendError("Not connected to the server. Your message was not sent; try again shortly.");
      return;
    }
    setSendError(null);
    setText("");
    stick.current = true;
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  async function saveTitle(e: FormEvent) {
    e.preventDefault();
    if (renaming === null) return;
    try {
      const { conversation: c } = await api.renameConversation(conversationId, renaming.trim());
      onRenamed(c);
      setRenaming(null);
    } catch (err) {
      setSendError(errorMessage(err));
    }
  }

  async function remove() {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await api.deleteConversation(conversationId);
      onDeleted();
    } catch (err) {
      setSendError(errorMessage(err));
    }
  }

  const rows = Math.min(8, Math.max(1, text.split("\n").length));

  return (
    <>
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <a
          href={href("/bridge")}
          className={cx(
            "rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 md:hidden dark:text-slate-300 dark:hover:bg-slate-800",
            focusRing,
          )}
        >
          ← Back
        </a>
        {renaming !== null ? (
          <form onSubmit={saveTitle} className="flex min-w-0 flex-1 items-center gap-2">
            <label htmlFor="conv-title" className="sr-only">
              Conversation title
            </label>
            <input
              id="conv-title"
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              className={cx(
                "min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900",
                focusRing,
              )}
            />
            <Button size="sm" type="submit" variant="primary">
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </form>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <h1 className="min-w-0 truncate font-semibold">{title}</h1>
              <span className="flex shrink-0 items-center gap-1.5">{tags}</span>
            </div>
            {conversation && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming(conversation.title ?? "")}
                >
                  Rename
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove()}>
                  Delete
                </Button>
              </>
            )}
          </>
        )}
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6"
        aria-live="polite"
        aria-busy={state.busy}
      >
        <div className="mx-auto max-w-3xl">
          {loadError && <ErrorText>{loadError}</ErrorText>}
          {state.items.length === 0 && restoredApprovals.length === 0 && !loadError && (
            <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              No messages yet. Say hello.
            </p>
          )}
          <TimelineView items={state.items} selfId={user.id} />
          {restoredApprovals.length > 0 && (
            <div className="mt-4 space-y-4">
              {restoredApprovals.map((a) => (
                <ApprovalCard key={a.id} approval={a} />
              ))}
            </div>
          )}
        </div>
      </div>

      <form
        onSubmit={send}
        className="border-t border-slate-200 bg-white px-3 py-3 sm:px-6 dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="mx-auto max-w-3xl space-y-2">
          {state.error && (
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <ErrorText>{state.error}</ErrorText>
              </div>
              <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "dismissError" })}>
                Dismiss
              </Button>
            </div>
          )}
          <ErrorText>{sendError}</ErrorText>
          <div className="flex items-end gap-2">
            <label htmlFor="composer" className="sr-only">
              Message
            </label>
            <textarea
              id="composer"
              ref={inputRef}
              rows={rows}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={state.busy ? "The crew is working…" : "Message the crew"}
              className={cx(
                "min-h-[42px] flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-[15px] dark:border-slate-600 dark:bg-slate-950",
                focusRing,
              )}
            />
            {state.busy ? (
              <Button
                variant="danger"
                onClick={() => socket.send({ type: "abort", conversationId })}
              >
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                disabled={!text.trim() || socketState !== "open"}
              >
                Send
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Enter to send, Shift+Enter for a new line.
          </p>
        </div>
      </form>
    </>
  );
}
