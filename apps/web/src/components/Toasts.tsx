import { useState } from "react";
import { useThemeWords } from "../appearance.js";
import { href } from "../router.js";
import { useServerEvents } from "../ws.js";
import { cx, focusRing } from "./ui.js";

/** How long a finished run's notice stays up. */
const SUCCESS_TOAST_MS = 10_000;

interface Toast {
  id: string;
  title: string;
  body: string;
  link: string;
  linkText: string;
  failed: boolean;
}

/** App-wide dismissible notices: finished and failed watch runs. */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const words = useThemeWords();
  const dismiss = (id: string) => setToasts((ts) => ts.filter((t) => t.id !== id));

  useServerEvents((ev) => {
    if (ev.type !== "watch_run") return;
    const run = ev.run;
    const failed = run.status === "failed";
    if (!failed && run.status !== "succeeded") return;
    const toast: Toast = failed
      ? {
          id: run.id,
          title: `"${ev.watchName}" failed`,
          body: run.error ?? "The run failed without an error message.",
          link: `/watches/${run.watchId}`,
          linkText: "View runs",
          failed,
        }
      : {
          id: run.id,
          title: ev.watchName,
          body: run.output?.trim() || "Done.",
          link: run.conversationId ? `/bridge/${run.conversationId}` : `/watches/${run.watchId}`,
          linkText: run.conversationId ? "Open" : `View in ${words.watches}`,
          failed,
        };
    setToasts((ts) => (ts.some((t) => t.id === toast.id) ? ts : [...ts.slice(-3), toast]));
    // A result stays in the chat list, so its notice can go by itself; a failure waits.
    if (!failed) setTimeout(() => dismiss(toast.id), SUCCESS_TOAST_MS);
  });

  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed top-[calc(4rem+env(safe-area-inset-top))] right-3 z-40 md:top-3 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.failed ? "alert" : "status"}
          className={cx(
            "pointer-events-auto animate-toast-in rounded-lg border bg-white p-3 text-sm shadow-lg dark:bg-slate-900",
            t.failed
              ? "border-red-200 dark:border-red-900"
              : "border-slate-200 dark:border-slate-700",
          )}
        >
          <div className="flex items-start gap-2">
            <span
              aria-hidden="true"
              className={cx(
                "mt-1.5 size-2 shrink-0 rounded-full",
                t.failed ? "bg-red-500" : "bg-emerald-500",
              )}
            />
            <div className="min-w-0 flex-1">
              <p
                className={cx(
                  "font-medium",
                  t.failed
                    ? "text-red-800 dark:text-red-200"
                    : "text-slate-900 dark:text-slate-100",
                )}
              >
                {t.title}
              </p>
              <p className="mt-0.5 line-clamp-3 break-words text-slate-600 dark:text-slate-300">
                {t.body}
              </p>
              <a
                href={href(t.link)}
                onClick={() => dismiss(t.id)}
                className={cx(
                  "mt-1 inline-block rounded text-xs font-medium text-accent-700 underline underline-offset-2 dark:text-accent-300",
                  focusRing,
                )}
              >
                {t.linkText}
              </a>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className={cx(
                "rounded p-1 text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                focusRing,
              )}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
