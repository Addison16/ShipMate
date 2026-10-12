/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, oklchToRgb, themePalettes } from "./contrast.js";
import { COLOR_THEMES } from "./theme.js";

// Tailwind's own values for the neutrals the pages sit on.
const WHITE = oklchToRgb("oklch(100% 0 0)");
const SLATE_50 = oklchToRgb("oklch(98.4% 0.003 247.858)");
const SLATE_800 = oklchToRgb("oklch(27.9% 0.041 260.031)");
const SLATE_900 = oklchToRgb("oklch(20.8% 0.042 265.755)");
const SLATE_950 = oklchToRgb("oklch(12.9% 0.042 264.695)");

// Read from disk: vitest hands CSS imports back empty, even with ?raw.
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
const palettes = themePalettes(css);
const TEXT = 4.5;
const CONTROL = 3;

function control(dark: boolean) {
  const block = dark
    ? css.match(/:root\.dark\s*\{([^}]*)\}/)?.[1]
    : css.match(/@theme\s*\{([^}]*)\}/)?.[1];
  const value = block?.match(/--color-control:\s*(oklch\([^)]*\))/)?.[1];
  if (!value) throw new Error("--color-control missing");
  return oklchToRgb(value);
}

describe("color theme contrast (WCAG 2.2 AA)", () => {
  it("has a palette for every theme in Settings", () => {
    expect(Object.keys(palettes).sort()).toEqual(COLOR_THEMES.map((t) => t.id).sort());
  });

  for (const theme of COLOR_THEMES.map((t) => t.id)) {
    const p = palettes[theme];
    it(`${theme}: white text on filled accent buttons and the active nav item`, () => {
      // Light buttons are accent-700 (hover 800); dark buttons and the light active nav are 600.
      for (const step of ["600", "700", "800"]) {
        expect(contrast(WHITE, p[step]), `white on accent-${step}`).toBeGreaterThanOrEqual(TEXT);
      }
    });
    it(`${theme}: accent text on light surfaces`, () => {
      for (const bg of [WHITE, SLATE_50, p["50"]]) {
        expect(contrast(p["700"], bg)).toBeGreaterThanOrEqual(TEXT);
      }
      expect(contrast(p["800"], p["100"])).toBeGreaterThanOrEqual(TEXT);
    });
    it(`${theme}: accent text on dark surfaces`, () => {
      for (const bg of [SLATE_800, SLATE_900, SLATE_950]) {
        expect(contrast(p["300"], bg)).toBeGreaterThanOrEqual(TEXT);
      }
    });
    it(`${theme}: focus outlines stand out from the page`, () => {
      for (const bg of [WHITE, SLATE_50])
        expect(contrast(p["600"], bg)).toBeGreaterThanOrEqual(CONTROL);
      for (const bg of [SLATE_900, SLATE_950])
        expect(contrast(p["400"], bg)).toBeGreaterThanOrEqual(CONTROL);
    });
  }

  it("form field borders and switch tracks stand out in light and dark", () => {
    for (const bg of [WHITE, SLATE_50])
      expect(contrast(control(false), bg)).toBeGreaterThanOrEqual(CONTROL);
    for (const bg of [SLATE_800, SLATE_900, SLATE_950]) {
      expect(contrast(control(true), bg)).toBeGreaterThanOrEqual(CONTROL);
    }
  });
});
