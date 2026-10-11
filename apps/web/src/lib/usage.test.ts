import { describe, expect, it } from "vitest";
import {
  capTone,
  dailyBars,
  defaultMetric,
  formatAxis,
  formatDuration,
  formatPercent,
  formatTokensShort,
  niceMax,
  percentUsed,
  usageExportUrl,
} from "./usage.js";

describe("usage helpers", () => {
  it("computes cap usage", () => {
    expect(percentUsed(500_000, null)).toBeNull();
    expect(percentUsed(500_000, 1_000_000)).toBe(50);
    expect(percentUsed(1, 0)).toBe(Infinity);
    expect(formatPercent(0.4)).toBe("<1%");
    expect(formatPercent(99.9)).toBe("99%");
    expect(formatPercent(Infinity)).toBe(">999%");
    expect(capTone(85)).toBe("warn");
    expect(capTone(100)).toBe("danger");
  });

  it("scales daily bars to a round maximum", () => {
    expect(niceMax(0)).toBe(10_000);
    expect(niceMax(1_300_000)).toBe(2_000_000);
    expect(niceMax(5_000_000)).toBe(5_000_000);
    const { max, bars } = dailyBars([
      { date: "2026-10-01", costMicroUsd: 1_000_000, calls: 3, tokens: 50, avgResponseMs: 900 },
      { date: "2026-10-02", costMicroUsd: 0, calls: 0, tokens: 0, avgResponseMs: null },
    ]);
    expect(max).toBe(1_000_000);
    expect(bars.map((b) => [b.day, b.height])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("charts tokens or response time when that says more than cost", () => {
    const daily = [
      { date: "2026-10-01", costMicroUsd: 0, calls: 4, tokens: 1_300, avgResponseMs: 2_400 },
      { date: "2026-10-02", costMicroUsd: 0, calls: 1, tokens: 650, avgResponseMs: null },
    ];
    const tokens = dailyBars(daily, "tokens");
    expect(tokens.max).toBe(2_000);
    expect(tokens.bars.map((b) => b.height)).toEqual([0.65, 0.325]);
    const time = dailyBars(daily, "time");
    expect(time.max).toBe(5_000);
    expect(time.bars.map((b) => b.value)).toEqual([2_400, 0]);
    expect(dailyBars([], "tokens").max).toBe(1_000);

    expect(defaultMetric({ calls: 5, costMicroUsd: 0 })).toBe("tokens");
    expect(defaultMetric({ calls: 0, costMicroUsd: 0 })).toBe("cost");
    expect(defaultMetric({ calls: 5, costMicroUsd: 12 })).toBe("cost");
  });

  it("formats durations and short token counts", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(1_240)).toBe("1.2 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatTokensShort(950)).toBe("950");
    expect(formatTokensShort(1_500)).toBe("1.5k");
    expect(formatTokensShort(12_000)).toBe("12k");
    expect(formatTokensShort(2_000_000)).toBe("2M");
    expect(formatAxis(0, "time")).toBe("0");
    expect(formatAxis(5_000, "time")).toBe("5.0 s");
    expect(formatAxis(10_000, "cost")).toBe("$0.01");
  });

  it("builds the export link", () => {
    expect(usageExportUrl("2026-10", "all")).toBe("/api/usage/export?month=2026-10&scope=all");
  });
});
