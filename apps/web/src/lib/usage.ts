import type { UsageResponse, UsageTotals } from "@shipmate/core";

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

/** What the daily chart plots. */
export type ChartMetric = "cost" | "tokens" | "time";

/**
 * The chart to show first: cost, unless the month has calls but cost nothing (local models),
 * where tokens say more than a flat $0 line.
 */
export function defaultMetric(totals: Pick<UsageTotals, "calls" | "costMicroUsd">): ChartMetric {
  return totals.calls > 0 && totals.costMicroUsd === 0 ? "tokens" : "cost";
}

/**
 * A round axis maximum at or above `max` (1, 2 or 5 × a power of ten). An empty chart still
 * gets an axis of `emptyMax` (one cent by default, in micro-USD).
 */
export function niceMax(max: number, emptyMax = 10_000): number {
  if (max <= 0) return emptyMax;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * pow >= max) return step * pow;
  return 10 * pow;
}

type Day = UsageResponse["daily"][number];

/** The value a day contributes to the chart for a metric (0 when nothing was timed). */
export function metricValue(d: Day, metric: ChartMetric): number {
  if (metric === "tokens") return d.tokens;
  if (metric === "time") return d.avgResponseMs ?? 0;
  return d.costMicroUsd;
}

const EMPTY_MAX: Record<ChartMetric, number> = { cost: 10_000, tokens: 1_000, time: 1_000 };

/** Bars for the daily chart: height as a fraction of the axis maximum. */
export function dailyBars(daily: UsageResponse["daily"], metric: ChartMetric = "cost") {
  const max = niceMax(Math.max(0, ...daily.map((d) => metricValue(d, metric))), EMPTY_MAX[metric]);
  return {
    max,
    bars: daily.map((d) => ({
      ...d,
      day: Number(d.date.slice(8, 10)),
      value: metricValue(d, metric),
      height: metricValue(d, metric) / max,
    })),
  };
}

/** "850 ms", "1.2 s", "12 s", "2m 05s"; an em dash when there is no measurement. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** "950", "12k", "1.5M": short token counts for chart axes. */
export function formatTokensShort(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
  return `${Number((n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0))}M`;
}

/** An axis label for a chart value in the given metric. */
export function formatAxis(value: number, metric: ChartMetric): string {
  if (metric === "tokens") return formatTokensShort(value);
  if (metric === "time") return value === 0 ? "0" : formatDuration(value);
  return formatUsdShort(value);
}

/** "$1.23", or "$0.0012" for small amounts, for chart labels. */
export function formatUsdShort(micro: number): string {
  const usd = micro / 1_000_000;
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}
