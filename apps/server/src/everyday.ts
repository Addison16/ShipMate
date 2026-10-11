import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ListDetailDto, ListDto, ListKind } from "@shipmate/core";
import {
  type CrewFolder,
  type ListHost,
  type ListSummary,
  listTools,
  profileTools,
} from "@shipmate/crew";
import type { UserRow } from "./auth.js";
import type { ListService } from "./services/lists.js";
import { hasAny, householdLines, type ProfileService, profileLines } from "./services/profiles.js";

/** Keeps the profile part of every crew member's system prompt short. */
const CONTEXT_FIELD_CHARS = 300;

/**
 * Everyday-life tools every crew member gets (shared lists, ...), bound to the person the crew
 * member is working for. The Bridge asks for them when it opens a session.
 */
export class EverydayTools {
  constructor(private readonly deps: { lists: ListService; profiles: ProfileService }) {}

  tools(user: UserRow, crew: CrewFolder): ToolDefinition[] {
    return [
      ...listTools(this.#listHost(user, crew)),
      ...profileTools({ read: () => this.#profilesText(user) }),
    ];
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
