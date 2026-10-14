/**
 * Color math for custom themes: hex to OKLCH, OKLCH to sRGB with gamut checks, and WCAG
 * contrast. Pure functions, used by the server (to check a theme) and the web app (to paint it).
 */

export type Rgb = [number, number, number];
export interface Oklch {
  /** Lightness 0..1. */
  l: number;
  c: number;
  /** Hue in degrees. */
  h: number;
}

/** `#rgb` or `#rrggbb`, any case. */
export const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Gamma-encoded sRGB in 0..1. */
export function hexToRgb(hex: string): Rgb {
  if (!HEX_COLOR.test(hex)) throw new Error(`not a hex color: ${hex}`);
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklch(rgb: Rgb): Oklch {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, B);
  const h = c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** Linear sRGB, unclipped (values outside 0..1 are out of gamut). */
function oklchToLinear({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

export function inGamut(color: Oklch): boolean {
  return oklchToLinear(color).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}

/** Gamma-encoded sRGB, clipped to the gamut. */
export function oklchToRgb(color: Oklch): Rgb {
  return oklchToLinear(color).map((v) => toGamma(Math.min(1, Math.max(0, v)))) as Rgb;
}

/** The most chroma this lightness and hue can have inside sRGB. */
export function maxChroma(l: number, h: number): number {
  let lo = 0;
  let hi = 0.4;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut({ l, c: mid, h })) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** CSS `oklch()` with the precision the stylesheet uses. */
export function oklchCss({ l, c, h }: Oklch): string {
  return `oklch(${(l * 100).toFixed(1)}% ${c.toFixed(3)} ${h.toFixed(1)})`;
}

/** Parses `oklch(L% C H)` (as written in index.css). */
export function parseOklch(value: string): Oklch {
  const m = value.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\s*\)/);
  if (!m) throw new Error(`not an oklch() color: ${value}`);
  return { l: Number(m[1]) / 100, c: Number(m[2]), h: m[3] === "none" ? 0 : Number(m[3]) };
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 to 21. AA asks 4.5 for text, 3 for large text and controls. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
