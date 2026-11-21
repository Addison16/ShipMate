import type { SharedChatDto } from "@shipmate/core";
import { useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { useThemeWords } from "../appearance.js";
import { BrandLogo } from "../components/Logo.js";
import { Markdown } from "../components/Markdown.js";
import { Loading } from "../components/ui.js";
import { formatTime } from "../lib/format.js";
import { shareApi } from "../lib/share.js";

/** #/shared/<token>: a chat someone shared, for anyone with the link. Read-only, no sign-in. */
export function SharedChatPage({ token }: { token: string }) {
  const words = useThemeWords();
  const [chat, setChat] = useState<SharedChatDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setChat(null);
    setError(null);
    shareApi.view(token).then(
      (c) => {
        if (!live) return;
        setChat(c);
        document.title = c.title;
      },
      (err) => live && setError(errorMessage(err)),
    );
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <header className="border-b border-slate-200 bg-white px-4 py-3 pt-[calc(0.75rem+var(--safe-top,0px))] dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <BrandLogo size={32} />
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">{chat?.title ?? "Shared chat"}</h1>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">
              {chat
                ? `Shared by ${chat.sharedBy} from ${words.appName} · as of ${formatTime(chat.sharedThrough)}`
                : `From ${words.appName}`}
            </p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6 pb-[calc(2rem+var(--safe-bottom,0px))]">
        {!chat && !error && <Loading />}
        {error && (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
            <p className="font-medium">This link does not work any more.</p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              The person who shared it may have stopped sharing or deleted the chat.
            </p>
          </div>
        )}
        {chat?.messages.length === 0 && (
          <p className="text-center text-sm text-slate-500">This chat has no messages.</p>
        )}
        {chat?.messages.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, read-only list
          <article key={i} className={m.role === "user" ? "flex flex-col items-end" : ""}>
            <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-700 dark:text-slate-200">{m.name}</span> ·{" "}
              {formatTime(m.createdAt)}
            </p>
            <div
              className={
                m.role === "user"
                  ? "max-w-[85%] rounded-2xl bg-accent-700 px-4 py-2.5 text-white dark:bg-accent-600"
                  : "max-w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900"
              }
            >
              <Markdown text={m.content} />
            </div>
          </article>
        ))}
        {chat && (
          <p className="pt-4 text-center text-xs text-slate-500 dark:text-slate-400">
            Read-only copy. Replies written after it was shared are not shown.
          </p>
        )}
      </main>
    </div>
  );
}
