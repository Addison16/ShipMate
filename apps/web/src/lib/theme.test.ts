import { describe, expect, it } from "vitest";
import { barColor, DEFAULT_APPEARANCE, isDark, readCachedAppearance } from "./theme.js";

const store = (value: string | null) => ({ getItem: () => value });

describe("appearance", () => {
  it("resolves Auto from the device and keeps Light and Dark fixed", () => {
    expect(isDark("auto", true)).toBe(true);
    expect(isDark("auto", false)).toBe(false);
    expect(isDark("light", true)).toBe(false);
    expect(isDark("dark", false)).toBe(true);
  });

  it("reads the cached appearance and ignores anything unknown or broken", () => {
    expect(readCachedAppearance(store('{"themeMode":"dark","colorTheme":"admiral"}'))).toEqual({
      themeMode: "dark",
      colorTheme: "admiral",
    });
    expect(readCachedAppearance(store('{"themeMode":"neon","colorTheme":"plaid"}'))).toEqual(
      DEFAULT_APPEARANCE,
    );
    expect(readCachedAppearance(store("not json"))).toEqual(DEFAULT_APPEARANCE);
    expect(readCachedAppearance(store(null))).toEqual(DEFAULT_APPEARANCE);
    expect(readCachedAppearance(null)).toEqual(DEFAULT_APPEARANCE);
  });

  it("colors the browser bar with the theme in light mode and dark slate in dark mode", () => {
    expect(barColor({ themeMode: "light", colorTheme: "open-sea" }, true)).toBe("#1d4ed8");
    expect(barColor({ themeMode: "auto", colorTheme: "open-sea" }, true)).toBe("#0f172a");
  });
});
