import type { ConversationDto, ConversationSearchResultDto, CrewDto } from "@shipmate/core";
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
import { AttachButtons, PendingFiles, useComposerFiles } from "../components/Attachments.js";
import { NavIcon } from "../components/icons.js";
import { TimelineView } from "../components/Timeline.js";
import {
  Badge,
  Button,
  cx,
  EmptyState,
  ErrorText,
  focusRing,
  IconButton,
} from "../components/ui.js";
import { MicButton, speaker, useHandsFree, useVoiceStatus } from "../components/Voice.js";
import { formatTime } from "../lib/format.js";
import { splitHighlights } from "../lib/search.js";
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

/** Thread header buttons: a 36px square tap target on phones, a labelled button from sm up. */
const headerAction = "max-sm:size-9 max-sm:p-0";

export function BridgePage({ conversationId }: { conversationId: string | null }) {
  const conversations = useResource(() => api.listConversations().then((r) => r.conversations));
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  const models = useResource(() => api.listModels().then((r) => r.models));
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = useConversationSearch();

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
  const current =
    conversations.data?.find((c) => c.id === conversationId) ??
    search.results?.find((r) => r.conversation.id === conversationId)?.conversation ??
    null;
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
            <div className="relative">
              <label htmlFor="conv-search" className="sr-only">
                Search conversations
              </label>
              <input
                id="conv-search"
                type="search"
                value={search.query}
                onChange={(e) => search.setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") search.setQuery("");
                }}
                placeholder="Search conversations"
                className={cx(
                  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900",
                  focusRing,
                )}
              />
            </div>
          </div>
          {search.active ? (
            <SearchResults
              search={search}
              conversationId={conversationId}
              crewList={crewList}
              projectNames={projectNames}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2 md:pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
              {conversations.error && <ErrorText>{conversations.error}</ErrorText>}
              {conversations.data?.length === 0 && (
                <p className="p-3 text-sm text-slate-500 dark:text-slate-400">
                  No conversations yet. Start one above.
                </p>
              )}
              <ul className="stagger space-y-0.5">
                {conversations.data?.map((c, i, all) => (
                  <li key={c.id}>
                    {c.pinned && i === 0 && <ListLabel>Pinned</ListLabel>}
                    {!c.pinned && i > 0 && all[i - 1]?.pinned && <ListLabel>Recent</ListLabel>}
                    <ConversationRow
                      c={c}
                      title={conversationTitle(c, crewList)}
                      active={c.id === conversationId}
                      projectNames={projectNames}
                      onRenamed={(next) =>
                        conversations.setData(
                          (conversations.data ?? []).map((x) => (x.id === next.id ? next : x)),
                        )
                      }
                      onPinned={() => void conversations.reload()}
                      onDeleted={() => {
                        conversations.setData(
                          (conversations.data ?? []).filter((x) => x.id !== c.id),
                        );
                        if (c.id === conversationId) navigate("/bridge");
                      }}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
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
              onPinned={() => void conversations.reload()}
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

/**
 * One chat in the list, with pin, rename and delete right on the row so nobody has to open a
 * chat to find them. Chats from other apps or watches are read-only and only get delete.
 */
function ConversationRow({
  c,
  title,
  active,
  projectNames,
  onRenamed,
  onPinned,
  onDeleted,
}: {
  c: ConversationDto;
  title: string;
  active: boolean;
  projectNames: Map<string, string>;
  onRenamed: (c: ConversationDto) => void;
  onPinned: () => void;
  onDeleted: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = c.surface === "web";

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function saveTitle(e: FormEvent) {
    e.preventDefault();
    if (renaming === null) return;
    void run(async () => {
      const { conversation } = await api.renameConversation(c.id, renaming.trim());
      onRenamed(conversation);
      setRenaming(null);
    });
  }

  if (renaming !== null) {
    return (
      <form
        onSubmit={saveTitle}
        className="space-y-1.5 rounded-md bg-slate-100 p-2 dark:bg-slate-800"
      >
        <label htmlFor={`rename-${c.id}`} className="sr-only">
          Chat name
        </label>
        <input
          id={`rename-${c.id}`}
          // biome-ignore lint/a11y/noAutofocus: the user just pressed Rename on this row
          autoFocus
          value={renaming}
          placeholder={title}
          maxLength={200}
          onChange={(e) => setRenaming(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setRenaming(null);
          }}
          className={cx(
            "w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900",
            focusRing,
          )}
        />
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-1.5">
          <Button size="sm" type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div
      className={cx(
        "relative rounded-md transition-colors duration-150",
        active
          ? "bg-accent-700/10 dark:bg-accent-400/10"
          : "hover:bg-slate-100 active:bg-slate-200/70 dark:hover:bg-slate-800 dark:active:bg-slate-700/70",
      )}
    >
      <a
        href={href(`/bridge/${c.id}`)}
        aria-current={active ? "page" : undefined}
        className={cx("block rounded-md px-3 py-2", focusRing)}
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1 text-sm font-medium">
            {c.pinned && <PinGlyph />}
            <span className="truncate">{title}</span>
          </span>
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {formatTime(c.updatedAt)}
          </span>
        </span>
        <span className="mt-0.5 flex min-h-9 min-w-0 flex-wrap items-center gap-1.5 pr-32 text-xs sm:min-h-7 sm:pr-24 text-slate-500 dark:text-slate-400">
          {c.kind === "bridge" ? "Bridge" : "Direct"}
          <ConversationTags c={c} projectNames={projectNames} />
        </span>
      </a>
      <div className="absolute right-1.5 bottom-1.5 flex items-center gap-0.5">
        {editable && (
          <>
            <IconButton
              icon="pin"
              label={c.pinned ? `Unpin ${title}` : `Pin ${title}`}
              active={c.pinned}
              aria-pressed={c.pinned}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.pinConversation(c.id, !c.pinned);
                  onPinned();
                })
              }
            />
            <IconButton
              icon="pencil"
              label={`Rename ${title}`}
              disabled={busy}
              onClick={() => setRenaming(c.title ?? "")}
            />
          </>
        )}
        <IconButton
          icon="trash"
          label={`Delete ${title}`}
          tone="danger"
          disabled={busy}
          onClick={() => {
            if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
            void run(async () => {
              await api.deleteConversation(c.id);
              onDeleted();
            });
          }}
        />
      </div>
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Thread({
  conversationId,
  conversation,
  title,
  tags,
  onRenamed,
  onPinned,
  onDeleted,
}: {
  conversationId: string;
  conversation: ConversationDto | null;
  title: string;
  tags: ReactNode;
  onRenamed: (c: ConversationDto) => void;
  onPinned: () => void;
  onDeleted: () => void;
}) {
  const user = useUser();
  const socketState = useSocketState();
  // Chats from Discord, Telegram, Slack or a watch (opened from search) are shown, not continued.
  const readOnly = conversation !== null && conversation.surface !== "web";
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
  const files = useComposerFiles(conversationId);

  useServerEvents((event) => dispatch({ type: "event", event }));

  const voice = useVoiceStatus();
  const [handsFree, setHandsFree] = useHandsFree();
  // Hands-free: crew replies in this conversation are read aloud as they arrive.
  useServerEvents((event) => {
    if (!handsFree || !voice || event.type !== "message") return;
    if (event.conversationId !== conversationId || event.message.author.kind !== "crew") return;
    void speaker.speak(event.message.id, event.message.content, voice.tts);
  });
  useEffect(() => () => speaker.stop(), []);

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

  /** `spoken`: text from the mic in hands-free mode, sent as is (with any attached files). */
  function send(e?: FormEvent, spoken?: string) {
    e?.preventDefault();
    const body = (spoken ?? text).trim();
    if ((!body && !files.ids.length) || state.busy || files.uploading) return;
    const attachments = files.ids.length ? { attachments: files.ids } : {};
    if (!socket.send({ type: "send", conversationId, text: body, ...attachments })) {
      setSendError("Not connected to the server. Your message was not sent; try again shortly.");
      return;
    }
    setSendError(null);
    if (spoken === undefined) setText("");
    files.clear();
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

  async function togglePin() {
    if (!conversation) return;
    try {
      await api.pinConversation(conversationId, !conversation.pinned);
      onPinned();
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
            {voice && voice.stt !== "off" && !readOnly && (
              <Button
                size="sm"
                variant={handsFree ? "primary" : "ghost"}
                aria-pressed={handsFree}
                title="Read replies aloud and send what you say right away"
                onClick={() => setHandsFree(!handsFree)}
              >
                Hands-free
              </Button>
            )}
            {conversation && !readOnly && (
              <>
                {/* Icons only on phones, so the chat's title keeps the room. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className={headerAction}
                  aria-pressed={conversation.pinned}
                  onClick={() => void togglePin()}
                >
                  <NavIcon name="pin" size={16} />
                  <span className="sr-only sm:not-sr-only">
                    {conversation.pinned ? "Unpin" : "Pin"}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={headerAction}
                  onClick={() => setRenaming(conversation.title ?? "")}
                >
                  <NavIcon name="pencil" size={16} />
                  <span className="sr-only sm:not-sr-only">Rename</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className={headerAction}
                  onClick={() => void remove()}
                >
                  <NavIcon name="trash" size={16} />
                  <span className="sr-only sm:not-sr-only">Delete</span>
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
            <EmptyState
              className="mt-6 border-none bg-transparent dark:bg-transparent"
              icon={<NavIcon name="bridge" size={22} />}
              title="No messages yet"
            >
              Say hello. Ask for anything, and the right crew member picks it up.
            </EmptyState>
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

      {readOnly ? (
        <p className="border-t border-slate-200 bg-white px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-center text-sm text-slate-500 sm:px-6 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {conversation?.surface === "watch"
            ? "A watch ran this conversation. It is shown here to read."
            : `This conversation happened in ${surfaceLabel(conversation?.surface ?? "") ?? "another app"}. Reply there to continue it.`}
        </p>
      ) : (
        <form
          onSubmit={send}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            files.add(e.dataTransfer.files);
          }}
          className="border-t border-slate-200 bg-white px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:px-6 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="mx-auto max-w-3xl space-y-2">
            {state.error && (
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <ErrorText>{state.error}</ErrorText>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => dispatch({ type: "dismissError" })}
                >
                  Dismiss
                </Button>
              </div>
            )}
            <ErrorText>{sendError}</ErrorText>
            <PendingFiles items={files.items} onRemove={files.remove} />
            <div className="flex items-end gap-2">
              <AttachButtons onFiles={files.add} disabled={files.full} />
              {voice && voice.stt !== "off" && (
                <MicButton
                  mode={voice.stt}
                  disabled={state.busy && handsFree}
                  onError={setSendError}
                  onText={(heard) => {
                    // Hands-free sends right away, unless it cannot yet (a file still uploading,
                    // the crew still answering): then the words wait in the composer, not lost.
                    if (handsFree && !state.busy && !files.uploading) {
                      send(undefined, heard);
                      return;
                    }
                    setText((t) => (t.trim() ? `${t.trimEnd()} ${heard}` : heard));
                    inputRef.current?.focus();
                  }}
                />
              )}
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
                onPaste={(e) => {
                  if (!e.clipboardData.files.length) return;
                  e.preventDefault();
                  files.add(e.clipboardData.files);
                }}
                placeholder={state.busy ? "The crew is working…" : "Message the crew"}
                className="min-h-[42px] flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-[15px] shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-slate-400 focus:border-accent-500 focus:ring-3 focus:ring-accent-500/25 focus:outline-none dark:border-slate-600 dark:bg-slate-950 dark:hover:border-slate-500 dark:focus:border-accent-400 dark:focus:ring-accent-400/25"
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
                  disabled={
                    (!text.trim() && !files.ids.length) || files.uploading || socketState !== "open"
                  }
                >
                  Send
                </Button>
              )}
            </div>
            <p
              className={cx(
                "text-xs text-slate-500 dark:text-slate-400",
                // Keyboard tips mean nothing on a phone; the hands-free tip still does.
                !handsFree && "hidden sm:block",
              )}
            >
              {handsFree
                ? "Hands-free: tap the mic, speak, tap again to send. Replies are read aloud."
                : "Enter to send, Shift+Enter for a new line."}
            </p>
          </div>
        </form>
      )}
    </>
  );
}

function ListLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
      {children}
    </p>
  );
}

function PinGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-label="Pinned"
      role="img"
      className="shrink-0 text-accent-700 dark:text-accent-300"
    >
      <path d="M15 3l6 6-3 1-3.5 3.5L15 18l-2 2-4-4-5 5-1-1 5-5-4-4 2-2 4.5.5L13 6z" />
    </svg>
  );
}

interface ConversationSearch {
  query: string;
  setQuery: (q: string) => void;
  /** Showing results instead of the conversation list. */
  active: boolean;
  results: ConversationSearchResultDto[] | null;
  loading: boolean;
  error: string | null;
}

/** Search as you type (debounced); two characters or more. */
function useConversationSearch(): ConversationSearch {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSearchResultDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = query.trim();
  const active = q.length >= 2;

  useEffect(() => {
    if (!active) {
      setResults(null);
      setError(null);
      return;
    }
    let stale = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .searchConversations(q)
        .then((r) => {
          if (!stale) {
            setResults(r.results);
            setError(null);
          }
        })
        .catch((err) => {
          if (!stale) setError(errorMessage(err));
        })
        .finally(() => {
          if (!stale) setLoading(false);
        });
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, active]);

  return { query, setQuery, active, results, loading, error };
}

function SearchResults({
  search,
  conversationId,
  crewList,
  projectNames,
}: {
  search: ConversationSearch;
  conversationId: string | null;
  crewList: CrewDto[];
  projectNames: Map<string, string>;
}) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto p-2 md:pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
      aria-live="polite"
    >
      <div className="flex items-center justify-between px-3 py-1 text-xs text-slate-500 dark:text-slate-400">
        <span>
          {search.loading && !search.results
            ? "Searching…"
            : `${search.results?.length ?? 0} conversation${search.results?.length === 1 ? "" : "s"}`}
        </span>
        <button
          type="button"
          onClick={() => search.setQuery("")}
          className={cx("rounded px-1 hover:text-slate-800 dark:hover:text-slate-100", focusRing)}
        >
          Clear
        </button>
      </div>
      <ErrorText>{search.error}</ErrorText>
      {search.results?.length === 0 && (
        <p className="p-3 text-sm text-slate-500 dark:text-slate-400">
          No matches. Try other words, or "an exact phrase".
        </p>
      )}
      <ul className="space-y-0.5">
        {search.results?.map((r) => (
          <li key={r.conversation.id}>
            <a
              href={href(`/bridge/${r.conversation.id}`)}
              aria-current={r.conversation.id === conversationId ? "page" : undefined}
              className={cx(
                "block rounded-md px-3 py-2",
                focusRing,
                r.conversation.id === conversationId
                  ? "bg-accent-700/10 dark:bg-accent-400/10"
                  : "hover:bg-slate-100 active:bg-slate-200/70 dark:hover:bg-slate-800 dark:active:bg-slate-700/70",
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1 text-sm font-medium">
                  {r.conversation.pinned && <PinGlyph />}
                  <span className="truncate">{conversationTitle(r.conversation, crewList)}</span>
                </span>
                <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {formatTime(r.conversation.updatedAt)}
                </span>
              </span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <ConversationTags c={r.conversation} projectNames={projectNames} />
              </span>
              {r.matches.map((m) => (
                <span
                  key={m.messageId}
                  className="mt-1 line-clamp-3 block text-xs text-slate-600 dark:text-slate-300"
                >
                  <span className="font-medium">{m.author}: </span>
                  <Snippet text={m.snippet} />
                </span>
              ))}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A search snippet with matched words highlighted; plain text only, never HTML. */
function Snippet({ text }: { text: string }) {
  let offset = 0;
  return (
    <>
      {splitHighlights(text).map((part) => {
        const key = offset;
        offset += part.text.length;
        return part.mark ? (
          <mark
            key={key}
            className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-500/30"
          >
            {part.text}
          </mark>
        ) : (
          <span key={key}>{part.text}</span>
        );
      })}
    </>
  );
}
