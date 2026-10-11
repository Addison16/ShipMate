import {
  auditEvents,
  conversations,
  crewMembers,
  type Db,
  listItems,
  lists,
  messages,
  watches,
  watchRuns,
} from "@shipmate/db";
import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { UserRow } from "../auth.js";

const MAX_ROWS = 20;
const oneLine = (s: string, max = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * "What did the crew do overnight?" for one person: their watch runs, conversations the crew
 * answered, crew actions from the audit log, and list items crew added. Only that person's own
 * activity (and the shared lists) is included, so nobody learns what others asked for.
 */
export async function recentActivity(db: Db, user: UserRow, hours: number): Promise<string> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const out: string[] = [`Activity for ${user.displayName} in the last ${hours} hours:`];

  const runs = await db
    .select({ run: watchRuns, name: watches.name })
    .from(watchRuns)
    .innerJoin(watches, eq(watches.id, watchRuns.watchId))
    .where(and(eq(watches.ownerId, user.id), gte(watchRuns.startedAt, since)))
    .orderBy(desc(watchRuns.startedAt))
    .limit(MAX_ROWS);
  out.push("", "## Watch runs");
  if (!runs.length) out.push("(none)");
  for (const r of runs) {
    const detail = r.run.error
      ? `error: ${oneLine(r.run.error)}`
      : r.run.output
        ? oneLine(r.run.output)
        : "";
    out.push(`- ${r.name}: ${r.run.status.replace("_", " ")}${detail ? `. ${detail}` : ""}`);
  }

  const replies = await db
    .select({
      title: conversations.title,
      surface: conversations.surface,
      crew: crewMembers.name,
      n: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .leftJoin(crewMembers, eq(crewMembers.id, messages.crewMemberId))
    .where(
      and(
        eq(conversations.userId, user.id),
        eq(messages.role, "assistant"),
        gte(messages.createdAt, since),
        // Watch runs are listed above.
        sql`${conversations.surface} <> 'watch'`,
      ),
    )
    .groupBy(conversations.id, conversations.title, conversations.surface, crewMembers.name)
    .limit(MAX_ROWS);
  out.push("", "## Conversations the crew answered");
  if (!replies.length) out.push("(none)");
  for (const r of replies) {
    out.push(
      `- "${oneLine(r.title ?? "untitled", 80)}" (${r.surface}): ${r.n} repl${r.n === 1 ? "y" : "ies"} from ${r.crew ?? "the crew"}`,
    );
  }

  const actions = await db
    .select({
      action: auditEvents.action,
      decision: auditEvents.decision,
      crew: crewMembers.name,
      n: sql<number>`count(*)::int`,
    })
    .from(auditEvents)
    .leftJoin(crewMembers, eq(crewMembers.id, auditEvents.crewMemberId))
    .where(
      and(
        eq(auditEvents.userId, user.id),
        isNotNull(auditEvents.crewMemberId),
        gte(auditEvents.createdAt, since),
      ),
    )
    .groupBy(auditEvents.action, auditEvents.decision, crewMembers.name)
    .orderBy(desc(sql`count(*)`))
    .limit(MAX_ROWS);
  out.push("", "## Crew actions (from the audit log)");
  if (!actions.length) out.push("(none)");
  for (const a of actions) {
    out.push(`- ${a.crew ?? "crew"}: ${a.action} ×${a.n}${a.decision ? ` (${a.decision})` : ""}`);
  }

  const added = await db
    .select({
      list: lists.name,
      crew: sql<string>`coalesce(${crewMembers.name}, ${listItems.createdByCrew})`,
      n: sql<number>`count(*)::int`,
    })
    .from(listItems)
    .innerJoin(lists, eq(lists.id, listItems.listId))
    .leftJoin(crewMembers, eq(crewMembers.slug, listItems.createdByCrew))
    .where(
      and(
        or(isNull(lists.ownerId), eq(lists.ownerId, user.id)),
        isNotNull(listItems.createdByCrew),
        gte(listItems.createdAt, since),
      ),
    )
    .groupBy(lists.name, listItems.createdByCrew, crewMembers.name)
    .limit(MAX_ROWS);
  out.push("", "## List items the crew added");
  if (!added.length) out.push("(none)");
  for (const a of added) out.push(`- ${a.n} on "${a.list}" by ${a.crew}`);

  return out.join("\n");
}

/** YYYY-MM-DD in `tz` (UTC when empty or unknown), `addDays` days from now. */
export function dateIn(tz: string, addDays = 0, now = new Date()): string {
  const at = new Date(now.getTime() + addDays * 86_400_000);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
