import { describe, expect, it } from "vitest";
import { formatItems } from "./everyday.js";

describe("list tools", () => {
  const items = [
    { text: "Milk", checked: false, dueOn: null, note: null },
    { text: "Rent", checked: false, dueOn: "2026-11-01", note: "$1,200, transfer" },
    { text: "Eggs", checked: true, dueOn: null, note: null },
  ];

  it("shows open items with due dates and notes", () => {
    expect(formatItems(items, false)).toBe(
      "- [ ] Milk\n- [ ] Rent (due 2026-11-01) — $1,200, transfer",
    );
    expect(formatItems(items, true)).toContain("- [x] Eggs");
    expect(formatItems([], true)).toBe("(empty)");
    expect(formatItems([items[2] as (typeof items)[number]], false)).toBe("(nothing open)");
  });
});
