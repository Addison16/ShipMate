import type { ListDetailDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import {
  daysUntil,
  dueLabel,
  kindLabel,
  localToday,
  PendingChanges,
  withItemChecked,
} from "./lists.js";

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

describe("withItemChecked", () => {
  const item = (id: string, checked: boolean) => ({
    id,
    text: id,
    checked,
    dueOn: null,
    note: null,
    position: 0,
    addedBy: null,
    checkedAt: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  });
  const list: ListDetailDto = {
    id: "l",
    name: "Groceries",
    kind: "grocery",
    shared: true,
    owner: null,
    createdById: null,
    openCount: 2,
    itemCount: 3,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    items: [item("milk", false), item("eggs", false), item("rice", true)],
  };

  it("checks an item and recounts what is open", () => {
    const next = withItemChecked(list, "milk", true);
    expect(next.items.find((i) => i.id === "milk")?.checked).toBe(true);
    expect(next.openCount).toBe(1);
    expect(withItemChecked(list, "rice", false).openCount).toBe(3);
    expect(list.openCount).toBe(2);
  });

  it("shows only the last answer of quick changes and refetches live updates afterwards", () => {
    const p = new PendingChanges();
    p.start(); // check milk
    p.start(); // check eggs
    // A live update for milk arrives while eggs is in flight: its refetch would uncheck eggs.
    expect(p.changedElsewhere()).toBe(false);
    // Milk's answer predates eggs' change, so it is not shown.
    expect(p.finish(true)).toEqual({ show: false, reload: false });
    expect(p.finish(true)).toEqual({ show: true, reload: true });
    // Settled: live updates refetch at once again.
    expect(p.changedElsewhere()).toBe(true);
    p.start();
    expect(p.finish(false)).toEqual({ show: false, reload: true });
    p.start();
    expect(p.finish(true)).toEqual({ show: true, reload: false });
  });
});
