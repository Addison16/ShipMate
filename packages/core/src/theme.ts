import { z } from "zod";
import {
  contrastRatio,
  HEX_COLOR,
  hexToRgb,
  maxChroma,
  type Oklch,
  oklchCss,
  oklchToRgb,
  parseOklch,
  type Rgb,
  rgbToHex,
  rgbToOklch,
} from "./color.js";

/*
 * Custom themes: a pack an AI (or a person) builds that replaces Shipmate's nautical look and
 * words with any idea, such as a trainer adventure or a company with a CEO. A pack is a few
 * plain choices (one accent color, a gray family, a font and corner style), an original SVG
 * logo, the app's words, and the voice the crew talks in. The palette is worked out here from
 * the one color, so any model's pick still meets the app's contrast rules.
 */

export const PALETTE_STEPS = [
  "50",
  "100",
  "200",
  "300",
  "400",
  "500",
  "600",
  "700",
  "800",
  "900",
  "950",
] as const;
export type PaletteStep = (typeof PALETTE_STEPS)[number];
export type Palette = Record<PaletteStep, string>;

/** Gray families for backgrounds, borders and text. "tinted" takes the accent's hue. */
export const THEME_NEUTRALS = ["slate", "gray", "zinc", "neutral", "stone", "tinted"] as const;
export type ThemeNeutral = (typeof THEME_NEUTRALS)[number];

export const THEME_FONTS = ["system", "rounded", "serif", "mono"] as const;
export type ThemeFont = (typeof THEME_FONTS)[number];

export const THEME_CORNERS = ["sharp", "soft", "round"] as const;
export type ThemeCorners = (typeof THEME_CORNERS)[number];

/** The app's themed words and what each one names. */
export const THEME_WORDS = {
  appName: { default: "Shipmate", means: "the app's name in the header and tab" },
  captain: { default: "Captain", means: "the coordinator who leads the crew (title)" },
  crew: { default: "Crew", means: "the team of AI helpers (page name)" },
  crewMember: { default: "crew member", means: "one helper, lowercase singular" },
  bridge: { default: "Bridge", means: "where you chat (page name)" },
  watches: { default: "Watches", means: "scheduled jobs and briefings (page name)" },
  shipyard: { default: "Shipyard", means: "GitHub and work projects (page name)" },
} as const;
export type ThemeWordKey = keyof typeof THEME_WORDS;
export type ThemeWordMap = Record<ThemeWordKey, string>;

export const DEFAULT_THEME_WORDS: ThemeWordMap = Object.fromEntries(
  Object.entries(THEME_WORDS).map(([k, v]) => [k, v.default]),
) as ThemeWordMap;

export const MAX_LOGO_LENGTH = 20_000;

const word = z.string().trim().min(1).max(24);

export const ThemeWords = z
  .object(
    Object.fromEntries(Object.keys(THEME_WORDS).map((k) => [k, word.optional()])) as Record<
      ThemeWordKey,
      z.ZodOptional<typeof word>
    >,
  )
  .strict();

/** What a custom theme is made of. Also the import/export file format (see themeFile). */
export const CustomThemeSpec = z
  .object({
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().max(160).default(""),
    accent: z.string().trim().regex(HEX_COLOR, "accent must be a hex color such as #7c3aed"),
    neutral: z.enum(THEME_NEUTRALS).default("slate"),
    font: z.enum(THEME_FONTS).default("system"),
    corners: z.enum(THEME_CORNERS).default("soft"),
    /** An SVG mark; empty keeps the North Star. Checked and cleaned by sanitizeLogoSvg. */
    logo: z.string().max(MAX_LOGO_LENGTH).default(""),
    words: ThemeWords.default({}),
    /** How the crew talks with the person using the theme. */
    voice: z.string().trim().max(1500).default(""),
  })
  .strict();
export type CustomThemeSpec = z.infer<typeof CustomThemeSpec>;

