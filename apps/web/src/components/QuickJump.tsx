import type { CrewDto } from "@shipmate/core";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../api.js";
import { useCrewName, useThemeText, useThemeWords } from "../appearance.js";
import { useUser } from "../auth.js";
import {
  canSee,
  type Destination,
  MAIN_NAV,
  SETTINGS_HOME,
  searchDestinations,
  visibleSections,
  withWords,
} from "../lib/nav.js";
import { navigate } from "../router.js";
import { NavIcon } from "./icons.js";
import { cx, focusRing } from "./ui.js";

interface Result extends Destination {
  /** Small grey label on the right: where the result lives. */
  where: string;
}

/** True when the key press lands in a text field, so "/" types instead of opening search. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

/** Opens on Ctrl+K / Cmd+K or "/" anywhere outside a text field. */
export function useQuickJumpShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        open();
      } else if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
        e.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

export function shortcutLabel(): string {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘K"
    : "Ctrl K";
}

/** The sidebar's "Search" button: looks like a field, opens the jump box. */
export function QuickJumpButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-500 hover:border-accent-300 hover:text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400 dark:hover:text-slate-200",
        focusRing,
      )}
    >
      <NavIcon name="search" size={16} />
      <span className="flex-1 text-left">Search</span>
      <kbd className="rounded border border-slate-200 bg-white px-1.5 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400 dark:bg-slate-900">
        {shortcutLabel()}
      </kbd>
    </button>
  );
}

/** Jump to any page, settings screen or crew member by typing a few letters. */
export function QuickJump({ onClose }: { onClose: () => void }) {
  const user = useUser();
  const words = useThemeWords();
  const t = useThemeText();
  const crewName = useCrewName();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [crew, setCrew] = useState<CrewDto[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let live = true;
    api
      .listCrew()
      .then(({ crew }) => {
        if (!live) return;
        setCrew(crew);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const all = useMemo<Result[]>(
    () => [
      ...MAIN_NAV.filter((d) => canSee(user, d.access)).map((d) => ({
        ...withWords(d, words),
        where: "Page",
      })),
      { ...SETTINGS_HOME, where: "Page" },
      ...visibleSections(user).map((s) => ({
        ...s,
        label: t(s.label),
        hint: t(s.hint),
        keywords: s.label === t(s.label) ? s.keywords : [...s.keywords, s.label.toLowerCase()],
        where: `Settings · ${t(s.group)}`,
      })),
      ...crew.map(
        (c): Result => ({
          id: `crew:${c.slug}`,
          path: `/crew/${c.slug}`,
          label: crewName(c.name),
          hint: t(c.role),
          icon: "crew",
          access: "all",
          keywords: [c.slug],
          where: t("Crew member"),
        }),
      ),
    ],
    [user, crew, words, t, crewName],
  );
  const results = useMemo(() => searchDestinations(all, query).slice(0, 12), [all, query]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(results.length - 1, 0)));
  }, [results.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function go(r: Result | undefined) {
    if (!r) return;
    onClose();
    navigate(r.path);
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (results.length ? (i - 1 + results.length) % results.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close search"
        className="slide-over-backdrop absolute inset-0 bg-slate-950/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Search ${words.appName}`}
        className="relative w-full max-w-lg animate-scale-in overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 dark:border-slate-800">
          <span className="text-slate-500 dark:text-slate-400">
            <NavIcon name="search" />
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-jump-results"
            aria-activedescendant={results[active] ? `quick-jump-${active}` : undefined}
            aria-label="Where to?"
            placeholder={t("Where to? Try “Discord”, “password” or a crew member")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="w-full bg-transparent py-3.5 text-[15px] outline-none placeholder:text-slate-500"
          />
          <kbd className="hidden rounded border border-slate-200 px-1.5 text-[11px] text-slate-500 sm:block dark:text-slate-400 dark:border-slate-700">
            Esc
          </kbd>
        </div>
        <div
          ref={listRef}
          id="quick-jump-results"
          role="listbox"
          aria-label="Results"
          className="relative max-h-[60vh] overflow-y-auto p-2"
        >
          {results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-500">
              Nothing matches “{query.trim()}”.
            </p>
          )}
          {results.map((r, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the input above handles the keyboard
            <div
              key={r.id}
              tabIndex={-1}
              id={`quick-jump-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseMove={() => setActive(i)}
              onClick={() => go(r)}
              className={cx(
                "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2",
                i === active ? "bg-accent-50 dark:bg-accent-500/15" : "",
              )}
            >
              <span
                className={cx(
                  "grid size-8 shrink-0 place-items-center rounded-md",
                  i === active
                    ? "bg-accent-600 text-white dark:bg-accent-500/30 dark:text-accent-100"
                    : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
                )}
              >
                <NavIcon name={r.icon} size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{r.label}</span>
                <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                  {r.hint}
                </span>
              </span>
              <span className="hidden shrink-0 text-[11px] text-slate-500 sm:block dark:text-slate-400">
                {r.where}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
