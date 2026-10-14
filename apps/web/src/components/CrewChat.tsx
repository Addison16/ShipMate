import type { ConversationDto, CrewDto } from "@shipmate/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useKeyboardInset } from "../lib/keyboard.js";
import { href, navigate } from "../router.js";
import { Avatar } from "./Avatar.js";
import { Button, cx, ErrorText, focusRing } from "./ui.js";

/** Crew members someone can talk to directly: active ones other than the Captain. */
export function directCandidates(crew: CrewDto[]): CrewDto[] {
  return crew.filter((m) => m.status === "active" && !m.captain);
}

/**
 * Open the person's chat with one crew member: their latest direct chat if there is one, so
 * talking to someone again continues where it left off, or a new one.
 */
export async function openDirectChat(
  slug: string,
  onOpened: (c: ConversationDto) => void,
): Promise<void> {
  const { conversation } = await api.createConversation({
    kind: "direct",
    crewSlug: slug,
    reuse: true,
  });
  onOpened(conversation);
  navigate(`/bridge/${conversation.id}`);
}

/** Crew slugs the person already has a direct chat with. */
export function chattedWith(conversations: ConversationDto[] | null): Set<string> {
  return new Set(
    (conversations ?? []).flatMap((c) => (c.kind === "direct" && c.crewSlug ? [c.crewSlug] : [])),
  );
}

/** One crew member as a tappable row or card: avatar, name and what they do. */
function MemberButton({
  member,
  subtitle,
  busy,
  disabled,
  active,
  onClick,
  card,
}: {
  member: { name: string; role: string };
  subtitle?: string;
  busy?: boolean;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  card?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        "group flex w-full min-w-0 items-center gap-3 text-left transition disabled:opacity-60",
        card
          ? "rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-md motion-reduce:hover:translate-y-0 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-accent-700"
          : "rounded-lg px-2.5 py-2",
        !card &&
          (active
            ? "bg-accent-700/10 dark:bg-accent-400/10"
            : "hover:bg-slate-100 dark:hover:bg-slate-800"),
        focusRing,
      )}
    >
      <Avatar name={member.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{member.name}</span>
        <span className="truncate text-xs text-slate-500 dark:text-slate-400">
          {busy ? "Opening chat…" : (subtitle ?? member.role)}
        </span>
      </span>
      {card && (
        <span
          aria-hidden="true"
          className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-accent-600 dark:text-slate-600 dark:group-hover:text-accent-400"
        >
          →
        </span>
      )}
    </button>
  );
}

/**
 * The Bridge with no chat open: who you can talk to, one tap away. The Captain starts a new
 * bridge chat; any other crew member opens your chat with them.
 */