/** A saved theme, as the API returns it. Everyone on the instance can see and use it. */
export interface CustomThemeDto extends CustomThemeSpec {
  id: string;
  createdBy: { id: string; name: string } | null;
  /** The person asking made it, or is an owner or admin: they may change or delete it. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ThemeCheck = { ok: true; theme: CustomThemeSpec } | { ok: false; errors: string[] };

/**
 * Checks a theme from an AI or a file. Errors are plain sentences a model can fix in one go,
 * and the logo comes back cleaned.
 */
export function checkTheme(input: unknown): ThemeCheck {
  const body =
    input && typeof input === "object" && !Array.isArray(input)
      ? Object.fromEntries(
          Object.entries(input as Record<string, unknown>).filter(
            ([k]) => k !== "shipmate" && k !== "version",
          ),
        )
      : input;
  const parsed = CustomThemeSpec.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => {
        const path = i.path.join(".");
        if (i.code === "unrecognized_keys") {
          const where = path ? ` in ${path}` : "";
          return `unknown field${i.keys.length > 1 ? "s" : ""}${where}: ${i.keys.join(", ")}`;
        }
        return path ? `${path}: ${i.message}` : i.message;
      }),
    };
  }
  const theme = parsed.data;
  if (theme.logo.trim()) {
    const logo = sanitizeLogoSvg(theme.logo);
    if ("error" in logo) return { ok: false, errors: [`logo: ${logo.error}`] };
    theme.logo = logo.svg;
  } else {
    theme.logo = "";
  }
  return { ok: true, theme };
}

/** The file people download and import: the spec with a marker saying what it is. */
export function themeFile(theme: CustomThemeSpec): Record<string, unknown> {
  const { name, description, accent, neutral, font, corners, logo, words, voice } = theme;
  return {
    shipmate: "theme",
    version: 1,
    name,
    description,
    accent,
    neutral,
    font,
    corners,
    logo,
    words,
    voice,
  };
}

export function themeWords(theme: Pick<CustomThemeSpec, "words"> | null | undefined): ThemeWordMap {
  const out = { ...DEFAULT_THEME_WORDS };
  for (const [key, value] of Object.entries(theme?.words ?? {})) {
    if (value) out[key as ThemeWordKey] = value;
  }
  return out;
}

// ---------- palettes ----------

const TAILWIND_NEUTRALS: Record<Exclude<ThemeNeutral, "tinted">, string[]> = {
  slate: [
    "oklch(98.4% 0.003 247.858)",
    "oklch(96.8% 0.007 247.896)",
    "oklch(92.9% 0.013 255.508)",
    "oklch(86.9% 0.022 252.894)",
    "oklch(70.4% 0.04 256.788)",
    "oklch(55.4% 0.046 257.417)",
    "oklch(44.6% 0.043 257.281)",
    "oklch(37.2% 0.044 257.287)",
    "oklch(27.9% 0.041 260.031)",
    "oklch(20.8% 0.042 265.755)",
    "oklch(12.9% 0.042 264.695)",
  ],
  gray: [
    "oklch(98.5% 0.002 247.839)",
    "oklch(96.7% 0.003 264.542)",
    "oklch(92.8% 0.006 264.531)",
    "oklch(87.2% 0.01 258.338)",
    "oklch(70.7% 0.022 261.325)",
    "oklch(55.1% 0.027 264.364)",
    "oklch(44.6% 0.03 256.802)",
    "oklch(37.3% 0.034 259.733)",
    "oklch(27.8% 0.033 256.848)",
    "oklch(21% 0.034 264.665)",
    "oklch(13% 0.028 261.692)",
  ],
  zinc: [
    "oklch(98.5% 0 0)",
    "oklch(96.7% 0.001 286.375)",
    "oklch(92% 0.004 286.32)",
    "oklch(87.1% 0.006 286.286)",
    "oklch(70.5% 0.015 286.067)",
    "oklch(55.2% 0.016 285.938)",
    "oklch(44.2% 0.017 285.786)",
    "oklch(37% 0.013 285.805)",
    "oklch(27.4% 0.006 286.033)",
    "oklch(21% 0.006 285.885)",
    "oklch(14.1% 0.005 285.823)",
  ],
  neutral: [
    "oklch(98.5% 0 0)",
    "oklch(97% 0 0)",
    "oklch(92.2% 0 0)",
    "oklch(87% 0 0)",
    "oklch(70.8% 0 0)",
    "oklch(55.6% 0 0)",
    "oklch(43.9% 0 0)",
    "oklch(37.1% 0 0)",
    "oklch(26.9% 0 0)",
    "oklch(20.5% 0 0)",
    "oklch(14.5% 0 0)",
  ],
  stone: [
    "oklch(98.5% 0.001 106.423)",
    "oklch(97% 0.001 106.424)",
    "oklch(92.3% 0.003 48.717)",
    "oklch(86.9% 0.005 56.366)",
    "oklch(70.9% 0.01 56.259)",
    "oklch(55.3% 0.013 58.071)",
    "oklch(44.4% 0.011 73.639)",
    "oklch(37.4% 0.01 67.558)",
    "oklch(26.8% 0.007 34.298)",
    "oklch(21.6% 0.006 56.043)",
    "oklch(14.7% 0.004 49.25)",
  ],
};

