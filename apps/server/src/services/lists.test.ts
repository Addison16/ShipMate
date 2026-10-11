import { describe, expect, it } from "vitest";
import { matchItem } from "./lists.js";

describe("matchItem", () => {
  // Last week's milk is still checked; today's milk was added again and is open.
  const items = [
    { id: "a", text: "Milk", checked: true },
    { id: "b", text: "Bread", checked: false },
    { id: "c", text: "milk", checked: false },
  ];

  it("picks the open copy to check off and the checked copy to uncheck", () => {
    expect(matchItem(items, "Milk", (i) => !i.checked)?.id).toBe("c");
    expect(matchItem(items, "milk", (i) => i.checked)?.id).toBe("a");
  });

  it("narrows an ambiguous partial match to the preferred item", () => {
    expect(matchItem(items, "mil")).toBeUndefined();
    expect(matchItem(items, "mil", (i) => !i.checked)?.id).toBe("c");
    expect(matchItem(items, "bre")?.id).toBe("b");
  });
});
