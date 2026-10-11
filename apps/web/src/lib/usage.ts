import type { UsageResponse } from "@shipmate/core";

/** GET /api/usage/export: a CSV download of every model call in the month. */
export function usageExportUrl(month: string, scope: "me" | "all"): string {
  return `/api/usage/export?month=${encodeURIComponent(month)}&scope=${scope}`;
}

/** Cap in USD cents → micro-USD; null stays null. */
export const centsToMicro = (cents: number | null): number | null =>
  cents === null ? null : cents * 10_000;

/** Cap in USD → micro-USD; null stays null. */
export const usdToMicro = (usd: number | null): number | null =>
  usd === null ? null : Math.round(usd * 1_000_000);

/** Share of a cap spent, in percent (may exceed 100); null when there is no cap. */
export function percentUsed(spentMicro: number, capMicro: number | null): number | null {
  if (capMicro === null) return null;
  if (capMicro <= 0) return spentMicro > 0 ? Infinity : 100;
  return (spentMicro / capMicro) * 100;
}

/** "42%", "<1%", "100%+" style label for a percent from percentUsed. */
export function formatPercent(p: number | null): string {
  if (p === null) return "";
  if (!Number.isFinite(p) || p > 999) return ">999%";
  if (p > 0 && p < 1) return "<1%";
  return `${Math.floor(p)}%`;
}

/** Tone for a cap meter: fine below 80%, warning up to 100%, reached at 100%. */
export function capTone(p: number | null): "ok" | "warn" | "danger" | "neutral" {
  if (p === null) return "neutral";
  if (p >= 100) return "danger";
  if (p >= 80) return "warn";
  return "ok";
}

/** A round axis maximum at or above `max` (1, 2 or 5 × a power of ten), in micro-USD. */
export function niceMax(max: number): number {
  if (max <= 0) return 10_000; // one cent, so an empty month still draws an axis
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

/** Bars for the daily chart: height as a fraction of the axis maximum. */
export function dailyBars(daily: UsageResponse["daily"]) {
  const max = niceMax(Math.max(0, ...daily.map((d) => d.costMicroUsd)));
  return {
    max,
    bars: daily.map((d) => ({
      ...d,
      day: Number(d.date.slice(8, 10)),
      height: d.costMicroUsd / max,
    })),
  };
}

/** "$1.23", or "$0.0012" for small amounts, for chart labels. */
export function formatUsdShort(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}
