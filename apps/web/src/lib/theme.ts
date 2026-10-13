import type { ColorTheme, ThemeMode, UserPreferences } from "@shipmate/core";

export interface ColorThemeInfo {
  id: ColorTheme;
  label: string;
  description: string;
  /** Accent 700, used for the browser and PWA title bar in light mode. */
  barColor: string;
}

/** Order shown in Settings. The palettes themselves live in index.css. */
export const COLOR_THEMES: ColorThemeInfo[] = [
  { id: "harbor", label: "Harbor", description: "Calm teal, the default", barColor: "#0f766e" },
  { id: "open-sea", label: "Open Sea", description: "Deep ocean blue", barColor: "#1d4ed8" },
  { id: "coral-reef", label: "Coral Reef", description: "Warm coral pink", barColor: "#be123c" },
  { id: "lighthouse", label: "Lighthouse", description: "Beacon orange", barColor: "#c2410c" },
  { id: "kelp-forest", label: "Kelp Forest", description: "Sea-green", barColor: "#047857" },
  { id: "admiral", label: "Admiral", description: "Navy indigo", barColor: "#4338ca" },
];

export const THEME_MODES: Array<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "auto", label: "Auto" },
];

export const DEFAULT_APPEARANCE: UserPreferences = { themeMode: "auto", colorTheme: "harbor" };

/** Same key as the inline script in index.html, which applies it before the first paint. */
export const APPEARANCE_STORAGE_KEY = "shipmate-appearance";

const DARK_BAR_COLOR = "#0f172a";

export function isDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "auto" && systemDark);
}

/** Reads the last applied appearance, so sign-in pages match the last signed-in user. */
export function readCachedAppearance(storage: Pick<Storage, "getItem"> | null): UserPreferences {
  try {
    const raw = storage?.getItem(APPEARANCE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<UserPreferences>) : {};
    return {
      themeMode: THEME_MODES.some((m) => m.id === parsed.themeMode)
        ? (parsed.themeMode as ThemeMode)
        : DEFAULT_APPEARANCE.themeMode,
      colorTheme: COLOR_THEMES.some((t) => t.id === parsed.colorTheme)
        ? (parsed.colorTheme as ColorTheme)
        : DEFAULT_APPEARANCE.colorTheme,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function barColor(prefs: UserPreferences, systemDark: boolean): string {
  if (isDark(prefs.themeMode, systemDark)) return DARK_BAR_COLOR;
  return COLOR_THEMES.find((t) => t.id === prefs.colorTheme)?.barColor ?? "#0f766e";
}

export const systemPrefersDark = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;

/** The home-screen icon, tab icon and manifest for a color theme (made by scripts/make-icons.mjs). */
export function appIconLinks(colorTheme: ColorTheme): {
  manifest: string;
  favicon: string;
  favicon32: string;
  appleTouch: string;
} {
  const dir = `/icons/${colorTheme}`;
  return {
    manifest: `${dir}/manifest.webmanifest`,
    favicon: `${dir}/icon.svg`,
    favicon32: `${dir}/favicon-32.png`,
    appleTouch: `${dir}/apple-touch-icon.png`,
  };
}

/** Points the icon and manifest links at the color theme, so a saved web app matches it. */
function applyAppIcons(colorTheme: ColorTheme): void {
  const links = appIconLinks(colorTheme);
  const set = (selector: string, href: string) => {
    const el = document.querySelector<HTMLLinkElement>(selector);
    if (el && el.getAttribute("href") !== href) el.setAttribute("href", href);
  };
  set('link[rel="manifest"]', links.manifest);
  set('link[rel="icon"][type="image/svg+xml"]', links.favicon);
  set('link[rel="icon"][type="image/png"]', links.favicon32);
  set('link[rel="apple-touch-icon"]', links.appleTouch);
}

/** Puts the appearance on <html> and remembers it for the next page load. */
export function applyAppearance(prefs: UserPreferences, systemDark = systemPrefersDark()): void {
  const root = document.documentElement;
  root.classList.toggle("dark", isDark(prefs.themeMode, systemDark));
  root.dataset.colorTheme = prefs.colorTheme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", barColor(prefs, systemDark));
  applyAppIcons(prefs.colorTheme);
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing or storage disabled: the server copy still applies after sign-in.
  }
}
