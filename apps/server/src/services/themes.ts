import {
  type CustomThemeDto,
  type CustomThemeSpec,
  checkTheme,
  parseUserPreferences,
  repairTheme,
  type ThemeWordMap,
  themeWords,
  type UserPreferences,
} from "@shipmate/core";
import { type Db, themes, users } from "@shipmate/db";
import { desc, eq, sql } from "drizzle-orm";
import { atLeast, HttpError, type UserRow } from "../auth.js";

type ThemeRow = typeof themes.$inferSelect;

/** Keeps a runaway model or a script from filling the database with themes. */
const MAX_THEMES = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A theme check that failed, with every problem listed so a model can fix them in one go. */
export class ThemeProblems extends HttpError {
  constructor(readonly problems: string[]) {
    super(400, `The theme needs fixing: ${problems.join("; ")}`);
  }
}

/**
 * The instance's custom themes. Anyone can make one and use any of them; the person who made a
 * theme, and owners and admins, can change or delete it.
 */
export class ThemeService {
  #listeners = new Set<() => void>();

  constructor(private readonly db: Db) {}

  /** Called after a theme is saved or deleted (the web apps refetch the list). */
  onChange(listener: () => void) {
    this.#listeners.add(listener);
  }

  #changed() {
    for (const l of this.#listeners) l();
  }

  /** Switch `user` to a custom theme, or back to their color theme with null. */
  async use(user: UserRow, id: string | null): Promise<UserPreferences> {
    if (id && !(await this.exists(id))) throw new HttpError(404, `no theme with id ${id}`);
    const raw =
      user.preferences && typeof user.preferences === "object"
        ? (user.preferences as Record<string, unknown>)
        : {};
    const preferences = { ...raw, ...parseUserPreferences(raw), customTheme: id };
    await this.db.update(users).set({ preferences }).where(eq(users.id, user.id));
    user.preferences = preferences;
    return parseUserPreferences(preferences);
  }

