import { describe, expect, it } from "vitest";
import { parseUserPreferences } from "./user.js";

describe("parseUserPreferences", () => {
  it("fills defaults for empty or missing values", () => {
    expect(parseUserPreferences({})).toEqual({
      themeMode: "auto",
      colorTheme: "harbor",
      customTheme: null,
    });
    expect(parseUserPreferences(null)).toEqual({
      themeMode: "auto",
      colorTheme: "harbor",
      customTheme: null,
    });
  });

  it("keeps valid values and replaces unknown ones", () => {
    expect(parseUserPreferences({ themeMode: "dark", colorTheme: "admiral" })).toEqual({
      themeMode: "dark",
      colorTheme: "admiral",
      customTheme: null,
    });
    expect(
      parseUserPreferences({ themeMode: "neon", colorTheme: "plaid", customTheme: "x", extra: 1 }),
    ).toEqual({
      themeMode: "auto",
      colorTheme: "harbor",
      customTheme: null,
    });
    const id = "6f1c2a7e-8d3b-4c5a-9e0f-1a2b3c4d5e6f";
    expect(parseUserPreferences({ customTheme: id }).customTheme).toBe(id);
  });
});
