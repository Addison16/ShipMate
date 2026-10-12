import { useEffect, useId, useRef, useState } from "react";
import { useApprovals } from "../approvals.js";
import { approvalPath } from "../lib/approvals.js";
import { formatTime } from "../lib/format.js";
import { navigate } from "../router.js";
import { cx, focusRing } from "./ui.js";

/**
 * App-wide indicator for pending approvals from any conversation or watch. Renders nothing
 * while there are none; otherwise a button with the count that opens a list.
 */
export function ApprovalTray({ variant }: { variant: "sidebar" | "topbar" }) {
  const { pending } = useApprovals();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const count = pending.length;

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    panelRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const label = `${count} ${count === 1 ? "approval" : "approvals"} waiting`;

  return (
    <>
      <span className="sr-only" aria-live="polite">
        {count > 0 ? label : ""}
      </span>
      {count > 0 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className={cx(
            "flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100 dark:hover:bg-amber-900/50",
            variant === "sidebar" ? "w-full px-3 py-2 text-sm" : "px-2.5 py-1.5 text-xs",
            focusRing,
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-5 place-items-center rounded-full bg-amber-500 text-[11px] font-bold text-white"
          >
            {count}
          </span>
          {variant === "sidebar" ? label : <span className="sr-only">{label}</span>}
          {variant === "topbar" && <span aria-hidden="true">Approve</span>}
        </button>
      )}
      {open && count > 0 && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-label="Close approvals"
            tabIndex={-1}
            className="absolute inset-0 animate-fade-in cursor-default bg-slate-950/20"
            onClick={() => setOpen(false)}
          />
          <div
            id={panelId}
            ref={panelRef}
            role="dialog"
            aria-label="Pending approvals"
            className="absolute top-14 right-3 left-3 max-h-[70dvh] animate-scale-in overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl sm:left-auto sm:w-96 md:top-auto md:bottom-24 md:left-3 dark:border-slate-700 dark:bg-slate-900"
          >
            <p className="px-2 py-1.5 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
              Waiting for you
            </p>
            <ul className="space-y-1">
              {pending.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      navigate(approvalPath(a));
                    }}
                    className={cx(
                      "block w-full rounded-md px-2 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800",
                      focusRing,
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {a.crew.name}: <span className="font-mono">{a.toolName}</span>
                      </span>
                      <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                        {formatTime(a.createdAt)}
                      </span>
                    </span>
                    <span className="block truncate text-xs text-slate-600 dark:text-slate-300">
                      {a.summary}
                    </span>
                    <span className="block text-xs text-accent-700 dark:text-accent-300">
                      {a.conversationId ? "Open conversation" : "Open watch"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