const asPalette = (values: string[]): Palette =>
  Object.fromEntries(PALETTE_STEPS.map((s, i) => [s, values[i] as string])) as Palette;

/** The grays the app's slate-* classes become. Same lightness as slate, so contrast holds. */
export function neutralPalette(neutral: ThemeNeutral, accent: string): Palette {
  if (neutral !== "tinted") return asPalette(TAILWIND_NEUTRALS[neutral]);
  const { h } = rgbToOklch(hexToRgb(accent));
  return asPalette(
    TAILWIND_NEUTRALS.slate.map((v) => {
      const s = parseOklch(v);
      return oklchCss({ l: s.l, c: Math.min(s.c, maxChroma(s.l, h) * 0.95), h });
    }),
  );
}

const TARGET_L: Record<PaletteStep, number> = {
  "50": 0.975,
  "100": 0.945,
  "200": 0.895,
  "300": 0.83,
  "400": 0.74,
  "500": 0.655,
  "600": 0.56,
  "700": 0.49,
  "800": 0.43,
  "900": 0.38,
  "950": 0.28,
};
const CHROMA_SHARE: Record<PaletteStep, number> = {
  "50": 0.12,
  "100": 0.25,
  "200": 0.45,
  "300": 0.7,
  "400": 0.9,
  "500": 1,
  "600": 1,
  "700": 0.92,
  "800": 0.8,
  "900": 0.66,
  "950": 0.46,
};

const WHITE: Rgb = [1, 1, 1];
// The lightest dark-mode surfaces accent text sits on, and the light page; see contrast.test.ts.
const DARK_800 = oklchToRgb(parseOklch("oklch(27.9% 0.041 260.031)"));
const DARK_900 = oklchToRgb(parseOklch("oklch(21.6% 0.042 265.755)"));
const LIGHT_50 = oklchToRgb(parseOklch("oklch(98.5% 0.003 247.858)"));
const TEXT = 4.6;
const CONTROL = 3.1;

/**
 * Eleven accent shades from one color, like Tailwind's palettes, nudged so white text on the
 * buttons, accent text on light and dark pages, and focus rings all meet WCAG AA.
 */
export function accentPalette(accent: string): Palette {
  const base = rgbToOklch(hexToRgb(accent));
  const h = base.h;
  const peak = base.c;
  const shade = (step: PaletteStep, l: number): Oklch => {
    const ll = Math.min(0.99, Math.max(0.05, l));
    return { l: ll, h, c: Math.min(peak * CHROMA_SHARE[step], maxChroma(ll, h) * 0.97) };
  };
  const rgb = (c: Oklch) => oklchToRgb(c);
  const p = Object.fromEntries(PALETTE_STEPS.map((s) => [s, shade(s, TARGET_L[s])])) as Record<
    PaletteStep,
    Oklch
  >;
  const darken = (step: PaletteStep, ok: (c: Rgb) => boolean) => {
    while (!ok(rgb(p[step])) && p[step].l > 0.06) p[step] = shade(step, p[step].l - 0.005);
  };
  const lighten = (step: PaletteStep, ok: (c: Rgb) => boolean) => {
    while (!ok(rgb(p[step])) && p[step].l < 0.985) p[step] = shade(step, p[step].l + 0.005);
  };
  const below = (step: PaletteStep, other: PaletteStep, gap: number) => {
    if (p[step].l > p[other].l - gap) p[step] = shade(step, p[other].l - gap);
  };
  const above = (step: PaletteStep, other: PaletteStep, gap: number) => {
    if (p[step].l < p[other].l + gap) p[step] = shade(step, p[other].l + gap);
  };

  darken("600", (c) => contrastRatio(WHITE, c) >= TEXT && contrastRatio(c, LIGHT_50) >= CONTROL);
  below("700", "600", 0.05);
  darken(
    "700",
    (c) =>
      contrastRatio(WHITE, c) >= TEXT &&
      contrastRatio(c, LIGHT_50) >= TEXT &&
      contrastRatio(c, rgb(p["50"])) >= TEXT,
  );
  below("800", "700", 0.05);
  darken("800", (c) => contrastRatio(c, rgb(p["100"])) >= TEXT);
  below("900", "800", 0.045);
  below("950", "900", 0.09);
  lighten("300", (c) => contrastRatio(c, DARK_800) >= TEXT);
  lighten("400", (c) => contrastRatio(c, DARK_900) >= CONTROL);
  above("400", "600", 0.08);
  above("300", "400", 0.05);
  // Keep the steps in order after the nudges.
  if (p["500"].l > p["400"].l - 0.03 || p["500"].l < p["600"].l + 0.03) {
    p["500"] = shade("500", (p["400"].l + p["600"].l) / 2);
  }
  above("200", "300", 0.045);
  above("100", "200", 0.035);
  above("50", "100", 0.025);
  return Object.fromEntries(PALETTE_STEPS.map((s) => [s, oklchCss(p[s])])) as Palette;
}

