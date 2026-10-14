import { type CustomThemeSpec, logoDataUri, themePaint, themeWords } from "@shipmate/core";
import { useMemo, useState } from "react";
import { api } from "../api.js";
import { useUpdateAppearance } from "../appearance.js";
import { useUser } from "../auth.js";
import { previewStyle } from "../lib/theme.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { useServerEvents } from "../ws.js";
import { setDraft } from "./CrewChat.js";
import { NavIcon } from "./icons.js";
import { Logo } from "./Logo.js";
import { Button, cx, ErrorText } from "./ui.js";

/** The theme's logo (or the North Star) in white on its accent tile. */
export function ThemeTile({ theme, size = 40 }: { theme: CustomThemeSpec; size?: number }) {
  const style = useMemo(() => previewStyle(themePaint(theme)), [theme]);
  const mark = Math.round(size * 0.6);
  return (
    <span
      aria-hidden="true"
      style={{ ...style, width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-sm"
    >
      {theme.logo ? (
        <img src={logoDataUri(theme.logo)} width={mark} height={mark} alt="" />
      ) : (
        <Logo size={mark} />
      )}
    </span>
  );
}

/**
 * A small picture of the app in the theme: header, menu, a chat and a button, in its colors,
 * grays, font, corners, logo and words. It follows the page's light or dark mode.
 */
export function ThemePreview({ theme }: { theme: CustomThemeSpec }) {
  const style = useMemo(() => previewStyle(themePaint(theme)), [theme]);
  const w = themeWords(theme);
  return (
    <div
      style={style}
      className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100"
      aria-hidden="true"
    >
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        <ThemeTile theme={theme} size={24} />
        <span className="truncate text-sm font-semibold">{w.appName}</span>
      </div>
      <div className="flex gap-2 p-3">
        <div className="hidden w-24 shrink-0 space-y-1 min-[380px]:block">
          <span className="block truncate rounded-md bg-accent-600 px-2 py-1 text-xs font-medium text-white dark:bg-accent-500/20 dark:text-accent-100">
            {w.bridge}
          </span>
          {[w.crew, w.watches, w.shipyard].map((label) => (
            <span
              key={label}
              className="block truncate rounded-md px-2 py-1 text-xs text-slate-700 dark:text-slate-300"
            >
              {label}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <span className="block font-medium text-accent-800 dark:text-accent-300">
              {w.captain}
            </span>
            <span className="text-slate-700 dark:text-slate-300">
              Ready when you are. Your {w.crew.toLowerCase()} is standing by.
            </span>
          </div>
          <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-tr-sm bg-gradient-to-br from-accent-600 to-accent-700 px-3 py-2 text-xs text-white shadow-sm">
            Plan my week
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="rounded-md bg-accent-700 px-2.5 py-1 text-xs font-medium text-white dark:bg-accent-600">
              Send
            </span>
            <span className="rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-900 dark:bg-accent-500/20 dark:text-accent-100">
              {w.watches}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Opens a chat with the Captain, ready to build a custom theme. */
export async function startThemeChat(idea = "") {
  const { conversation } = await api.createConversation({ kind: "bridge" });
  setDraft(
    conversation.id,
    idea.trim()
      ? `Let's build a custom theme for me: ${idea.trim()}`
      : "Let's build a custom theme for me.",
  );
  navigate(`/bridge/${conversation.id}`);
}

/** The preview card the Captain posts in the chat after saving a theme. */
export function ThemeChatCard({ id }: { id: string }) {
  const user = useUser();
  const theme = useResource(() => api.getTheme(id).then((r) => r.theme), [id]);
  // The Captain saves changes to the same theme; the card shows the latest.
  useServerEvents((ev) => {
    if (ev.type === "themes_changed") void theme.reload();
  });
  const { update, error } = useUpdateAppearance();
  const [busy, setBusy] = useState(false);
  const inUse = user.preferences.customTheme === id;

  if (theme.error) {
    return (
      <p className="mx-auto max-w-md text-center text-xs text-slate-500 dark:text-slate-400">
        This theme was deleted.
      </p>
    );
  }
  const t = theme.data;
  const choose = async (customTheme: string | null) => {
    setBusy(true);
    await update({ customTheme });
    setBusy(false);
  };
  return (
    <div className="mx-auto w-full max-w-md animate-fade-up rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {t ? (
        <>
          <div className="mb-3 flex items-center gap-3">
            <ThemeTile theme={t} />
            <div className="min-w-0">
              <p className="truncate font-medium">{t.name}</p>
              {t.description && (
                <p className="truncate text-xs text-slate-600 dark:text-slate-400">
                  {t.description}
                </p>
              )}
            </div>
          </div>
          <ThemePreview theme={t} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {inUse ? (
              <>
                <span className="inline-flex items-center gap-1 text-sm font-medium text-accent-800 dark:text-accent-300">
                  <NavIcon name="check" size={16} /> In use
                </span>
                <Button disabled={busy} onClick={() => void choose(null)}>
                  Switch back
                </Button>
              </>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void choose(id)}>
                Try it
              </Button>
            )}
            <a
              href={href("/settings/appearance")}
              className="ml-auto text-sm text-accent-700 underline-offset-2 hover:underline dark:text-accent-300"
            >
              All themes
            </a>
          </div>
          {error && (
            <div className="mt-2">
              <ErrorText>{error}</ErrorText>
            </div>
          )}
        </>
      ) : (
        <div className={cx("h-48 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800")} />
      )}
    </div>
  );
}
