import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { UsageResponse, UsageTotals } from "@shipmate/core";
import { crewMembers, type Db, usageEvents, users, watches } from "@shipmate/db";
import { and, asc, eq, gte, isNotNull, lt, type SQL, sql } from "drizzle-orm";

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

/**
 * How a call was paid for. "api": billed per token (an API key, or a free local model).
 * "subscription": covered by a flat plan the person already pays for (Claude through the Claude
 * Code CLI, ChatGPT through Sign in with ChatGPT or Codex), so it is not spend and does not count
 * towards caps; its API-price estimate is kept apart.
 */
export type Billing = "api" | "subscription";

/** Providers whose calls run on someone's plan rather than an API key. */
const SUBSCRIPTION_PROVIDERS = new Set(["claude-code", "chatgpt", "codex"]);

export const defaultBilling = (model: Pick<Model<Api>, "provider">): Billing =>
  SUBSCRIPTION_PROVIDERS.has(model.provider) ? "subscription" : "api";

let openaiPrices: Map<string, Model<Api>> | undefined;

/**
 * The same model with its API prices, for pricing a subscription call: ChatGPT-plan models are
 * registered at zero cost, so look the id up in pi's OpenAI catalog. Others keep their own table.
 */
function apiPriced(model: Model<Api>): Model<Api> {
  if (model.provider !== "chatgpt" && model.provider !== "codex") return model;
  openaiPrices ??= new Map(
    openaiProvider()
      .getModels()
      .map((m) => [m.id, m as Model<Api>]),
  );
  return openaiPrices.get(model.id) ?? model;
}

/**
 * What one call costs, split by billing. API calls cost what pi (or the model's table) says.
 * Subscription calls cost nothing; what they would have cost at API prices is estimated from the
 * provider's own report (the Claude Code CLI's total_cost_usd) or the API price table.
 */
export function callCost(
  model: Model<Api>,
  usage: Usage,
  billing: Billing = defaultBilling(model),
): { billing: Billing; costMicroUsd: number; apiEquivalentMicroUsd: number } {
  if (billing === "api") {
    return { billing, costMicroUsd: costMicroUsd(model, usage), apiEquivalentMicroUsd: 0 };
  }
  return { billing, costMicroUsd: 0, apiEquivalentMicroUsd: costMicroUsd(apiPriced(model), usage) };
}

/** One row per model call so cost is attributable per user, crew and routine (Q3, Q4). */
export class UsageService {
  constructor(private readonly db: Db) {}