  async list(user: UserRow): Promise<CustomThemeDto[]> {
    const rows = await this.db
      .select({ theme: themes, creator: users.displayName })
      .from(themes)
      .leftJoin(users, eq(users.id, themes.createdById))
      .orderBy(desc(themes.updatedAt));
    return rows.flatMap((r) => this.#dto(user, r.theme, r.creator));
  }

  async get(user: UserRow, id: string): Promise<CustomThemeDto> {
    const found = await this.#row(id);
    if (!found) throw new HttpError(404, "theme not found");
    const dto = this.#dto(user, found.theme, found.creator);
    if (!dto.length) throw new HttpError(404, "theme not found");
    return dto[0] as CustomThemeDto;
  }

  /** Checks and stores a theme; with `id`, replaces that theme (if `user` may edit it). */
  /**
   * Saves a theme; with `id`, replaces that theme (if `user` may edit it). Input is repaired
   * rather than refused (small local models get details wrong), and `notes` says what changed.
   */
  async save(
    user: UserRow,
    input: unknown,
    id?: string,
  ): Promise<{ theme: CustomThemeDto; notes: string[] }> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(400, "That is not a theme file.");
    }
    const { theme: repaired, notes } = repairTheme(input);
    const check = checkTheme(repaired);
    if (!check.ok) throw new ThemeProblems(check.errors);
    const spec = check.theme;
    const done = async (themeId: string) => ({ theme: await this.get(user, themeId), notes });
    if (id) {
      const found = await this.#row(id);
      if (!found)
        throw new HttpError(404, `no theme with id ${id}; leave id out to make a new one`);
      this.#assertCanEdit(user, found.theme);
      const [row] = await this.db
        .update(themes)
        .set({ name: spec.name, spec, updatedAt: new Date() })
        .where(eq(themes.id, id))
        .returning();
      this.#changed();
      return done((row as ThemeRow).id);
    }
    const [{ count } = { count: 0 }] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(themes);
    if (count >= MAX_THEMES) {
      throw new HttpError(400, `this Shipmate already has ${MAX_THEMES} themes; delete some first`);
    }
    const [row] = await this.db
      .insert(themes)
      .values({ name: spec.name, spec, createdById: user.id })
      .returning();
    this.#changed();
    return done((row as ThemeRow).id);
  }

  async remove(user: UserRow, id: string): Promise<void> {
    const found = await this.#row(id);
    if (!found) throw new HttpError(404, "theme not found");
    this.#assertCanEdit(user, found.theme);
    await this.db.delete(themes).where(eq(themes.id, id));
    // Anyone using it goes back to their color theme.
    await this.db
      .update(users)
      .set({ preferences: sql`${users.preferences} || '{"customTheme": null}'::jsonb` })
      .where(sql`${users.preferences}->>'customTheme' = ${id}`);
    this.#changed();
  }

  /** The custom theme `user` has picked, or null (none, or it was deleted). */
  async activeFor(user: UserRow): Promise<CustomThemeSpec | null> {
    const id = parseUserPreferences(user.preferences).customTheme;
    if (!id) return null;
    const found = await this.#row(id);
    if (!found) return null;
    const check = checkTheme(found.theme.spec);
    return check.ok ? check.theme : null;
  }

  /** The app's words as `userId` sees them (their custom theme's, or their style's). */
  async wordsFor(userId: string): Promise<ThemeWordMap> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return themeWords(null);
    const { style } = parseUserPreferences(user.preferences);
    return themeWords(await this.activeFor(user), style);
  }

  /** Whether a theme exists (for picking one in preferences). */
  async exists(id: string): Promise<boolean> {
    return (await this.#row(id)) !== null;
  }

  /**
   * What the crew should know when someone uses a custom theme: its words and voice. Empty
   * when they use a standard theme.
   */
  async promptFor(user: UserRow): Promise<string> {
    const theme = await this.activeFor(user);
    const { style } = parseUserPreferences(user.preferences);
    if (!theme) {
      if (style === "nautical") return "";
      const w = themeWords(null);
      return `## Words\n\n${user.displayName} sees plain AI words in this app: the coordinator is the "${w.captain}", the helpers are "${w.crew}" (one is an "${w.crewMember}"), the chat is "${w.bridge}", scheduled jobs are "${w.watches}", work projects are "${w.shipyard}". Use these words with ${user.displayName}, not ship words like Captain, Crew, Bridge, Watches or Shipyard.`;
    }
    const w = themeWords(theme);
    const lines = [
      `## ${user.displayName}'s theme: ${theme.name}`,
      "",
      `${user.displayName} uses a custom theme, so in this app (for them) the coordinator is called "${w.captain}", the team is "${w.crew}" (one of them is a "${w.crewMember}"), the chat is "${w.bridge}", scheduled jobs are "${w.watches}", work projects are "${w.shipyard}", and the app is "${w.appName}". Use these words with ${user.displayName}, including for yourself and the others, even where your instructions use ship words like Captain, Crew, Bridge, Watches or Shipyard.`,
    ];
    if (theme.voice) {
      lines.push(
        "",
        "How to talk with them in this theme (flavor only; stay clear, accurate and brief, and drop it for serious or urgent topics):",
        "",
        theme.voice,
      );
    }
    return lines.join("\n");
  }

  async #row(id: string): Promise<{ theme: ThemeRow; creator: string | null } | null> {
    if (!UUID.test(id)) return null;
    const [r] = await this.db
      .select({ theme: themes, creator: users.displayName })
      .from(themes)
      .leftJoin(users, eq(users.id, themes.createdById))
      .where(eq(themes.id, id));
    return r ?? null;
  }

  #assertCanEdit(user: UserRow, row: ThemeRow) {
    if (row.createdById !== user.id && !atLeast(user.role, "admin")) {
      throw new HttpError(
        403,
        "only the person who made this theme, or an owner or admin, can change it",
      );
    }
  }

  #dto(user: UserRow, row: ThemeRow, creator: string | null): CustomThemeDto[] {
    // A row from an older or hand-edited database that no longer passes is left out.
    const check = checkTheme(row.spec);
    if (!check.ok) return [];
    return [
      {
        ...check.theme,
        id: row.id,
        createdBy: row.createdById ? { id: row.createdById, name: creator ?? "Someone" } : null,
        canEdit: row.createdById === user.id || atLeast(user.role, "admin"),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    ];
  }
}
