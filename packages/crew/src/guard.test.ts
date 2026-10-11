import { describe, expect, it } from "vitest";
import { isInside } from "./guard.js";

describe("isInside", () => {
  it("allows the folder and its children only", () => {
    expect(isInside("/data/crew/galley", "notes.md")).toBe(true);
    expect(isInside("/data/crew/galley", "/data/crew/galley/memory/x.md")).toBe(true);
    expect(isInside("/data/crew/galley", "../captain/CREW.md")).toBe(false);
    expect(isInside("/data/crew/galley", "/data/.secret")).toBe(false);
    expect(isInside("/data/crew/galley", "/data/crew/galley-evil/x")).toBe(false);
  });
});
