import { useState } from "react";
import { href } from "../router.js";
import { useServerEvents } from "../ws.js";
import { cx, focusRing } from "./ui.js";

interface Toast {
  id: string;
  title: string;
  body: string;
  link: string;
}

/** App-wide dismissible notices; today: failed watch runs. */
export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useServerEvents((ev) => {
    if (ev.type !== "watch_run" || ev.run.status !== "failed") return;
    const id = ev.run.id;
    setToasts((ts) =>
      ts.some((t) => t.id === id)
        ? ts
        : [
            ...ts.slice(-3),
            {
              id,
              title: `Watch "${ev.watchName}" failed`,
              body: ev.run.error ?? "The run failed without an error message.",
              link: `/watches/${ev.run.watchId}`,
            },
          ],
    );
  });

  const dismiss = (id: string) => setToasts((ts) => ts.filter((t) => t.id !== id));

  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed top-16 right-3 z-40 md:top-3 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="pointer-events-auto rounded-lg border border-red-200 bg-white p-3 text-sm shadow-lg dark:border-red-900 dark:bg-slate-900"
        >
          <div className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-red-500" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-red-800 dark:text-red-200">{t.title}</p>
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
                View runs
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
