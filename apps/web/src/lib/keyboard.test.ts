import { describe, expect, it } from "vitest";
import { keyboardInset } from "./keyboard.js";

describe("keyboardInset", () => {
  it("is 0 with the keyboard closed", () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
    expect(keyboardInset(844, 820, 0)).toBe(0);
  });
  it("measures the covered bottom of the window", () => {
    expect(keyboardInset(844, 508, 0)).toBe(336);
  });
  it("allows for the page being scrolled up under the keyboard", () => {
    expect(keyboardInset(844, 508, 120)).toBe(216);
  });
});
