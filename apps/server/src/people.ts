import { ColorTheme, parseUserPreferences, ThemeMode, type UserPreferences } from "@shipmate/core";
import type { HouseholdChanges, PersonChanges } from "@shipmate/crew";
import { type Db, users } from "@shipmate/db";
import { asc, eq } from "drizzle-orm";
import { ZodError } from "zod";
import { atLeast, HttpError, type UserRow } from "./auth.js";
import {
  householdLines,
  type ProfileService,
  profileLines,
  UpdateHouseholdSchema,
  UpdateProfileSchema,
} from "./services/profiles.js";

const PROFILE_KEYS = ["diet", "budget", "timezone", "schedule", "notes", "shared"] as const;

/**
 * The Captain's side of setting people up: read and change each person's settings and profile,
 * and the household facts, with the same rules as the web app plus one addition: owners and
 * admins may fill in other people's profiles when asked to set them up.
 */
export class PeopleSettings {
  constructor(
    private readonly db: Db,
    private readonly profiles: ProfileService,
  ) {}

  async list(actor: UserRow): Promise<string> {
    const rows = await this.db.select().from(users).orderBy(asc(users.createdAt));
    const manager = atLeast(actor.role, "admin");
    const out: string[] = [];
    for (const u of rows) {
      const self = u.id === actor.id;
      const prefs = parseUserPreferences(u.preferences);
      const profile = await this.profiles.get(u.id);
      const cap =
        u.monthlyCapCents === null
          ? "no cap"
          : `cap $${(u.monthlyCapCents / 100).toFixed(2)}/month`;
      out.push(
        `## ${u.displayName}${self ? " (you are talking with them)" : ""}`,
        `- ${u.email}, ${u.role}, ${cap}, theme ${prefs.colorTheme} (${prefs.themeMode})`,
      );
      // Unshared profiles stay private, except to the managers who set people up.
      if (self || profile.shared || manager) {
        const lines = profileLines(profile);
        out.push(...(lines.length ? lines : ["- (no profile yet)"]));
        out.push(`- Profile ${profile.shared ? "shared with the household's crew" : "private"}`);
      } else {
        out.push("- (profile private)");
      }
      out.push("");
    }
    const household = householdLines(await this.profiles.household());
    out.push("## Household", ...(household.length ? household : ["(nothing set)"]));
    return out.join("\n");
  }

  async update(actor: UserRow, ref: string, changes: PersonChanges): Promise<string> {
    const target = await this.#find(ref);
    const self = target.id === actor.id;
    if (!self && !atLeast(actor.role, "admin")) {
      throw new HttpError(
        403,
        `${actor.displayName} is a member and can only change their own settings; an owner or admin can set up ${target.displayName}.`,
      );
    }
    if (changes.monthlyCapUsd !== undefined && actor.role !== "owner") {
      throw new HttpError(403, "only the owner can set spending caps");
    }
    if (changes.displayName !== undefined && !self && actor.role !== "owner") {
      throw new HttpError(403, "only the owner can rename other people");
    }

    const done: string[] = [];
    const profilePatch = Object.fromEntries(
      PROFILE_KEYS.filter((k) => changes[k] !== undefined).map((k) => [k, changes[k]]),
    );
    if (Object.keys(profilePatch).length) {
      await this.profiles.set(
        target.id,
        parse(() => UpdateProfileSchema.parse(profilePatch)),
      );
      done.push(...Object.keys(profilePatch).map((k) => (k === "shared" ? "profile sharing" : k)));
    }

    const values: Partial<typeof users.$inferInsert> = {};
    if (changes.displayName !== undefined) {
      const name = changes.displayName.trim();
      if (!name || name.length > 80) throw new HttpError(400, "a name is 1 to 80 characters");
      values.displayName = name;
      done.push("name");
    }
    if (changes.monthlyCapUsd !== undefined) {
      values.monthlyCapCents =
        changes.monthlyCapUsd === null ? null : Math.round(changes.monthlyCapUsd * 100);
      done.push("spending cap");
    }
    if (changes.themeMode !== undefined || changes.colorTheme !== undefined) {
      const raw =
        target.preferences && typeof target.preferences === "object"
          ? (target.preferences as Record<string, unknown>)
          : {};
      const appearance: Partial<UserPreferences> = parse(() => ({
        ...(changes.themeMode !== undefined
          ? { themeMode: ThemeMode.parse(changes.themeMode) }
          : {}),
        ...(changes.colorTheme !== undefined
          ? { colorTheme: ColorTheme.parse(changes.colorTheme) }
          : {}),
      }));
      values.preferences = { ...raw, ...parseUserPreferences(raw), ...appearance };
      done.push("theme");
    }
    if (Object.keys(values).length) {
      await this.db.update(users).set(values).where(eq(users.id, target.id));
    }
    if (!done.length) return "Nothing to change.";
    return `Updated ${values.displayName ?? target.displayName}: ${done.join(", ")}.`;
  }

  async updateHousehold(actor: UserRow, changes: HouseholdChanges): Promise<string> {
    if (!atLeast(actor.role, "admin")) {
      throw new HttpError(403, "only an owner or admin can change the household facts");
    }
    const patch = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) return "Nothing to change.";
    await this.profiles.setHousehold(parse(() => UpdateHouseholdSchema.parse(patch)));
    return `Updated the household: ${Object.keys(patch).join(", ")}.`;
  }

  async #find(ref: string): Promise<UserRow> {
    const rows = await this.db.select().from(users);
    const key = ref.trim().toLowerCase();
    const byId = rows.find((u) => u.id === ref.trim());
    if (byId) return byId;
    const exact = rows.filter(
      (u) => u.email.toLowerCase() === key || u.displayName.toLowerCase() === key,
    );
    const found =
      exact.length === 1
        ? exact
        : rows.filter((u) => u.displayName.toLowerCase().split(/\s+/)[0] === key);
    if (found.length === 1 && found[0]) return found[0];
    if (found.length > 1) {
      throw new HttpError(400, `more than one person matches "${ref}"; use their email`);
    }
    throw new HttpError(
      404,
      `nobody called "${ref}" has an account. An owner or admin adds people on the Users page.`,
    );
  }
}

/** Validation errors as one plain sentence the Captain can relay. */
function parse<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(
        400,
        err.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "),
      );
    }
    throw err;
  }
}