  /**
   * Store one model call. `durationMs` is how long the model took to answer (request to last
   * token), so local models, which cost nothing, still show how they perform. `billing` defaults
   * by provider (see defaultBilling); the Claude Code CLI passes "api" when it ran on an API key.
   */
  async record(
    ctx: UsageContext,
    model: Model<Api>,
    usage: Usage,
    durationMs?: number | null,
    billing?: Billing,
  ): Promise<void> {
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
      ...callCost(model, usage, billing),
      durationMs:
        durationMs === undefined || durationMs === null || !Number.isFinite(durationMs)
          ? null
          : Math.max(0, Math.round(durationMs)),
    });
  }

  /** This month's API spend for a user, in micro-USD (for caps; subscription use is not spend). */
  monthSpend(userId: string, now = new Date()): Promise<number> {
    return this.#spend(eq(usageEvents.userId, userId), now);
  }

  /** This month's spend for a crew member (all people together), in micro-USD. */
  monthSpendCrew(crewMemberId: string, now = new Date()): Promise<number> {
    return this.#spend(eq(usageEvents.crewMemberId, crewMemberId), now);
  }

  /** This month's spend for a watch (all its runs), in micro-USD. */
  monthSpendWatch(watchId: string, now = new Date()): Promise<number> {
    return this.#spend(eq(usageEvents.routineId, watchId), now);
  }

  async #spend(filter: SQL, now: Date): Promise<number> {
    const { start, end } = monthRange(currentMonth(now));
    const [row] = await this.db
      .select({ cost: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)` })
      .from(usageEvents)
      .where(and(filter, gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)));
    return Number(row?.cost ?? 0);
  }

  #where(month: string, onlyUserId?: string) {
    const { start, end } = monthRange(month);
    const filters: SQL[] = [gte(usageEvents.createdAt, start), lt(usageEvents.createdAt, end)];
    if (onlyUserId) filters.push(eq(usageEvents.userId, onlyUserId));
    return { start, end, where: and(...filters) };
  }

  async summary(month: string, options: SummaryOptions = {}): Promise<UsageResponse> {
    const { start, end, where } = this.#where(month, options.userId);
    const totals = {
      calls: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      cacheWriteTokens: sql<string>`coalesce(sum(${usageEvents.cacheWriteTokens}), 0)`,
      costMicroUsd: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)`,
      subscriptionCalls: sql<string>`count(*) filter (where ${usageEvents.billing} = 'subscription')`,
      apiEquivalentMicroUsd: sql<string>`coalesce(sum(${usageEvents.apiEquivalentMicroUsd}), 0)`,
      // Calls recorded before response times were kept have no duration and are left out.
      avgResponseMs: sql<string | null>`avg(${usageEvents.durationMs})`,
      p95ResponseMs: sql<
        string | null
      >`percentile_cont(0.95) within group (order by ${usageEvents.durationMs})`,
    };
    const ms = (v: string | number | null | undefined) =>
      v === null || v === undefined ? null : Math.round(Number(v));
    const num = (r: Record<keyof typeof totals, string | number | null>): UsageTotals => ({
      calls: Number(r.calls),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
      cacheReadTokens: Number(r.cacheReadTokens),
      cacheWriteTokens: Number(r.cacheWriteTokens),
      costMicroUsd: Number(r.costMicroUsd),
      subscriptionCalls: Number(r.subscriptionCalls),
      apiEquivalentMicroUsd: Number(r.apiEquivalentMicroUsd),
      avgResponseMs: ms(r.avgResponseMs),
      p95ResponseMs: ms(r.p95ResponseMs),
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
    // Watch runs record the watch as the event's routine.
    const byWatch = await this.db
      .select({
        ...totals,
        watchId: usageEvents.routineId,
        name: watches.name,
        capCents: watches.monthlyCapCents,
      })
      .from(usageEvents)
      .leftJoin(watches, eq(watches.id, usageEvents.routineId))
      .where(and(where, isNotNull(usageEvents.routineId)))
      .groupBy(usageEvents.routineId, watches.name, watches.monthlyCapCents);
    const day = sql<string>`to_char(${usageEvents.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
    const perDay = await this.db
      .select({
        date: day,
        calls: totals.calls,
        costMicroUsd: totals.costMicroUsd,
        apiEquivalentMicroUsd: totals.apiEquivalentMicroUsd,
        tokens: sql<string>`coalesce(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)`,
        avgResponseMs: totals.avgResponseMs,
      })
      .from(usageEvents)
      .where(where)
      .groupBy(day);

    const byDate = new Map(perDay.map((d) => [d.date, d]));
    const now = options.now ?? new Date();
    const last = Math.min(end.getTime(), now.getTime());
    const daily: UsageResponse["daily"] = [];
    for (let t = start.getTime(); t < last; t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      const d = byDate.get(date);
      daily.push({
        date,
        calls: Number(d?.calls ?? 0),
        costMicroUsd: Number(d?.costMicroUsd ?? 0),
        apiEquivalentMicroUsd: Number(d?.apiEquivalentMicroUsd ?? 0),
        tokens: Number(d?.tokens ?? 0),
        avgResponseMs: ms(d?.avgResponseMs),
      });
    }

    // Most spend first, then most subscription value; free (local) usage falls back to tokens.
    const byCost = <T extends UsageTotals>(a: T, b: T) =>
      b.costMicroUsd - a.costMicroUsd ||
      b.apiEquivalentMicroUsd - a.apiEquivalentMicroUsd ||
      b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
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
        .map((r) => ({
          ...num(r),
          slug: r.slug,
          name: r.name ?? "(retired crew)",
          capUsd: r.slug && options.crewCapUsd ? options.crewCapUsd(r.slug) : null,
        }))
        .sort(byCost),
      byModel: byModel.map((r) => ({ ...num(r), model: r.model })).sort(byCost),
      byWatch: byWatch
        .map((r) => ({
          ...num(r),
          watchId: r.watchId ?? "",
          name: r.name ?? "(deleted watch)",
          capCents: r.capCents ?? null,
        }))
        .sort(byCost),
      daily,
    };
  }

  /** One CSV row per model call in the month, oldest first (GET /api/usage/export). */
  async exportCsv(month: string, onlyUserId?: string): Promise<string> {
    const { where } = this.#where(month, onlyUserId);
    const rows = await this.db
      .select({
        e: usageEvents,
        user: users.displayName,
        crew: crewMembers.slug,
        watch: watches.name,
      })
      .from(usageEvents)
      .leftJoin(users, eq(users.id, usageEvents.userId))
      .leftJoin(crewMembers, eq(crewMembers.id, usageEvents.crewMemberId))
      .leftJoin(watches, eq(watches.id, usageEvents.routineId))
      .where(where)
      .orderBy(asc(usageEvents.createdAt));
    const header = [
      "time",
      "person",
      "crew",
      "watch",
      "watch_id",
      "conversation_id",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_usd",
      "response_ms",
      "billing",
      "api_equivalent_usd",
    ];
    const lines = [header.join(",")];
    for (const { e, user, crew, watch } of rows) {
      lines.push(
        [
          e.createdAt.toISOString(),
          csvText(user ?? (e.userId ? "(deleted user)" : "")),
          csvText(crew ?? ""),
          csvText(watch ?? (e.routineId ? "(deleted watch)" : "")),
          e.routineId ?? "",
          e.conversationId ?? "",
          csvText(e.model),
          e.inputTokens,
          e.outputTokens,
          e.cacheReadTokens,
          e.cacheWriteTokens,
          (e.costMicroUsd / 1_000_000).toFixed(6),
          e.durationMs ?? "",
          e.billing,
          e.billing === "subscription" ? (e.apiEquivalentMicroUsd / 1_000_000).toFixed(6) : "",
        ].join(","),
      );
    }
    return `${lines.join("\r\n")}\r\n`;
  }
}

export interface SummaryOptions {
  /** Only this person's usage (scope=me). */
  userId?: string;
  /** The crew member's monthlyCapUsd from its manifest, or null. */
  crewCapUsd?: (slug: string) => number | null;
  now?: Date;
}

/**
 * One CSV field of free text (RFC 4180): quoted when it holds a comma, quote or line break.
 * A leading =, +, - or @ is prefixed with ' so spreadsheets do not run it as a formula.
 */
export function csvText(value: string): string {
  const v = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
