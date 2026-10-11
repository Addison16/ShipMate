import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import type { UsageResponse, UsageTotals } from "@shipmate/core";
import { crewMembers, type Db, usageEvents, users } from "@shipmate/db";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";

export interface UsageContext {
  userId: string | null;
  crewMemberId: string | null;
  conversationId: string | null;
  routineId?: string | null;
}

/** Start (inclusive) and end (exclusive) of a UTC month given as YYYY-MM. */
export function monthRange(month: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error("month must be YYYY-MM");
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  return { start: new Date(Date.UTC(y, mo, 1)), end: new Date(Date.UTC(y, mo + 1, 1)) };
}

export const currentMonth = (now = new Date()) => now.toISOString().slice(0, 7);

/** Cost in micro-USD. pi prices known models itself; fall back to the model's table. */
export function costMicroUsd(model: Model<Api>, usage: Usage): number {
  const total = usage.cost?.total || calculateCost(model, usage).total;
  return Math.round(total * 1_000_000);
}

/** One row per model call so cost is attributable per user, crew and routine (Q3, Q4). */
export class UsageService {
  constructor(private readonly db: Db) {}

  async record(ctx: UsageContext, model: Model<Api>, usage: Usage): Promise<void> {
    await this.db.insert(usageEvents).values({
      userId: ctx.userId,
      crewMemberId: ctx.crewMemberId,
      conversationId: ctx.conversationId,
      routineId: ctx.routineId ?? null,
      model: `${model.provider}/${model.id}`,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      costMicroUsd: costMicroUsd(model, usage),
    });
  }

  /** This month's spend for a user, in micro-USD (for caps). */
  async monthSpend(userId: string, now = new Date()): Promise<number> {
    const { start, end } = monthRange(currentMonth(now));
    const [row] = await this.db
      .select({ cost: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, userId),
          gte(usageEvents.createdAt, start),
          lt(usageEvents.createdAt, end),
        ),
      );
    return Number(row?.cost ?? 0);
  }

  async summary(month: string, onlyUserId?: string): Promise<UsageResponse> {
    const { start, end } = monthRange(month);
    const filters: SQL[] = [gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)];
    if (onlyUserId) filters.push(eq(usageEvents.userId, onlyUserId));
    const where = and(...filters);
    const totals = {
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      costMicroUsd: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)`,
    };
    const num = (r: Record<keyof typeof totals, string>): UsageTotals => ({
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      costMicroUsd: Number(r.costMicroUsd),
    });

    const [all] = await this.db.select(totals).from(usageEvents).where(where);
    const byUser = await this.db
      .select({
        ...totals,
        userId: usageEvents.userId,
        displayName: users.displayName,
        capCents: users.monthlyCapCents,
      })
      .from(usageEvents)
      .leftJoin(users, eq(users.id, usageEvents.userId))
      .where(where)
      .groupBy(usageEvents.userId, users.displayName, users.monthlyCapCents);
    const byCrew = await this.db
      .select({ ...totals, slug: crewMembers.slug, name: crewMembers.name })
      .from(usageEvents)
      .leftJoin(crewMembers, eq(crewMembers.id, usageEvents.crewMemberId))
      .where(where)
      .groupBy(crewMembers.slug, crewMembers.name);
    const byModel = await this.db
      .select({ ...totals, model: usageEvents.model })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.model);

    const byCost = <T extends UsageTotals>(a: T, b: T) => b.costMicroUsd - a.costMicroUsd;
    return {
      month,
      totals: all ? num(all) : num({} as never),
      byUser: byUser
        .map((r) => ({
          ...num(r),
          userId: r.userId,
          displayName: r.displayName ?? "(deleted user)",
          capCents: r.capCents ?? null,
        }))
        .sort(byCost),
      byCrew: byCrew
        .map((r) => ({ ...num(r), slug: r.slug, name: r.name ?? "(retired crew)" }))
        .sort(byCost),
      byModel: byModel.map((r) => ({ ...num(r), model: r.model })).sort(byCost),
    };
  }
}
