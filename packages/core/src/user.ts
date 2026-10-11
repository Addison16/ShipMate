import { z } from "zod";

/** Roles are instance-wide. `owner` is created on first boot. */
export const UserRole = z.enum(["owner", "admin", "member"]);
export type UserRole = z.infer<typeof UserRole>;

/** Light, dark, or follow the device's setting. */
export const ThemeMode = z.enum(["auto", "light", "dark"]);
export type ThemeMode = z.infer<typeof ThemeMode>;

/** Accent color presets for the web app. The web app holds their names and swatches. */
export const ColorTheme = z.enum([
  "harbor",
  "open-sea",
  "coral-reef",
  "lighthouse",
  "kelp-forest",
  "admiral",
]);
export type ColorTheme = z.infer<typeof ColorTheme>;

/**
 * Per-user web app preferences, stored as JSON on the user row. Unknown or missing values fall
 * back to the defaults, so old rows and removed presets never break sign-in.
 */
export const UserPreferences = z.object({
  themeMode: ThemeMode.catch("auto"),
  colorTheme: ColorTheme.catch("harbor"),
});
export type UserPreferences = z.infer<typeof UserPreferences>;

export function parseUserPreferences(value: unknown): UserPreferences {
  return UserPreferences.parse(value && typeof value === "object" ? value : {});
}
