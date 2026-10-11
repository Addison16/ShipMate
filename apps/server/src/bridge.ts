import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  BashOperations,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type ConversationDto,
  type ConversationSearchResultDto,
  type MessageDto,
  SEARCH_MARK,
  type ServerEvent,
} from "@shipmate/core";
import {
  type ActingUser,
  type ApprovalHost,
  CAPTAIN_SLUG,
  type CaptainHost,
  type CrewFolder,
  type CrewHost,
  type CrewSession,
  type CrewSummary,
  captainTools,
  createCrewSession,
  crewTools,
  MemoryStore,
  memoryTools,
  skillTools,
  splitModelRef,
} from "@shipmate/crew";
import { conversations, crewMembers, type Db, messages, users, watches } from "@shipmate/db";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { HttpError, type UserRow } from "./auth.js";
import { ClaudeCliTurns } from "./claude-cli-turn.js";
import type { EverydayTools } from "./everyday.js";
import type { AttachmentService } from "./files/service.js";
import { toDto as toAttachmentDto } from "./files/service.js";
import type { ApprovalService } from "./services/approvals.js";
import type { AuditService } from "./services/audit.js";
import type { CrewService } from "./services/crew.js";
import type { McpService } from "./services/mcp.js";
import type { ProviderService } from "./services/providers.js";
import type { SettingsService } from "./services/settings.js";
import type { SkillService } from "./services/skills.js";
import type { UsageService } from "./services/usage.js";
import type { WatchService } from "./services/watches.js";
import { summarize } from "./summarize.js";

type ConversationRow = typeof conversations.$inferSelect;
type Send = (event: ServerEvent) => void;

const IDLE_MS = 30 * 60_000;

export interface BridgeDeps {
  db: Db;
  crew: CrewService;
  providers: ProviderService;
  mcp: McpService;
  settings: SettingsService;
  usage: UsageService;
  approvals: ApprovalService;
  audit: AuditService;
  skills: SkillService;
  /** Files attached in chat. */
  files: AttachmentService;
  agentDir: string;
}

/**
 * Supplies a project's workspace to conversations that work in it (the Shipyard): the folder,
 * the sandboxed shell, project tools (push, pull requests) and a prompt section.
 */
export interface WorkspaceProvider {
  forConversation(
    projectId: string,
    user: UserRow,
    crew: CrewFolder,
    /** The conversation the session belongs to (e.g. to follow the PRs it opens). */
    conversationId: string,
  ): Promise<{
    dir: string;
    bash: BashOperations;
    tools: ToolDefinition[];
    prompt: string;
  }>;
}

/** Everything a cached session's tools need from the turn in progress. */
interface TurnContext {
  captain: CaptainHost;
  crew: CrewHost;
  approvals: ApprovalHost;
}

export interface RunTurnOptions {
  /** Set for watch runs: usage is attributed to the watch and approvals mention it. */
  watchId?: string;
  /** Called when the run starts or stops waiting for a person's approval. */
  onWaiting?: (waiting: boolean) => void;
}

/** Options of a single turn inside a run. */
interface TurnOptions extends RunTurnOptions {
  /**
   * Set when a crew member asks the Captain with `ask_captain`: the Captain answers in a
   * separate session (its main one may be busy delegating), without crew-management tools.
   */
  consultFor?: { slug: string; name: string };
  /** Photos the person sent with this message; only the crew member they wrote to sees them. */
  images?: ImageContent[];
  imageNames?: string[];
}

/** Live state of one conversation: a pi session per crew member taking part. */
interface Run {
  sessions: Map<string, CrewSession>;
  /** Per crew slug, the context of the turn in progress. */
  hosts: Map<string, TurnContext>;
  busy: boolean;
  aborted: boolean;
  /** Usage rows being written; a turn is not over until they are stored. */
  writes: Set<Promise<void>>;
  idleTimer?: NodeJS.Timeout;
}

/**
 * The Bridge: conversations between people and the crew. Each message from a person runs the
 * Captain (or, in a direct chat, one crew member) as a pi session; the Captain's `delegate`
 * tool runs other crew members in the same conversation. Every event streams to the person's
 * open sockets, every reply is stored, and every model call is metered to that person.
 */
export class Bridge {
  #sockets = new Map<string, Set<Send>>();
  #taps = new Set<(userId: string, event: ServerEvent) => void>();
  #runs = new Map<string, Run>();
  #watches: WatchService | undefined;
  #workspaces: WorkspaceProvider | undefined;
  #everyday: EverydayTools | undefined;
  /** Turns of `backend: claude-code-cli` crew members (the official `claude` binary). */
  #cli: ClaudeCliTurns;

  constructor(private readonly deps: BridgeDeps) {
    this.#cli = new ClaudeCliTurns(deps.db);
    deps.crew.onChange(() => this.broadcast({ type: "crew_changed" }));
    deps.skills.onChange(() => this.broadcast({ type: "skills_changed" }));
  }

  /** Watches depend on the Bridge to run, so they are attached after both exist. */
  attachWorkspaces(provider: WorkspaceProvider) {
    this.#workspaces = provider;
  }

  attachWatches(watches: WatchService) {
    this.#watches = watches;
  }

  /** Lists and other everyday-life tools every crew member gets. */
  attachEveryday(everyday: EverydayTools) {
    this.#everyday = everyday;
  }

