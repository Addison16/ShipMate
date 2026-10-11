import { describe, expect, it } from "vitest";
import {
  capTone,
  dailyBars,
  formatPercent,
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
      { date: "2026-10-01", costMicroUsd: 1_000_000, calls: 3 },
      { date: "2026-10-02", costMicroUsd: 0, calls: 0 },
    ]);
    expect(max).toBe(1_000_000);
    expect(bars.map((b) => [b.day, b.height])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it("builds the export link", () => {
    expect(usageExportUrl("2026-10", "all")).toBe("/api/usage/export?month=2026-10&scope=all");
  });
});
