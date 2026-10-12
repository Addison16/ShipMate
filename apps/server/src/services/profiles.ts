import {
  type HouseholdDto,
  type HouseholdFacts,
  type PersonProfile,
  type ProfileDto,
  parseHouseholdFacts,
  parsePersonProfile,
  SHIPMATE_USES,
} from "@shipmate/core";
import { type Db, userProfiles, users } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { UserRow } from "../auth.js";
import type { SettingsService } from "./settings.js";
import { isTimeZone } from "./starters.js";

const HOUSEHOLD_KEY = "household";

const TimeZone = z
  .string()
  .trim()
  .max(64)
  .refine((tz) => tz === "" || isTimeZone(tz), "not a known IANA timezone, e.g. Europe/Berlin");

export const UpdateProfileSchema = z
  .object({
    diet: z.string().trim().max(500),
    budget: z.string().trim().max(500),
    timezone: TimeZone,
    schedule: z.string().trim().max(2000),
    notes: z.string().trim().max(2000),
    shared: z.boolean(),
  })
  .partial()
  .strict();

export const UpdateHouseholdSchema = z
  .object({
    use: z.enum(["", ...SHIPMATE_USES]),
    location: z.string().trim().max(200),
    timezone: TimeZone,
    notes: z.string().trim().max(4000),
  })
  .partial()
  .strict();

/** A profile other crew may read: whose it is, and what it says. */
export interface NamedProfile {
  userId: string;
  name: string;
  profile: PersonProfile;
}

/**
 * Household profiles (per-person facts) and household-wide facts, so every crew member knows
 * diets, budgets, timezones and schedules without being told each time.
 */
export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async get(userId: string): Promise<ProfileDto> {
    const [row] = await this.db.select().from(userProfiles).where(eq(userProfiles.userId, userId));
    return {
      ...parsePersonProfile(row?.profile),
      shared: row?.shared ?? false,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  async set(userId: string, patch: z.infer<typeof UpdateProfileSchema>): Promise<ProfileDto> {
    const current = await this.get(userId);
    const { shared, ...fields } = patch;
    const profile = parsePersonProfile({ ...current, ...fields });
    const nextShared = shared ?? current.shared;
    await this.db
      .insert(userProfiles)
      .values({ userId, profile, shared: nextShared })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: { profile, shared: nextShared, updatedAt: new Date() },
      });
    return this.get(userId);
  }

  async household(): Promise<HouseholdDto> {
    const stored = await this.settings.getJson<HouseholdFacts & { updatedAt?: string }>(
      HOUSEHOLD_KEY,
    );
    return { ...parseHouseholdFacts(stored), updatedAt: stored?.updatedAt ?? null };
  }

  async setHousehold(patch: z.infer<typeof UpdateHouseholdSchema>): Promise<HouseholdDto> {
    const current = await this.household();
    const { updatedAt: _, ...facts } = current;
    const next = parseHouseholdFacts({ ...facts, ...patch });
    await this.settings.setJson(HOUSEHOLD_KEY, { ...next, updatedAt: new Date().toISOString() });
    return this.household();
  }

  /** What crew working for `user` may read: the household, their profile, others' shared ones. */
  async forCrew(user: UserRow): Promise<{
    household: HouseholdFacts;
    me: PersonProfile;
    others: NamedProfile[];
  }> {
    const rows = await this.db
      .select({ p: userProfiles, name: users.displayName })
      .from(userProfiles)
      .innerJoin(users, eq(users.id, userProfiles.userId));
    const mine = rows.find((r) => r.p.userId === user.id);
    const { updatedAt: _, ...household } = await this.household();
    return {
      household,
      me: parsePersonProfile(mine?.p.profile),
      others: rows
        .filter((r) => r.p.userId !== user.id && r.p.shared)
        .map((r) => ({
          userId: r.p.userId,
          name: r.name,
          profile: parsePersonProfile(r.p.profile),
        }))
        .filter((r) => hasAny(r.profile))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
}

export function hasAny(p: Partial<Record<string, string>>): boolean {
  return Object.values(p).some((v) => typeof v === "string" && v.trim() !== "");
}

const PROFILE_LABELS: Array<[keyof PersonProfile, string]> = [
  ["diet", "Diet"],
  ["budget", "Budget"],
  ["timezone", "Timezone"],
  ["schedule", "Schedule"],
  ["notes", "Notes"],
];

/** A profile as short "- Diet: ..." lines; long fields are cut to `max` characters each. */
export function profileLines(p: PersonProfile, max = Number.POSITIVE_INFINITY): string[] {
  return PROFILE_LABELS.filter(([k]) => p[k].trim()).map(([k, label]) => {
    const v = p[k].trim().replace(/\s*\n\s*/g, "; ");
    return `- ${label}: ${v.length > max ? `${v.slice(0, max)}… (read_profiles for the rest)` : v}`;
  });
}

const USE_LABELS = {
  home: "home life (family, meals, bills, plans)",
  work: "work (tasks, email, meetings, research)",
  both: "both home life and work",
} as const;

/** Household facts as lines; empty when nothing is set. */
export function householdLines(h: HouseholdFacts, max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  if (h.use) out.push(`- Used for: ${USE_LABELS[h.use]}`);
  const home = [h.location.trim(), h.timezone.trim() ? `(${h.timezone.trim()})` : ""]
    .filter(Boolean)
    .join(" ");
  if (home) out.push(`- ${h.use === "work" ? "Based in" : "Home"}: ${home}`);
  const notes = h.notes.trim();
  if (notes) {
    out.push(notes.length > max ? `${notes.slice(0, max)}… (read_profiles for the rest)` : notes);
  }
  return out;
}