  // ---------- sockets ----------

  connect(userId: string, send: Send): () => void {
    const set = this.#sockets.get(userId) ?? new Set<Send>();
    this.#sockets.set(userId, set);
    set.add(send);
    return () => {
      set.delete(send);
      if (!set.size) this.#sockets.delete(userId);
    };
  }

  emit(userId: string, event: ServerEvent) {
    for (const send of this.#sockets.get(userId) ?? []) send(event);
    for (const tap of this.#taps) tap(userId, event);
  }

  /** See every event sent to anyone, connected or not (push notifications). */
  tap(listener: (userId: string, event: ServerEvent) => void): () => void {
    this.#taps.add(listener);
    return () => this.#taps.delete(listener);
  }

  broadcast(event: ServerEvent) {
    for (const set of this.#sockets.values()) for (const send of set) send(event);
  }

  // ---------- conversations ----------

  async listConversations(userId: string): Promise<ConversationDto[]> {
    const rows = await this.deps.db
      .select({ c: conversations, slug: crewMembers.slug })
      .from(conversations)
      .leftJoin(crewMembers, eq(crewMembers.id, conversations.crewMemberId))
      .where(and(eq(conversations.userId, userId), eq(conversations.surface, "web")))
      .orderBy(sql`${conversations.pinnedAt} desc nulls last`, desc(conversations.updatedAt));
    return rows.map((r) => toConversationDto(r.c, r.slug));
  }

  /**
   * Full-text search over one person's own conversations (every surface): message content via
   * the messages_content_search_idx index, plus titles. Best match first.
   */
  async searchConversations(
    user: UserRow,
    query: string,
    limit = 20,
  ): Promise<ConversationSearchResultDto[]> {
    const q = query.trim().slice(0, 200);
    if (!q) return [];
    const tsquery = sql`websearch_to_tsquery('english', ${q})`;
    const vector = sql`to_tsvector('english', ${messages.content})`;
    const rank = sql<number>`ts_rank(${vector}, ${tsquery})`;
    const options = `StartSel=${SEARCH_MARK.start}, StopSel=${SEARCH_MARK.end}, MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "`;
    const hits = await this.deps.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        createdAt: messages.createdAt,
        userName: users.displayName,
        crewName: crewMembers.name,
        snippet: sql<string>`ts_headline('english', ${messages.content}, ${tsquery}, ${options})`,
        rank,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(users, eq(users.id, messages.userId))
      .leftJoin(crewMembers, eq(crewMembers.id, messages.crewMemberId))
      .where(and(eq(conversations.userId, user.id), sql`${vector} @@ ${tsquery}`))
      .orderBy(desc(rank), desc(messages.createdAt))
      .limit(300);
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const titled = await this.deps.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.userId, user.id), ilike(conversations.title, pattern)))
      .orderBy(desc(conversations.updatedAt))
      .limit(limit);

    // Conversations in order of their best message (titles count as a strong match).
    const byConv = new Map<string, { score: number; title: boolean; hits: typeof hits }>();
    for (const t of titled) byConv.set(t.id, { score: 1, title: true, hits: [] });
    for (const h of hits) {
      const entry = byConv.get(h.conversationId) ?? { score: 0, title: false, hits: [] };
      entry.score = Math.max(entry.score, Number(h.rank));
      if (entry.hits.length < 3) entry.hits.push(h);
      byConv.set(h.conversationId, entry);
    }
    const ids = [...byConv.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([id]) => id);
    if (!ids.length) return [];
    const convRows = await this.deps.db
      .select({ c: conversations, slug: crewMembers.slug })
      .from(conversations)
      .leftJoin(crewMembers, eq(crewMembers.id, conversations.crewMemberId))
      .where(inArray(conversations.id, ids));
    const convs = new Map(convRows.map((r) => [r.c.id, toConversationDto(r.c, r.slug)]));
    return ids.flatMap((id) => {
      const conversation = convs.get(id);
      const entry = byConv.get(id);
      if (!conversation || !entry) return [];
      return [
        {
          conversation,
          titleMatch: entry.title,
          matches: entry.hits.map((h) => ({
            messageId: h.id,
            snippet: h.snippet,
            author: h.userName ?? h.crewName ?? "Shipmate",
            createdAt: h.createdAt.toISOString(),
          })),
        },
      ];
    });
  }

