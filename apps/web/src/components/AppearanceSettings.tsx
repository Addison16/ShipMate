import { useUpdateAppearance } from "../appearance.js";
import { useUser } from "../auth.js";
import { COLOR_THEMES, THEME_MODES } from "../lib/theme.js";
import { NavIcon } from "./icons.js";
import { Card, cx, ErrorText } from "./ui.js";

const MODE_HINTS = {
  light: "Always light",
  dark: "Always dark",
  auto: "Follows this device",
} as const;

/** Per-user theme: Light, Dark or Auto, plus an accent color theme. Saved to the account. */
export function AppearanceSettings() {
  const user = useUser();
  const { update, error } = useUpdateAppearance();
  const { themeMode, colorTheme } = user.preferences;

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
            const on = colorTheme === t.id;
            return (
              <label
                key={t.id}
                data-color-theme={t.id}
                className={cx(
                  "relative flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent-600",
                  on
                    ? "border-accent-600 ring-1 ring-accent-600 dark:border-accent-400 dark:ring-accent-400"
                    : "border-slate-200 hover:border-accent-400 dark:border-slate-700",
                )}
              >
                <input
                  type="radio"
                  name="color-theme"
                  value={t.id}
                  checked={on}
                  onChange={() => void update({ colorTheme: t.id })}
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
                {on && (
                  <span className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-accent-600 text-white">
                    <NavIcon name="check" size={12} />
                  </span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>
      {error && (
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  );
}
