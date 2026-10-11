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

const text = (max: number) => z.string().max(max).catch("");

/**
 * What the crew should know about one person so nobody repeats themselves to each bot. Stored
 * per user; every field is free text and optional.
 */
export const PersonProfile = z.object({
  diet: text(500).default(""),
  budget: text(500).default(""),
  /** IANA timezone, e.g. America/Chicago. */
  timezone: text(64).default(""),
  /** Work hours, routines, the kids' school and activities. */
  schedule: text(2000).default(""),
  notes: text(2000).default(""),
});
export type PersonProfile = z.infer<typeof PersonProfile>;

/** Facts about the whole household, kept by the owner and admins, read by everyone. */
export const HouseholdFacts = z.object({
  /** Home town or address used for weather and travel, e.g. "Austin, TX". */
  location: text(200).default(""),
  timezone: text(64).default(""),
  /** Who lives here, kids' ages, pets, shared routines, house rules. */
  notes: text(4000).default(""),
});
export type HouseholdFacts = z.infer<typeof HouseholdFacts>;

export function parsePersonProfile(value: unknown): PersonProfile {
  return PersonProfile.parse(value && typeof value === "object" ? value : {});
}

export function parseHouseholdFacts(value: unknown): HouseholdFacts {
  return HouseholdFacts.parse(value && typeof value === "object" ? value : {});
}
