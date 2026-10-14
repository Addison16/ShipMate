import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  BashOperations,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type AttachmentDto,
  ClaudeCliSettings,
  CODEX_PROVIDER,
  type ConversationDto,
  type ConversationSearchResultDto,
  type CrewManifest,
  DEFAULT_MODEL,
  type LiveItemDto,
  type LiveToolDto,
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
  type EquipSpec,
  gateToolCall,
  type HelperHost,
  helperTools,
  MemoryStore,
  memoryTools,
  type PetHost,
  type PictureHost,
  petTools,
  pictureTools,
  type QuestionHost,
  questionTools,
  skillTools,
  splitModelRef,
  type ThemeHost,
  themeTools,
} from "@shipmate/crew";
import { conversations, crewMembers, type Db, messages, users, watches } from "@shipmate/db";
import { and, asc, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { accessSummary } from "./access-summary.js";
import { HttpError, type UserRow } from "./auth.js";
import { ClaudeCliTurns, cliModelFromRef, onCrewDefault } from "./claude-cli-turn.js";
import { CliToolServer } from "./cli-mcp.js";
import { CodexCliTurns, codexModels } from "./codex-cli-turn.js";
import type { EverydayTools } from "./everyday.js";
import type { AttachmentService } from "./files/service.js";
import { toDto as toAttachmentDto } from "./files/service.js";
import { modelList, modelPrice } from "./model-price.js";
import { petHost } from "./pets/host.js";
import type { PetService } from "./pets/service.js";
import type { ApprovalService } from "./services/approvals.js";
import type { AuditService } from "./services/audit.js";
import type { CrewService } from "./services/crew.js";
import type { McpService } from "./services/mcp.js";
import type { ProviderService } from "./services/providers.js";
import type { SettingsService } from "./services/settings.js";
import type { SkillService } from "./services/skills.js";
import { ThemeProblems, type ThemeService } from "./services/themes.js";
import type { UsageService } from "./services/usage.js";
import type { WatchService } from "./services/watches.js";
import { summarize } from "./summarize.js";

type ConversationRow = typeof conversations.$inferSelect;
type Send = (event: ServerEvent) => void;

const IDLE_MS = 30 * 60_000;
/** How much of the latest message the conversation list shows. */
const PREVIEW_CHARS = 140;

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
  /** Custom themes: the Captain builds them, and the crew talks in the person's theme. */
  themes: ThemeService;
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

/** Tools that show as their own line or card in the conversation, not as a tool chip. */
const HIDDEN_TOOL_CHIPS = new Set([
  "delegate",
  "ask_captain",
  "ask_person",
  "save_theme",
  "make_pet",
]);

/** Everything a cached session's tools need from the turn in progress. */
interface TurnContext {
  captain: CaptainHost;
  crew: CrewHost;
  approvals: ApprovalHost;
  question: QuestionHost;
  helper: HelperHost;
  /** The Captain's pet building; absent when pets are not wired up (some tests). */
  pet?: PetHost | undefined;
  /** make_picture; absent when pictures are not wired up (some tests). */
  picture?: PictureHost | undefined;
  theme: ThemeHost;
}

/** Helper agents one crew member may start while answering one message. */
export const MAX_HELPERS_PER_TURN = 8;

/**
 * What a pi session is for besides a crew member's own turn: answering a crew member's
 * `ask_captain`, or one helper agent's task (the id keeps side-by-side helpers apart).
 */
type SessionMode = { consultFor: { slug: string; name: string } } | { helper: string };

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
  /** #promptKey() when these sessions were made; their system prompts list the crew. */
  promptKey?: string | undefined;
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
  /** Per conversation, the turn in progress as a page that opens now should show it. */
  #live = new Map<string, LiveTurn>();
  #watches: WatchService | undefined;
  #workspaces: WorkspaceProvider | undefined;
  #everyday: EverydayTools | undefined;
  #pets: PetService | undefined;
  /** Turns of `backend: claude-code-cli` crew members (the official `claude` binary). */
  #cli: ClaudeCliTurns;
  /** Turns of `backend: codex-cli` crew members (the official `codex` binary). */
  #codex: CodexCliTurns;
  /** Shipmate's tools for those turns, served over loopback MCP. */
  readonly cliTools = new CliToolServer();
  /** Bumped on every crew change, so idle sessions pick up the new crew list (see send). */
  #crewVersion = 0;

  constructor(private readonly deps: BridgeDeps) {
    this.#cli = new ClaudeCliTurns(deps.db);
    this.#codex = new CodexCliTurns(deps.db);
    deps.crew.onChange(() => {
      this.#crewVersion++;
      this.broadcast({ type: "crew_changed" });
    });
    deps.skills.onChange(() => this.broadcast({ type: "skills_changed" }));
    deps.themes.onChange(() => this.broadcast({ type: "themes_changed" }));
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

  /** Pet pictures, for the Captain's pet tools. */
  attachPets(pets: PetService) {
    this.#pets = pets;
  }

  #people() {
    if (!this.#everyday) throw new Error("people settings are not available");
    return this.#everyday.people;
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
    this.#track(event);
    for (const send of this.#sockets.get(userId) ?? []) send(event);
    for (const tap of this.#taps) tap(userId, event);
  }

  /**
   * The turn in progress in a conversation, for a page that opens (or reconnects) mid-turn.
   * Turns run on the server whether or not anyone is watching; this lets the page catch up.
   */
  async live(
    user: UserRow,
    conversationId: string,
  ): Promise<Extract<ServerEvent, { type: "live" }>> {
    await this.conversation(user, conversationId);
    const live = this.#live.get(conversationId);
    return {
      type: "live",
      conversationId,
      busy: this.isBusy(conversationId),
      items: (live?.items ?? []).map((it) =>
        it.kind === "stream" ? { ...it, tools: [...it.tools.values()] } : it,
      ),
    };
  }

  /** Mirror what the person's pages see into `#live`. */
  #track(event: ServerEvent) {
    if (!("conversationId" in event) || !event.conversationId) return;
    const id = event.conversationId;
    let live = this.#live.get(id);
    if (event.type === "status") {
      if (event.busy) this.#live.set(id, { items: [] });
      else this.#live.delete(id);
      return;
    }
    const streamOf = (streamId: string) =>
      live?.items.find((it): it is LiveStream => it.kind === "stream" && it.streamId === streamId);
    switch (event.type) {
      case "stream_start":
        if (!live) {
          // A watch run streams without a status event; the stream ends on its own.
          live = { items: [] };
          this.#live.set(id, live);
        }
        live.items.push({
          kind: "stream",
          streamId: event.streamId,
          crew: event.crew,
          text: "",
          tools: new Map(),
        });
        break;
      case "delta": {
        const s = streamOf(event.streamId);
        if (s) s.text += event.text;
        break;
      }
      case "tool": {
        const s = streamOf(event.streamId);
        if (!s) break;
        const before = s.tools.get(event.toolCallId);
        s.tools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          summary: event.summary || before?.summary || "",
          running: event.phase === "start",
          isError: Boolean(event.isError),
        });
        break;
      }
      case "stream_end":
        {
          if (!live) break;
          const ended = streamOf(event.streamId);
          // Its saved message follows; a page that opens now loads that instead. The hand-off
          // line to its writer goes too: a page loads saved messages first and adds live items
          // after them, so the line would land below the reply it introduced.
          const handoff = ended
            ? live.items.findLastIndex(
                (it) => it.kind === "handoff" && it.to.slug === ended.crew.slug,
              )
            : -1;
          live.items = live.items.filter(
            (it, i) => i !== handoff && (it.kind !== "stream" || it.streamId !== event.streamId),
          );
          if (!live.items.length && !this.isBusy(id)) this.#live.delete(id);
        }
        break;
      case "handoff":
        live?.items.push({ kind: "handoff", from: event.from, to: event.to, task: event.task });
        break;
    }
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
      .select({
        c: conversations,
        slug: crewMembers.slug,
        // The latest thing said, for the list; the person's own words start with "You: ".
        preview: sql<string | null>`(
          select case when m.role = 'user' then 'You: ' else '' end
            || left(regexp_replace(m.content, '[[:space:]]+', ' ', 'g'), ${PREVIEW_CHARS})
          from ${messages} m
          where m.conversation_id = ${conversations.id} and m.role <> 'system' and m.content <> ''
          order by m.created_at desc
          limit 1
        )`,
      })
      .from(conversations)
      .leftJoin(crewMembers, eq(crewMembers.id, conversations.crewMemberId))
      .where(and(eq(conversations.userId, userId), eq(conversations.surface, "web")))
      .orderBy(sql`${conversations.pinnedAt} desc nulls last`, desc(conversations.updatedAt));
    return rows.map((r) => toConversationDto(r.c, r.slug, r.preview));
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
    const matched = and(eq(conversations.userId, user.id), sql`${vector} @@ ${tsquery}`);
    // Pick the best conversations first, so one long chat can't crowd the others out.
    const top = await this.deps.db
      .select({ conversationId: messages.conversationId, best: sql<number>`max(${rank})` })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(matched)
      .groupBy(messages.conversationId)
      .orderBy(sql`max(${rank}) desc`)
      .limit(limit);
    const topIds = top.map((t) => t.conversationId);
    // Then up to three best messages in each of them.
    const ranked = this.deps.db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        createdAt: messages.createdAt,
        userId: messages.userId,
        crewMemberId: messages.crewMemberId,
        content: messages.content,
        rank: rank.as("rank"),
        place:
          sql<number>`row_number() over (partition by ${messages.conversationId} order by ${rank} desc, ${messages.createdAt} desc)`.as(
            "place",
          ),
      })
      .from(messages)
      .where(and(inArray(messages.conversationId, topIds), sql`${vector} @@ ${tsquery}`))
      .as("ranked");
    const hits = topIds.length
      ? await this.deps.db
          .select({
            id: ranked.id,
            conversationId: ranked.conversationId,
            createdAt: ranked.createdAt,
            userName: users.displayName,
            crewName: crewMembers.name,
            snippet: sql<string>`ts_headline('english', ${ranked.content}, ${tsquery}, ${options})`,
            rank: ranked.rank,
          })
          .from(ranked)
          .leftJoin(users, eq(users.id, ranked.userId))
          .leftJoin(crewMembers, eq(crewMembers.id, ranked.crewMemberId))
          .where(sql`${ranked.place} <= 3`)
          .orderBy(desc(ranked.rank), desc(ranked.createdAt))
      : [];
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
      /** Direct chats: reopen the person's latest web chat with that crew member, if any. */
      reuse?: boolean | undefined;
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
      if (input.reuse && (input.surface ?? "web") === "web" && !input.projectId) {
        const [existing] = await this.deps.db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.userId, user.id),
              eq(conversations.kind, "direct"),
              eq(conversations.crewMemberId, row.id),
              eq(conversations.surface, "web"),
              isNull(conversations.projectId),
            ),
          )
          .orderBy(desc(conversations.updatedAt))
          .limit(1);
        if (existing) return toConversationDto(existing, slug);
      }
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

  /**
   * Start the crew afresh in a conversation: they forget what was said (their sessions are
   * dropped) while every message stays on screen, below a divider. Refused while a turn runs.
   */
  async resetConversation(user: UserRow, id: string): Promise<MessageDto> {
    const conv = await this.conversation(user, id);
    if (conv.surface !== "web") throw new HttpError(400, "only web conversations can start fresh");
    if (this.#runs.get(id)?.busy) {
      throw new HttpError(409, "the crew is still answering; stop them first");
    }
    this.#dispose(id);
    conv.sessionFiles = {};
    await this.deps.db
      .update(conversations)
      .set({ sessionFiles: {} })
      .where(eq(conversations.id, id));
    const [member] = conv.crewMemberId
      ? await this.deps.db
          .select({ name: crewMembers.name })
          .from(crewMembers)
          .where(eq(crewMembers.id, conv.crewMemberId))
      : [];
    const who = member?.name ?? "The crew";
    const message = await this.#store(conv, {
      role: "system",
      content: `Fresh start. ${who} won't remember the messages above.`,
      authorName: "Shipmate",
      meta: { sessionReset: true },
    });
    this.emit(user.id, { type: "message", conversationId: id, message });
    return message;
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
    const promptKey = await this.#promptKey().catch(() => run.promptKey);
    if (run.promptKey !== promptKey) {
      // The crew, the crew default or the models changed since these sessions started: reopen
      // them from their files so the Captain's crew list (in its system prompt) is current.
      for (const s of run.sessions.values()) s.dispose();
      run.sessions.clear();
      run.promptKey = promptKey;
    }
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
    this.#codex.abort(conversationId);
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
    // Claim the run before any await, like send(): two turns in one conversation would share
    // (and the first to finish would dispose) the other's sessions.
    const run = this.#run(conversationId);
    if (run.busy) throw new HttpError(409, "the crew is still answering the last message");
    run.busy = true;
    try {
      const conv = await this.conversation(user, conversationId);
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
    // On the crew default, it runs where the default does (the Claude subscription included).
    const folder = onCrewDefault(
      this.deps.crew.folder(slug),
      (await this.deps.settings.get()).defaultModel,
    );
    const crewRow = await this.deps.crew.row(slug);
    const crew = { slug, name: folder.manifest.name };
    let stream = this.#openStream(user.id, conv.id, crew);
    let final = "";

    const host: CaptainHost = {
      listCrew: () => this.#pricedRoster(user),
      listModels: () => this.#listModels(user),
      recruit: (spec) => this.#recruit(user, spec),
      edit: async (target, spec) => {
        const { persona, cli, ...changes } = spec;
        const clean: Partial<CrewManifest> = Object.fromEntries(
          Object.entries(changes).filter(([, v]) => v !== undefined),
        );
        // A Codex model only runs on the Codex engine.
        if (clean.model?.startsWith(`${CODEX_PROVIDER}/`) && !clean.backend) {
          clean.backend = "codex-cli";
        }
        if (cli) {
          const now = this.deps.crew.folder(target).manifest.cli;
          clean.cli = ClaudeCliSettings.parse({
            ...now,
            ...Object.fromEntries(Object.entries(cli).filter(([, v]) => v !== undefined)),
            ...(cli.model === "" ? { model: undefined } : {}),
          });
        }
        const d = await this.deps.crew.patch(target, clean, persona);
        return { ...d, status: d.status };
      },
      crewSettings: async (target) => {
        if (!(await this.#roster(user)).some((c) => c.slug === target)) {
          throw new Error(`no crew member "${target}"; check list_crew`);
        }
        return (await this.deps.crew.detail(target)).manifestYaml;
      },
      listPeople: () => this.#people().list(user),
      updatePerson: (person, changes) => this.#people().update(user, person, changes),
      updateHousehold: (changes) => this.#people().updateHousehold(user, changes),
      retire: async (target) => {
        await this.deps.crew.setStatus(target, "retired");
      },
      approve: async (target) => {
        const now = (await this.#roster(user)).find((c) => c.slug === target);
        if (!now) throw new Error(`no crew member "${target}"; check list_crew`);
        if (now.status !== "pending_review") throw new Error(`${now.name} is not awaiting review`);
        return { ...(await this.deps.crew.setStatus(target, "active")) };
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
      equip: (target, grant) => this.#equip(user, target, grant),
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
          const summary = call.everyTime
            ? await this.#accessSummary(crew.name, call.toolName, call.input)
            : undefined;
          return await this.deps.approvals.request({
            userId: user.id,
            conversationId: conv.id,
            watchId: options.watchId ?? null,
            crew,
            toolName: call.toolName,
            args: call.input,
            ...(summary ? { summary } : {}),
            ...(call.everyTime ? { everyTime: true } : {}),
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

    const question: QuestionHost = {
      ask: async (q) => {
        // A watch runs with nobody watching; the crew member decides and says so.
        if (options.watchId) return null;
        // What the crew member said so far is stored above the question, and the answer is kept
        // in the conversation as a note, so it reads in order after a reload.
        await this.#closeStream(conv, crewRow.id, stream);
        options.onWaiting?.(true);
        try {
          const answer = await this.deps.approvals.ask({
            userId: user.id,
            conversationId: conv.id,
            watchId: null,
            crew,
            question: q,
          });
          const message = await this.#store(conv, {
            role: "system",
            content: `${crew.name} asked: ${q.text} ${user.displayName}: ${answer ?? "(skipped)"}`,
            authorName: "Shipmate",
            meta: { question: { crew, text: q.text, answer } },
          });
          this.emit(user.id, { type: "message", conversationId: conv.id, message });
          return answer;
        } finally {
          options.onWaiting?.(false);
          stream = this.#openStream(user.id, conv.id, crew);
        }
      },
    };

    let helpersStarted = 0;
    const helper: HelperHost = {
      run: async (task, signal) => {
        if (!folder.manifest.helpers) throw new Error("helper agents are off for this crew member");
        if (++helpersStarted > MAX_HELPERS_PER_TURN) {
          throw new Error(
            `at most ${MAX_HELPERS_PER_TURN} helpers per message; finish with what you have`,
          );
        }
        // Helpers spend like the crew member itself, so the same caps stop them.
        await this.#checkCap(user, slug, options.watchId);
        return this.#runHelper(user, conv, run, folder, crewRow.id, context, task, signal, {
          watchId: options.watchId ?? null,
        });
      },
    };
    const theme: ThemeHost = {
      list: async () => {
        const all = await this.deps.themes.list(user);
        const active = (await this.deps.themes.activeFor(user))?.name;
        if (!all.length) return "No custom themes yet.";
        return all
          .map(
            (t) =>
              `- ${t.id}: ${t.name}${t.description ? ` (${t.description})` : ""}, by ${t.createdBy?.name ?? "someone"}${t.canEdit ? "" : ", read-only for you"}${t.name === active ? `, ${user.displayName} uses it` : ""}`,
          )
          .join("\n");
      },
      save: async (input, rawId) => {
        // A small model may send an id it made up; then it saves as a new theme.
        const id = rawId && (await this.deps.themes.exists(rawId)) ? rawId : undefined;
        let saved: Awaited<ReturnType<ThemeService["save"]>>;
        try {
          saved = await this.deps.themes.save(user, input, id);
        } catch (err) {
          if (err instanceof ThemeProblems) {
            throw new Error(
              `the theme was not saved. Fix these and call save_theme again:\n- ${err.problems.join("\n- ")}`,
            );
          }
          throw err;
        }
        const { theme: t, notes } = saved;
        // The preview card sits after what the Captain said so far, like a question card.
        await this.#closeStream(conv, crewRow.id, stream);
        const message = await this.#store(conv, {
          role: "system",
          content: `${crew.name} ${id ? "updated" : "made"} the theme "${t.name}".`,
          authorName: "Shipmate",
          meta: { theme: { id: t.id, name: t.name } },
        });
        this.emit(user.id, { type: "message", conversationId: conv.id, message });
        stream = this.#openStream(user.id, conv.id, crew);
        return [
          `Saved the theme "${t.name}". Its id is ${t.id}.`,
          ...(rawId && !id ? [`There was no theme with id ${rawId}, so this is a new theme.`] : []),
          ...(notes.length
            ? [
                `Shipmate fixed some things. Tell ${user.displayName} in one short sentence:`,
                ...notes.map((n) => `- ${n}`),
              ]
            : []),
          `Now tell ${user.displayName}: "Tap Try it on the card to use it." Then ask if they want changes. For a change, call save_theme again with id ${t.id} and the full theme.`,
        ].join("\n");
      },
      use: async (id) => {
        const preferences = await this.deps.themes.use(user, id);
        this.emit(user.id, { type: "preferences_changed", preferences });
        return id
          ? `Switched ${user.displayName} to the theme. It shows right away; new chats use its words and voice.`
          : `Switched ${user.displayName} back to the standard Shipmate look.`;
      },
    };
    const pets = this.#pets;
    const pet: PetHost | undefined = pets
      ? petHost({
          crew: this.deps.crew,
          pets,
          roster: async () => (await this.#roster(user)).filter((c) => c.status !== "retired"),
          preview: async (meta) => {
            await this.#closeStream(conv, crewRow.id, stream);
            try {
              const message = await this.#store(conv, {
                role: "system",
                content: `${meta.crew.name}'s new pet: ${meta.name}`,
                authorName: "Shipmate",
                meta: { petPreview: meta },
              });
              this.emit(user.id, { type: "message", conversationId: conv.id, message });
            } finally {
              stream = this.#openStream(user.id, conv.id, crew);
            }
          },
          ask: (q, signal) => question.ask(q, signal),
          personName: user.displayName,
        })
      : undefined;
    // A picture shows on the reply, stored like a photo the person sent.
    const showPicture = async (file: { name: string; data: Buffer }) => {
      const dto = await this.deps.files.upload(user.id, conv.id, { ...file, type: "" });
      if (dto.kind === "image") stream.files.push(dto);
    };
    const picture: PictureHost | undefined = pets
      ? {
          make: async (description, signal) => {
            if (!(await pets.painter()).paints) {
              return `No image model is set up, so you cannot make pictures yet. Tell ${user.displayName} that an owner can pick one under Settings, Photos and voice.`;
            }
            let made: Awaited<ReturnType<PetService["picture"]>>;
            const startedAt = performance.now();
            try {
              // A paid image API spends like the chat model, so the same caps stop it.
              await this.#checkCap(user, slug, options.watchId);
              made = await pets.picture(description, signal);
            } catch (err) {
              return `The picture was not made: ${(err as Error).message}. Tell ${user.displayName} in one short sentence.`;
            }
            this.#recordUsage(
              run,
              {
                userId: user.id,
                crewMemberId: crewRow.id,
                conversationId: conv.id,
                routineId: options.watchId ?? null,
              },
              pictureModel(made.model),
              {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: made.costUsd },
              },
              performance.now() - startedAt,
              "api",
            );
            await showPicture({ name: `picture.${made.ext}`, data: Buffer.from(made.bytes) });
            return "The picture is shown on your reply. Say in one short sentence what it shows. Do not add a link or an image tag.";
          },
        }
      : undefined;
    const context: TurnContext = {
      captain: host,
      crew: crewHost,
      approvals,
      question,
      helper,
      pet,
      picture,
      theme,
    };

    const backend = folder.manifest.backend;
    if (backend === "claude-code-cli" || backend === "codex-cli") {
      const codex = backend === "codex-cli";
      if (options.images?.length) {
        await this.#note(
          conv,
          `${crew.name} runs on ${codex ? "Codex" : "the Claude Code CLI"}, which Shipmate cannot pass photos to, so ${crew.name} only gets their names. Ask the ${this.deps.crew.captain().manifest.name} on the Bridge to look at them instead.`,
        );
        prompt = `${prompt}\n\n(${user.displayName} attached photos you cannot see: ${(options.imageNames ?? []).join(", ")}.)`;
      }
      const isCaptain = folder.manifest.captain && conv.kind === "bridge" && !options.consultFor;
      // A consult is a one-off answer without tools, like the pi Captain's consult session.
      const allowed = new Set(folder.manifest.allow);
      // The crew member's installed MCP servers run inside Claude Code, behind the same
      // approvals. Codex has no hook to ask Shipmate first, so it gets only Shipmate's tools.
      const mcp =
        options.consultFor || codex
          ? { servers: {}, skipped: [] as string[] }
          : await this.deps.mcp.serversFor(folder);
      const grant = options.consultFor
        ? undefined
        : this.cliTools.open(
            {
              tools: this.#cliTools(
                user,
                folder,
                // Codex makes pictures with its own image tool.
                {
                  captain: host,
                  crew: crewHost,
                  question,
                  theme,
                  pet,
                  picture: codex ? undefined : picture,
                },
                isCaptain,
              ),
              gate: (call) =>
                gateToolCall({ approval: folder.manifest.approval, allowed }, approvals, call),
            },
            mcp.servers,
          );
      const context = options.consultFor
        ? [
            `## Answering the crew\n\nIn this session you only answer a question from ${options.consultFor.name}, who is mid-task. You cannot delegate or change the crew here; if the answer needs that, say so and ${user.displayName} or you can do it on the Bridge.`,
          ]
        : [
            ...(await this.#crewContext(user, folder, isCaptain, grant !== undefined)),
            ...(await this.#themeContext(user)),
            ...(mcp.skipped.length
              ? [`MCP servers not started (missing setup): ${mcp.skipped.join(", ")}.`]
              : []),
            ...(codex && folder.manifest.mcp.length
              ? [
                  `Its MCP servers (${folder.manifest.mcp.join(", ")}) are not available on Codex; switch to the Shipmate or Claude Code engine to use them.`,
                ]
              : []),
          ];
      const usage = {
        userId: user.id,
        crewMemberId: crewRow.id,
        conversationId: conv.id,
        routineId: options.watchId ?? null,
      };
      try {
        if (codex) {
          return await this.#codex.turn({
            user,
            conv,
            folder,
            prompt,
            stream: () => stream,
            usage,
            emit: (event) => this.emit(user.id, event),
            record: (...args) => this.#recordUsage(run, ...args),
            ...(grant ? { mcp: grant.http } : {}),
            addImage: showPicture,
            context,
            oneOff: options.consultFor !== undefined,
          });
        }
        return await this.#cli.turn({
          user,
          conv,
          folder,
          prompt,
          stream: () => stream,
          usage,
          emit: (event) => this.emit(user.id, event),
          record: (...args) => this.#recordUsage(run, ...args),
          ...(grant ? { mcpConfig: grant.mcpConfig } : {}),
          ...(grant?.settingsJson ? { settingsJson: grant.settingsJson } : {}),
          context,
          oneOff: options.consultFor !== undefined,
        });
      } finally {
        grant?.revoke();
        await this.#closeStream(conv, crewRow.id, stream);
        await Promise.all(run.writes);
      }
    }

    const session = await this.#session(
      user,
      conv,
      run,
      folder,
      context,
      options.consultFor ? { consultFor: options.consultFor } : undefined,
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
    // Response time of each model call: from the request (a new turn, or the last user or tool
    // result message) to the end of the assistant's message.
    let requestedAt = performance.now();
    const unsubscribe = session.subscribe((event) => {
      const now = performance.now();
      const assistantEnd = event.type === "message_end" && event.message.role === "assistant";
      const answeredInMs = assistantEnd ? now - requestedAt : null;
      if (event.type === "turn_start" || (event.type === "message_end" && !assistantEnd)) {
        requestedAt = now;
      }
      this.#onEvent(
        user,
        conv,
        run,
        crewRow.id,
        session.session.model ?? session.model,
        stream,
        event,
        options.watchId ?? null,
        answeredInMs,
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
    answeredInMs: number | null,
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
            answeredInMs,
          );
        }
        break;
      case "tool_execution_start":
        // Hand-offs show as their own line, not as a tool chip.
        if (HIDDEN_TOOL_CHIPS.has(event.toolName)) break;
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
        if (HIDDEN_TOOL_CHIPS.has(event.toolName)) break;
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
    const stream: Stream = {
      id: randomUUID(),
      userId,
      crew,
      text: "",
      tools: [],
      files: [],
      closed: false,
    };
    this.emit(userId, { type: "stream_start", conversationId, streamId: stream.id, crew });
    return stream;
  }

  async #closeStream(conv: ConversationRow, crewMemberId: string, stream: Stream) {
    if (stream.closed) return;
    stream.closed = true;
    this.emit(stream.userId, { type: "stream_end", conversationId: conv.id, streamId: stream.id });
    const content = stream.text.trim();
    if (!content && !stream.files.length) return;
    const meta = {
      ...(stream.tools.length ? { tools: stream.tools } : {}),
      ...(stream.files.length ? { attachments: stream.files } : {}),
    };
    const message = await this.#store(conv, {
      role: "assistant",
      content,
      crewMemberId,
      authorName: stream.crew.name,
      crewSlug: stream.crew.slug,
      meta: Object.keys(meta).length ? meta : null,
    });
    await this.deps.files.attach(
      stream.files.map((f) => f.id),
      message.id,
    );
    this.emit(stream.userId, { type: "message", conversationId: conv.id, message });
  }

  async #session(
    user: UserRow,
    conv: ConversationRow,
    run: Run,
    folder: CrewFolder,
    context: TurnContext,
    mode?: SessionMode,
  ): Promise<CrewSession> {
    const consultFor = mode && "consultFor" in mode ? mode.consultFor : undefined;
    const helperId = mode && "helper" in mode ? mode.helper : undefined;
    const key = sessionKey(folder.slug, mode);
    run.hosts.set(key, context);
    const existing = run.sessions.get(key);
    if (existing) return existing;
    const acting: ActingUser = { id: user.id, displayName: user.displayName, role: user.role };
    const memory = new MemoryStore(folder.dir);
    const isCaptain = folder.manifest.captain && conv.kind === "bridge" && !mode;
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
      listModels: () => current().captain.listModels(),
      recruit: (s) => current().captain.recruit(s),
      edit: (slug, s) => current().captain.edit(slug, s),
      retire: (slug) => current().captain.retire(slug),
      approve: (slug) => current().captain.approve(slug),
      delegate: (slug, task, signal) => current().captain.delegate(slug, task, signal),
      createWatch: (spec) => current().captain.createWatch(spec),
      installMcp: (id, crews) => current().captain.installMcp(id, crews),
      equip: (slug, grant) => current().captain.equip(slug, grant),
      crewSettings: (slug) => current().captain.crewSettings(slug),
      listPeople: () => current().captain.listPeople(),
      updatePerson: (person, changes) => current().captain.updatePerson(person, changes),
      updateHousehold: (changes) => current().captain.updateHousehold(changes),
    };
    const pet = (): PetHost => {
      const p = current().pet;
      if (!p) throw new Error("pets are not available");
      return p;
    };
    const petProxy: PetHost = {
      status: () => pet().status(),
      make: (spec, signal) => pet().make(spec, signal),
      show: (slug, show) => pet().show(slug, show),
    };
    const pictureProxy: PictureHost = {
      make: (description, signal) => {
        const p = current().picture;
        if (!p) throw new Error("pictures are not available");
        return p.make(description, signal);
      },
    };
    const themeProxy: ThemeHost = {
      list: () => current().theme.list(),
      save: (t, id) => current().theme.save(t, id),
      use: (id) => current().theme.use(id),
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
      customTools: helperId
        ? // A helper does its one task: no crew management, questions or helpers of its own,
          // and no Shipyard pushes or comments (the crew member it works for decides those).
          [...memoryTools(memory, acting), ...(this.#everyday?.tools(user, folder) ?? [])]
        : [
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
            ...(isCaptain ? [...captainTools(proxy, acting), ...themeTools(themeProxy)] : []),
            ...(isCaptain && this.#pets ? petTools(petProxy, acting) : []),
            ...(this.#pets && !consultFor ? pictureTools(pictureProxy) : []),
            ...(folder.manifest.captain
              ? []
              : crewTools(
                  { askCaptain: (q, signal) => current().crew.askCaptain(q, signal) },
                  captainName,
                )),
            ...(consultFor
              ? []
              : questionTools(
                  { ask: (q, signal) => current().question.ask(q, signal) },
                  user.displayName,
                )),
            ...(consultFor || !folder.manifest.helpers
              ? []
              : helperTools({ run: (task, signal) => current().helper.run(task, signal) })),
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
        ...(helperId
          ? [
              `## Helping\n\nYou are a helper agent that ${folder.manifest.name} started for one task. Nobody else sees your work: do the task, then reply with what was asked for. You cannot ask anyone questions or start helpers yourself; if something blocks you, say so in your reply.`,
            ]
          : []),
        ...(workspace ? [workspace.prompt] : []),
      ],
      ...(mode ? { inMemory: true } : {}),
      ...(!mode && conv.sessionFiles[folder.slug]
        ? { sessionFile: conv.sessionFiles[folder.slug] }
        : {}),
    });
    run.sessions.set(key, created);
    return created;
  }

  /**
   * One helper agent: a fresh, in-memory copy of the crew member that runs `task` and returns
   * its final reply. Its spend is the crew member's; its text stays out of the conversation (the
   * crew member reports what matters). Stopping the turn stops it, as it sits in the run.
   */
  async #runHelper(
    user: UserRow,
    conv: ConversationRow,
    run: Run,
    folder: CrewFolder,
    crewMemberId: string,
    context: TurnContext,
    task: string,
    signal: AbortSignal | undefined,
    usage: { watchId: string | null },
  ): Promise<string> {
    const mode: SessionMode = { helper: randomUUID() };
    const key = sessionKey(folder.slug, mode);
    const session = await this.#session(user, conv, run, folder, context, mode);
    let final = "";
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      this.#recordUsage(
        run,
        { userId: user.id, crewMemberId, conversationId: conv.id, routineId: usage.watchId },
        session.session.model ?? session.model,
        event.message.usage,
        null,
      );
      const t = textOf(event.message);
      if (t) final = t;
    });
    const stop = () => void session.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      if (signal?.aborted) throw new Error("stopped");
      await session.prompt(task);
      const failure = lastError(session);
      if (failure && !run.aborted) throw new Error(failure);
      return final;
    } finally {
      signal?.removeEventListener("abort", stop);
      unsubscribe();
      run.sessions.delete(key);
      run.hosts.delete(key);
      session.dispose();
    }
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
    // A saved model its provider no longer offers falls back to that provider's newest one,
    // before the instance default, so a crew member keeps the provider it was given.
    const sameProvider = (ref: string) => {
      const provider = splitModelRef(ref)?.provider;
      return provider ? available.find((m) => m.provider === provider) : undefined;
    };
    const { defaultModel } = await this.deps.settings.get();
    const model =
      find(folder.manifest.model) ??
      sameProvider(folder.manifest.model) ??
      find(defaultModel) ??
      sameProvider(defaultModel) ??
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
    parts.push(...(await this.#crewContext(user, folder, isCaptain, true)).flatMap((p) => ["", p]));
    parts.push(...(await this.#themeContext(user)).flatMap((p) => ["", p]));
    if (skippedMcp.length) {
      parts.push("", `MCP servers not started (missing setup): ${skippedMcp.join(", ")}.`);
    }
    return parts.join("\n");
  }

  /** The words and voice of the person's custom theme, when they use one. */
  async #themeContext(user: UserRow): Promise<string[]> {
    const prompt = await this.deps.themes.promptFor(user).catch(() => "");
    return prompt ? [prompt] : [];
  }

  /** The Captain's crew roster, or a crew member's note on asking the Captain. */
  async #crewContext(
    user: UserRow,
    folder: CrewFolder,
    isCaptain: boolean,
    hasTools: boolean,
  ): Promise<string[]> {
    if (isCaptain) {
      const crew = await this.#pricedRoster(user);
      const own = crew.find((c) => c.captain);
      const roster = crew
        .filter((c) => !c.captain)
        .map(
          (c) =>
            `- ${c.slug}: ${c.name}, ${c.role} (model ${c.model}, ${c.price}${c.status === "pending_review" ? ", awaiting review" : ""})`,
        );
      const out = [
        `## Crew aboard\n\n${roster.join("\n") || "(only you so far)"}${own ? `\n\nYou run on ${own.model}, ${own.price}.` : ""}`,
      ];
      out.push(
        hasTools
          ? [
              "## Coordinating",
              "",
              `You coordinate this crew; the crew does the work. Your tokens are the most expensive aboard, and whatever you read or run stays in your context for every later message, so keep your own work small. When ${user.displayName}'s message needs tools, research, files, a plan, a draft, code or more than a short answer, and a crew member's role fits, hand it over with \`delegate\`: crew slug plus the task with all the context they need, since they cannot see this conversation. When two fit, pick the one on the cheaper model. Answer yourself only when it is quick (no tools, a few lines) or nobody fits.`,
              "",
              "Then supervise: check their reply against what was asked. If it misses, delegate to them again with specific notes (they remember their earlier work in this conversation) instead of redoing it. The person sees their reply, so add only what is needed next. Your standing orders say more.",
            ].join("\n")
          : "## Coordinating\n\nShipmate's crew tools are not reachable from this session, so you cannot hand work to the crew right now; answer yourself and say who would normally take it.",
      );
      return out;
    }
    if (folder.manifest.captain || !hasTools) return [];
    const captain = this.deps.crew.captain().manifest.name;
    return [
      `${captain} coordinates the crew. When you are unsure what ${user.displayName} wants, what to do next, or whether something is your job, ask ${captain} with \`ask_captain\` instead of guessing.`,
    ];
  }

  /** Shipmate's tools for a turn on the Claude Code CLI, served to it over MCP (cli-mcp.ts). */
  #cliTools(
    user: UserRow,
    folder: CrewFolder,
    hosts: {
      captain: CaptainHost;
      crew: CrewHost;
      question: QuestionHost;
      theme: ThemeHost;
      pet?: PetHost | undefined;
      picture?: PictureHost | undefined;
    },
    isCaptain: boolean,
  ): ToolDefinition[] {
    const acting: ActingUser = { id: user.id, displayName: user.displayName, role: user.role };
    const skills = this.deps.skills;
    return [
      ...memoryTools(new MemoryStore(folder.dir), acting),
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
      ...(isCaptain ? [...captainTools(hosts.captain, acting), ...themeTools(hosts.theme)] : []),
      ...(isCaptain && hosts.pet ? petTools(hosts.pet, acting) : []),
      ...(hosts.picture ? pictureTools(hosts.picture) : []),
      ...(folder.manifest.captain
        ? []
        : crewTools(hosts.crew, this.deps.crew.captain().manifest.name)),
      ...questionTools(hosts.question, user.displayName),
      ...(this.#everyday?.tools(user, folder) ?? []),
    ];
  }

  /** A plain card line for a request to change a crew member's access (access-summary.ts). */
  async #accessSummary(who: string, toolName: string, input: Record<string, unknown>) {
    const servers = new Map((await this.deps.mcp.list()).map((s) => [s.id, s.name]));
    return accessSummary(who, toolName, input, {
      crew: (slug) => {
        try {
          return this.deps.crew.folder(slug).manifest.name;
        } catch {
          return slug;
        }
      },
      server: (id) => servers.get(id) ?? id,
    });
  }

  /** equip_crew_member, after the person approved it: add servers, tools and skills. */
  async #equip(user: UserRow, target: string, grant: EquipSpec): Promise<string> {
    if (!(await this.#roster(user)).some((c) => c.slug === target)) {
      throw new Error(`no crew member "${target}"; check list_crew`);
    }
    const name = this.deps.crew.folder(target).manifest.name;
    const given: string[] = [];
    const notes: string[] = [];
    const servers = await this.deps.mcp.list();
    for (const id of new Set(grant.mcp ?? [])) {
      const known = servers.find((s) => s.id === id);
      const server = known?.installed ? known : await this.deps.mcp.install(id);
      await this.deps.mcp.assign(id, [...new Set([...server.crews, target])]);
      given.push(server.name);
      const missing = server.secrets.filter((x) => x.required && !x.set).map((x) => x.label);
      if (missing.length) {
        notes.push(
          `${server.name} needs ${missing.join(", ")} entered by an owner on the MCP servers page before it starts.`,
        );
      }
    }
    // Read after assign(), which rewrote the mcp list.
    const now = this.deps.crew.folder(target).manifest;
    const union = (have: string[], add: string[] | undefined) => [
      ...new Set([...have, ...(add ?? [])]),
    ];
    const changes: Partial<CrewManifest> = {};
    if (grant.tools?.length) {
      // An empty list already means every built-in tool.
      if (now.tools.length) changes.tools = union(now.tools, grant.tools);
      given.push(...grant.tools);
    }
    if (grant.skills?.length) {
      changes.skills = union(now.skills, grant.skills);
      given.push(...grant.skills.map((s) => `${s} skill`));
    }
    if (grant.claudeCodeTools?.length) {
      changes.cli = ClaudeCliSettings.parse({
        ...now.cli,
        allowedTools: union(now.cli?.allowedTools ?? [], grant.claudeCodeTools),
      });
      given.push(...grant.claudeCodeTools.map((t) => `Claude Code ${t}`));
    }
    if (Object.keys(changes).length) await this.deps.crew.patch(target, changes);
    return [
      `${name} now has ${given.join(", ")}. It applies from their next conversation.`,
      ...notes,
    ].join(" ");
  }

  /** The roster with each model resolved to what it runs on (see #effectiveModel) and priced. */
  async #pricedRoster(user: UserRow): Promise<Array<CrewSummary & { price: string }>> {
    const [crew, available, settings] = await Promise.all([
      this.#roster(user),
      this.deps.providers.available(),
      this.deps.settings.get(),
    ]);
    return crew.map((c) => {
      const ref = this.#effectiveModel(c.slug, settings.defaultModel);
      return {
        ...c,
        model: c.model === DEFAULT_MODEL ? `${ref} (crew default)` : ref,
        price: modelPrice(ref, available),
      };
    });
  }

  /**
   * The model a crew member's turns actually use: the crew default for `default`, and for crew on
   * the Claude Code or Codex CLI the model it passes as --model (`claude-code/<model>`,
   * `codex/<model>`).
   */
  #effectiveModel(slug: string, defaultModel: string): string {
    let folder: CrewFolder;
    try {
      folder = onCrewDefault(this.deps.crew.folder(slug), defaultModel);
    } catch {
      return defaultModel;
    }
    const m = folder.manifest;
    if (m.backend === "claude-code-cli") {
      const id = m.cli?.model ?? cliModelFromRef(m.model);
      return id ? `claude-code/${id}` : "claude-code/default";
    }
    if (m.backend === "codex-cli") {
      return m.model.startsWith(`${CODEX_PROVIDER}/`) ? m.model : `${CODEX_PROVIDER}/default`;
    }
    return m.model === DEFAULT_MODEL ? defaultModel : m.model;
  }

  /** list_models: what crew can run on, cheapest first. */
  async #listModels(user: UserRow): Promise<string> {
    const [available, settings, crew] = await Promise.all([
      this.deps.providers.available(),
      this.deps.settings.get(),
      this.#roster(user),
    ]);
    // The Claude subscription is not a pi provider; list its models once something uses it.
    const refs = [
      settings.defaultModel,
      ...crew.map((c) => this.#effectiveModel(c.slug, settings.defaultModel)),
    ];
    return modelList(
      available,
      refs.some((r) => r.startsWith("claude-code/")),
      refs.some((r) => r.startsWith(`${CODEX_PROVIDER}/`)) ? codexModels() : [],
    );
  }

  /**
   * What the Captain's crew list in its system prompt depends on: the crew, the crew default and
   * the models set up. A cached session made under another key has a stale list.
   */
  async #promptKey(): Promise<string> {
    const [available, settings] = await Promise.all([
      this.deps.providers.available(),
      this.deps.settings.get(),
    ]);
    const models = available.map((m) => `${m.provider}/${m.id}:${m.cost.input}/${m.cost.output}`);
    return [this.#crewVersion, settings.defaultModel, ...models].join("|");
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
    const d = await this.deps.crew.create({
      slug: spec.slug,
      manifest: {
        name: spec.name,
        role: spec.role,
        model: spec.model ?? DEFAULT_MODEL,
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
    this.#codex.abort(conversationId);
    clearTimeout(run.idleTimer);
    this.#live.delete(conversationId);
    for (const s of run.sessions.values()) s.dispose();
    this.#runs.delete(conversationId);
  }
}

type LiveStream = Omit<Extract<LiveItemDto, { kind: "stream" }>, "tools"> & {
  /** By tool call id. */
  tools: Map<string, LiveToolDto>;
};

/** A turn in progress, as `Bridge.live` reports it. Hand-off lines stay until the turn ends. */
interface LiveTurn {
  items: (LiveStream | Extract<LiveItemDto, { kind: "handoff" }>)[];
}

interface Stream {
  id: string;
  userId: string;
  crew: { slug: string; name: string };
  text: string;
  tools: string[];
  /** Pictures shown on the reply (Codex's image tool). */
  files: AttachmentDto[];
  closed: boolean;
}

/** How a `make_picture` call shows in usage: `images/<model>`, priced per picture. */
function pictureModel(id: string): Model<Api> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "images",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as unknown as Model<Api>;
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

/** Where a run keeps a crew member's pi session for `mode` (see SessionMode). */
function sessionKey(slug: string, mode: SessionMode | undefined): string {
  if (!mode) return slug;
  // A consult is the Captain's second session in the run, so it never collides with the main
  // one, which may be waiting on the delegate that asked.
  return "consultFor" in mode ? `${slug}#consult` : `${slug}#helper:${mode.helper}`;
}

function lastError(session: CrewSession): string | undefined {
  const last = [...session.session.messages].reverse().find((m) => m.role === "assistant");
  if (last && last.role === "assistant" && last.stopReason === "error") {
    return last.errorMessage || "the model returned an error";
  }
  return undefined;
}

function toConversationDto(
  c: ConversationRow,
  slug: string | null,
  preview: string | null = null,
): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    kind: c.kind === "direct" ? "direct" : "bridge",
    crewSlug: slug,
    surface: c.surface,
    projectId: c.projectId,
    pinned: c.pinnedAt !== null,
    preview,
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
