import { describe, expect, it } from "vitest";
import { contrastRatio, oklchToRgb, parseOklch } from "./color.js";
import {
  accentPalette,
  checkTheme,
  logoTileSvg,
  neutralPalette,
  PALETTE_STEPS,
  sanitizeLogoSvg,
  THEME_NEUTRALS,
  themeFile,
  themePaint,
  themeText,
  themeWords,
} from "./theme.js";
import { THEME_BUILD_GUIDE } from "./theme-guide.js";

const rgb = (v: string) => oklchToRgb(parseOklch(v));
const WHITE: [number, number, number] = [1, 1, 1];

const LOGO =
  '<svg viewBox="0 0 64 64" fill="currentColor"><circle cx="32" cy="32" r="20"/><path opacity=".5" d="M12 32h40"/></svg>';

describe("accentPalette", () => {
  // Every hue around the wheel, plus very light, very dark and gray picks a model might make.
  const picks = [
    ...Array.from({ length: 24 }, (_, i) => {
      const h = i * 15;
      // A rough vivid color at that hue.
      const c = (n: number) =>
        Math.round(127.5 + 127.5 * Math.cos(((h - n) * Math.PI) / 180))
          .toString(16)
          .padStart(2, "0");
      return `#${c(0)}${c(120)}${c(240)}`;
    }),
    "#ffff00",
    "#fde047",
    "#111111",
    "#ffffff",
    "#808080",
    "#7c3aed",
    "#dc2626",
  ];

  for (const hex of picks) {
    it(`${hex} meets the app's contrast rules in light and dark`, () => {
      const p = Object.fromEntries(
        Object.entries(accentPalette(hex)).map(([k, v]) => [k, rgb(v)]),
      ) as Record<string, [number, number, number]>;
      for (const step of ["600", "700", "800"]) {
        expect(contrastRatio(WHITE, p[step] as never), `white on ${step}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      for (const n of THEME_NEUTRALS) {
        const g = Object.fromEntries(
          Object.entries(neutralPalette(n, hex)).map(([k, v]) => [k, rgb(v)]),
        ) as Record<string, [number, number, number]>;
        for (const bg of [WHITE, g["50"], p["50"]]) {
          expect(contrastRatio(p["700"] as never, bg as never)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(p["800"] as never, p["100"] as never)).toBeGreaterThanOrEqual(4.5);
        for (const bg of [g["800"], g["900"], g["950"]]) {
          expect(
            contrastRatio(p["300"] as never, bg as never),
            `300 on ${n}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        for (const bg of [g["900"], g["950"]]) {
          expect(contrastRatio(p["400"] as never, bg as never)).toBeGreaterThanOrEqual(3);
        }
      }
      // Lightest to darkest, in order.
      const ls = PALETTE_STEPS.map((s) => parseOklch(accentPalette(hex)[s]).l);
      for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeLessThan(ls[i - 1] as number);
    });
  }
});

describe("themePaint", () => {
  it("sets the accent and slate scales and the title bar colors", () => {
    const paint = themePaint({
      accent: "#7c3aed",
      neutral: "stone",
      font: "serif",
      corners: "sharp",
    });
    expect(Object.keys(paint.vars)).toHaveLength(30);
    expect(paint.vars["--color-slate-50"]).toBe("oklch(98.5% 0.001 106.423)");
    expect(paint.vars["--radius-lg"]).toBe("0.1875rem");
    expect(paint.barLight).toMatch(/^#[0-9a-f]{6}$/);
    expect(paint.fontFamily).toContain("Georgia");
    const plain = themePaint({
      accent: "#7c3aed",
      neutral: "slate",
      font: "system",
      corners: "soft",
    });
    expect(Object.keys(plain.vars)).toHaveLength(22);
    expect(plain.fontFamily).toBeNull();
  });
});

describe("sanitizeLogoSvg", () => {
  it("keeps plain shapes and adds the SVG namespace", () => {
    const r = sanitizeLogoSvg(`<?xml version="1.0"?><!-- hi -->${LOGO}`);
    expect(r).toEqual({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="currentColor"><circle cx="32" cy="32" r="20"/><path opacity=".5" d="M12 32h40"/></svg>',
    });
  });

  it("allows gradients referenced by id", () => {
    const r = sanitizeLogoSvg(
      '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>',
    );
    expect("svg" in r).toBe(true);
  });

  it.each([
    ['<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>', "<script> is not allowed"],
    ['<svg viewBox="0 0 1 1" onload="x()"><rect/></svg>', "onload attribute is not allowed"],
    ['<svg viewBox="0 0 1 1"><rect style="fill:red"/></svg>', "set fill and stroke directly"],
    ['<svg viewBox="0 0 1 1"><image href="x.png"/></svg>', "<image> is not allowed"],
    ['<svg viewBox="0 0 1 1"><rect fill="url(https://x/y)"/></svg>', "url(#id)"],
    ['<svg viewBox="0 0 1 1"><text>Hi</text></svg>', "<text> is not allowed"],
    ['<svg viewBox="0 0 1 1">Hi<rect/></svg>', "no text"],
    ["<svg><rect/></svg>", "needs a viewBox"],
    ['<svg viewBox="0 0 1 1"><rect>', "never closed"],
    ['<svg viewBox="0 0 1 1"><rect/></svg><svg/>', "inside one <svg>"],
    ['<!DOCTYPE svg><svg viewBox="0 0 1 1"><rect/></svg>', "DOCTYPE"],
    ['<svg viewBox="0 0 1 1"><rect fill="&#106;avascript"/></svg>', "may not contain"],
    ['<div><svg viewBox="0 0 1 1"/></div>', "<div> is not allowed"],
  ])("refuses %s", (input, message) => {
    const r = sanitizeLogoSvg(input);
    expect("error" in r && r.error).toContain(message);
  });

  it("makes a tab icon with the logo on an accent tile", () => {
    const svg = sanitizeLogoSvg(LOGO);
    if (!("svg" in svg)) throw new Error(svg.error);
    const tile = logoTileSvg(svg.svg, "#7c3aed");
    expect(tile).toContain('<svg x="10" y="10" width="44" height="44" xmlns=');
    expect(tile).not.toContain("currentColor");
  });
});

describe("checkTheme", () => {
  const theme = {
    name: "Head Office",
    accent: "#2563eb",
    neutral: "gray",
    font: "system",
    corners: "sharp",
    logo: LOGO,
    words: { captain: "CEO", crew: "Team", crewMember: "team member", bridge: "Office" },
    voice: "Speak like a sharp, friendly executive assistant.",
  };

  it("accepts a full theme, fills defaults, and cleans the logo", () => {
    const r = checkTheme(theme);
    if (!r.ok) throw new Error(r.errors.join("; "));
    expect(r.theme.description).toBe("");
    expect(r.theme.logo).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(themeWords(r.theme)).toMatchObject({ captain: "CEO", watches: "Routines" });
  });

  it("reads its own export file back", () => {
    const r = checkTheme(theme);
    if (!r.ok) throw new Error("bad");
    const again = checkTheme(JSON.parse(JSON.stringify(themeFile(r.theme))));
    expect(again).toEqual(r);
  });

  it("lists every problem at once in plain words", () => {
    const r = checkTheme({
      ...theme,
      accent: "blue",
      font: "comic",
      words: { boss: "x" },
      sparkle: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/accent must be a hex color/);
    expect(r.errors.join("\n")).toMatch(/font:/);
    expect(r.errors.join("\n")).toMatch(/unknown field in words: boss/);
    expect(r.errors.join("\n")).toMatch(/unknown field: sparkle/);
  });

  it("reports a bad logo", () => {
    const r = checkTheme({ ...theme, logo: "<svg><script/></svg>" });
    expect(r.ok).toBe(false);
  });
});

describe("THEME_BUILD_GUIDE", () => {
  it("names every word, choice and tool the AI needs", () => {
    for (const s of ["appName", "crewMember", "shipyard", "tinted", "rounded", "sharp"]) {
      expect(THEME_BUILD_GUIDE).toContain(s);
    }
    for (const tool of ["ask_person", "save_theme", "use_theme"]) {
      expect(THEME_BUILD_GUIDE).toContain(tool);
    }
  });
});

describe("repairTheme (for small models)", () => {
  it("turns sloppy input into a valid theme and says what it changed", async () => {
    const { repairTheme } = await import("./theme.js");
    const { theme, notes } = repairTheme({
      Name: "  Trainer Camp  ",
      color: "bright red please",
      neutral: "warm",
      font: "Friendly",
      corners: "pill",
      words: { Leader: "Professor", team: "Team", "app name": "Trailmate", sidekick: "x" },
      logo: '```svg\n<svg width="48" height="48" class="logo"><title>Hi</title><circle cx="24" cy="24" r="20" style="fill:currentColor;opacity:.5" onclick="x()"/><text x="1">A</text><script>alert(1)</script></svg>\n```',
      mood: "fun",
    });
    expect(theme).toMatchObject({
      name: "Trainer Camp",
      accent: "#dc2626",
      neutral: "stone",
      font: "rounded",
      corners: "round",
      words: { captain: "Professor", crew: "Team", appName: "Trailmate" },
    });
    expect(theme.logo).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="currentColor" opacity=".5"/></svg>'.replace(
        ' width="48" height="48"',
        "",
      ),
    );
    expect(notes.join("\n")).toMatch(/ignored unknown field: mood/);
    expect(notes.join("\n")).toMatch(/ignored words: sidekick/);
    expect(checkTheme(theme).ok).toBe(true);
  });

  it("fills a name and accent, and leaves out a logo it cannot use", async () => {
    const { repairTheme } = await import("./theme.js");
    const { theme, notes } = repairTheme({ accent: "a bad color", logo: "a cute dragon" });
    expect(theme.name).toBe("My theme");
    expect(theme.accent).toBe("#0d9488");
    expect(theme.logo).toBe("");
    expect(notes).toHaveLength(3);
    expect(repairTheme({ accent: "1E3A8A" }).theme.accent).toBe("#1e3a8a");
    expect(repairTheme({ accent: "rgb(255, 0, 0)" }).theme.accent).toBe("#ff0000");
    expect(repairTheme(null).theme.name).toBe("My theme");
  });
});

describe("theme words", () => {
  it("uses plain AI words by default, nautical on request, and fills custom themes from plain", () => {
    expect(themeWords(null)).toMatchObject({
      captain: "Assistant",
      crew: "Agents",
      bridge: "Chat",
    });
    expect(themeWords(null, "nautical")).toMatchObject({ captain: "Captain", bridge: "Bridge" });
    expect(themeWords({ words: { captain: "CEO" } }, "nautical")).toMatchObject({
      captain: "CEO",
      bridge: "Chat",
    });
  });

  it("rewrites nautical sentences in the theme's words", () => {
    const plain = themeWords(null);
    expect(themeText("Captain asked", plain)).toBe("Assistant asked");
    expect(themeText("Pick a crew member. Crew members have jobs.", plain)).toBe(
      "Pick an agent. Agents have jobs.",
    );
    expect(themeText("Open it in the Shipyard, or the Bridge.", plain)).toBe(
      "Open it in Projects, or Chat.",
    );
    expect(themeText("← Crew", plain)).toBe("← Agents");
    expect(
      themeText("A watch runs after another watch. Results go on the watch's page.", plain),
    ).toBe("A routine runs after another routine. Results go on the routine's page.");
    expect(themeText("Pick the project to watch.", plain)).toBe("Pick the project to watch.");
    const guild = themeWords({
      words: { captain: "Guildmaster", crewMember: "adventurer", bridge: "Tavern" },
    });
    expect(themeText("A crew member asks the Captain on the Bridge.", guild)).toBe(
      "An adventurer asks the Guildmaster on the Tavern.",
    );
    const allies = themeWords({
      words: { captain: "Crew Chief", crew: "Team", crewMember: "ally" },
    });
    expect(themeText("Captain asked the Crew. Crew members help.", allies)).toBe(
      "Crew Chief asked the Team. Allies help.",
    );
    expect(themeText("crew members", themeWords({ words: { crewMember: "boss" } }))).toBe("bosses");
    const nautical = themeWords(null, "nautical");
    const text = "Open it in the Shipyard. A crew member asks the Captain with ask_captain.";
    expect(themeText(text, nautical)).toBe(text);
  });
});
