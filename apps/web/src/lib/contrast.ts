/** WCAG 2.x contrast for the oklch() colors the themes are written in. */

type Rgb = [number, number, number];

/** Parses `oklch(L% C H)` into gamma-encoded sRGB in 0..1, clipped to the sRGB gamut. */
export function oklchToRgb(value: string): Rgb {
  const m = value.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!m) throw new Error(`not an oklch() color: ${value}`);
  const l = Number(m[1]) / 100;
  const c = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return linear.map((x) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Contrast ratio between two colors, 1 to 21. AA asks 4.5 for text, 3 for large text and controls. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `[data-color-theme="…"]` block in a stylesheet, as accent step to color. */
export function themePalettes(css: string): Record<string, Record<string, Rgb>> {
  const themes: Record<string, Record<string, Rgb>> = {};
  for (const block of css.matchAll(/\[data-color-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)) {
    const steps: Record<string, Rgb> = {};
    for (const step of block[2].matchAll(/--color-accent-(\d+):\s*(oklch\([^)]*\))/g)) {
      steps[step[1]] = oklchToRgb(step[2]);
    }
    themes[block[1]] = steps;
  }
  return themes;
}