  async pinConversation(user: UserRow, id: string, pinned: boolean): Promise<ConversationDto> {
    await this.conversation(user, id);
    const [c] = await this.deps.db
      .update(conversations)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(eq(conversations.id, id))
      .returning();
    if (!c) throw new HttpError(404, "conversation not found");
    return toConversationDto(c, await this.#slugOf(c.crewMemberId));
  }

  async createConversation(
    user: UserRow,
    input: {
      kind?: "bridge" | "direct" | undefined;
      crewSlug?: string | undefined;
      /** web (default), discord, watch. */
      surface?: string | undefined;
      /** An id on that surface, e.g. a Discord channel and user. */
      externalId?: string | undefined;
      /** Work in this Shipyard project's workspace. */
      projectId?: string | undefined;
      title?: string | undefined;
    },
  ): Promise<ConversationDto> {
    const kind = input.kind ?? "bridge";
    let crewMemberId: string | null = null;
    let slug: string | null = null;
    if (kind === "direct") {
      if (!input.crewSlug) throw new HttpError(400, "a direct conversation needs crewSlug");
      const row = await this.deps.crew.assertVisible(input.crewSlug, user);
      crewMemberId = row.id;
      slug = row.slug;
    }
    const [c] = await this.deps.db
      .insert(conversations)
      .values({
        userId: user.id,
        kind,
        crewMemberId,
        surface: input.surface ?? "web",
        externalId: input.externalId ?? null,
        projectId: input.projectId ?? null,
        title: input.title ?? null,
      })
      .returning();
    if (!c) throw new Error("insert failed");
    return toConversationDto(c, slug);
  }

  async conversation(user: UserRow, id: string): Promise<ConversationRow> {
    const [c] = await this.deps.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, user.id)))
      .limit(1);
    if (!c) throw new HttpError(404, "conversation not found");
    return c;
  }

  async renameConversation(user: UserRow, id: string, title: string): Promise<ConversationDto> {
    await this.conversation(user, id);
    const [c] = await this.deps.db
      .update(conversations)
      .set({ title: title.slice(0, 120) })
      .where(eq(conversations.id, id))
      .returning();
    if (!c) throw new HttpError(404, "conversation not found");
    return toConversationDto(c, await this.#slugOf(c.crewMemberId));
  }

  async deleteConversation(user: UserRow, id: string): Promise<void> {
    await this.conversation(user, id);
    this.#dispose(id);
    const files = await this.deps.files.idsIn(id);
    await this.deps.db.delete(conversations).where(eq(conversations.id, id));
    await this.deps.files.removeFiles(files);
  }

  async messages(user: UserRow, id: string): Promise<MessageDto[]> {
    await this.conversation(user, id);
    const rows = await this.deps.db
      .select({
        m: messages,
        userName: users.displayName,
        crewSlug: crewMembers.slug,
        crewName: crewMembers.name,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.userId))
      .leftJoin(crewMembers, eq(crewMembers.id, messages.crewMemberId))
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt));
    return rows.map((r) =>
      toMessageDto(r.m, {
        userName: r.userName,
        crewSlug: r.crewSlug,
        crewName: r.crewName,
      }),
    );
  }

  // ---------- running turns ----------

  /**
   * Handle a message from a person, with any files they uploaded for it. Resolves when the crew
   * has finished replying.
   */
  async send(
    user: UserRow,
    conversationId: string,
    text: string,
    attachmentIds: string[] = [],
  ): Promise<void> {
    const content = text.trim();
    if (!content && !attachmentIds.length) return;
    const conv = await this.conversation(user, conversationId);
    // Checked before the turn is claimed, so a stale file id is a plain error, not a stuck run.
    const files = await this.deps.files.claim(user.id, conversationId, attachmentIds);
    const run = this.#run(conversationId);
    if (run.busy) throw new HttpError(409, "the crew is still answering the last message");
    // Claim the run before any await, so two quick sends cannot both start a turn.
    run.busy = true;

    let slug: string | null;
    try {
      slug = conv.kind === "direct" ? await this.#slugOf(conv.crewMemberId) : CAPTAIN_SLUG;
      await this.#checkCap(user, slug);
    } catch (err) {
      run.busy = false;
      throw err;
    }

    run.aborted = false;
    clearTimeout(run.idleTimer);
    this.emit(user.id, { type: "status", conversationId, busy: true });
    try {
      const userMessage = await this.#store(conv, {
        role: "user",
        content,
        userId: user.id,
        authorName: user.displayName,
        meta: files.length ? { attachments: files.map(toAttachmentDto) } : null,
      });
      await this.deps.files.attach(
        files.map((f) => f.id),
        userMessage.id,
      );
      this.emit(user.id, { type: "message", conversationId, message: userMessage });
      if (!conv.title) {
        const title = content || files.map((f) => f.name).join(", ");
        await this.deps.db
          .update(conversations)
          .set({ title: title.replace(/\s+/g, " ").slice(0, 60) })
          .where(eq(conversations.id, conv.id));
      }

      if (!slug) throw new HttpError(410, "this crew member is no longer aboard");
      await this.#assertActive(slug, user);
      const prepared = await this.deps.files.prepare(files);
      const prompt =
        [content, prepared.text].filter(Boolean).join("\n\n") ||
        `(${user.displayName} sent ${prepared.imageNames.length === 1 ? "a photo" : "photos"} without a message.)`;
      await this.#turn(user, conv, run, slug, prompt, {
        ...(prepared.images.length
          ? { images: prepared.images, imageNames: prepared.imageNames }
          : {}),
      });
    } catch (err) {
      if (!run.aborted) {
        this.emit(user.id, {
          type: "error",
          conversationId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      run.busy = false;
      this.emit(user.id, { type: "status", conversationId, busy: false });
      run.idleTimer = setTimeout(() => this.#dispose(conversationId), IDLE_MS);
      run.idleTimer.unref?.();
    }
  }

  async abort(user: UserRow, conversationId: string): Promise<void> {
    await this.conversation(user, conversationId);
    const run = this.#runs.get(conversationId);
    if (!run?.busy) return;
    run.aborted = true;
    this.deps.approvals.cancelConversation(conversationId);
    this.#cli.abort(conversationId);
    await Promise.all([...run.sessions.values()].map((s) => s.abort()));
  }

  /**
   * Run one prompt with a crew member in an existing conversation, without a person's message
   * (watch runs). Returns the final reply and the pi session file.
   */
  async runTurn(
    user: UserRow,
    conversationId: string,
    slug: string,
    prompt: string,
    options: RunTurnOptions,
  ): Promise<{ text: string; sessionFile: string | undefined }> {
    const conv = await this.conversation(user, conversationId);
    const run = this.#run(conversationId);
    run.busy = true;
    try {
      await this.#checkCap(user, slug, options.watchId);
      await this.#assertActive(slug, user);
      const text = await this.#turn(user, conv, run, slug, prompt, options);
      return { text, sessionFile: run.sessions.get(slug)?.sessionFile };
    } finally {
      run.busy = false;
      this.#dispose(conversationId);
    }
  }

  /** Whether a turn is running in this conversation. */
  isBusy(conversationId: string): boolean {
    return this.#runs.get(conversationId)?.busy ?? false;
  }

  async close(): Promise<void> {
    for (const id of [...this.#runs.keys()]) this.#dispose(id);
  }

  /**
   * One crew member answers `prompt` in this conversation. Text streams into a bubble; when
   * the Captain hands off, its bubble closes, the crew member answers in its own, and the
   * Captain continues in a fresh one, so the stored transcript reads in order.
   */
  async #turn(
    user: UserRow,
    conv: ConversationRow,
    run: Run,
    slug: string,
    prompt: string,
    options: TurnOptions,
  ): Promise<string> {
    const folder = this.deps.crew.folder(slug);
    const crewRow = await this.deps.crew.row(slug);
    const crew = { slug, name: folder.manifest.name };
    let stream = this.#openStream(user.id, conv.id, crew);
    let final = "";

    if (folder.manifest.backend === "claude-code-cli" && options.consultFor) {
      await this.#closeStream(conv, crewRow.id, stream);
      return `${folder.manifest.name} runs on the Claude Code CLI and cannot answer crew questions mid-task. Use your best judgment, say what you assumed, and check with the person if it matters.`;
    }
    if (folder.manifest.backend === "claude-code-cli") {
      if (options.images?.length) {
        await this.#note(
          conv,
          `${crew.name} runs on the Claude Code CLI, which Shipmate cannot pass photos to, so ${crew.name} only gets their names. Ask the ${this.deps.crew.captain().manifest.name} on the Bridge to look at them instead.`,
        );
        prompt = `${prompt}\n\n(${user.displayName} attached photos you cannot see: ${(options.imageNames ?? []).join(", ")}.)`;
      }
      try {
        return await this.#cli.turn({
          user,
          conv,
          folder,
          prompt,
          stream,
          usage: {
            userId: user.id,
            crewMemberId: crewRow.id,
            conversationId: conv.id,
            routineId: options.watchId ?? null,
          },
          emit: (event) => this.emit(user.id, event),
          record: (...args) => this.#recordUsage(run, ...args),
        });
      } finally {
        await this.#closeStream(conv, crewRow.id, stream);
        await Promise.all(run.writes);
      }
    }

    const host: CaptainHost = {
      listCrew: () => this.#roster(user),
      recruit: (spec) => this.#recruit(user, spec),
      edit: async (target, spec) => {
        const { persona, ...changes } = spec;
        const clean = Object.fromEntries(
          Object.entries(changes).filter(([, v]) => v !== undefined),
        );
        const d = await this.deps.crew.patch(target, clean, persona);
        return { ...d, status: d.status };
      },
      retire: async (target) => {
        await this.deps.crew.setStatus(target, "retired");
      },
      createWatch: async (spec) => {
        if (!this.#watches) throw new Error("watches are not available");
        const trigger = spec.cron
          ? {
              kind: "cron" as const,
              expression: spec.cron,
              ...(spec.timezone ? { timezone: spec.timezone } : {}),
            }
          : {
              kind: "interval" as const,
              everyMinutes: Math.max(1, Math.round(spec.everyMinutes ?? 60)),
            };
        const w = await this.#watches.create(user, {
          name: spec.name,
          crewSlug: spec.crew,
          prompt: spec.prompt,
          trigger,
        });
        return { id: w.id, name: w.name };
      },
      installMcp: async (id, crews) => {
        const server = await this.deps.mcp.install(id);
        if (crews.length) await this.deps.mcp.assign(id, [...new Set([...server.crews, ...crews])]);
        const missing = server.secrets.filter((x) => x.required && !x.set).map((x) => x.label);
        return missing.length
          ? `Installed ${server.name}. It needs ${missing.join(", ")} entered by an owner on the MCP servers page before it starts.`
          : `Installed ${server.name} for ${crews.join(", ") || "nobody yet"}. It starts in new conversations.`;
      },
      delegate: async (target, task) => {
        if (target === slug) throw new Error("you cannot delegate to yourself");
        const to = this.deps.crew.folder(target);
        await this.#assertActive(target, user);
        await this.#checkCrewCap(target);
        await this.#closeStream(conv, crewRow.id, stream);
        this.emit(user.id, {
          type: "handoff",
          conversationId: conv.id,
          from: crew,
          to: { slug: target, name: to.manifest.name },
          task,
        });
        try {
          // Only the Captain's main session can delegate, so options carry no consult here. The
          // person's photos stay with the Captain; it describes what the delegate needs.
          return await this.#turn(user, conv, run, target, task, withoutImages(options));
        } finally {
          stream = this.#openStream(user.id, conv.id, crew);
        }
      },
    };

    const crewHost: CrewHost = {
      askCaptain: async (question) => {
        const captain = this.deps.crew.captain();
        if (captain.slug === slug) throw new Error("you are the Captain; decide yourself");
        await this.#checkCrewCap(captain.slug);
        await this.#closeStream(conv, crewRow.id, stream);
        this.emit(user.id, {
          type: "handoff",
          conversationId: conv.id,
          from: crew,
          to: { slug: captain.slug, name: captain.manifest.name },
          task: question,
        });
        const role = folder.manifest.role;
        const consult = [
          `${crew.name} (${role}) is working for ${user.displayName} and asks you:`,
          "",
          question,
          "",
          `Answer so ${crew.name} can carry on: decide, give the missing detail, or tell them to stop and report back to ${user.displayName}. Be brief and concrete.`,
        ].join("\n");
        try {
          return await this.#turn(user, conv, run, captain.slug, consult, {
            ...withoutImages(options),
            consultFor: crew,
          });
        } finally {
          stream = this.#openStream(user.id, conv.id, crew);
        }
      },
    };

    const approvals: ApprovalHost = {
      request: async (call) => {
        options.onWaiting?.(true);
        try {
          return await this.deps.approvals.request({
            userId: user.id,
            conversationId: conv.id,
            watchId: options.watchId ?? null,
            crew,
            toolName: call.toolName,
            args: call.input,
          });
        } finally {
          options.onWaiting?.(false);
        }
      },
      audit: (call) =>
        void this.deps.audit
          .record({
            userId: user.id,
            crewMemberId: crewRow.id,
            action: call.toolName,
            summary: summarize(call.input),
            decision: call.decision,
            detail: {
              conversationId: conv.id,
              watchId: options.watchId ?? null,
              input: call.input,
            },
          })
          .catch(() => {}),
      remember: async (tool) => {
        const latest = this.deps.crew.folder(slug).manifest;
        if (!latest.allow.includes(tool)) {
          await this.deps.crew.patch(slug, { allow: [...latest.allow, tool] });
        }
      },
    };

    const session = await this.#session(
      user,
      conv,
      run,
      folder,
      { captain: host, crew: crewHost, approvals },
      options.consultFor,
    );
    // A crew member whose model cannot see images hands this one turn to a model that can.
    let images = options.images ?? [];
    const own = session.session.model ?? session.model;
    let restore: Model<Api> | undefined;
    if (images.length && !own.input.includes("image")) {
      const vision = await this.#visionModel(own);
      if (
        vision &&
        (await session.session.setModel(vision).then(
          () => true,
          () => false,
        ))
      ) {
        restore = own;
        try {
          await this.#note(
            conv,
            `${crew.name}'s model can't see photos, so ${vision.name} (${vision.provider}/${vision.id}) answers this message.`,
          );
        } catch (err) {
          // The turn ends here, before the finally below that would switch back; the session
          // is cached, so it must not keep the vision model for later messages.
          await session.session.setModel(own).catch(() => {});
          throw err;
        }
      } else {
        images = [];
        prompt = `${prompt}\n\n(${user.displayName} attached photos you cannot see: ${(options.imageNames ?? []).join(", ")}.)`;
        await this.#note(
          conv,
          `No model that can see photos is set up, so ${crew.name} only gets their names. An owner can add one on the Providers page, or pick one under Settings → Photos.`,
        );
      }
    }
    const unsubscribe = session.subscribe((event) => {
      this.#onEvent(
        user,
        conv,
        run,
        crewRow.id,
        session.session.model ?? session.model,
        stream,
        event,
        options.watchId ?? null,
      );
      if (event.type === "message_end" && event.message.role === "assistant") {
        const t = textOf(event.message);
        if (t) final = t;
      }
    });
    try {
      await session.prompt(prompt, images);
      const failure = lastError(session);
      if (failure && !run.aborted) throw new Error(failure);
    } finally {
      unsubscribe();
      if (restore) await session.session.setModel(restore).catch(() => {});
      await this.#closeStream(conv, crewRow.id, stream);
      // Spend must be stored before the turn ends, or the next message could slip past a cap.
      await Promise.all(run.writes);
      const file = session.sessionFile;
      if (file && !options.consultFor && conv.sessionFiles[slug] !== file) {
        conv.sessionFiles = { ...conv.sessionFiles, [slug]: file };
        await this.deps.db
          .update(conversations)
          .set({ sessionFiles: conv.sessionFiles })
          .where(eq(conversations.id, conv.id));
      }
    }
    return final;
  }

  /**
   * Refuse a turn once a monthly ceiling is reached: the person's cap (watch runs count too),
   * the crew member's `monthlyCapUsd`, and for watch runs the watch's own cap. Callers claim
   * the run first, so two quick turns cannot both pass the check.
   */
  async #checkCap(user: UserRow, slug: string | null, watchId?: string) {
    if (user.monthlyCapCents !== null) {
      const spent = await this.deps.usage.monthSpend(user.id);
      if (spent >= user.monthlyCapCents * 10_000) {
        throw new HttpError(
          402,
          `You have reached your monthly usage cap (${usd(user.monthlyCapCents / 100)}). An owner can raise it on the Users page.`,
        );
      }
    }
    if (slug) await this.#checkCrewCap(slug);
    if (watchId) {
      const [w] = await this.deps.db
        .select({ name: watches.name, capCents: watches.monthlyCapCents })
        .from(watches)
        .where(eq(watches.id, watchId));
      if (w && w.capCents !== null) {
        const spent = await this.deps.usage.monthSpendWatch(watchId);
        if (spent >= w.capCents * 10_000) {
          throw new HttpError(
            402,
            `The watch "${w.name}" has reached its monthly ceiling (${usd(w.capCents / 100)}). Its owner can raise it on the Watches page.`,
          );
        }
      }
    }
  }

  /** A crew member's monthly ceiling (`monthlyCapUsd` in crew.yaml), across everyone. */
  async #checkCrewCap(slug: string) {
    const manifest = this.deps.crew.folder(slug).manifest;
    const cap = manifest.monthlyCapUsd;
    if (cap === null || cap === undefined) return;
    const row = await this.deps.crew.row(slug);
    const spent = await this.deps.usage.monthSpendCrew(row.id);
    if (spent >= cap * 1_000_000) {
      throw new HttpError(
        402,
        `${manifest.name} has reached its monthly ceiling (${usd(cap)}). An admin can raise monthlyCapUsd on the Crew page.`,
      );
    }
  }

  /** Store one model call's usage, retrying once; the turn waits for it (see #turn). */
  #recordUsage(run: Run, ...args: Parameters<UsageService["record"]>) {
    const write = this.deps.usage
      .record(...args)
      .catch(() => this.deps.usage.record(...args))
      .catch((err: unknown) => {
        console.error("shipmate: could not record usage", err);
      })
      .finally(() => run.writes.delete(write));
    run.writes.add(write);
  }

  #onEvent(
    user: UserRow,
    conv: ConversationRow,
    run: Run,
    crewMemberId: string,
    model: Model<Api>,
    stream: Stream,
    event: AgentSessionEvent,
    watchId: string | null,
  ) {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") {
          stream.text += event.assistantMessageEvent.delta;
          this.emit(user.id, {
            type: "delta",
            conversationId: conv.id,
            streamId: stream.id,
            text: event.assistantMessageEvent.delta,
          });
        }
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          if (stream.text && !stream.text.endsWith("\n\n")) stream.text += "\n\n";
          this.#recordUsage(
            run,
            { userId: user.id, crewMemberId, conversationId: conv.id, routineId: watchId },
            model,
            event.message.usage,
          );
        }
        break;
      case "tool_execution_start":
        // Hand-offs show as their own line, not as a tool chip.
        if (event.toolName === "delegate" || event.toolName === "ask_captain") break;
        stream.tools.push(event.toolName);
        this.emit(user.id, {
          type: "tool",
          conversationId: conv.id,
          streamId: stream.id,
          phase: "start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: summarize(event.args),
        });
        break;
      case "tool_execution_end":
        if (event.toolName === "delegate" || event.toolName === "ask_captain") break;
        this.emit(user.id, {
          type: "tool",
          conversationId: conv.id,
          streamId: stream.id,
          phase: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          summary: summarize(event.result),
          isError: event.isError,
        });
        break;
    }
  }

  #openStream(userId: string, conversationId: string, crew: { slug: string; name: string }) {
    const stream: Stream = { id: randomUUID(), userId, crew, text: "", tools: [], closed: false };
    this.emit(userId, { type: "stream_start", conversationId, streamId: stream.id, crew });
    return stream;
  }

  async #closeStream(conv: ConversationRow, crewMemberId: string, stream: Stream) {
    if (stream.closed) return;
    stream.closed = true;
    this.emit(stream.userId, { type: "stream_end", conversationId: conv.id, streamId: stream.id });
    const content = stream.text.trim();
    if (!content) return;
    const message = await this.#store(conv, {
      role: "assistant",
      content,
      crewMemberId,
      authorName: stream.crew.name,
      crewSlug: stream.crew.slug,
      meta: stream.tools.length ? { tools: stream.tools } : null,
    });
    this.emit(stream.userId, { type: "message", conversationId: conv.id, message });
  }

  async #session(
    user: UserRow,
    conv: ConversationRow,
    run: Run,
    folder: CrewFolder,
    context: TurnContext,
    consultFor?: { slug: string; name: string },
  ): Promise<CrewSession> {
    // A consult is the Captain's second session in the run, so it never collides with the main
    // one, which may be waiting on the delegate that asked.
    const key = consultFor ? `${folder.slug}#consult` : folder.slug;
    run.hosts.set(key, context);
    const existing = run.sessions.get(key);
    if (existing) return existing;
    const acting: ActingUser = { id: user.id, displayName: user.displayName, role: user.role };
    const memory = new MemoryStore(folder.dir);
    const isCaptain = folder.manifest.captain && conv.kind === "bridge" && !consultFor;
    const captainName = this.deps.crew.captain().manifest.name;
    // A cached session's tools outlive the turn that created them, so they look up the host of
    // the turn in progress.
    const current = (): TurnContext => {
      const h = run.hosts.get(key);
      if (!h) throw new Error("no turn in progress");
      return h;
    };
    const proxy: CaptainHost = {
      listCrew: () => current().captain.listCrew(),
      recruit: (s) => current().captain.recruit(s),
      edit: (slug, s) => current().captain.edit(slug, s),
      retire: (slug) => current().captain.retire(slug),
      delegate: (slug, task, signal) => current().captain.delegate(slug, task, signal),
      createWatch: (spec) => current().captain.createWatch(spec),
      installMcp: (id, crews) => current().captain.installMcp(id, crews),
    };
    const skills = this.deps.skills;
    const { servers, skipped } = await this.deps.mcp.serversFor(folder);
    const model = await this.#model(folder);
    if (conv.projectId && !this.#workspaces) {
      throw new HttpError(503, "the Shipyard is not available on this instance");
    }
    const workspace =
      conv.projectId && this.#workspaces
        ? await this.#workspaces.forConversation(conv.projectId, user, folder, conv.id)
        : undefined;
    const created = await createCrewSession({
      crew: folder,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.providers.runtime,
      model,
      customTools: [
        ...memoryTools(memory, acting),
        ...skillTools({
          createSkill: async ({ scope, content }) =>
            skills.createByCrew(
              folder.slug,
              user.id,
              scope,
              content,
              this.deps.crew.folder(folder.slug).manifest.autoApproveSkills,
            ),
        }),
        ...(isCaptain ? captainTools(proxy, acting) : []),
        ...(folder.manifest.captain
          ? []
          : crewTools(
              { askCaptain: (q, signal) => current().crew.askCaptain(q, signal) },
              captainName,
            )),
        ...(this.#everyday?.tools(user, folder) ?? []),
        ...(workspace?.tools ?? []),
      ],
      ...(workspace ? { workspace: { dir: workspace.dir, bash: workspace.bash } } : {}),
      mcpServers: servers,
      skillPaths: this.deps.skills.pathsFor(user.id),
      approvals: () => current().approvals,
      appendSystemPrompt: [
        await this.#context(user, folder, memory, isCaptain, skipped),
        ...(this.#everyday ? [await this.#everyday.context(user)] : []),
        ...(consultFor
          ? [
              `## Answering the crew\n\nIn this session you only answer questions from crew members who are mid-task. You cannot delegate or change the crew here; if the answer needs that, say so and ${user.displayName} or you can do it on the Bridge.`,
            ]
          : []),
        ...(workspace ? [workspace.prompt] : []),
      ],
      ...(consultFor ? { inMemory: true } : {}),
      ...(!consultFor && conv.sessionFiles[folder.slug]
        ? { sessionFile: conv.sessionFiles[folder.slug] }
        : {}),
    });
    run.sessions.set(key, created);
    return created;
  }

  /**
   * A model that can see images for a crew member whose `current` model cannot: the one picked
   * in Settings, else one from the same provider, else the default model, else any.
   */
  async #visionModel(current: Model<Api>): Promise<Model<Api> | undefined> {
    const available = (await this.deps.providers.available()).filter((m) =>
      m.input.includes("image"),
    );
    const settings = await this.deps.settings.get();
    const byRef = (ref: string) => {
      const r = splitModelRef(ref);
      return r ? available.find((m) => m.provider === r.provider && m.id === r.id) : undefined;
    };
    return (
      (settings.visionModel ? byRef(settings.visionModel) : undefined) ??
      available.find((m) => m.provider === current.provider) ??
      byRef(settings.defaultModel) ??
      available[0]
    );
  }

  /** A line in the conversation from Shipmate itself (shown small and centered). */
  async #note(conv: ConversationRow, content: string) {
    const message = await this.#store(conv, { role: "system", content, authorName: "Shipmate" });
    this.emit(conv.userId, { type: "message", conversationId: conv.id, message });
  }

  /** The crew member's model, or the instance default when it has no credentials yet. */
  async #model(folder: CrewFolder): Promise<Model<Api>> {
    const available = await this.deps.providers.available();
    const find = (ref: string) => {
      const r = splitModelRef(ref);
      return r ? available.find((m) => m.provider === r.provider && m.id === r.id) : undefined;
    };
    const model =
      find(folder.manifest.model) ??
      find((await this.deps.settings.get()).defaultModel) ??
      available[0];
    if (!model) {
      throw new HttpError(
        503,
        "No model provider is set up yet. An owner can add one on the Providers page.",
      );
    }
    return model;
  }

  async #context(
    user: UserRow,
    folder: CrewFolder,
    memory: MemoryStore,
    isCaptain: boolean,
    skippedMcp: string[],
  ): Promise<string> {
    const parts = [
      "# Shipmate",
      "",
      `You are ${folder.manifest.name}, a crew member of a self-hosted Shipmate instance shared by several people.`,
      `You are talking with ${user.displayName} (${user.role}). Today is ${new Date().toISOString().slice(0, 10)}.`,
      "Use `remember` for durable facts worth keeping, `recall` to read a memory in full, and `forget` for facts that are no longer true. Keep one person's private memory away from everyone else.",
      "",
      memory.contextFor(user.id),
    ];
    if (isCaptain) {
      const roster = (await this.#roster(user))
        .filter((c) => !c.captain && c.status !== "retired")
        .map(
          (c) =>
            `- ${c.slug}: ${c.name}, ${c.role}${c.status === "pending_review" ? " (awaiting review)" : ""}`,
        );
      parts.push("", "## Crew aboard", "", roster.join("\n") || "(only you so far)");
    } else if (!folder.manifest.captain) {
      const captain = this.deps.crew.captain().manifest.name;
      parts.push(
        "",
        `${captain} coordinates the crew. When you are unsure what ${user.displayName} wants, what to do next, or whether something is your job, ask ${captain} with \`ask_captain\` instead of guessing.`,
      );
    }
    if (skippedMcp.length) {
      parts.push("", `MCP servers not started (missing setup): ${skippedMcp.join(", ")}.`);
    }
    return parts.join("\n");
  }

  async #roster(user: UserRow): Promise<CrewSummary[]> {
    return (await this.deps.crew.list(false, user)).map((c) => ({
      slug: c.slug,
      name: c.name,
      role: c.role,
      model: c.model,
      status: c.status,
      captain: c.captain,
    }));
  }

  async #recruit(user: UserRow, spec: Parameters<CaptainHost["recruit"]>[0]) {
    const settings = await this.deps.settings.get();
    const d = await this.deps.crew.create({
      slug: spec.slug,
      manifest: {
        name: spec.name,
        role: spec.role,
        model: spec.model ?? settings.defaultModel,
        tools: spec.tools ?? ["read", "write", "edit"],
        mcp: spec.mcp ?? [],
      },
      persona: spec.persona,
      createdById: user.id,
      status: "pending_review",
    });
    return { ...d };
  }

  async #assertActive(slug: string, user: UserRow) {
    const crew = (await this.deps.crew.list(true, user)).find((c) => c.slug === slug);
    if (!crew) throw new HttpError(404, `no crew member "${slug}"`);
    if (crew.status === "pending_review") {
      throw new HttpError(409, `${crew.name} is awaiting review on the Crew page before first use`);
    }
    if (crew.status === "retired") throw new HttpError(410, `${crew.name} has been retired`);
  }

  async #slugOf(crewMemberId: string | null): Promise<string | null> {
    if (!crewMemberId) return null;
    const [row] = await this.deps.db
      .select({ slug: crewMembers.slug })
      .from(crewMembers)
      .where(eq(crewMembers.id, crewMemberId));
    return row?.slug ?? null;
  }

  async #store(
    conv: ConversationRow,
    m: {
      role: "user" | "assistant" | "system";
      content: string;
      userId?: string;
      crewMemberId?: string;
      authorName: string;
      crewSlug?: string;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<MessageDto> {
    const [row] = await this.deps.db
      .insert(messages)
      .values({
        conversationId: conv.id,
        role: m.role,
        content: m.content,
        userId: m.userId ?? null,
        crewMemberId: m.crewMemberId ?? null,
        meta: m.meta ?? null,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    await this.deps.db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conv.id));
    return toMessageDto(row, {
      userName: m.userId ? m.authorName : null,
      crewSlug: m.crewSlug ?? null,
      crewName: m.crewMemberId ? m.authorName : null,
    });
  }

  #run(conversationId: string): Run {
    const run = this.#runs.get(conversationId) ?? {
      sessions: new Map(),
      hosts: new Map(),
      busy: false,
      aborted: false,
      writes: new Set(),
    };
    this.#runs.set(conversationId, run);
    return run;
  }

  #dispose(conversationId: string) {
    const run = this.#runs.get(conversationId);
    if (!run) return;
    this.#cli.abort(conversationId);
    clearTimeout(run.idleTimer);
    for (const s of run.sessions.values()) s.dispose();
    this.#runs.delete(conversationId);
  }
}

