import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appIconLinks,
  barColor,
  COLOR_THEMES,
  DEFAULT_APPEARANCE,
  isDark,
  readCachedAppearance,
} from "./theme.js";

const publicFile = (path: string) => new URL(`../../public${path}`, import.meta.url);

const store = (value: string | null) => ({ getItem: () => value });

describe("appearance", () => {
  it("resolves Auto from the device and keeps Light and Dark fixed", () => {
    expect(isDark("auto", true)).toBe(true);
    expect(isDark("auto", false)).toBe(false);
    expect(isDark("light", true)).toBe(false);
    expect(isDark("dark", false)).toBe(true);
  });

  it("reads the cached appearance and ignores anything unknown or broken", () => {
    expect(readCachedAppearance(store('{"themeMode":"dark","colorTheme":"admiral"}'))).toEqual({
      themeMode: "dark",
      colorTheme: "admiral",
    });
    expect(readCachedAppearance(store('{"themeMode":"neon","colorTheme":"plaid"}'))).toEqual(
      DEFAULT_APPEARANCE,
    );
    expect(readCachedAppearance(store("not json"))).toEqual(DEFAULT_APPEARANCE);
    expect(readCachedAppearance(store(null))).toEqual(DEFAULT_APPEARANCE);
    expect(readCachedAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it("colors the browser bar with the theme in light mode and dark slate in dark mode", () => {
    expect(barColor({ themeMode: "light", colorTheme: "open-sea" }, true)).toBe("#1d4ed8");
    expect(barColor({ themeMode: "auto", colorTheme: "open-sea" }, true)).toBe("#0f172a");
  });

  it("has a home-screen icon set and manifest in the theme's color for every color theme", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    for (const theme of COLOR_THEMES) {
      const links = appIconLinks(theme.id);
      for (const path of Object.values(links))
        expect(existsSync(publicFile(path)), path).toBe(true);
      const manifest = JSON.parse(readFileSync(publicFile(links.manifest), "utf8"));
      expect(manifest.theme_color).toBe(theme.barColor);
      for (const icon of manifest.icons)
        expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
      expect(html).toContain(`"${theme.id}"`);
    }
  });
});
