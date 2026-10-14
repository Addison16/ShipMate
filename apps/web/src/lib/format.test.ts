import { describe, expect, it } from "vitest";
import { currentMonth, dollarsToCents, formatCost, formatTokens } from "./format.js";

describe("format", () => {
  it("formats micro-dollars as cents, with 4 decimals only under a cent", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(1_234_567)).toBe("$1.23");
    expect(formatCost(1_500_000_000)).toBe("$1,500.00");
    expect(formatCost(1_234)).toBe("$0.0012");
  });
  it("formats tokens with separators", () => {
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
  it("converts dollar input to cents", () => {
    expect(dollarsToCents("")).toBeNull();
    expect(dollarsToCents("12.5")).toBe(1250);
    expect(dollarsToCents("0.07")).toBe(7);
    expect(dollarsToCents("abc")).toBeUndefined();
    expect(dollarsToCents("-1")).toBeUndefined();
  });
  it("uses the UTC month", () => {
    expect(currentMonth(new Date("2026-01-31T23:30:00-05:00"))).toBe("2026-02");
  });
});
