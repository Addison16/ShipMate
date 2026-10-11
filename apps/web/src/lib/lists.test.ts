import { describe, expect, it } from "vitest";
import { daysUntil, dueLabel, kindLabel, localToday } from "./lists.js";

describe("lists", () => {
  it("labels kinds", () => {
    expect(kindLabel("grocery")).toBe("Groceries");
    expect(kindLabel("bills")).toBe("Bills");
  });

  it("counts days across months and years", () => {
    expect(daysUntil("2026-11-01", "2026-10-31")).toBe(1);
    expect(daysUntil("2027-01-01", "2026-12-31")).toBe(1);
    expect(daysUntil("2026-10-01", "2026-10-11")).toBe(-10);
  });

  it("describes due dates", () => {
    const today = "2026-10-11";
    expect(dueLabel("2026-10-10", today)).toEqual({ text: "Overdue by 1 day", tone: "danger" });
    expect(dueLabel("2026-10-08", today).text).toBe("Overdue by 3 days");
    expect(dueLabel("2026-10-11", today)).toEqual({ text: "Due today", tone: "warn" });
    expect(dueLabel("2026-10-12", today).text).toBe("Due tomorrow");
    expect(dueLabel("2026-10-15", today).text).toBe("Due in 4 days");
    expect(dueLabel("2026-10-31", today).text).toBe("Due Oct 31");
  });

  it("formats the local date", () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
  });
});