export function ChatLanding({
  crew,
  conversations,
  onNewBridge,
  onOpened,
  creating,
}: {
  crew: CrewDto[];
  conversations: ConversationDto[] | null;
  onNewBridge: () => void;
  onOpened: (c: ConversationDto) => void;
  creating: boolean;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const captain = crew.find((m) => m.captain);
  const members = directCandidates(crew);
  const talked = chattedWith(conversations);

  async function open(slug: string) {
    setOpening(slug);
    setError(null);
    try {
      await openDirectChat(slug, onOpened);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl animate-fade-up flex-col gap-6 px-4 py-10">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Who would you like to talk to?</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Ask {captain?.name ?? "the Captain"} and the right crew member is pulled in, or talk to
          one of them yourself. Your chat with each crew member picks up where you left off.
        </p>
      </div>
      {captain && (
        <MemberButton
          card
          member={captain}
          subtitle="New bridge chat · hands each job to the right crew member"
          busy={creating}
          disabled={creating || opening !== null}
          onClick={onNewBridge}
        />
      )}
      {members.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
            Crew
          </p>
          <div className="stagger grid grid-cols-1 gap-2 sm:grid-cols-2">
            {members.map((m) => (
              <MemberButton
                key={m.slug}
                card
                member={m}
                subtitle={talked.has(m.slug) ? `${m.role} · continue chat` : m.role}
                busy={opening === m.slug}
                disabled={creating || opening !== null}
                onClick={() => void open(m.slug)}
              />
            ))}
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <a
        href={href("/crew")}
        className={cx(
          "self-start rounded text-sm text-accent-700 hover:underline dark:text-accent-300",
          focusRing,
        )}
      >
        Browse the whole crew
      </a>
    </div>
  );
}

/**
 * Phones: the crew as a row of avatars above the chat list (the landing page needs the room a
 * phone doesn't have), so starting a chat with anyone is one tap.
 */
export function CrewStrip({
  crew,
  creating,
  onNewBridge,
  onOpened,
}: {
  crew: CrewDto[];
  creating: boolean;
  onNewBridge: () => void;
  onOpened: (c: ConversationDto) => void;
}) {
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const captain = crew.find((m) => m.captain);
  const people = [...(captain ? [captain] : []), ...directCandidates(crew)];
  if (people.length < 2) return null;

  async function open(m: CrewDto) {
    if (m.captain) return onNewBridge();
    setOpening(m.slug);
    setError(null);
    try {
      await openDirectChat(m.slug, onOpened);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="md:hidden">
      <ul
        aria-label="Talk to"
        className="stagger -mx-3 flex snap-x gap-1 overflow-x-auto px-3 pt-1 [scrollbar-width:none]"
      >
        {people.map((m) => (
          <li key={m.slug} className="snap-start">
            <button
              type="button"
              disabled={creating || opening !== null}
              onClick={() => void open(m)}
              title={m.captain ? `New bridge chat with ${m.name}` : `Chat with ${m.name}`}
              className={cx(
                "flex w-16 flex-col items-center gap-1 rounded-lg py-1.5 transition active:scale-95 disabled:opacity-60",
                focusRing,
              )}
            >
              <span
                className={cx(
                  "rounded-full",
                  m.captain && "ring-2 ring-accent-500 ring-offset-2 dark:ring-offset-slate-900",
                  opening === m.slug && "animate-pulse",
                )}
              >
                <Avatar name={m.name} size="lg" />
              </span>
              <span className="w-full truncate text-center text-[11px] text-slate-600 dark:text-slate-300">
                {m.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** A searchable list of crew members to chat with, opened from the conversation list. */
export function CrewPicker({
  open,
  onClose,
  crew,
  conversations,
  onOpened,
}: {
  open: boolean;
  onClose: () => void;
  crew: CrewDto[];
  conversations: ConversationDto[] | null;
  onOpened: (c: ConversationDto) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyboard = useKeyboardInset(open);
  const talked = chattedWith(conversations);
  const q = query.trim().toLowerCase();
  const shown = directCandidates(crew).filter((m) =>
    `${m.name} ${m.role} ${m.slug}`.toLowerCase().includes(q),
  );

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery("");
      setIndex(0);
      setError(null);
      d.showModal();
      search.current?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  async function pick(slug: string) {
    setOpening(slug);
    setError(null);
    try {
      await openDirectChat(slug, onOpened);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setOpening(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (shown.length ? (i + step + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = shown[Math.min(index, shown.length - 1)];
      if (m && opening === null) void pick(m.slug);
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal dialog
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop (the dialog itself, outside its panel) closes it.
        if (e.target === dialog.current) onClose();
      }}
      aria-labelledby="crew-picker-title"
      // With the phone keyboard open, sit on top of it and fit the space left, so the matches
      // stay in view as the list narrows instead of sinking behind the keyboard.
      style={
        keyboard.inset > 0 && keyboard.height !== null
          ? { marginBottom: keyboard.inset, maxHeight: keyboard.height - 8, paddingBottom: 0 }
          : undefined
      }
      className="m-auto open:flex open:flex-col w-[min(28rem,calc(100vw-2rem))] rounded-xl max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:pb-[var(--safe-bottom)] border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/40 backdrop:backdrop-blur-[2px] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex min-h-0 flex-col">
        <div className="shrink-0 space-y-3 border-b border-slate-200 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-2">
            <h2 id="crew-picker-title" className="text-sm font-semibold">
              Chat with a crew member
            </h2>
            <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
              ✕
            </Button>
          </div>
          <label htmlFor="crew-picker-search" className="sr-only">
            Find a crew member
          </label>
          <input
            id="crew-picker-search"
            ref={search}
            type="search"
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Find by name or role"
            className={cx(
              "w-full rounded-md border border-control bg-white px-3 py-2 text-sm dark:bg-slate-950",
              focusRing,
            )}
          />
        </div>
        <div className="relative min-h-0 max-h-[50vh] overflow-y-auto overscroll-contain p-2 max-sm:max-h-[60vh]">
          {shown.length === 0 ? (
            <p className="px-2.5 py-6 text-sm text-slate-500 dark:text-slate-400">
              {q ? "No one matches. Try another name or role." : "No crew to chat with yet."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {shown.map((m, i) => (
                <li key={m.slug}>
                  <MemberButton
                    member={m}
                    subtitle={talked.has(m.slug) ? `${m.role} · continue chat` : m.role}
                    busy={opening === m.slug}
                    disabled={opening !== null}
                    active={i === index}
                    onClick={() => void pick(m.slug)}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="px-2.5">
            <ErrorText>{error}</ErrorText>
          </div>
        </div>
        <p className="border-t border-slate-200 px-4 py-2.5 text-xs max-sm:hidden text-slate-500 dark:border-slate-800 dark:text-slate-400">
          ↑ ↓ to choose, Enter to open. Each crew member keeps one chat with you.
        </p>
      </div>
    </dialog>
  );
}

const DRAFT_KEY = "shipmate.drafts";

function readDrafts(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The composer's text, kept per conversation for this browser tab, so switching chats loses nothing. */
export function useDraft(
  conversationId: string,
): [string, (next: string | ((t: string) => string)) => void] {
  const [text, setText] = useState(() => readDrafts()[conversationId] ?? "");
  useEffect(() => {
    try {
      const drafts = readDrafts();
      if (text) drafts[conversationId] = text;
      else delete drafts[conversationId];
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
    } catch {
      // Storage can be unavailable (private mode); the draft just isn't kept.
    }
  }, [conversationId, text]);
  return [text, setText];
}