export const hexOf = (oklch: string) => rgbToHex(oklchToRgb(parseOklch(oklch)));

const FONT_STACKS: Record<ThemeFont, string | null> = {
  system: null,
  rounded:
    'ui-rounded, "SF Pro Rounded", "Nunito", "Quicksand", "Varela Round", system-ui, sans-serif',
  serif: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace',
};

const RADIUS_STEPS = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;
/** Tailwind's corner sizes per style; "soft" keeps Tailwind's own. */
const RADII: Record<ThemeCorners, string[] | null> = {
  sharp: ["0px", "0.125rem", "0.125rem", "0.1875rem", "0.25rem", "0.3125rem", "0.375rem", "0.5rem"],
  soft: null,
  round: ["0.25rem", "0.375rem", "0.5rem", "0.75rem", "1rem", "1.375rem", "1.75rem", "2.25rem"],
};

/** Every CSS custom property a theme may set, so switching away can clear them all. */
export const THEME_PAINT_PROPERTIES = [
  ...PALETTE_STEPS.flatMap((s) => [`--color-accent-${s}`, `--color-slate-${s}`]),
  ...RADIUS_STEPS.map((s) => `--radius-${s}`),
];

/** Everything the web app needs to paint a theme. */
export interface ThemePaint {
  /** CSS custom properties: the accent and slate scales, and corner sizes. */
  vars: Record<string, string>;
  /** The font stack, or null for the app's own. */
  fontFamily: string | null;
  /** The browser and home-screen title bar: accent 700 in light, the darkest-but-one gray in dark. */
  barLight: string;
  barDark: string;
}

export function themePaint(
  theme: Pick<CustomThemeSpec, "accent" | "neutral" | "font" | "corners">,
): ThemePaint {
  const accent = accentPalette(theme.accent);
  const gray = neutralPalette(theme.neutral, theme.accent);
  const vars: Record<string, string> = {};
  for (const s of PALETTE_STEPS) {
    vars[`--color-accent-${s}`] = accent[s];
    vars[`--color-slate-${s}`] = gray[s];
  }
  RADII[theme.corners]?.forEach((v, i) => {
    vars[`--radius-${RADIUS_STEPS[i]}`] = v;
  });
  return {
    vars,
    fontFamily: FONT_STACKS[theme.font],
    barLight: hexOf(accent["700"]),
    barDark: hexOf(gray["900"]),
  };
}

// ---------- logos ----------

const SVG_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
]);
const SVG_ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "width",
  "height",
  "id",
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "maskUnits",
  "clipPathUnits",
  "paint-order",
  "vector-effect",
]);
const MAX_ELEMENTS = 300;

/**
 * Accepts only plain vector shapes: no scripts, styles, links, images, text or outside
 * references. It rebuilds the SVG from what it allows, so what comes out is exactly what was
 * checked. Logos are also only ever shown as images, where browsers never run scripts.
 */
