// Regenerates the North Star app icons and a web app manifest for every color theme.
// Usage: node apps/web/scripts/make-icons.mjs   (PNGs need Playwright with a Chromium build)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Accent 500 and 700 of each palette in src/index.css. 700 is also the title bar color. */
const THEMES = {
  harbor: ["#14b8a6", "#0f766e"],
  "open-sea": ["#3b82f6", "#1d4ed8"],
  "coral-reef": ["#f43f5e", "#be123c"],
  lighthouse: ["#f97316", "#c2410c"],
  "kelp-forest": ["#10b981", "#047857"],
  admiral: ["#6366f1", "#4338ca"],
};

const MARK = `
    <path d="M32 7 26.5 26.5 32 32ZM57 32 37.5 26.5 32 32ZM32 57 37.5 37.5 32 32ZM7 32 26.5 37.5 32 32Z"/>
    <path opacity=".55" d="M32 7 37.5 26.5 32 32ZM57 32 37.5 37.5 32 32ZM32 57 26.5 37.5 32 32ZM7 32 26.5 26.5 32 32Z"/>
    <circle cx="32" cy="32" r="16" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="2"/>`;

/** rx 112 is the rounded app tile; rx 0 is full bleed for icons the phone masks itself. */
function svg([from, to], { rx, maskable = false }) {
  const corner = rx ? ` rx="${rx}"` : "";
  const mark = maskable ? "translate(64 64) scale(6)" : "scale(8)";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>Shipmate</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".18"/><stop offset=".55" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="512" height="512"${corner} fill="url(#bg)"/>
  <rect width="512" height="512"${corner} fill="url(#shine)"/>
  <g transform="${mark}" fill="#ffffff">${MARK}
  </g>
</svg>
`;
}

function manifest(theme, [, to]) {
  const base = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8"));
  const dir = `/icons/${theme}`;
  return `${JSON.stringify(
    {
      ...base,
      background_color: to,
      theme_color: to,
      icons: [
        { src: `${dir}/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: `${dir}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: `${dir}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
        {
          src: `${dir}/maskable-512.png`,
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

const pngJobs = [];
for (const [theme, colors] of Object.entries(THEMES)) {
  const dir = join(PUBLIC, "icons", theme);
  mkdirSync(dir, { recursive: true });
  const rounded = svg(colors, { rx: 112 });
  const square = svg(colors, { rx: 0 });
  const maskable = svg(colors, { rx: 0, maskable: true });
  writeFileSync(join(dir, "icon.svg"), rounded);
  writeFileSync(join(dir, "manifest.webmanifest"), manifest(theme, colors));
  pngJobs.push(
    [rounded, 512, join(dir, "icon-512.png"), true],
    [rounded, 192, join(dir, "icon-192.png"), true],
    [rounded, 32, join(dir, "favicon-32.png"), true],
    [maskable, 512, join(dir, "maskable-512.png"), false],
    [square, 180, join(dir, "apple-touch-icon.png"), false],
  );
  if (theme === "harbor") {
    // The default set at the old paths, used before the app knows the theme.
    writeFileSync(join(PUBLIC, "icons", "icon.svg"), rounded);
    writeFileSync(join(PUBLIC, "favicon.svg"), rounded);
    writeFileSync(join(PUBLIC, "icons", "maskable.svg"), maskable);
    pngJobs.push(
      [rounded, 512, join(PUBLIC, "icons", "icon-512.png"), true],
      [rounded, 192, join(PUBLIC, "icons", "icon-192.png"), true],
      [rounded, 32, join(PUBLIC, "icons", "favicon-32.png"), true],
      [maskable, 512, join(PUBLIC, "icons", "maskable-512.png"), false],
      [square, 180, join(PUBLIC, "icons", "apple-touch-icon.png"), false],
    );
  }
}

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright"));
} catch {
  console.warn("Playwright not found: wrote SVGs and manifests, skipped PNGs.");
  process.exit(0);
}
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
for (const [source, size, out, transparent] of pngJobs) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = source.replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`,
  );
  await page.screenshot({ path: out, omitBackground: transparent });
  await page.close();
}
await browser.close();
console.log(`Wrote icons for ${Object.keys(THEMES).length} color themes.`);
