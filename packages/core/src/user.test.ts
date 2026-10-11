import { describe, expect, it } from "vitest";
import { parseUserPreferences } from "./user.js";

describe("parseUserPreferences", () => {
  it("fills defaults for empty or missing values", () => {
    expect(parseUserPreferences({})).toEqual({ themeMode: "auto", colorTheme: "harbor" });
    expect(parseUserPreferences(null)).toEqual({ themeMode: "auto", colorTheme: "harbor" });
  });

  it("keeps valid values and replaces unknown ones", () => {
    expect(parseUserPreferences({ themeMode: "dark", colorTheme: "admiral" })).toEqual({
      themeMode: "dark",
      colorTheme: "admiral",
    });
    expect(parseUserPreferences({ themeMode: "neon", colorTheme: "plaid", extra: 1 })).toEqual({
      themeMode: "auto",
      colorTheme: "harbor",
    });
  });
});