export function sanitizeLogoSvg(input: string): { svg: string } | { error: string } {
  let s = input.trim();
  if (s.length > MAX_LOGO_LENGTH) return { error: `keep it under ${MAX_LOGO_LENGTH} characters` };
  s = s.replace(/^<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "");
  if (/<!/.test(s)) return { error: "no DOCTYPE, CDATA or entity declarations" };
  const out: string[] = [];
  const stack: string[] = [];
  let count = 0;
  let pos = 0;
  const tag = /<[^>]*>/g;
  for (let m = tag.exec(s); m; m = tag.exec(s)) {
    const between = s.slice(pos, m.index);
    if (between.trim()) {
      return { error: "no text in the logo; draw letters as paths, or leave them out" };
    }
    pos = m.index + m[0].length;
    const raw = m[0];
    const close = raw.match(/^<\/\s*([A-Za-z][\w:-]*)\s*>$/);
    if (close) {
      const name = close[1] as string;
      if (stack.pop() !== name) return { error: `</${name}> does not match an open element` };
      out.push(`</${name}>`);
      continue;
    }
    const open = raw.match(/^<([A-Za-z][\w:-]*)([\s\S]*?)(\/?)>$/);
    if (!open) return { error: `could not read ${raw.slice(0, 40)}` };
    const name = open[1] as string;
    if (!SVG_ELEMENTS.has(name)) {
      return {
        error: `<${name}> is not allowed; use only ${[...SVG_ELEMENTS].join(", ")}`,
      };
    }
    if (!stack.length && out.length) return { error: "put everything inside one <svg>" };
    if (!out.length && name !== "svg") return { error: "the logo must start with <svg>" };
    if (++count > MAX_ELEMENTS) return { error: `use at most ${MAX_ELEMENTS} elements` };
    const attrs = parseAttributes(open[2] as string);
    if ("error" in attrs) return attrs;
    const kept: string[] = [];
    for (const [key, value] of attrs.list) {
      if (!SVG_ATTRIBUTES.has(key)) {
        return {
          error: `the ${key} attribute is not allowed${key === "style" || key === "class" ? "; set fill and stroke directly" : ""}`,
        };
      }
      const bad = checkValue(key, value);
      if (bad) return { error: bad };
      if (name === "svg" && !stack.length && ["xmlns", "width", "height"].includes(key)) continue;
      kept.push(`${key}="${value.replace(/"/g, "&quot;")}"`);
    }
    if (name === "svg" && !stack.length) {
      const viewBox = attrs.list.find(([k]) => k === "viewBox")?.[1] ?? "";
      if (
        viewBox
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number)
          .filter(Number.isFinite).length !== 4
      ) {
        return { error: 'the <svg> needs a viewBox such as viewBox="0 0 64 64"' };
      }
      kept.unshift('xmlns="http://www.w3.org/2000/svg"');
    }
    const selfClosing = open[3] === "/";
    out.push(`<${name}${kept.length ? ` ${kept.join(" ")}` : ""}${selfClosing ? "/" : ""}>`);
    if (!selfClosing) stack.push(name);
    if (!stack.length && selfClosing && name === "svg") break;
  }
  if (s.slice(pos).trim()) return { error: "nothing may follow the closing </svg>" };
  if (stack.length) return { error: `<${stack[stack.length - 1]}> is never closed` };
  if (!out.length) return { error: "the logo must be an <svg> element" };
  if (count < 2) return { error: "the logo has no shapes" };
  return { svg: out.join("") };
}

function parseAttributes(text: string): { list: Array<[string, string]> } | { error: string } {
  const list: Array<[string, string]> = [];
  const re = /\s*([^\s="'/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  let pos = 0;
  while (pos < text.length) {
    if (!text.slice(pos).trim()) break;
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return { error: `could not read the attributes "${text.trim().slice(0, 40)}"` };
    list.push([m[1] as string, (m[2] ?? m[3] ?? "").trim()]);
    pos = re.lastIndex;
  }
  return { list };
}

function checkValue(key: string, value: string): string | null {
  if (/[<>&\\]/.test(value)) return `the ${key} value may not contain < > & or \\`;
  if (/javascript:|data:|expression\(|@import/i.test(value))
    return `the ${key} value is not allowed`;
  if (/url\(/i.test(value) && !/^url\(#[\w-]+\)$/.test(value)) {
    return `${key} may only point at a gradient, clip path or mask in the logo, as url(#id)`;
  }
  if (key === "xmlns" && value !== "http://www.w3.org/2000/svg")
    return "use the standard SVG xmlns";
  if (key === "id" && !/^[\w-]+$/.test(value)) return "ids may only use letters, digits, - and _";
  return null;
}

/** The logo as an image URL; currentColor draws in `color` (white on the accent tile). */
export function logoDataUri(svg: string, color = "#ffffff"): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/currentColor/g, color))}`;
}

/** The tab icon: the logo in white on a rounded accent tile, like the North Star icons. */
export function logoTileSvg(svg: string, accent: string): string {
  const p = accentPalette(accent);
  const inner = svg
    .replace(/currentColor/g, "#ffffff")
    .replace(/^<svg /, '<svg x="10" y="10" width="44" height="44" ');
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '<defs><linearGradient id="shipmate-tile" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="${hexOf(p["500"])}"/><stop offset="1" stop-color="${hexOf(p["700"])}"/>`,
    "</linearGradient></defs>",
    '<rect width="64" height="64" rx="14" fill="url(#shipmate-tile)"/>',
    inner,
    "</svg>",
  ].join("");
}
