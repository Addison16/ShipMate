import type { CustomThemeDto } from "@shipmate/core";
import { type ChangeEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useThemeList, useThemeWords, useUpdateAppearance } from "../appearance.js";
import { useUser } from "../auth.js";
import { COLOR_THEMES, THEME_MODES } from "../lib/theme.js";
import { NavIcon } from "./icons.js";
import { startThemeChat, ThemePreview, ThemeTile } from "./ThemeCard.js";
import { Button, Card, cx, ErrorText, IconButton } from "./ui.js";

const MODE_HINTS = {
  light: "Always light",
  dark: "Always dark",
  auto: "Follows this device",
} as const;

const STYLES = [
  { id: "plain", label: "Plain", example: "Assistant, Agents, Chat" },
  { id: "nautical", label: "Nautical", example: "Captain, Crew, Bridge" },
] as const;

const choice = (on: boolean) =>
  cx(
    "relative flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-600",
    on
      ? "border-accent-600 ring-1 ring-accent-600 dark:border-accent-400 dark:ring-accent-400"
      : "border-slate-200 hover:border-accent-400 dark:border-slate-700",
  );

function Picked() {
  return (
    <span className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-accent-600 text-white">
      <NavIcon name="check" size={12} />
    </span>
  );
}

/**
 * Per-user theme: Light, Dark or Auto, an accent color theme, plain or nautical words, or a
 * custom theme the Captain builds (colors, logo, words and voice). Saved to the account.
 */
