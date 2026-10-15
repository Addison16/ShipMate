import type { ConversationDto, ConversationSearchResultDto, CrewDto } from "@shipmate/core";
import { singular } from "@shipmate/core";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { api, errorMessage } from "../api.js";
import { useCrewName, useThemeText, useThemeWords } from "../appearance.js";
import { useApprovals } from "../approvals.js";
import { useUser } from "../auth.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { AttachButtons, PendingFiles, useComposerFiles } from "../components/Attachments.js";
import { Avatar } from "../components/Avatar.js";
import {
  ChatLanding,
  CrewPicker,
  CrewStrip,
  directCandidates,
  useDraft,
} from "../components/CrewChat.js";
import { NavIcon } from "../components/icons.js";
import { PetDock } from "../components/Pet.js";
import { TimelineView } from "../components/Timeline.js";
import { TopBarTitle } from "../components/TopBar.js";
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
import { dockPets } from "../lib/pets.js";
import { splitHighlights } from "../lib/search.js";
import { surfaceLabel } from "../lib/shipyard.js";
import { initialTimeline, timelineReducer } from "../lib/timeline.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { socket, useServerEvents, useSocketState } from "../ws.js";

function conversationTitle(
  c: ConversationDto,
  crew: CrewDto[],
  crewName: (name: string) => string,
  t: (text: string) => string,
): string {
  if (c.title) return c.title;
  if (c.kind === "direct") {
    const member = crew.find((m) => m.slug === c.crewSlug);
    return member ? crewName(member.name) : (c.crewSlug ?? t("Crew member"));
  }
  return "New chat";
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
  const words = useThemeWords();
  const t = useThemeText();
  // A watch's run is labelled with the theme's word for watches, in the singular.
  const surface = c.surface === "watch" ? singular(words.watches) : surfaceLabel(c.surface);
  const projectName = c.projectId ? (projectNames.get(c.projectId) ?? "Project") : null;
  return (
    <>
      {surface && <Badge tone={c.surface === "discord" ? "accent" : "neutral"}>{surface}</Badge>}
      {c.projectId &&
        (linkProject ? (
          <a
            href={href(`/shipyard/${c.projectId}`)}
            title={t("Open the project in the Shipyard")}
            className={cx(
              "inline-flex min-w-0 max-w-40 items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 hover:underline dark:bg-amber-900/50 dark:text-amber-100",
              focusRing,
            )}
          >
            <span className="truncate">{projectName}</span>
          </a>
        ) : (
          <span className="inline-flex min-w-0 max-w-40 items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
            <span className="truncate">{projectName}</span>
          </span>
        ))}
    </>
  );
}

/** Thread header buttons: a 36px square tap target until 2xl, a labelled button from there. */
const headerAction = "shrink-0 max-2xl:size-9 max-2xl:p-0";

