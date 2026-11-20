import { describe, expect, it } from "vitest";
import { matchPrompts, slashQuery } from "./prompts.js";

describe("saved prompts", () => {
  it("shows the menu only while the message is a single short / line", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/Meal pl")).toBe("meal pl");
    expect(slashQuery("hello /x")).toBeNull();
    expect(slashQuery("/x\nmore")).toBeNull();
    expect(slashQuery("")).toBeNull();
    expect(slashQuery(`/${"x".repeat(50)}`)).toBeNull();
  });

  it("matches every typed word, titles that start with the text first", () => {
    const all = [{ title: "Weekly meal plan" }, { title: "Meal ideas" }, { title: "Budget" }];
    expect(matchPrompts(all, "")).toEqual(all);
    expect(matchPrompts(all, "meal").map((p) => p.title)).toEqual([
      "Meal ideas",
      "Weekly meal plan",
    ]);
    expect(matchPrompts(all, "plan meal").map((p) => p.title)).toEqual(["Weekly meal plan"]);
    expect(matchPrompts(all, "zzz")).toEqual([]);
  });
});
