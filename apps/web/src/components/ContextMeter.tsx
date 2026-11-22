import type { ChatContextDto } from "@shipmate/core";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { href } from "../router.js";
import { useServerEvents } from "../ws.js";
import { cx, focusRing } from "./ui.js";

/** 84213 → "84K", 1_000_000 → "1M". */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Share of the window used, 0 to 1; null when the engine does not say. */
export function contextShare(c: ChatContextDto | null): number | null {
  if (!c || c.tokens === null || !c.window) return null;
  return Math.max(0, Math.min(1, c.tokens / c.window));
}

const ENGINE_NOTE: Record<ChatContextDto["engine"], string> = {
  pi: "When it fills up, older messages get summed up to make room.",
  "claude-code": "When it fills up, Claude Code sums up older messages to make room.",
  codex: "Codex handles its own context and doesn't say how full it is.",
  cursor: "Cursor handles its own context and doesn't say how full it is.",
  gemini: "Gemini CLI handles its own context and doesn't say how full it is.",
};

/** The chat's context after its last reply, kept up to date as replies land. */
export function useChatContext(conversationId: string): {
  context: ChatContextDto | null;
  clear: () => void;
} {
  const [context, setContext] = useState<ChatContextDto | null>(null);
  useEffect(() => {
    let live = true;
    setContext(null);
    api
      .conversationContext(conversationId)
      .then((r) => live && setContext(r.context))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversationId]);
  useServerEvents((ev) => {
    if (ev.type === "context" && ev.conversationId === conversationId) setContext(ev.context);
  });
  return { context, clear: () => setContext(null) };
}

/**
 * A small ring in the chat header showing how full the context is; tap for the numbers. Hidden
 * until a reply has said, and for engines that do not report it.
 */
export function ContextMeter({
  context,
  onStartFresh,
  className,
}: {
  context: ChatContextDto | null;
  onStartFresh?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const share = contextShare(context);
  if (!context || share === null) return null;
  const pct = Math.round(share * 100);
  const tone = share >= 0.9 ? "danger" : share >= 0.7 ? "warn" : "ok";
  const ring = {
    ok: "text-accent-600 dark:text-accent-400",
    warn: "text-amber-500 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
  }[tone];
  const r = 7;
  const length = 2 * Math.PI * r;

  return (
    <div ref={box} className={cx("relative shrink-0", className)}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Context ${pct}% full`}
        title={`Context ${pct}% full`}
        onClick={() => setOpen(!open)}
        className={cx(
          "flex h-9 items-center gap-1 rounded-md px-1.5 text-xs font-medium tabular-nums text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
          focusRing,
        )}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="-rotate-90">
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            strokeWidth="2.5"
            className="stroke-slate-200 dark:stroke-slate-700"
          />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${Math.max(0.5, share * length)} ${length}`}
            className={ring}
          />
        </svg>
        <span>{pct}%</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Context"
          className="absolute top-full right-0 z-30 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg animate-page-in dark:border-slate-700 dark:bg-slate-900"
        >
          <p className="font-medium">Context {pct}% full</p>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
            aria-hidden="true"
          >
            <div
              className={cx(
                "h-full rounded-full",
                {
                  ok: "bg-accent-600 dark:bg-accent-500",
                  warn: "bg-amber-500 dark:bg-amber-400",
                  danger: "bg-red-600 dark:bg-red-500",
                }[tone],
              )}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
            {shortTokens(context.tokens ?? 0)} of {shortTokens(context.window ?? 0)} tokens ·{" "}
            {context.crew.name}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {ENGINE_NOTE[context.engine]}
          </p>
          <div className="mt-3 flex items-center justify-between gap-2 text-xs">
            {onStartFresh ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onStartFresh();
                }}
                className={cx(
                  "rounded px-1 py-0.5 font-medium text-accent-700 hover:underline dark:text-accent-300",
                  focusRing,
                )}
              >
                Start fresh
              </button>
            ) : (
              <span />
            )}
            <a
              href={href("/usage")}
              className={cx(
                "rounded px-1 py-0.5 font-medium text-accent-700 hover:underline dark:text-accent-300",
                focusRing,
              )}
            >
              Usage limits
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