interface Stream {
  id: string;
  userId: string;
  crew: { slug: string; name: string };
  text: string;
  tools: string[];
  closed: boolean;
}

function withoutImages(options: TurnOptions): TurnOptions {
  const { images: _images, imageNames: _names, ...rest } = options;
  return rest;
}

function textOf(message: AssistantMessage): string {
  return message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

function lastError(session: CrewSession): string | undefined {
  const last = [...session.session.messages].reverse().find((m) => m.role === "assistant");
  if (last && last.role === "assistant" && last.stopReason === "error") {
    return last.errorMessage || "the model returned an error";
  }
  return undefined;
}

function toConversationDto(c: ConversationRow, slug: string | null): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    kind: c.kind === "direct" ? "direct" : "bridge",
    crewSlug: slug,
    surface: c.surface,
    projectId: c.projectId,
    pinned: c.pinnedAt !== null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toMessageDto(
  m: typeof messages.$inferSelect,
  names: { userName: string | null; crewSlug: string | null; crewName: string | null },
): MessageDto {
  const author: MessageDto["author"] =
    m.userId && names.userName
      ? { kind: "user", id: m.userId, name: names.userName }
      : names.crewSlug
        ? { kind: "crew", slug: names.crewSlug, name: names.crewName ?? names.crewSlug }
        : { kind: "system" };
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role === "user" || m.role === "assistant" ? m.role : "system",
    content: m.content,
    author,
    meta: (m.meta as Record<string, unknown> | null) ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

const usd = (dollars: number) => `$${dollars.toFixed(2)}`;
