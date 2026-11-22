import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  ChatContextDto,
  LimitsResponse,
  LimitWindowDto,
  ProviderLimitDto,
} from "@shipmate/core";
import { CODEX_PROVIDER, CURSOR_PROVIDER, GEMINI_PROVIDER } from "@shipmate/core";
import {
  type ClaudeRateLimit,
  type CodexLimitWindow,
  type CodexRateLimits,
  codexRateLimits,
} from "@shipmate/crew";
import { crewMembers, type Db, messages, usageEvents } from "@shipmate/db";
import { piProviderId, SELF_HOSTED_KINDS } from "@shipmate/providers";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { CHATGPT_PROVIDER_ID } from "./chatgpt.js";
import type { ProviderService } from "./providers.js";
import { currentMonth, monthRange } from "./usage.js";

/** What is kept between restarts: the plan figures last read from the official CLIs. */
interface Saved {
  claude?: { limit: ClaudeRateLimit; at: string };
  chatgpt?: { limits: CodexRateLimits; at: string };
}

/** Close enough to a limit to warn about it. */
const WARN_AT = 0.8;
/** A Check is not repeated within this time; the figures it read are shown instead. */
const CHECK_REUSE_MS = 60_000;

export interface MeterDeps {
  db: Db;
  providers: Pick<ProviderService, "records" | "available" | "chatgpt">;
  /** Where plan figures are kept (in a private folder). */
  file: string;
  readCodex?: () => Promise<CodexRateLimits>;
  now?: () => Date;
}

/**
 * Glanceable meters: how full a chat's context is, and how much of each provider's limit is used.
 *
 * Plan limits come only from what the official CLIs report: Claude Code sends a
 * `rate_limit_event` while it replies, and Codex answers `account/rateLimits/read` when someone
 * taps Check. Nothing here sends prompts or calls a provider on a timer.
 */
export class MeterService {
  /** null: started fresh, so nothing to show until the next reply. */
  #context = new Map<string, ChatContextDto | null>();
  #saved: Saved;
  #checking: Promise<ProviderLimitDto> | undefined;

  constructor(private readonly deps: MeterDeps) {
    this.#saved = load(deps.file);
  }

