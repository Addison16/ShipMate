import { randomBytes } from "node:crypto";
import type {
  CreateWatchRequest,
  ServerEvent,
  WatchDto,
  WatchRunDto,
  WatchTrigger,
} from "@shipmate/core";
import { conversations, type Db, usageEvents, users, watches, watchRuns } from "@shipmate/db";
import { Cron } from "croner";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type postgres from "postgres";
import { z } from "zod";
import { atLeast, HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import type { AuditService } from "./audit.js";
import type { CrewService } from "./crew.js";

type WatchRow = typeof watches.$inferSelect;
type RunRow = typeof watchRuns.$inferSelect;

export const WatchTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1).max(120),
    timezone: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 31),
  }),
  z.object({ kind: z.literal("webhook") }),
  z.object({ kind: z.literal("after"), routineId: z.string().uuid() }),
]);

/** Arbitrary but fixed key so only one Shipmate process schedules watches (§7). */
const LEADER_LOCK = 0x5348_4950;

/**
 * Watches (routines): a crew member runs a prompt on a schedule, a webhook, or after another
 * watch. Each run is a conversation owned by the watch's owner, so its transcript, tool calls,
 * approvals and cost are attributed and viewable like any other.
 */
export class WatchService {
  #jobs = new Map<string, { stop: () => void; next: () => Date | null }>();
  #leader: postgres.ReservedSql | null = null;
  #leaderTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(
    private readonly db: Db,
    private readonly sql: postgres.Sql,
    private readonly crew: CrewService,
    private readonly bridge: Bridge,
    private readonly audit: AuditService,
    private readonly emit: (userId: string, event: ServerEvent) => void,
    private readonly baseUrl: string,
  ) {}

  // ---------- scheduling ----------

  /** Become the scheduling leader if no other process is, then schedule every enabled watch. */
  async start(): Promise<void> {
    this.#stopped = false;
    // Runs left "running" by a crash will never finish.
    await this.db
      .update(watchRuns)
      .set({
        status: "failed",
        error: "Shipmate restarted during this run",
        finishedAt: new Date(),
      })
      .where(inArray(watchRuns.status, ["running", "waiting_approval"]));
    await this.#tryLead();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#leaderTimer);
    for (const job of this.#jobs.values()) job.stop();
    this.#jobs.clear();
    if (this.#leader) {
      await this.#leader`select pg_advisory_unlock(${LEADER_LOCK})`.catch(() => {});
      this.#leader.release();
      this.#leader = null;
    }
  }

  get isLeader() {
    return this.#leader !== null;
  }

  async #tryLead() {
    if (this.#stopped) return;
    const conn = await this.sql.reserve();
    const [row] = await conn`select pg_try_advisory_lock(${LEADER_LOCK}) as ok`;
    if (row?.ok) {
      this.#leader = conn;
      for (const w of await this.db.select().from(watches)) this.#schedule(w);
      return;
    }
    conn.release();
    this.#leaderTimer = setTimeout(() => void this.#tryLead(), 60_000);
    this.#leaderTimer.unref?.();
  }

  #schedule(w: WatchRow) {
    this.#jobs.get(w.id)?.stop();
    this.#jobs.delete(w.id);
    if (!this.#leader || !w.enabled) return;
    const trigger = w.trigger as WatchTrigger;
    const fire = () => void this.run(w.id, "schedule").catch(() => {});
    if (trigger.kind === "cron") {
      const job = new Cron(
        trigger.expression,
        { ...(trigger.timezone ? { timezone: trigger.timezone } : {}), protect: true },
        fire,
      );
      this.#jobs.set(w.id, { stop: () => job.stop(), next: () => job.nextRun() });
    } else if (trigger.kind === "interval") {
      const ms = trigger.everyMinutes * 60_000;
      let next = new Date(Date.now() + ms);
      const timer = setInterval(() => {
        next = new Date(Date.now() + ms);
        fire();
      }, ms);
      timer.unref?.();
      this.#jobs.set(w.id, { stop: () => clearInterval(timer), next: () => next });
    }
  }

  // ---------- CRUD ----------

  async list(viewer: UserRow): Promise<WatchDto[]> {
    const rows = await this.db
      .select({ w: watches, ownerName: users.displayName })
      .from(watches)
      .innerJoin(users, eq(users.id, watches.ownerId))
      .orderBy(watches.createdAt);
    const out: WatchDto[] = [];
    for (const r of rows) out.push(await this.#dto(r.w, r.ownerName, viewer));
    return out;
  }

  async get(id: string, viewer: UserRow): Promise<WatchDto> {
    const [r] = await this.db
      .select({ w: watches, ownerName: users.displayName })
      .from(watches)
      .innerJoin(users, eq(users.id, watches.ownerId))
      .where(eq(watches.id, id));
    if (!r) throw new HttpError(404, "watch not found");
    return this.#dto(r.w, r.ownerName, viewer);
  }

  async create(user: UserRow, req: CreateWatchRequest): Promise<WatchDto> {
    await this.#validate(user, req.crewSlug, req.trigger);
    const [w] = await this.db
      .insert(watches)
      .values({
        name: req.name,
        crewSlug: req.crewSlug,
        trigger: req.trigger,
        prompt: req.prompt,
        enabled: req.enabled ?? true,
        session: req.session ?? "fresh",
        monthlyCapCents: req.monthlyCapCents ?? null,
        ownerId: user.id,
        webhookToken: randomBytes(24).toString("base64url"),
      })
      .returning();
    if (!w) throw new Error("insert failed");
    this.#schedule(w);
    await this.audit.record({
      userId: user.id,
      crewMemberId: (await this.crew.row(req.crewSlug)).id,
      action: "watch.create",
      summary: `Created watch "${req.name}"`,
      decision: null,
      detail: req,
    });
    return this.get(w.id, user);
  }

  async update(user: UserRow, id: string, patch: Partial<CreateWatchRequest>): Promise<WatchDto> {
    const w = await this.#owned(user, id);
    const next = {
      name: patch.name ?? w.name,
      crewSlug: patch.crewSlug ?? w.crewSlug,
      trigger: patch.trigger ?? (w.trigger as WatchTrigger),
      prompt: patch.prompt ?? w.prompt,
      enabled: patch.enabled ?? w.enabled,
      session: patch.session ?? (w.session as "fresh" | "continue"),
      monthlyCapCents:
        patch.monthlyCapCents !== undefined ? patch.monthlyCapCents : w.monthlyCapCents,
    };
    if (patch.crewSlug || patch.trigger)
      await this.#validate(user, next.crewSlug, next.trigger, id);
    const [row] = await this.db
      .update(watches)
      .set({
        ...next,
        ...(patch.crewSlug && patch.crewSlug !== w.crewSlug ? { sessionFile: null } : {}),
      })
      .where(eq(watches.id, id))
      .returning();
    if (row) this.#schedule(row);
    return this.get(id, user);
  }

  async remove(user: UserRow, id: string): Promise<void> {
    await this.#owned(user, id);
    this.#jobs.get(id)?.stop();
    this.#jobs.delete(id);
    await this.db.delete(watches).where(eq(watches.id, id));
  }

  async runs(id: string, limit: number): Promise<WatchRunDto[]> {
    const rows = await this.db
      .select()
      .from(watchRuns)
      .where(eq(watchRuns.watchId, id))
      .orderBy(desc(watchRuns.startedAt))
      .limit(limit);
    return Promise.all(rows.map((r) => this.#runDto(r)));
  }

  async canEdit(user: UserRow, id: string) {
    await this.#owned(user, id);
  }

  /** Public webhook trigger: the token in the URL is the credential. */
  async runFromWebhook(id: string, token: string, body: string): Promise<WatchRunDto> {
    const [w] = await this.db.select().from(watches).where(eq(watches.id, id));
    const trigger = w?.trigger as WatchTrigger | undefined;
    if (!w || trigger?.kind !== "webhook" || !safeEqual(w.webhookToken, token)) {
      throw new HttpError(404, "not found");
    }
    if (!w.enabled) throw new HttpError(409, "this watch is turned off");
    return this.run(id, "webhook", body);
  }

  // ---------- running ----------

  /** Start a run now. Resolves with the run as soon as it starts; it finishes in the background. */
  async run(id: string, cause: string, extra?: string): Promise<WatchRunDto> {
    const [w] = await this.db.select().from(watches).where(eq(watches.id, id));
    if (!w) throw new HttpError(404, "watch not found");
    const [owner] = await this.db.select().from(users).where(eq(users.id, w.ownerId));
    if (!owner) throw new HttpError(410, "the owner of this watch is gone");
    const crewRow = await this.crew.row(w.crewSlug);

    // Claim the watch first: the partial unique index on active runs lets only one start,
    // across every Shipmate process.
    let run: RunRow | undefined;
    try {
      [run] = await this.db.insert(watchRuns).values({ watchId: id, cause }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, "this watch is already running");
      throw err;
    }
    if (!run) throw new Error("insert failed");
    const runId = run.id;
    let conversationId: string;
    try {
      const [conv] = await this.db
        .insert(conversations)
        .values({
          userId: owner.id,
          kind: "direct",
          surface: "watch",
          crewMemberId: crewRow.id,
          title: `${w.name} (${new Date().toISOString().slice(0, 16).replace("T", " ")})`,
          sessionFiles:
            w.session === "continue" && w.sessionFile ? { [w.crewSlug]: w.sessionFile } : {},
        })
        .returning();
      if (!conv) throw new Error("insert failed");
      conversationId = conv.id;
      [run] = await this.db
        .update(watchRuns)
        .set({ conversationId })
        .where(eq(watchRuns.id, runId))
        .returning();
      if (!run) throw new Error("update failed");
    } catch (err) {
      await this.db
        .update(watchRuns)
        .set({ status: "failed", error: (err as Error).message, finishedAt: new Date() })
        .where(eq(watchRuns.id, runId));
      throw err;
    }
    const started = await this.#runDto(run);
    this.emit(owner.id, { type: "watch_run", watchName: w.name, run: started });

    const prompt = extra?.trim()
      ? `${w.prompt}\n\n---\nWebhook payload:\n${extra.slice(0, 20_000)}`
      : w.prompt;
    void this.#execute(w, owner, conversationId, runId, prompt);
    return started;
  }

  async #execute(
    w: WatchRow,
    owner: UserRow,
    conversationId: string,
    runId: string,
    prompt: string,
  ) {
    let status: "succeeded" | "failed" = "succeeded";
    let output: string | null = null;
    let error: string | null = null;
    try {
      const result = await this.bridge.runTurn(owner, conversationId, w.crewSlug, prompt, {
        watchId: w.id,
        onWaiting: (waiting) =>
          void this.db
            .update(watchRuns)
            .set({ status: waiting ? "waiting_approval" : "running" })
            .where(eq(watchRuns.id, runId)),
      });
      output = result.text || null;
      if (w.session === "continue" && result.sessionFile) {
        await this.db
          .update(watches)
          .set({ sessionFile: result.sessionFile })
          .where(eq(watches.id, w.id));
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }
    const [run] = await this.db
      .update(watchRuns)
      .set({ status, output, error, finishedAt: new Date() })
      .where(eq(watchRuns.id, runId))
      .returning();
    if (run)
      this.emit(owner.id, { type: "watch_run", watchName: w.name, run: await this.#runDto(run) });
    if (status === "succeeded") {
      const followers = (await this.db.select().from(watches)).filter((f) => {
        const t = f.trigger as WatchTrigger;
        return f.enabled && t.kind === "after" && t.routineId === w.id;
      });
      for (const f of followers) void this.run(f.id, "after").catch(() => {});
    }
  }

  // ---------- helpers ----------

  async #validate(user: UserRow, crewSlug: string, trigger: WatchTrigger, selfId?: string) {
    const crew = (await this.crew.list(false, user)).find((c) => c.slug === crewSlug);
    if (!crew) throw new HttpError(400, `no crew member "${crewSlug}"`);
    if (crew.status !== "active") throw new HttpError(400, `${crew.name} is not active`);
    if (trigger.kind === "cron") {
      try {
        new Cron(trigger.expression, {
          paused: true,
          ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
        }).stop();
      } catch (err) {
        throw new HttpError(400, `cron: ${(err as Error).message}`);
      }
    }
    if (trigger.kind === "after") {
      if (trigger.routineId === selfId) throw new HttpError(400, "a watch cannot follow itself");
      const all = new Map((await this.db.select().from(watches)).map((x) => [x.id, x]));
      if (!all.has(trigger.routineId)) {
        throw new HttpError(400, "the watch to follow does not exist");
      }
      // Each watch follows at most one other, so walking the chain finds any loop.
      if (selfId) {
        let cursor: string | undefined = trigger.routineId;
        for (let i = 0; cursor && i <= all.size; i++) {
          if (cursor === selfId)
            throw new HttpError(400, "these watches would follow each other in a loop");
          const t = all.get(cursor)?.trigger as WatchTrigger | undefined;
          cursor = t?.kind === "after" ? t.routineId : undefined;
        }
      }
    }
  }

  async #owned(user: UserRow, id: string): Promise<WatchRow> {
    const [w] = await this.db.select().from(watches).where(eq(watches.id, id));
    if (!w) throw new HttpError(404, "watch not found");
    if (w.ownerId !== user.id && !atLeast(user.role, "admin")) {
      throw new HttpError(403, "only the watch's owner or an admin can change it");
    }
    return w;
  }

  async #dto(w: WatchRow, ownerName: string, viewer: UserRow): Promise<WatchDto> {
    const [last] = await this.db
      .select()
      .from(watchRuns)
      .where(eq(watchRuns.watchId, w.id))
      .orderBy(desc(watchRuns.startedAt))
      .limit(1);
    const trigger = w.trigger as WatchTrigger;
    const next = this.#jobs.get(w.id)?.next() ?? null;
    return {
      id: w.id,
      name: w.name,
      crewSlug: w.crewSlug,
      trigger,
      prompt: w.prompt,
      enabled: w.enabled,
      session: w.session === "continue" ? "continue" : "fresh",
      owner: { id: w.ownerId, name: ownerName },
      // The URL is the webhook's credential, so only the owner sees it.
      monthlyCapCents: w.monthlyCapCents ?? null,
      webhookUrl:
        trigger.kind === "webhook" && viewer.id === w.ownerId
          ? `${this.baseUrl.replace(/\/+$/, "")}/api/hooks/watches/${w.id}/${w.webhookToken}`
          : null,
      lastRun: last ? await this.#runDto(last) : null,
      nextRunAt: next ? next.toISOString() : null,
      createdAt: w.createdAt.toISOString(),
    };
  }

  async #runDto(r: RunRow): Promise<WatchRunDto> {
    let cost = 0;
    if (r.conversationId) {
      const [row] = await this.db
        .select({ cost: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)` })
        .from(usageEvents)
        .where(eq(usageEvents.conversationId, r.conversationId));
      cost = Number(row?.cost ?? 0);
    }
    return {
      id: r.id,
      watchId: r.watchId,
      status: r.status as WatchRunDto["status"],
      cause: r.cause,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      output: r.output,
      error: r.error,
      costMicroUsd: cost,
      conversationId: r.conversationId,
    };
  }
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Postgres unique_violation, possibly wrapped by drizzle. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