export function BridgePage({ conversationId }: { conversationId: string | null }) {
  const conversations = useResource(() => api.listConversations().then((r) => r.conversations));
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  const models = useResource(() => api.listModels().then((r) => r.models));
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [picking, setPicking] = useState(false);
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
  // A Captain on Claude Code, Codex, Cursor or Gemini CLI answers without a provider.
  const captainOnCli = crewList.some((m) => m.captain && m.backend !== "pi");
  const noModels = models.data !== null && !models.data.some((m) => m.available) && !captainOnCli;
  const current =
    conversations.data?.find((c) => c.id === conversationId) ??
    search.results?.find((r) => r.conversation.id === conversationId)?.conversation ??
    null;
  const projectNames = useProjectNames(
    conversations.data?.some((c) => c.projectId !== null) ?? false,
  );

  async function createBridge() {
    setCreating(true);
    setCreateError(null);
    try {
      const { conversation } = await api.createConversation({ kind: "bridge" });
      opened(conversation);
      navigate(`/bridge/${conversation.id}`);
    } catch (err) {
      setCreateError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  /** Put a just-opened conversation at the top of the list (once). */
  /**
   * Show a just-opened conversation in the list. A reopened one stays where it is (keeping its
   * preview, which only the list carries); a new one goes first after the pinned ones.
   */
  function opened(conversation: ConversationDto) {
    const list = conversations.data ?? [];
    if (list.some((x) => x.id === conversation.id)) {
      conversations.setData(
        list.map((x) => (x.id === conversation.id ? { ...conversation, preview: x.preview } : x)),
      );
      return;
    }
    const at = list.findIndex((x) => !x.pinned);
    const i = at < 0 ? list.length : at;
    conversations.setData([...list.slice(0, i), conversation, ...list.slice(i)]);
  }

  const canDirect = directCandidates(crewList).length > 0;
  const crewName = useCrewName();
  const t = useThemeText();
  const captainName = crewName(crewList.find((m) => m.captain)?.name ?? "Captain");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {noModels && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
          No AI model is set up yet, so nothing can answer.{" "}
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
            <div className="flex gap-2">
              <Button
                variant="primary"
                className="flex-1"
                disabled={creating}
                onClick={() => void createBridge()}
              >
                New chat
              </Button>
              {canDirect && (
                <Button
                  disabled={creating}
                  title="Chat with one of them yourself"
                  aria-haspopup="dialog"
                  onClick={() => setPicking(true)}
                >
                  Chat with…
                </Button>
              )}
            </div>
            <ErrorText>{createError}</ErrorText>
            <CrewStrip
              crew={crewList}
              creating={creating}
              onNewBridge={() => void createBridge()}
              onOpened={opened}
            />
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
                  "w-full rounded-md border border-control bg-white px-3 py-2 text-sm dark:bg-slate-900",
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
            <div className="relative min-h-0 flex-1 overflow-y-auto p-2 md:pb-[calc(0.5rem+var(--safe-bottom))]">
              {conversations.error && <ErrorText>{conversations.error}</ErrorText>}
              {conversations.data?.length === 0 && (
                <p className="p-3 text-sm text-slate-500 dark:text-slate-400">
                  No conversations yet. Start a new chat.
                </p>
              )}
              <ul className="stagger space-y-0.5">
                {conversations.data?.map((c, i, all) => (
                  <li key={c.id}>
                    {c.pinned && i === 0 && <ListLabel>Pinned</ListLabel>}
                    {!c.pinned && i > 0 && all[i - 1]?.pinned && <ListLabel>Recent</ListLabel>}
                    <ConversationRow
                      c={c}
                      title={conversationTitle(c, crewList, crewName, t)}
                      who={withWhom(c, crewList, captainName, crewName, t)}
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
              title={current ? conversationTitle(current, crewList, crewName, t) : ""}
              crew={crewList}
              member={
                current?.kind === "direct"
                  ? (crewList.find((m) => m.slug === current.crewSlug) ?? null)
                  : (crewList.find((m) => m.captain) ?? null)
              }
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
            <div className="relative min-h-0 flex-1 overflow-y-auto">
              <ChatLanding
                crew={crewList}
                conversations={conversations.data}
                creating={creating}
                onNewBridge={() => void createBridge()}
                onOpened={opened}
              />
            </div>
          )}
        </section>
      </div>
      <CrewPicker
        open={picking}
        onClose={() => setPicking(false)}
        crew={crewList}
        conversations={conversations.data}
        onOpened={opened}
      />
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
  who,
  active,
  projectNames,
  onRenamed,
  onPinned,
  onDeleted,
}: {
  c: ConversationDto;
  title: string;
  /** Who the chat is with: its crew member, or the Captain. */
  who: string;
  active: boolean;
  projectNames: Map<string, string>;
  onRenamed: (c: ConversationDto) => void;
  onPinned: () => void;
  onDeleted: () => void;
}) {
  const words = useThemeWords();
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
        className={cx("flex items-start gap-2.5 rounded-md px-2.5 py-2", focusRing)}
      >
        <Avatar name={who} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1 text-sm font-medium">
              {c.pinned && <PinGlyph />}
              <span className="truncate">{title}</span>
            </span>
            <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {formatTime(c.updatedAt)}
            </span>
          </span>
          {c.preview && (
            <span className="mt-0.5 block truncate text-xs text-slate-600 dark:text-slate-300">
              {c.preview}
            </span>
          )}
          <span className="mt-0.5 flex min-h-9 min-w-0 flex-wrap items-center gap-1.5 pr-32 text-xs sm:min-h-7 sm:pr-24 text-slate-500 dark:text-slate-400">
            {c.kind === "bridge" ? `${words.bridge} · ${who}` : `Direct · ${who}`}
            <ConversationTags c={c} projectNames={projectNames} />
          </span>
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
  crew,
  member,
  tags,
  onRenamed,
  onPinned,
  onDeleted,
}: {
  conversationId: string;
  conversation: ConversationDto | null;
  title: string;
  /** Everyone aboard, for the pets of crew members who speak in this conversation. */
  crew: CrewDto[];
  /** Who answers here: the crew member of a direct chat, or the Captain. */
  member: CrewDto | null;
  tags: ReactNode;
  onRenamed: (c: ConversationDto) => void;
  onPinned: () => void;
  onDeleted: () => void;
}) {
  const words = useThemeWords();
  const crewName = useCrewName();
  const t = useThemeText();
  const user = useUser();
  const socketState = useSocketState();
  // Chats from Discord, Telegram or Slack (opened from search) are shown, not continued. A
  // watch's run can be answered: the crew member who ran it still has its context.
  const readOnly =
    conversation !== null && conversation.surface !== "web" && conversation.surface !== "watch";
  const [state, dispatch] = useReducer(timelineReducer, initialTimeline);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useDraft(conversationId);
  const [resetting, setResetting] = useState(false);
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

  // Whether the last load ran with the socket open; a reply saved before the socket opened
  // reaches neither that load nor the socket, so the first open loads again.
  const loadedLive = useRef(false);
  const load = useCallback(async () => {
    loadedLive.current = socket.state === "open";
    dispatch({ type: "open", conversationId });
    setLoadError(null);
    try {
      const { messages } = await api.listMessages(conversationId);
      dispatch({ type: "loaded", conversationId, messages });
      // The crew may still be working (they carry on while the page is closed): catch up.
      socket.send({ type: "watch", conversationId });
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
      if (dropped.current || !loadedLive.current) void load();
      else socket.send({ type: "watch", conversationId });
      dropped.current = false;
      seenOpen.current = true;
    } else if (seenOpen.current) {
      dropped.current = true;
    }
  }, [socketState, load, conversationId]);

  const pets = readOnly ? [] : dockPets(state.items, crew, member);
  // Pets fade back while someone reads further up, so they never sit on top of what is read.
  const [readingBack, setReadingBack] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the items (or the room left for pets) change
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items, restoredApprovals.length, pets.length > 0]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setReadingBack(!stick.current);
  }

  /** The crew forget the chat so far; the messages stay, below a divider. */
  async function startFresh() {
    if (state.busy || resetting) return;
    setResetting(true);
    try {
      const { message } = await api.resetConversation(conversationId);
      // Shown now even if the live event never arrives (socket down); duplicates are dropped.
      dispatch({ type: "event", event: { type: "message", conversationId, message } });
      setSendError(null);
      stick.current = true;
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setResetting(false);
    }
  }

  /** `spoken`: text from the mic in hands-free mode, sent as is (with any attached files). */
  function send(e?: FormEvent, spoken?: string) {
    e?.preventDefault();
    const body = (spoken ?? text).trim();
    // Typing /new on its own starts fresh, like the button.
    if (spoken === undefined && body === "/new" && !files.ids.length) {
      setText("");
      void startFresh();
      return;
    }
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
  const subtitle = member
    ? conversation?.kind === "direct"
      ? `${crewName(member.name)} · ${t(member.role)}`
      : `${crewName(member.name)} · brings in the right ${words.crewMember}`
    : null;

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
                "min-w-0 flex-1 rounded-md border border-control bg-white px-2 py-1 text-sm dark:bg-slate-900",
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
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              {member && (
                <span className="hidden md:contents">
                  <Avatar name={crewName(member.name)} />
                </span>
              )}
              <div className="hidden min-w-0 md:block">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="min-w-0 truncate font-semibold">{title}</h1>
                  <span className="flex min-w-0 items-center gap-1.5 overflow-hidden [&>*]:min-w-0">
                    {tags}
                  </span>
                </div>
                {subtitle && (
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
                )}
              </div>
              {/* Phones: the title is up in the top bar, so this row only has the tags. */}
              <span className="flex min-w-0 items-center gap-1.5 overflow-hidden md:hidden [&>*]:min-w-0">
                {tags}
              </span>
              {member && (
                <a
                  href={href(`/crew/${member.slug}`)}
                  title={`${crewName(member.name)}'s settings`}
                  aria-label={`${crewName(member.name)}'s settings`}
                  className={cx(
                    "hidden shrink-0 rounded p-1 text-slate-400 transition-colors md:block hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200",
                    focusRing,
                  )}
                >
                  <GearGlyph />
                </a>
              )}
            </div>
            {voice && voice.stt !== "off" && !readOnly && (
              <Button
                size="sm"
                variant={handsFree ? "primary" : "ghost"}
                aria-pressed={handsFree}
                className="shrink-0"
                title="Read replies aloud and send what you say right away"
                onClick={() => setHandsFree(!handsFree)}
              >
                Hands-free
              </Button>
            )}
            {conversation?.surface === "web" && (
              <>
                {/* Icons only until there is room for words, so the title keeps its space. */}
                <Button
                  size="sm"
                  variant="ghost"
                  className={headerAction}
                  disabled={state.busy || resetting}
                  title={t(
                    "Start fresh: the crew members forget this chat so far, and the messages stay here. You can also type /new.",
                  )}
                  onClick={() => void startFresh()}
                >
                  <FreshGlyph />
                  <span className="sr-only 2xl:not-sr-only">Start fresh</span>
                </Button>
                {/* Pin, rename and delete: in a menu until the header is wide enough for all. */}
                <span className="2xl:hidden">
                  <MoreMenu
                    items={[
                      {
                        label: conversation.pinned ? "Unpin" : "Pin",
                        icon: "pin",
                        onSelect: () => void togglePin(),
                      },
                      {
                        label: "Rename",
                        icon: "pencil",
                        onSelect: () => setRenaming(conversation.title ?? ""),
                      },
                      {
                        label: "Delete",
                        icon: "trash",
                        danger: true,
                        onSelect: () => void remove(),
                      },
                    ]}
                  />
                </span>
                <span className="hidden items-center gap-2 2xl:flex">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-pressed={conversation.pinned}
                    onClick={() => void togglePin()}
                  >
                    <NavIcon name="pin" size={16} />
                    {conversation.pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(conversation.title ?? "")}
                  >
                    <NavIcon name="pencil" size={16} />
                    Rename
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove()}>
                    <NavIcon name="trash" size={16} />
                    Delete
                  </Button>
                </span>
              </>
            )}
          </>
        )}
      </div>
      <TopBarTitle>
        <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        {subtitle && (
          <p className="truncate text-xs leading-tight text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        )}
      </TopBarTitle>

      <div
        ref={scroller}
        onScroll={onScroll}
        className={cx(
          "relative min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6",
          // Room for the pets sitting on the message box, so they never cover the last message.
          pets.length > 0 && "pb-16",
        )}
        aria-live="polite"
        aria-busy={state.busy}
      >
        <div className="mx-auto max-w-3xl">
          {loadError && <ErrorText>{loadError}</ErrorText>}
          {state.items.length === 0 && restoredApprovals.length === 0 && !loadError && (
            <EmptyState
              className="mt-6 border-none bg-transparent dark:bg-transparent"
              icon={
                member && conversation?.kind === "direct" ? (
                  <Avatar name={crewName(member.name)} size="lg" />
                ) : (
                  <NavIcon name="bridge" size={22} />
                )
              }
              title={
                member && conversation?.kind === "direct"
                  ? `This is your chat with ${crewName(member.name)}`
                  : "No messages yet"
              }
            >
              {member && conversation?.kind === "direct"
                ? `${t(member.role)}. Ask a question, think something through, or hand over a job.`
                : `Say hello. Ask for anything, and the right ${words.crewMember} picks it up.`}
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
        <p className="border-t border-slate-200 bg-white px-3 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] text-center text-sm text-slate-500 sm:px-6 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {`This conversation happened in ${surfaceLabel(conversation?.surface ?? "") ?? "another app"}. Reply there to continue it.`}
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
          className="border-t border-slate-200 bg-white px-3 pt-3 pb-[calc(0.75rem+var(--safe-bottom))] sm:px-6 dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="relative mx-auto max-w-3xl space-y-2">
            <PetDock
              pets={pets}
              className={cx(
                "absolute bottom-[calc(100%+0.5rem)] left-1 transition-opacity duration-300",
                readingBack && "opacity-25 [&>*]:pointer-events-none!",
              )}
            />
            {state.error && (
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <ChatError message={state.error} detail={state.errorDetail} />
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
                placeholder={
                  state.busy
                    ? `${member ? crewName(member.name) : `The ${words.crew.toLowerCase()}`} is working…`
                    : conversation?.kind === "direct" && member
                      ? `Message ${crewName(member.name)}`
                      : `Message the ${words.crew.toLowerCase()}`
                }
                className={cx(
                  "min-h-[42px] flex-1 resize-none rounded-xl border border-control bg-white px-3.5 py-2 text-[15px] shadow-xs transition-[border-color,box-shadow] duration-150 dark:bg-slate-950",
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
                : "Enter to send, Shift+Enter for a new line, /new to start fresh."}
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

/** Who a conversation is with: its crew member, or the Captain for a bridge chat. */
function withWhom(
  c: ConversationDto,
  crew: CrewDto[],
  captainName: string,
  crewName: (name: string) => string,
  t: (text: string) => string,
): string {
  if (c.kind !== "direct") return captainName;
  const member = crew.find((m) => m.slug === c.crewSlug);
  return member ? crewName(member.name) : (c.crewSlug ?? t("Crew member"));
}

type MenuItem = {
  label: string;
  icon: "pin" | "pencil" | "trash";
  danger?: boolean;
  onSelect: () => void;
};

/** A "more" button that opens a short list of actions below it. */
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // Back to the button, so the keyboard does not lose its place.
      box.current?.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <Button
        size="sm"
        variant="ghost"
        className={headerAction}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <DotsGlyph />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-30 mt-1 w-40 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg animate-page-in dark:border-slate-700 dark:bg-slate-900"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
              className={cx(
                "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800",
                focusRing,
                it.danger ? "text-red-700 dark:text-red-300" : "text-slate-700 dark:text-slate-200",
              )}
            >
              <NavIcon name={it.icon} size={16} />
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DotsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  );
}

function FreshGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function GearGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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
  const crewName = useCrewName();
  const t = useThemeText();
  return (
    <div
      className="relative min-h-0 flex-1 overflow-y-auto p-2 md:pb-[calc(0.5rem+var(--safe-bottom))]"
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
                  <span className="truncate">
                    {conversationTitle(r.conversation, crewList, crewName, t)}
                  </span>
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
                  <span className="font-medium">{crewName(m.author)}: </span>
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

/** Why the last reply failed, with the provider's own words behind "More details". */
function ChatError({ message, detail }: { message: string; detail: string | null }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  return (
    <div>
      <ErrorText>{message}</ErrorText>
      {detail && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((o) => !o)}
            className={cx(
              "mt-1 rounded px-1 text-xs font-medium text-slate-600 underline underline-offset-2 dark:text-slate-300",
              focusRing,
            )}
          >
            {open ? "Hide details" : "More details"}
          </button>
          {open && (
            <pre
              id={detailId}
              className="mt-1 max-h-48 overflow-auto rounded border border-slate-200 bg-slate-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300"
            >
              {detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
