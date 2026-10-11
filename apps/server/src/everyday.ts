import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ListDetailDto, ListDto, ListKind } from "@shipmate/core";
import {
  briefingTools,
  type CrewFolder,
  type ListHost,
  type ListSummary,
  listTools,
  profileTools,
  weatherTools,
} from "@shipmate/crew";
import type { Db } from "@shipmate/db";
import type { UserRow } from "./auth.js";
import { dateIn, recentActivity } from "./services/activity.js";
import type { ListService } from "./services/lists.js";
import { hasAny, householdLines, type ProfileService, profileLines } from "./services/profiles.js";
import { formatForecast, type WeatherService } from "./services/weather.js";

/** Keeps the profile part of every crew member's system prompt short. */
const CONTEXT_FIELD_CHARS = 300;

/**
 * Everyday-life tools every crew member gets (shared lists, ...), bound to the person the crew
 * member is working for. The Bridge asks for them when it opens a session.
 */
export class EverydayTools {
  constructor(
    private readonly deps: {
      db: Db;
      lists: ListService;
      profiles: ProfileService;
      weather: WeatherService;
    },
  ) {}

  tools(user: UserRow, crew: CrewFolder): ToolDefinition[] {
    return [
      ...listTools(this.#listHost(user, crew)),
      ...profileTools({ read: () => this.#profilesText(user) }),
      ...weatherTools({
        forecast: async (place, days) => {
          const where = place?.trim() || (await this.deps.profiles.household()).location.trim();
          if (!where) {
            return "No place given and no home location set. Ask for the town, or an admin can set the home location under Settings, Household.";
          }
          return formatForecast(await this.deps.weather.forecast(where, days));
        },
      }),
      ...briefingTools({
        recentActivity: (hours) => recentActivity(this.deps.db, user, hours),
        dueSoon: (days) => this.#dueSoon(user, days),
      }),
    ];
  }

  async #dueSoon(user: UserRow, days: number): Promise<string> {
    const { household, me } = await this.deps.profiles.forCrew(user);
    const tz = me.timezone || household.timezone;
    const today = dateIn(tz);
    const until = dateIn(tz, days);
    const due = await this.deps.lists.dueBy(user, until);
    if (!due.length) return `Nothing open is due by ${until}.`;
    return [
      `Open items due by ${until} (today is ${today}):`,
      ...due.map(({ list, item }) => {
        const when =
          item.dueOn && item.dueOn < today ? `OVERDUE since ${item.dueOn}` : `due ${item.dueOn}`;
        return `- ${item.text} (${list}, ${when})${item.note ? ` — ${item.note}` : ""}`;
      }),
    ].join("\n");
  }

  /**
   * A compact system-prompt section: the household facts and the profile of the person the crew
   * member works for, so nobody has to repeat their diet or timezone to each bot.
   */
  async context(user: UserRow, now = new Date()): Promise<string> {
    const { household, me, others } = await this.deps.profiles.forCrew(user);
    const parts = ["## Household"];
    const home = householdLines(household, CONTEXT_FIELD_CHARS * 2);
    parts.push("", ...(home.length ? home : ["(no household facts yet)"]));
    const mine = profileLines(me, CONTEXT_FIELD_CHARS);
    parts.push("", `About ${user.displayName}:`, ...(mine.length ? mine : ["(no profile yet)"]));
    const tz = me.timezone || household.timezone;
    if (tz) {
      const local = localTime(now, tz);
      if (local) parts.push(`- Local time for ${user.displayName}: ${local}`);
    }
    if (others.length) {
      parts.push(
        `Shared profiles of ${others.map((o) => o.name).join(", ")} are available with \`read_profiles\`.`,
      );
    }
    parts.push(
      "",
      "Lists (groceries, to-dos, packing, bills) are kept with the list tools, not in memory. When someone tells you a lasting preference (diet, budget, timezone, schedule), suggest they add it to their profile in Settings so every crew member knows it.",
    );
    return parts.join("\n");
  }

  async #profilesText(user: UserRow): Promise<string> {
    const { household, me, others } = await this.deps.profiles.forCrew(user);
    const out = [
      "# Household",
      ...(householdLines(household).length ? householdLines(household) : ["(nothing set)"]),
    ];
    out.push("", `# ${user.displayName} (the person you are helping)`);
    out.push(...(hasAny(me) ? profileLines(me) : ["(no profile yet)"]));
    for (const o of others) out.push("", `# ${o.name} (shared)`, ...profileLines(o.profile));
    return out.join("\n");
  }

  #listHost(user: UserRow, crew: CrewFolder): ListHost {
    const lists = this.deps.lists;
    const actor = { user, crew: { slug: crew.slug, name: crew.manifest.name } };
    return {
      lists: async () => (await lists.list(user)).map(summary),
      read: async (ref) => {
        const l = await lists.find(user, ref);
        return { list: summary(l), items: l.items };
      },
      create: async (input) =>
        summary(
          await lists.create(actor, {
            name: input.name,
            kind: input.kind as ListKind,
            shared: !input.private,
          }),
        ),
      add: async (ref, items) => {
        const l = await lists.find(user, ref);
        const r = await lists.addItems(actor, l.id, items);
        return { list: summary(r.list), added: r.added, skipped: r.skipped };
      },
      change: async (ref, names, change) => {
        const l = await lists.find(user, ref);
        const r = await lists.changeByText(actor, l.id, names, change);
        return { list: summary(r.list), changed: r.changed, missing: r.missing };
      },
    };
  }
}

const summary = (l: ListDto | ListDetailDto): ListSummary => ({
  id: l.id,
  name: l.name,
  kind: l.kind,
  shared: l.shared,
  open: l.openCount,
  total: l.itemCount,
});

/** "Sunday, October 11, 21:05 (America/Chicago)", or null for an unknown timezone. */
export function localTime(now: Date, tz: string): string | null {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return `${f.format(now)} (${tz})`;
  } catch {
    return null;
  }
}