export function AppearanceSettings() {
  const user = useUser();
  const { update, error } = useUpdateAppearance();
  const { themeMode, colorTheme, customTheme, style } = user.preferences;

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Appearance</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Just for you, on every device you sign in from.
      </p>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">Mode</legend>
        <div className="grid grid-cols-3 gap-2">
          {THEME_MODES.map((m) => {
            const on = themeMode === m.id;
            return (
              <label
                key={m.id}
                className={cx(
                  "flex cursor-pointer flex-col items-center gap-1 rounded-lg border px-3 py-3 text-sm font-medium transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-600",
                  on
                    ? "border-accent-600 bg-accent-50 text-accent-800 dark:border-accent-400 dark:bg-accent-950/40 dark:text-accent-100"
                    : "border-slate-200 hover:border-accent-300 dark:border-slate-700 dark:hover:border-accent-700",
                )}
              >
                <input
                  type="radio"
                  name="theme-mode"
                  value={m.id}
                  checked={on}
                  onChange={() => void update({ themeMode: m.id })}
                  className="sr-only"
                />
                <NavIcon name={m.id} size={22} />
                {m.label}
                <span className="text-xs font-normal text-slate-600 dark:text-slate-400">
                  {MODE_HINTS[m.id]}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="mb-2 text-sm font-medium">Color theme</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {COLOR_THEMES.map((t) => {
            const on = !customTheme && colorTheme === t.id;
            return (
              <label key={t.id} data-color-theme={t.id} className={choice(on)}>
                <input
                  type="radio"
                  name="color-theme"
                  value={t.id}
                  checked={on}
                  // A color theme is also the way back from a custom theme.
                  onChange={() => void update({ colorTheme: t.id, customTheme: null })}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 overflow-hidden rounded-full shadow-inner ring-1 ring-black/5"
                >
                  <span className="w-1/3 bg-accent-300" />
                  <span className="w-1/3 bg-accent-500" />
                  <span className="w-1/3 bg-accent-700" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                    {t.description}
                  </span>
                </span>
                {on && <Picked />}
              </label>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
          The app icon matches too. On your home screen, add Shipmate again to update it.
        </p>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="mb-2 text-sm font-medium">Words</legend>
        <div className="grid grid-cols-2 gap-2">
          {STYLES.map((st) => {
            const on = !customTheme && style === st.id;
            return (
              <label key={st.id} className={choice(on)}>
                <input
                  type="radio"
                  name="style"
                  value={st.id}
                  checked={on}
                  onChange={() => void update({ style: st.id, customTheme: null })}
                  className="sr-only"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{st.label}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">
                    {st.example}
                  </span>
                </span>
                {on && <Picked />}
              </label>
            );
          })}
        </div>
      </fieldset>

      <CustomThemes
        current={customTheme}
        onPick={(id) => void update({ customTheme: id })}
        onBack={() => void update({ customTheme: null })}
      />
      {error && (
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  );
}

function CustomThemes({
  current,
  onPick,
  onBack,
}: {
  current: string | null;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  const { themes, error: listError, reload } = useThemeList();
  const words = useThemeWords();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const picked = themes?.find((t) => t.id === current) ?? null;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await startThemeChat();
    } catch (err) {
      setError(errorMessage(err));
      setStarting(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    try {
      const { theme } = await api.importTheme(JSON.parse(await file.text()));
      reload();
      onPick(theme.id);
    } catch (err) {
      setError(err instanceof SyntaxError ? "That file is not a theme file." : errorMessage(err));
    }
  }

  async function remove(t: CustomThemeDto) {
    if (!window.confirm(`Delete the ${t.name} theme for everyone?`)) return;
    setError(null);
    try {
      await api.deleteTheme(t.id);
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <fieldset className="mt-6 min-w-0">
      <legend className="mb-1 text-sm font-medium">Custom theme</legend>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Any idea you like. Your AI builds the colors, logo, words and how it talks.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={starting} onClick={() => void start()}>
          <NavIcon name="sparkle" size={16} />
          {starting ? "Opening…" : "Make a custom theme"}
        </Button>
        <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-800 transition hover:bg-slate-50 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700">
          <input
            type="file"
            accept=".json,application/json"
            className="sr-only"
            onChange={(e) => void onFile(e)}
          />
          Import a file
        </label>
      </div>

      {themes && themes.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {themes.map((t) => {
            const on = t.id === current;
            return (
              <div key={t.id} className={cx(choice(on), "min-w-0")}>
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="radio"
                    name="custom-theme"
                    value={t.id}
                    checked={on}
                    onChange={() => onPick(t.id)}
                    className="sr-only"
                  />
                  <ThemeTile theme={t} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{t.name}</span>
                    <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                      {t.description || `By ${t.createdBy?.name ?? "someone"}`}
                    </span>
                  </span>
                </label>
                <span className="flex shrink-0 items-center">
                  <a
                    href={api.themeFileUrl(t.id)}
                    download
                    aria-label={`Download ${t.name}`}
                    title="Download"
                    className="grid size-9 place-items-center rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 sm:size-7 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
                  >
                    <NavIcon name="download" size={16} />
                  </a>
                  {t.canEdit && (
                    <IconButton
                      icon="trash"
                      label={`Delete ${t.name}`}
                      tone="danger"
                      onClick={() => void remove(t)}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {picked && (
        <div className="mt-3 space-y-2">
          <ThemePreview theme={picked} />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={onBack}>Back to the standard look</Button>
            <span className="text-xs text-slate-600 dark:text-slate-400">
              To change it, ask your {words.captain} in a chat.
            </span>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setDetails((d) => !d)}
        className="mt-3 text-xs font-medium text-accent-700 underline-offset-2 hover:underline dark:text-accent-300"
        aria-expanded={details}
      >
        {details ? "Hide details" : "More details"}
      </button>
      {details && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-400">
          <li>Everyone here can use the themes anyone makes; each person picks their own.</li>
          <li>The crew uses the theme's words and voice only with the person using it.</li>
          <li>Logos are always original art, never copied from a brand or franchise.</li>
          <li>
            Files work with other AIs too: the build guide is in the docs (custom themes). Saved
            phone apps keep their icon.
          </li>
        </ul>
      )}
      {(error || listError) && (
        <div className="mt-3">
          <ErrorText>{error ?? listError}</ErrorText>
        </div>
      )}
    </fieldset>
  );
}
