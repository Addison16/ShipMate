import {
  type ColorTheme,
  type CustomThemeSpec,
  logoTileSvg,
  THEME_PAINT_PROPERTIES,
  type ThemeMode,
  type ThemePaint,
  themePaint,
  type UserPreferences,
} from "@shipmate/core";
import type { CSSProperties } from "react";

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

export const DEFAULT_APPEARANCE: UserPreferences = {
  themeMode: "auto",
  colorTheme: "harbor",
  customTheme: null,
};

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
      customTheme: typeof parsed.customTheme === "string" ? parsed.customTheme : null,
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

/** A custom theme as last painted, kept so the next page load paints it before the first frame. */
export interface PaintedTheme {
  id: string;
  theme: CustomThemeSpec;
  paint: ThemePaint;
  /** The tab icon: the theme's logo on its accent tile, as a data URL. */
  favicon: string;
}

/** The custom theme cached with the appearance, when it is the one the appearance picks. */
export function readCachedTheme(storage: Pick<Storage, "getItem"> | null): PaintedTheme | null {
  try {
    const raw = storage?.getItem(APPEARANCE_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { customTheme?: unknown; custom?: PaintedTheme }) : {};
    const custom = parsed.custom;
    if (!custom || custom.id !== parsed.customTheme || !custom.theme || !custom.paint) return null;
    return custom;
  } catch {
    return null;
  }
}

/** The North Star, for the tab icon of a custom theme without a logo of its own. */
const NORTH_STAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="7 7 50 50" fill="currentColor"><path d="M32 7 26.5 26.5 32 32ZM57 32 37.5 26.5 32 32ZM32 57 37.5 37.5 32 32ZM7 32 26.5 37.5 32 32Z"/><path opacity=".55" d="M32 7 37.5 26.5 32 32ZM57 32 37.5 37.5 32 32ZM32 57 26.5 37.5 32 32ZM7 32 26.5 26.5 32 32Z"/><circle cx="32" cy="32" r="16" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="2.5"/></svg>';

export function paintTheme(id: string, theme: CustomThemeSpec): PaintedTheme {
  const svg = logoTileSvg(theme.logo || NORTH_STAR_SVG, theme.accent);
  return {
    id,
    theme,
    paint: themePaint(theme),
    favicon: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  };
}

/** Sets a custom theme's colors, corners and font on <html>, or clears them with null. */
function applyPaint(root: HTMLElement, paint: ThemePaint | null) {
  for (const name of THEME_PAINT_PROPERTIES) {
    const value = paint?.vars[name];
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  if (paint?.fontFamily) root.style.setProperty("font-family", paint.fontFamily);
  else root.style.removeProperty("font-family");
}

/** Inline style that paints a theme on one element, for previews. */
export function previewStyle(paint: ThemePaint): CSSProperties {
  return {
    ...(paint.vars as CSSProperties),
    ...(paint.fontFamily ? { fontFamily: paint.fontFamily } : {}),
  };
}

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

/**
 * Points the icon and manifest links at the color theme, so a saved web app matches it. A custom
 * theme also swaps the tab icon (home screens keep the color theme's set: they need PNG files).
 */
function applyAppIcons(colorTheme: ColorTheme, favicon?: string): void {
  const links = appIconLinks(colorTheme);
  const set = (selector: string, href: string) => {
    const el = document.querySelector<HTMLLinkElement>(selector);
    if (el && el.getAttribute("href") !== href) el.setAttribute("href", href);
  };
  set('link[rel="manifest"]', links.manifest);
  set('link[rel="icon"][type="image/svg+xml"]', favicon ?? links.favicon);
  set('link[rel="icon"][type="image/png"]', links.favicon32);
  set('link[rel="apple-touch-icon"]', links.appleTouch);
}

/**
 * Puts the appearance on <html> and remembers it for the next page load. `custom` paints over
 * the color theme when it is the custom theme the preferences pick.
 */
export function applyAppearance(
  prefs: UserPreferences,
  systemDark = systemPrefersDark(),
  custom: PaintedTheme | null = null,
): void {
  const root = document.documentElement;
  const dark = isDark(prefs.themeMode, systemDark);
  const painted = custom && custom.id === prefs.customTheme ? custom : null;
  root.classList.toggle("dark", dark);
  root.dataset.colorTheme = prefs.colorTheme;
  applyPaint(root, painted?.paint ?? null);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      "content",
      painted
        ? dark
          ? painted.paint.barDark
          : painted.paint.barLight
        : barColor(prefs, systemDark),
    );
  applyAppIcons(prefs.colorTheme, painted?.favicon);
  try {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(painted ? { ...prefs, custom: painted } : prefs),
    );
  } catch {
    // Private browsing or storage disabled: the server copy still applies after sign-in.
  }
}