  #now() {
    return this.deps.now?.() ?? new Date();
  }

  // ---------- context ----------

  setContext(conversationId: string, context: ChatContextDto) {
    this.#context.set(conversationId, context);
  }

  /** The chat started fresh: its context is empty until the next reply. */
  reset(conversationId: string) {
    this.#context.set(conversationId, null);
  }

  /**
   * The chat's context after its last reply. Kept in memory; after a restart, a chat on pi is
   * worked out from its last recorded model call (its prompt plus reply is the context size).
   */
  async context(conversationId: string): Promise<ChatContextDto | null> {
    const known = this.#context.get(conversationId);
    if (known !== undefined) return known;
    const [row] = await this.deps.db
      .select({
        model: usageEvents.model,
        input: usageEvents.inputTokens,
        output: usageEvents.outputTokens,
        cacheRead: usageEvents.cacheReadTokens,
        cacheWrite: usageEvents.cacheWriteTokens,
        at: usageEvents.createdAt,
        slug: crewMembers.slug,
        name: crewMembers.name,
      })
      .from(usageEvents)
      .leftJoin(crewMembers, eq(crewMembers.id, usageEvents.crewMemberId))
      .where(eq(usageEvents.conversationId, conversationId))
      .orderBy(desc(usageEvents.createdAt))
      .limit(1);
    if (!row?.slug || !row.name) return null;
    // Started fresh since that call: the context it measured is gone.
    const [reset] = await this.deps.db
      .select({ at: messages.createdAt })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          sql`${messages.meta} ->> 'sessionReset' = 'true'`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    if (reset && reset.at >= row.at) {
      this.#context.set(conversationId, null);
      return null;
    }
    const engine = engineOf(row.model);
    // CLI rows add up a whole run, which is not the context size; wait for the next reply.
    if (engine !== "pi") return null;
    const model = (await this.deps.providers.available()).find(
      (m) => `${m.provider}/${m.id}` === row.model,
    );
    if (!model?.contextWindow) return null;
    const context: ChatContextDto = {
      crew: { slug: row.slug, name: row.name },
      engine,
      model: row.model,
      tokens: row.input + row.output + row.cacheRead + row.cacheWrite,
      window: model.contextWindow,
      at: row.at.toISOString(),
    };
    this.#context.set(conversationId, context);
    return context;
  }

  // ---------- plan limits ----------

  /** A `rate_limit_event` from Claude Code (the install's one Claude sign-in). */
  noteClaude(limit: ClaudeRateLimit) {
    this.#saved.claude = { limit, at: this.#now().toISOString() };
    this.#save();
  }

  /** Read the ChatGPT plan's figures from Codex now (reused for a minute). */
  checkChatgpt(): Promise<ProviderLimitDto> {
    const last = this.#saved.chatgpt;
    if (last && this.#now().getTime() - Date.parse(last.at) < CHECK_REUSE_MS) {
      return Promise.resolve(chatgptLimit(last));
    }
    this.#checking ??= (this.deps.readCodex ?? (() => codexRateLimits()))()
      .then((limits) => {
        this.#saved.chatgpt = { limits, at: this.#now().toISOString() };
        this.#save();
        return chatgptLimit(this.#saved.chatgpt);
      })
      .finally(() => {
        this.#checking = undefined;
      });
    return this.#checking;
  }

  /**
   * `everyone`: show API spend for all people together (admins and owners); otherwise each
   * provider's spend is only this person's, as on the Usage page.
   */
  async limits(
    me: { id: string; monthlyCapCents: number | null },
    everyone = false,
  ): Promise<LimitsResponse> {
    const now = this.#now();
    const { start, end } = monthRange(currentMonth(now));
    const [records, rows, mine] = await Promise.all([
      this.deps.providers.records(),
      this.deps.db
        .select({
          provider: sql<string>`split_part(${usageEvents.model}, '/', 1)`,
          cost: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)`,
          billing: usageEvents.billing,
        })
        .from(usageEvents)
        .where(
          and(
            gte(usageEvents.createdAt, start),
            lt(usageEvents.createdAt, end),
            everyone ? undefined : eq(usageEvents.userId, me.id),
          ),
        )
        .groupBy(sql`split_part(${usageEvents.model}, '/', 1)`, usageEvents.billing),
      this.deps.db
        .select({ cost: sql<string>`coalesce(sum(${usageEvents.costMicroUsd}), 0)` })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.userId, me.id),
            gte(usageEvents.createdAt, start),
            lt(usageEvents.createdAt, end),
          ),
        ),
    ]);
    const used = new Set(rows.map((r) => r.provider));
    const spend = new Map<string, number>();
    for (const r of rows) {
      if (r.billing === "api") spend.set(r.provider, (spend.get(r.provider) ?? 0) + Number(r.cost));
    }
    const kinds = new Set(records.filter((r) => r.enabled).map((r) => r.kind));
    const limits: ProviderLimitDto[] = [];

    if (this.#saved.claude || kinds.has("claude-code-cli") || used.has("claude-code")) {
      limits.push(claudeLimit(this.#saved.claude));
    }
    if (
      this.#saved.chatgpt ||
      this.deps.providers.chatgpt.configures(CHATGPT_PROVIDER_ID) ||
      used.has(CHATGPT_PROVIDER_ID) ||
      used.has(CODEX_PROVIDER)
    ) {
      limits.push(chatgptLimit(this.#saved.chatgpt));
    }
    if (used.has(CURSOR_PROVIDER)) {
      limits.push(
        silentPlan(
          "cursor-plan",
          "Cursor plan",
          "Cursor doesn't share its limits with other apps.",
        ),
      );
    }
    if (used.has(GEMINI_PROVIDER)) {
      limits.push(
        silentPlan(
          "gemini-plan",
          "Gemini CLI",
          "Gemini CLI doesn't share its limits with other apps.",
        ),
      );
    }
    for (const r of records) {
      if (!r.enabled || r.kind === "claude-code-cli" || r.kind === "openai-chatgpt") continue;
      const pid = piProviderId(r);
      if (!pid) continue;
      if (SELF_HOSTED_KINDS.includes(r.kind)) {
        limits.push({
          id: r.id,
          name: r.label,
          kind: "local",
          status: "ok",
          windows: [],
          spentMicroUsd: null,
          checkedAt: null,
          canCheck: false,
          note: "Your own server, so no limits.",
        });
        continue;
      }
      if (!r.apiKey) continue;
      limits.push({
        id: r.id,
        name: r.label,
        kind: "api",
        status: "ok",
        windows: [],
        spentMicroUsd: spend.get(pid) ?? 0,
        checkedAt: now.toISOString(),
        canCheck: false,
        note: null,
      });
    }
    return {
      limits,
      me: { capCents: me.monthlyCapCents, spentMicroUsd: Number(mine[0]?.cost ?? 0) },
    };
  }

  #save() {
    try {
      const tmp = `${this.deps.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#saved), { mode: 0o600 });
      renameSync(tmp, this.deps.file);
    } catch (err) {
      console.error("shipmate: could not save plan limits", err);
    }
  }
}

function load(file: string): Saved {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Saved;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/** Which engine a usage row's model belongs to. */
export function engineOf(model: string): ChatContextDto["engine"] {
  const provider = model.split("/")[0];
  if (provider === "claude-code") return "claude-code";
  if (provider === CODEX_PROVIDER) return "codex";
  if (provider === CURSOR_PROVIDER) return "cursor";
  if (provider === GEMINI_PROVIDER) return "gemini";
  return "pi";
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function statusOf(windows: LimitWindowDto[]): ProviderLimitDto["status"] {
  const most = Math.max(-1, ...windows.map((w) => w.used ?? -1));
  if (most < 0) return "unknown";
  return most >= 1 ? "limited" : most >= WARN_AT ? "warning" : "ok";
}

export function claudeLimit(saved: Saved["claude"]): ProviderLimitDto {
  const base = {
    id: "claude-plan",
    name: "Claude plan",
    kind: "plan" as const,
    spentMicroUsd: null,
    canCheck: false,
  };
  if (!saved) {
    return {
      ...base,
      status: "unknown",
      windows: [],
      checkedAt: null,
      note: "Shows after Claude's next reply.",
    };
  }
  const { limit } = saved;
  // A reset time in the past means the figures are from an earlier window.
  const stale = limit.resetsAt !== null && limit.resetsAt < Date.now();
  const windows: LimitWindowDto[] = stale
    ? []
    : [{ label: "Current", used: limit.utilization, resetsAt: iso(limit.resetsAt) }];
  const status: ProviderLimitDto["status"] = stale
    ? "ok"
    : limit.status === "rejected"
      ? "limited"
      : limit.status === "allowed_warning"
        ? "warning"
        : windows[0]?.used === null
          ? "ok"
          : statusOf(windows);
  return {
    ...base,
    status,
    windows,
    checkedAt: saved.at,
    note: stale
      ? "The limit has reset since the last reply."
      : limit.utilization === null
        ? status === "ok"
          ? "Within the limit."
          : null
        : null,
  };
}

function windowLabel(w: CodexLimitWindow, fallback: string): string {
  const m = w.windowMinutes;
  if (!m) return fallback;
  if (m === 10_080) return "Weekly";
  if (m % 1440 === 0) return `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-minute`;
}

export function chatgptLimit(saved: Saved["chatgpt"]): ProviderLimitDto {
  const base = {
    id: "chatgpt-plan",
    name: "ChatGPT plan",
    kind: "plan" as const,
    spentMicroUsd: null,
    canCheck: true,
  };
  if (!saved) {
    return {
      ...base,
      status: "unknown",
      windows: [],
      checkedAt: null,
      note: "Tap Check to read it from Codex.",
    };
  }
  const windows: LimitWindowDto[] = [];
  const { primary, secondary } = saved.limits;
  if (primary) {
    windows.push({
      label: windowLabel(primary, "Short"),
      used: primary.usedPercent / 100,
      resetsAt: iso(primary.resetsAt),
    });
  }
  if (secondary) {
    windows.push({
      label: windowLabel(secondary, "Long"),
      used: secondary.usedPercent / 100,
      resetsAt: iso(secondary.resetsAt),
    });
  }
  return {
    ...base,
    status: statusOf(windows),
    windows,
    checkedAt: saved.at,
    note: windows.length ? null : "Codex gave no figures for this plan.",
  };
}

function silentPlan(id: string, name: string, note: string): ProviderLimitDto {
  return {
    id,
    name,
    kind: "plan",
    status: "unknown",
    windows: [],
    spentMicroUsd: null,
    checkedAt: null,
    canCheck: false,
    note,
  };
}
