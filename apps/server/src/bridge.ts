import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  BashOperations,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AttachmentDto,
  type ChatContextDto,
  type ChatPeopleDto,
  ClaudeCliSettings,
  CODEX_PROVIDER,
  type ConversationDto,
  type ConversationSearchResultDto,
  type CrewManifest,
  CURSOR_PROVIDER,
  DEFAULT_MODEL,
  GEMINI_PROVIDER,
  type LiveItemDto,
  type LiveToolDto,
  type McpServerDto,
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
import {
  conversationMembers,
  conversations,
  crewMembers,
  type Db,
  messages,
  users,
  watches,
  watchRuns,
} from "@shipmate/db";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { accessSummary } from "./access-summary.js";
import { HttpError, type UserRow } from "./auth.js";
import { chatTitle } from "./chat/title.js";
import { chatOpenTo } from "./chat-access.js";
import { ClaudeCliTurns, cliModelFromRef, onCrewDefault } from "./claude-cli-turn.js";
import { CliToolServer } from "./cli-mcp.js";
import { CodexCliTurns, codexModels } from "./codex-cli-turn.js";
import { CursorCliTurns, type CursorTurnInput, cursorModels } from "./cursor-cli-turn.js";
import type { EverydayTools } from "./everyday.js";
import type { AttachmentService } from "./files/service.js";
import { toDto as toAttachmentDto } from "./files/service.js";
import { GeminiCliTurns, geminiModels } from "./gemini-cli-turn.js";
import { contextFullError, ModelError, serviceName, toModelError } from "./model-errors.js";
import { modelList, modelPrice } from "./model-price.js";
import { petHost } from "./pets/host.js";
import type { PetService } from "./pets/service.js";
import type { ApprovalService } from "./services/approvals.js";
import type { AuditService } from "./services/audit.js";
import { ChatImportService, IMPORT_SOURCES } from "./services/chat-import.js";
import type { CrewService } from "./services/crew.js";
import type { McpService } from "./services/mcp.js";
import type { MeterService } from "./services/meters.js";
import type { ProviderService } from "./services/providers.js";
import type { SettingsService } from "./services/settings.js";
import type { SkillService } from "./services/skills.js";
import type { TaskService } from "./services/tasks.js";
import { ThemeProblems, type ThemeService } from "./services/themes.js";
import type { UsageService } from "./services/usage.js";
import type { WatchService } from "./services/watches.js";
import { summarize } from "./summarize.js";

type ConversationRow = typeof conversations.$inferSelect;
type Send = (event: ServerEvent) => void;

const IDLE_MS = 30 * 60_000;
/** A private chat left alone this long is deleted. */
export const PRIVATE_IDLE_MS = 60 * 60_000;

/** In a private chat's system prompt, on every engine. */
/** Most people that can be added to one group chat. */
const MAX_GROUP_PEOPLE = 20;
/** Events everyone in a group chat receives, not only the person who wrote the message. */
const GROUP_EVENTS = new Set<ServerEvent["type"]>([
  "message",
  "stream_start",
  "delta",
  "tool",
  "stream_end",
  "handoff",
  "status",
]);

const PRIVATE_CHAT_NOTE =
  "## Private chat\n\nThis is a private chat. It is deleted when it ends, and nothing from it may outlive it: do not save anything said here to memory, lists, notes, documents, skills or files, do not set reminders or routines from it, and do not pass it to other crew members, unless the person asks for exactly that in this chat. You cannot use `remember` or `forget` here.";

/** Memory tools that write; a private chat does not get them. */
const MEMORY_WRITES = new Set(["remember", "forget"]);
const forChat = <T extends { name: string }>(conv: { privateChat: boolean }, tools: T[]): T[] =>
  conv.privateChat ? tools.filter((t) => !MEMORY_WRITES.has(t.name)) : tools;

/**
 * Remove the session files pi kept for a deleted chat. Values that are not files (the session
 * ids of the CLI engines, which keep their own records) are left alone.
 */
async function removeSessionRecords(files: Iterable<string>): Promise<void> {
  for (const file of files) {
    if (!isAbsolute(file) || !file.endsWith(".jsonl")) continue;
    await rm(file, { force: true }).catch(() => {});
  }
}
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
  /** The Gemini API key an owner saved for the Gemini CLI engine (see GeminiKeyService). */
  geminiKey?: () => Promise<string | null>;
  /** Context and plan-limit meters (see MeterService). */
  meters?: MeterService;
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

/** Surfaces where a result can still reach the person after the turn that asked for it ends. */
const BACKGROUND_SURFACES = new Set(["web", "discord", "telegram", "slack"]);

/**
 * Tasks the Captain may start on its own, from task results, before the person writes again:
 * a model that answers every result with more hand-offs stops here.
 */
export const MAX_UNPROMPTED_TASKS = 8;

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
  onWaiting?: (waiting: boolean) => void | Promise<void>;
  /**
   * Set for a background task's turn: its chat shows as busy and keeps a note if it fails, like
   * a person's own message, and its questions and approvals also show in the chat it came from.
   */
  task?: { parentConversationId: string };
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
  /** The Captain is answering news from Shipmate (a finished task), not a person's message. */
  nudge?: boolean;
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
  /** Tasks the Captain started from task results since the person last wrote. */
  unprompted?: number;
  /** When the person last wrote here. */
  wroteAt?: Date;
  /** Whose message the sessions were opened for (see `send`). */
  actingUserId?: string | undefined;
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
  /** Group chats: conversation id → the people in it, the starter included. */
  #groups = new Map<string, Set<string>>();
  /** Chats that stopped being a group since start: conversation id → the starter. */
  #ungrouped = new Map<string, string>();
  #runs = new Map<string, Run>();
  /** Per conversation, the turn in progress as a page that opens now should show it. */
  #live = new Map<string, LiveTurn>();
  #watches: WatchService | undefined;
  #workspaces: WorkspaceProvider | undefined;
  #everyday: EverydayTools | undefined;
  #pets: PetService | undefined;
  #tasks: TaskService | undefined;
  /** Per chat, news for its Captain that waits until the chat is free (see nudge). */
  #nudges = new Map<string, string[]>();
  /** Turns of `backend: claude-code-cli` crew members (the official `claude` binary). */
  #cli: ClaudeCliTurns;
  /** Turns of `backend: codex-cli` crew members (the official `codex` binary). */
  #codex: CodexCliTurns;
  /** Turns of `backend: cursor-cli` crew members (the official `cursor-agent` binary). */
  #cursor: CursorCliTurns;
  /** Turns of `backend: gemini-cli` crew members (the official `gemini` binary). */
  #gemini: GeminiCliTurns;
  /** Shipmate's tools for those turns, served over loopback MCP. */
  readonly cliTools = new CliToolServer();
  /** Bumped on every crew change, so idle sessions pick up the new crew list (see send). */
  #crewVersion = 0;

  readonly #imports: ChatImportService;

  constructor(private readonly deps: BridgeDeps) {
    this.#imports = new ChatImportService(deps.db);
    this.#cli = new ClaudeCliTurns(deps.db);
    this.#codex = new CodexCliTurns(deps.db);
    this.#cursor = new CursorCliTurns(deps.db);
    this.#gemini = new GeminiCliTurns(deps.db, deps.geminiKey);
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

  /** Background tasks run their turns through the Bridge, so they are attached after it. */
  attachTasks(tasks: TaskService) {
    this.#tasks = tasks;
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
    for (const id of this.#audience(userId, event)) {
      for (const send of this.#sockets.get(id) ?? []) send(event);
      for (const tap of this.#taps) tap(id, event);
    }
  }

  /**
   * Who an event goes to: the person named, plus, for what happens in a group chat (messages,
   * replies as they are written, busy state), everyone else in that chat. Approvals and
   * questions stay with the person whose message the agent is working on.
   */
  #audience(userId: string, event: ServerEvent): Iterable<string> {
    if (!GROUP_EVENTS.has(event.type) || !("conversationId" in event)) return [userId];
    const group = event.conversationId ? this.#groups.get(event.conversationId) : undefined;
    // Only the people in it now: someone removed while their message is being answered stops
    // getting the reply.
    if (group) return group;
    // A chat that stopped being a group mid-reply goes on to its starter alone.
    const starter = event.conversationId ? this.#ungrouped.get(event.conversationId) : undefined;
    return [starter ?? userId];
  }

  #dto(
    c: ConversationRow,
    slug: string | null,
    preview: string | null = null,
    viewerId: string = c.userId,
  ): ConversationDto {
    return toConversationDto(c, slug, preview, {
      group: this.#groups.has(c.id),
      mine: viewerId === c.userId,
    });
  }

  // ---------- group chats ----------

  /** Read who is in which group chat. Called once at startup. */
  async loadGroups(): Promise<void> {
    const rows = await this.deps.db
      .select({
        c: conversationMembers.conversationId,
        u: conversationMembers.userId,
        owner: conversations.userId,
      })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId));
    this.#groups.clear();
    for (const r of rows) this.#group(r.c, r.owner).add(r.u);
  }

  /** The member set of a group chat, made on first use. It always carries the starter too. */
  #group(conversationId: string, ownerId: string): Set<string> {
    let set = this.#groups.get(conversationId);
    if (!set) {
      set = new Set([ownerId]);
      this.#groups.set(conversationId, set);
    }
    return set;
  }

  /** A conversation the person may read and write in: their own, or a group chat they are in. */
  async openConversation(user: UserRow, id: string): Promise<ConversationRow> {
    const [c] = await this.deps.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), chatOpenTo(user.id)))
      .limit(1);
    if (!c) throw new HttpError(404, "conversation not found");
    return c;
  }

  async people(user: UserRow, id: string): Promise<ChatPeopleDto> {
    const conv = await this.openConversation(user, id);
    const everyone = await this.deps.db
      .select({ id: users.id, name: users.displayName })
      .from(users)
      .orderBy(asc(users.displayName));
    const inChat = this.#groups.get(id) ?? new Set([conv.userId]);
    return {
      people: everyone
        .filter((p) => inChat.has(p.id))
        .map((p) => ({ ...p, starter: p.id === conv.userId }))
        .sort((a, b) => Number(b.starter) - Number(a.starter)),
      household: conv.userId === user.id ? everyone.filter((p) => p.id !== user.id) : [],
    };
  }

  /** Set who else is in a chat (the starter only). An empty list makes it an ordinary chat again. */
  async setPeople(user: UserRow, id: string, userIds: string[]): Promise<ChatPeopleDto> {
    const conv = await this.conversation(user, id);
    if (conv.privateChat)
      throw new HttpError(400, "A private chat cannot have other people in it.");
    if (conv.surface !== "web" || conv.projectId) {
      throw new HttpError(400, "Only ordinary chats can have other people in them.");
    }
    const wanted = [...new Set(userIds)].filter((u) => u !== user.id);
    if (wanted.length > MAX_GROUP_PEOPLE) throw new HttpError(400, "That is too many people.");
    if (wanted.length) {
      const known = await this.deps.db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, wanted));
      if (known.length !== wanted.length) throw new HttpError(404, "person not found");
    }
    const before = this.#groups.get(id) ?? new Set<string>();
    await this.deps.db.transaction(async (tx) => {
      await tx.delete(conversationMembers).where(eq(conversationMembers.conversationId, id));
      if (wanted.length) {
        await tx
          .insert(conversationMembers)
          .values(wanted.map((userId) => ({ conversationId: id, userId })));
      }
    });
    if (wanted.length) {
      this.#groups.set(id, new Set([conv.userId, ...wanted]));
      this.#ungrouped.delete(id);
    } else {
      if (this.#groups.delete(id)) this.#ungrouped.set(id, conv.userId);
    }
    // Everyone affected reloads their chat list: the chat appears, changes or goes.
    for (const person of new Set([...before, ...wanted, conv.userId])) {
      this.#notify(person, { type: "chats_changed" });
    }
    return this.people(user, id);
  }

  /** Someone who was added takes themselves out. */
  async leave(user: UserRow, id: string): Promise<void> {
    const conv = await this.openConversation(user, id);
    if (conv.userId === user.id) {
      throw new HttpError(400, "You started this chat. Remove the others, or delete it.");
    }
    await this.deps.db
      .delete(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, user.id)),
      );
    const set = this.#groups.get(id);
    set?.delete(user.id);
    if (set && set.size <= 1) {
      this.#groups.delete(id);
      this.#ungrouped.set(id, conv.userId);
    }
    for (const person of new Set([user.id, conv.userId, ...(set ?? [])])) {
      this.#notify(person, { type: "chats_changed" });
    }
  }

  /** Send to one person's open pages only (no fan-out, no push). */
  #notify(userId: string, event: ServerEvent) {
    for (const send of this.#sockets.get(userId) ?? []) send(event);
  }

  /**
   * The turn in progress in a conversation, for a page that opens (or reconnects) mid-turn.
   * Turns run on the server whether or not anyone is watching; this lets the page catch up.
   */
  async live(
    user: UserRow,
    conversationId: string,
  ): Promise<Extract<ServerEvent, { type: "live" }>> {
    await this.openConversation(user, conversationId);
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
          select case when m.role = 'user' and m.user_id = ${userId} then 'You: ' else '' end
            || left(regexp_replace(m.content, '[[:space:]]+', ' ', 'g'), ${PREVIEW_CHARS})
          from ${messages} m
          where m.conversation_id = ${conversations.id} and m.role <> 'system' and m.content <> ''
          order by m.created_at desc
          limit 1
        )`,
      })
      .from(conversations)
      .leftJoin(crewMembers, eq(crewMembers.id, conversations.crewMemberId))
      .where(
        and(
          chatOpenTo(userId),
          // Web chats, chats other apps started with a key, plus each watch's latest run, so its result reads like any reply.
          sql`(${conversations.surface} in ('web', 'api') or ${conversations.id} in (
            select distinct on (r.watch_id) r.conversation_id
            from ${watchRuns} r
            where r.conversation_id is not null
            order by r.watch_id, r.started_at desc
          ))`,
        ),
      )
      // Archived chats go last; the app shows them folded away.
      .orderBy(
        sql`${conversations.archivedAt} is not null`,
        sql`${conversations.pinnedAt} desc nulls last`,
        desc(conversations.updatedAt),
      );
    return rows.map((r) => this.#dto(r.c, r.slug, r.preview, userId));
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
    const matched = and(
      eq(conversations.userId, user.id),
      eq(conversations.privateChat, false),
      sql`${vector} @@ ${tsquery}`,
    );
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
      .where(
        and(
          eq(conversations.userId, user.id),
          eq(conversations.privateChat, false),
          ilike(conversations.title, pattern),
        ),
      )
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
    const convs = new Map(convRows.map((r) => [r.c.id, this.#dto(r.c, r.slug)]));
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
    return this.#dto(c, await this.#slugOf(c.crewMemberId));
  }

  async archiveConversation(
    user: UserRow,
    id: string,
    archived: boolean,
  ): Promise<ConversationDto> {
    await this.conversation(user, id);
    const [c] = await this.deps.db
      .update(conversations)
      // An archived chat is not pinned: it would sit at the top of a list it has left.
      .set(archived ? { archivedAt: new Date(), pinnedAt: null } : { archivedAt: null })
      .where(eq(conversations.id, id))
      .returning();
    if (!c) throw new HttpError(404, "conversation not found");
    return this.#dto(c, await this.#slugOf(c.crewMemberId));
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
      /** A private chat (see PRIVATE_IDLE_MS); never a reused one. */
      private?: boolean | undefined;
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
      if (input.reuse && !input.private && (input.surface ?? "web") === "web" && !input.projectId) {
        const [existing] = await this.deps.db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.userId, user.id),
              eq(conversations.kind, "direct"),
              eq(conversations.crewMemberId, row.id),
              eq(conversations.surface, "web"),
              eq(conversations.privateChat, false),
              isNull(conversations.projectId),
            ),
          )
          .orderBy(desc(conversations.updatedAt))
          .limit(1);
        if (existing) return this.#dto(existing, slug);
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
        // Named up front, so the list never shows a name made from what was said in it.
        title: input.private ? "Private chat" : (input.title ?? null),
        privateChat: input.private === true,
      })
      .returning();
    if (!c) throw new Error("insert failed");
    return this.#dto(c, slug);
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
    return this.#dto(c, await this.#slugOf(c.crewMemberId));
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
    const records = this.#sessionRecords(conv);
    this.#dispose(id);
    this.deps.meters?.reset(id);
    conv.sessionFiles = {};
    await this.deps.db
      .update(conversations)
      .set({ sessionFiles: {} })
      .where(eq(conversations.id, id));
    // A private chat keeps nothing behind, so what was said before the fresh start goes now.
    if (conv.privateChat) await removeSessionRecords(records);
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
    const conv = await this.conversation(user, id);
    await this.#remove(conv);
  }

  /** Delete a chat with everything kept for it: messages, its files and the agents' records. */
  async #remove(conv: ConversationRow): Promise<void> {
    // The tasks handed over here stop, and their chats go with this one.
    const taskChats = (await this.#tasks?.release(conv.id).catch(() => [])) ?? [];
    for (const id of taskChats) {
      const [child] = await this.deps.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, id));
      if (child) await this.#remove(child);
    }
    this.#nudges.delete(conv.id);
    // Stop a reply that is still being written, so nothing is added once the records are gone.
    const run = this.#runs.get(conv.id);
    if (run?.busy) {
      run.aborted = true;
      this.deps.approvals.cancelConversation(conv.id);
      await Promise.all([...run.sessions.values()].map((s) => s.abort().catch(() => {})));
    }
    const records = this.#sessionRecords(conv);
    this.#dispose(conv.id);
    const group = this.#groups.get(conv.id);
    this.#groups.delete(conv.id);
    this.#ungrouped.delete(conv.id);
    for (const person of group ?? []) {
      if (person !== conv.userId) this.#notify(person, { type: "chats_changed" });
    }
    const files = await this.deps.files.idsIn(conv.id);
    await this.deps.db.delete(conversations).where(eq(conversations.id, conv.id));
    await this.deps.files.removeFiles(files);
    await removeSessionRecords(records);
  }

  /**
   * The session files that belong to this chat alone: the saved ones plus those of agents that
   * are open right now (a first reply's file is only saved when its turn ends). A routine's run
   * has none of its own, because a routine that continues shares one file across its runs.
   */
  #sessionRecords(conv: ConversationRow): Set<string> {
    if (conv.surface === "watch") return new Set();
    const records = new Set(Object.values(conv.sessionFiles));
    for (const s of this.#runs.get(conv.id)?.sessions.values() ?? []) {
      if (s.sessionFile) records.add(s.sessionFile);
    }
    return records;
  }

  /**
   * Delete private chats nobody has used for PRIVATE_IDLE_MS. Runs at start and on a timer, so
   * one that was left open in a closed tab, or cut off by a restart, does not stay.
   */
  async sweepPrivateChats(now = new Date()): Promise<number> {
    const stale = await this.deps.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.privateChat, true),
          // A private chat's tasks go when it does, not one by one while it is still in use.
          ne(conversations.surface, "task"),
          lt(conversations.updatedAt, new Date(now.getTime() - PRIVATE_IDLE_MS)),
        ),
      );
    let removed = 0;
    for (const conv of stale) {
      if (this.#runs.get(conv.id)?.busy) continue;
      await this.#remove(conv);
      removed++;
    }
    return removed;
  }

  /**
   * One page of a conversation, oldest first: the newest `limit` messages, or the `limit` just
   * before the message `before`. `more` says whether older ones remain.
   */
  async messagePage(
    user: UserRow,
    id: string,
    options: { limit: number; before?: string | undefined },
  ): Promise<{ messages: MessageDto[]; more: boolean }> {
    await this.openConversation(user, id);
    let cut: Date | undefined;
    if (options.before) {
      const [edge] = await this.deps.db
        .select({ at: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, id), eq(messages.id, options.before)));
      if (!edge) throw new HttpError(404, "message not found");
      cut = edge.at;
    }
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
      .where(and(eq(messages.conversationId, id), cut ? lt(messages.createdAt, cut) : undefined))
      .orderBy(desc(messages.createdAt))
      .limit(options.limit + 1);
    const more = rows.length > options.limit;
    return {
      more,
      messages: rows
        .slice(0, options.limit)
        .reverse()
        .map((r) =>
          toMessageDto(r.m, {
            userName: r.userName,
            crewSlug: r.crewSlug,
            crewName: r.crewName,
          }),
        ),
    };
  }

  async messages(user: UserRow, id: string): Promise<MessageDto[]> {
    await this.openConversation(user, id);
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
    const conv = await this.openConversation(user, conversationId);
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
    run.unprompted = 0;
    run.wroteAt = new Date();
    clearTimeout(run.idleTimer);
    await this.#freshen(run);
    this.emit(user.id, { type: "status", conversationId, busy: true });
    try {
      // Before the message is saved, so a restart can never leave it without a reply or a note.
      await this.#markTurn(conversationId, true);
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
        await this.deps.db
          .update(conversations)
          .set({
            title: chatTitle(
              content,
              files.map((f) => f.name),
            ),
          })
          .where(eq(conversations.id, conv.id));
      }
      // Writing in an archived chat brings it back to the list.
      if (conv.archivedAt) {
        await this.deps.db
          .update(conversations)
          .set({ archivedAt: null })
          .where(eq(conversations.id, conv.id));
      }

      if (!slug) throw new HttpError(410, "this crew member is no longer aboard");
      await this.#assertActive(slug, user);
      const prepared = await this.deps.files.prepare(files);
      const said =
        [content, prepared.text].filter(Boolean).join("\n\n") ||
        `(${user.displayName} sent ${prepared.imageNames.length === 1 ? "a photo" : "photos"} without a message.)`;
      // The Captain is told which of its tasks are still open, so it can answer about them.
      const open =
        slug === CAPTAIN_SLUG && conv.kind === "bridge"
          ? await this.#tasks?.statusNote(conv.id, user.displayName).catch(() => "")
          : "";
      const prompt = open ? `${said}\n\n${open}` : said;
      await this.#turn(user, conv, run, slug, (await this.#groupNote(conv, user)) + prompt, {
        ...(prepared.images.length
          ? { images: prepared.images, imageNames: prepared.imageNames }
          : {}),
      });
    } catch (err) {
      if (!run.aborted) await this.#failed(user, conv, slug, err);
    } finally {
      await this.#markTurn(conversationId, false);
      run.busy = false;
      this.emit(user.id, { type: "status", conversationId, busy: false });
      run.idleTimer = setTimeout(() => this.#dispose(conversationId), IDLE_MS);
      run.idleTimer.unref?.();
      // Task results that came in meanwhile go to the Captain now.
      void this.#drainNudges(conversationId);
    }
  }

  /**
   * Reopen a run's sessions when the crew, the crew default or the models (or their context
   * sizes) changed since they started, so the Captain's crew list (in its system prompt) is
   * current.
   */
  async #freshen(run: Run) {
    const promptKey = await this.#promptKey().catch(() => run.promptKey);
    if (run.promptKey === promptKey) return;
    for (const s of run.sessions.values()) s.dispose();
    run.sessions.clear();
    run.promptKey = promptKey;
  }

  /**
   * Add a message to a chat from outside a turn (a task's card, its brief or its result) and
   * show it on the person's open pages. Returns null when the chat is gone.
   */
  async post(
    conversationId: string,
    m: {
      role: "assistant" | "system";
      content: string;
      /** The crew member who wrote it (role "assistant"). */
      crewSlug?: string;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<MessageDto | null> {
    const [conv] = await this.deps.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conv) return null;
    const crewRow = m.crewSlug ? await this.deps.crew.row(m.crewSlug) : undefined;
    const message = await this.#store(conv, {
      role: m.role,
      content: m.content,
      authorName: crewRow ? (this.#crewName(crewRow.slug) ?? crewRow.name) : "Shipmate",
      ...(crewRow ? { crewMemberId: crewRow.id, crewSlug: crewRow.slug } : {}),
      meta: m.meta ?? null,
    });
    this.emit(conv.userId, { type: "message", conversationId, message });
    return message;
  }

  /**
   * Resolves once the reply being written in a chat is done, or after `ms`. A task's result
   * waits for this, so it lands below the Captain's "they are on it" and not above it.
   */
  async whenFree(conversationId: string, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.#runs.get(conversationId)?.busy && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * News for a chat's Captain that nobody asked for (a task ended): the Captain answers it in
   * that chat as soon as the chat is free, as if it were a message. Notes that pile up while
   * the chat is busy are answered together.
   */
  nudge(conversationId: string, note: string): void {
    this.#nudges.set(conversationId, [...(this.#nudges.get(conversationId) ?? []), note]);
    void this.#drainNudges(conversationId);
  }

  async #drainNudges(conversationId: string): Promise<void> {
    if (!this.#nudges.get(conversationId)?.length) return;
    const run = this.#run(conversationId);
    // The turn in progress picks them up when it ends (see send).
    if (run.busy) return;
    run.busy = true;
    const notes = this.#nudges.get(conversationId) ?? [];
    this.#nudges.delete(conversationId);
    let conv: ConversationRow | undefined;
    let user: UserRow | undefined;
    try {
      [conv] = await this.deps.db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      if (conv) [user] = await this.deps.db.select().from(users).where(eq(users.id, conv.userId));
      // Only the Captain's chats are told; a spending cap ends the reporting quietly, since
      // the result itself is already in the chat.
      if (conv?.kind === "bridge" && user) {
        await this.#checkCap(user, CAPTAIN_SLUG);
        await this.#assertActive(CAPTAIN_SLUG, user);
      } else {
        conv = undefined;
      }
    } catch {
      conv = undefined;
    }
    if (!conv || !user) {
      run.busy = false;
      if (!conv) this.#dispose(conversationId);
      return;
    }
    run.aborted = false;
    clearTimeout(run.idleTimer);
    this.emit(user.id, { type: "status", conversationId, busy: true });
    try {
      await this.#freshen(run);
      await this.#markTurn(conversationId, true);
      await this.#turn(user, conv, run, CAPTAIN_SLUG, notes.join("\n\n"), { nudge: true });
    } catch (err) {
      if (!run.aborted) await this.#failed(user, conv, CAPTAIN_SLUG, err);
    } finally {
      await this.#markTurn(conversationId, false);
      run.busy = false;
      this.emit(user.id, { type: "status", conversationId, busy: false });
      run.idleTimer = setTimeout(() => this.#dispose(conversationId), IDLE_MS);
      run.idleTimer.unref?.();
      void this.#drainNudges(conversationId);
    }
  }

  /** In a group chat, a line ahead of each message saying who is in the chat and who wrote it. */
  async #groupNote(conv: ConversationRow, writer: UserRow): Promise<string> {
    const group = this.#groups.get(conv.id);
    if (!group) return "";
    const rows = await this.deps.db
      .select({ name: users.displayName })
      .from(users)
      .where(inArray(users.id, [...group]))
      .orderBy(asc(users.displayName));
    const names = rows.map((r) => r.name).join(", ");
    return `[Group chat between ${names}. Everyone in it reads your reply. This message is from ${writer.displayName}.]\n\n`;
  }

  /**
   * A turn that failed. The reason is saved in the chat (and pushed when no page is open), so a
   * person who left mid-reply finds out why there is no answer when they come back.
   */
  async #failed(user: UserRow, conv: ConversationRow, slug: string | null, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = err instanceof ModelError ? err.detail : undefined;
    const name = slug ? this.#crewName(slug) : null;
    // Pages that are open show it at once; the saved note below replaces it there.
    this.emit(user.id, {
      type: "error",
      conversationId: conv.id,
      message,
      ...(detail ? { detail } : {}),
    });
    try {
      const note = await this.#store(conv, {
        role: "system",
        content: `${name ?? "The crew"} stopped before finishing: ${message}`,
        authorName: "Shipmate",
        meta: { turnError: true, ...(detail ? { detail } : {}) },
      });
      this.emit(user.id, { type: "message", conversationId: conv.id, message: note });
    } catch {
      // Not saved: open pages still show the error above.
    }
  }

  #crewName(slug: string): string | null {
    try {
      return this.deps.crew.folder(slug).manifest.name;
    } catch {
      return null;
    }
  }

  /** Remember that a turn is running here, so a restart mid-reply is noticed (see recover). */
  async #markTurn(conversationId: string, running: boolean) {
    await this.deps.db
      .update(conversations)
      .set({ turnStartedAt: running ? new Date() : null })
      .where(eq(conversations.id, conversationId))
      .catch(() => {});
  }

  /**
   * At startup: chats where the crew were still answering when the server stopped get a note,
   * since that reply is gone and nobody is working on it any more.
   */
  async recover(): Promise<number> {
    const stuck = await this.deps.db
      .select()
      .from(conversations)
      .where(isNotNull(conversations.turnStartedAt));
    for (const conv of stuck) {
      const slug = conv.kind === "direct" ? await this.#slugOf(conv.crewMemberId) : CAPTAIN_SLUG;
      const name = (slug && this.#crewName(slug)) ?? "The crew";
      const note = await this.#store(conv, {
        role: "system",
        content: `Shipmate restarted while ${name} was working, so that reply was lost. Send your message again to carry on.`,
        authorName: "Shipmate",
        meta: { turnError: true, restarted: true },
      });
      // Cleared only once its note is saved, so a failure here is retried on the next start.
      await this.#markTurn(conv.id, false);
      this.emit(conv.userId, { type: "message", conversationId: conv.id, message: note });
    }
    return stuck.length;
  }

  async abort(user: UserRow, conversationId: string): Promise<void> {
    await this.openConversation(user, conversationId);
    const run = this.#runs.get(conversationId);
    if (!run?.busy) return;
    run.aborted = true;
    this.deps.approvals.cancelConversation(conversationId);
    this.#cli.abort(conversationId);
    this.#codex.abort(conversationId);
    this.#cursor.abort(conversationId);
    this.#gemini.abort(conversationId);
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
  ): Promise<{ text: string; sessionFile: string | undefined; aborted: boolean }> {
    // Claim the run before any await, like send(): two turns in one conversation would share
    // (and the first to finish would dispose) the other's sessions.
    const run = this.#run(conversationId);
    if (run.busy) throw new HttpError(409, "the crew is still answering the last message");
    run.busy = true;
    // The person may have written (and pressed Stop) here before; this turn starts clean.
    run.aborted = false;
    clearTimeout(run.idleTimer);
    let conv: ConversationRow | undefined;
    try {
      conv = await this.conversation(user, conversationId);
      // A task's chat can be open on the person's screen: it shows as busy, like any chat.
      if (options.task) this.emit(user.id, { type: "status", conversationId, busy: true });
      await this.#checkCap(user, slug, options.watchId);
      await this.#assertActive(slug, user);
      await this.#markTurn(conversationId, true);
      const text = await this.#turn(user, conv, run, slug, prompt, options);
      return { text, sessionFile: run.sessions.get(slug)?.sessionFile, aborted: run.aborted };
    } catch (err) {
      // A task's chat keeps why it stopped, for whoever opens it later.
      if (options.task && conv && !run.aborted) await this.#failed(user, conv, slug, err);
      throw err;
    } finally {
      await this.#markTurn(conversationId, false);
      run.busy = false;
      if (options.task && conv) {
        this.emit(user.id, { type: "status", conversationId, busy: false });
      }
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
    // In a group chat the agents act for whoever wrote the message: their role, their lists,
    // their spending cap. Sessions hold the person they were opened for, so every turn checks
    // who it is for (a person's message, a routine, a task's result reported to the starter)
    // and reopens them on a change (from their files, so nothing said is lost).
    if (run.actingUserId !== user.id) {
      for (const s of run.sessions.values()) s.dispose();
      run.sessions.clear();
      run.actingUserId = user.id;
    }
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
      recruit: async (spec) => {
        if (spec.model) await this.#checkModel(spec.model);
        return this.#recruit(user, spec);
      },
      edit: async (target, spec) => {
        const { persona, cli, ...changes } = spec;
        const clean: Partial<CrewManifest> = Object.fromEntries(
          Object.entries(changes).filter(([, v]) => v !== undefined),
        );
        const now = this.deps.crew.folder(target).manifest;
        // `model` is the one place a crew member's model lives: a Claude Code model given as
        // cliModel becomes `claude-code/<model>`, and cli.model is cleared so the two can't disagree.
        if (cli?.model) clean.model ??= `claude-code/${cli.model}`;
        if (clean.model !== undefined) {
          await this.#checkModel(clean.model);
          const provider = splitModelRef(clean.model)?.provider;
          // A Claude Code, Codex, Cursor or Gemini CLI model only runs on its own engine; any other model on pi.
          if (!clean.backend && provider === "claude-code") clean.backend = "claude-code-cli";
          if (!clean.backend && provider === CODEX_PROVIDER) clean.backend = "codex-cli";
          if (!clean.backend && provider === CURSOR_PROVIDER) clean.backend = "cursor-cli";
          if (!clean.backend && provider === GEMINI_PROVIDER) clean.backend = "gemini-cli";
          if (
            !clean.backend &&
            now.backend !== "pi" &&
            provider &&
            provider !== "claude-code" &&
            provider !== CODEX_PROVIDER &&
            provider !== CURSOR_PROVIDER &&
            provider !== GEMINI_PROVIDER &&
            !(provider === "anthropic" && now.backend === "claude-code-cli")
          ) {
            clean.backend = "pi";
          }
        }
        if (cli || (clean.model !== undefined && now.cli?.model)) {
          clean.cli = ClaudeCliSettings.parse({
            ...now.cli,
            ...Object.fromEntries(Object.entries(cli ?? {}).filter(([, v]) => v !== undefined)),
            ...(clean.model !== undefined || cli?.model === "" ? { model: undefined } : {}),
          });
        }
        const d = await this.deps.crew.patch(target, clean, persona);
        return { ...d, status: d.status };
      },
      crewSettings: async (target) => {
        if (!(await this.#roster(user)).some((c) => c.slug === target)) {
          throw new Error(`no crew member "${target}"; check list_crew`);
        }
        const yaml = (await this.deps.crew.detail(target)).manifestYaml;
        const m = this.deps.crew.folder(target).manifest;
        // An empty list reads like "none" but means every built-in tool.
        return m.tools.length
          ? yaml
          : `${yaml.trimEnd()}\n\n(tools: [] means all built-in tools: read, write, edit, bash and the rest. It is not "none".)`;
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
        const onceAt =
          spec.inMinutes !== undefined
            ? new Date(Date.now() + Math.max(1, spec.inMinutes) * 60_000)
            : spec.at
              ? new Date(spec.at)
              : null;
        if (onceAt && Number.isNaN(onceAt.getTime())) {
          throw new Error("`at` must be an ISO date-time such as 2026-11-20T17:00:00-06:00");
        }
        const trigger = onceAt
          ? { kind: "once" as const, at: onceAt.toISOString() }
          : spec.cron
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
      listMcpCatalog: async () => mcpCatalogList(await this.deps.mcp.list()),
      installMcp: async (id, crews) => {
        const server = await this.deps.mcp.install(id);
        if (crews.length) await this.deps.mcp.assign(id, [...new Set([...server.crews, ...crews])]);
        const missing = server.secrets.filter((x) => x.required && !x.set).map((x) => x.label);
        return missing.length
          ? `Installed ${server.name}. It needs ${missing.join(", ")} entered by an owner on the MCP servers page before it starts.`
          : `Installed ${server.name} for ${crews.join(", ") || "nobody yet"}. It starts in new conversations.`;
      },
      delegate: async (spec, signal) => {
        const tasks = this.#tasks;
        if (!tasks) throw new Error("tasks are not available on this instance");
        // Where nobody could be told later (another app waiting for one answer), the tool call
        // waits for the crew member instead of leaving the work in the background.
        const background = BACKGROUND_SURFACES.has(conv.surface) && !options.watchId;
        if (options.nudge && spec.continueTask === undefined) {
          run.unprompted = (run.unprompted ?? 0) + 1;
          if (run.unprompted > MAX_UNPROMPTED_TASKS) {
            throw new Error(
              `You have started ${MAX_UNPROMPTED_TASKS} tasks since ${user.displayName} last wrote. Do not start more: tell ${user.displayName} where things stand and ask how to go on.`,
            );
          }
        }
        let target = spec.crew;
        if (spec.continueTask === undefined) {
          if (target === slug) throw new Error("you cannot delegate to yourself");
          if (!(await this.#roster(user)).some((c) => c.slug === target)) {
            throw new Error(`no crew member "${target}"; check list_crew for the slugs`);
          }
          await this.#assertActive(target, user);
          await this.#checkCrewCap(target);
        }
        // The task's card sits after what the Captain said so far, like a question card.
        await this.#closeStream(conv, crewRow.id, stream);
        try {
          const started =
            spec.continueTask === undefined
              ? await tasks.start(
                  user,
                  conv,
                  { crewSlug: target, prompt: spec.task, title: spec.title },
                  {
                    from: crew,
                    quiet: !background,
                    unprompted: options.nudge === true,
                    since: run.wroteAt,
                  },
                )
              : {
                  ...(await tasks.continue(user, conv, spec.continueTask, spec.task, {
                    from: crew,
                    quiet: !background,
                  })),
                  already: false,
                };
          const task = started.task;
          target = task.crew.slug;
          if (background) {
            const what = `Task ${task.number} ("${task.title}")`;
            const next = `Do not wait for it and do not hand it over again. If there is more to hand over, do that now; otherwise tell ${user.displayName} in one short line what is under way and end your reply. Its result comes to you when it is done.`;
            return {
              kind: "started",
              text: started.already
                ? `${what} is already with ${task.crew.name} for exactly this, so nothing new was started. ${next}`
                : spec.continueTask !== undefined
                  ? `${what} went back to ${task.crew.name} with your notes${started.queued ? "; they take them up when their current work ends" : ""}. ${next}`
                  : `${what} is now with ${task.crew.name}${started.queued ? " and starts when another task finishes" : ""}. It runs in the background, and ${user.displayName} sees it on a card in this chat. ${next}`,
            };
          }
          const ended = await tasks.settled(task.id, signal);
          if (ended.status === "done") return { kind: "reply", text: ended.result ?? "" };
          if (run.aborted || ended.status === "stopped") throw new Error("the task was stopped");
          // A long task that dies partway (a dropped connection, a provider timeout) still did
          // work; hand the Captain what there is rather than nothing.
          if (!ended.result?.trim()) throw new Error(ended.error ?? "the task failed");
          return {
            kind: "reply",
            text: [
              `${task.crew.name} stopped before finishing: ${ended.error ?? "unknown error"}`,
              "",
              "What they had so far:",
              "",
              ended.result,
              "",
              `Check what is already done, then delegate the rest with continue_task ${task.number} and notes on where to pick up.`,
            ].join("\n"),
          };
        } finally {
          stream = this.#openStream(user.id, conv.id, crew);
        }
      },
      listTasks: async () => {
        if (!this.#tasks) throw new Error("tasks are not available on this instance");
        return this.#tasks.describe(conv.id);
      },
      checkTask: async (number) => {
        if (!this.#tasks) throw new Error("tasks are not available on this instance");
        return this.#tasks.check(conv.id, number);
      },
      stopTask: async (number) => {
        if (!this.#tasks) throw new Error("tasks are not available on this instance");
        return this.#tasks.stopNumbered(conv.id, number);
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
        void options.onWaiting?.(true);
        try {
          const summary = call.everyTime
            ? await this.#accessSummary(crew.name, call.toolName, call.input)
            : undefined;
          return await this.deps.approvals.request({
            userId: user.id,
            conversationId: conv.id,
            ...(options.task ? { parentConversationId: options.task.parentConversationId } : {}),
            watchId: options.watchId ?? null,
            crew,
            toolName: call.toolName,
            args: call.input,
            ...(summary ? { summary } : {}),
            ...(call.everyTime ? { everyTime: true } : {}),
          });
        } finally {
          // May hold the turn a moment: a background task takes a free slot before it goes on.
          await options.onWaiting?.(false);
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
        void options.onWaiting?.(true);
        try {
          const answer = await this.deps.approvals.ask({
            userId: user.id,
            conversationId: conv.id,
            ...(options.task ? { parentConversationId: options.task.parentConversationId } : {}),
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
          // May hold the turn a moment: a background task takes a free slot before it goes on.
          await options.onWaiting?.(false);
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
              return `No picture maker is set up, so you cannot make pictures yet. Tell ${user.displayName} in one short sentence that an owner can pick one under Settings, Photos and voice, Pictures and pets (an OpenAI key, a local image server, or their ChatGPT plan through Codex).`;
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
              made.billing,
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
    if (
      backend === "claude-code-cli" ||
      backend === "codex-cli" ||
      backend === "cursor-cli" ||
      backend === "gemini-cli"
    ) {
      const codex = backend === "codex-cli";
      const cursor = backend === "cursor-cli";
      const gemini = backend === "gemini-cli";
      const engine = codex
        ? "Codex"
        : cursor
          ? "Cursor"
          : gemini
            ? "Gemini CLI"
            : "the Claude Code CLI";
      if (options.images?.length) {
        await this.#note(
          conv,
          `${crew.name} runs on ${engine}, which Shipmate cannot pass photos to, so ${crew.name} only gets their names. Ask the ${this.deps.crew.captain().manifest.name} on the Bridge to look at them instead.`,
        );
        prompt = `${prompt}\n\n(${user.displayName} attached photos you cannot see: ${(options.imageNames ?? []).join(", ")}.)`;
      }
      const isCaptain = folder.manifest.captain && conv.kind === "bridge" && !options.consultFor;
      // A consult is a one-off answer without tools, like the pi Captain's consult session.
      const allowed = new Set(folder.manifest.allow);
      // The crew member's installed MCP servers run inside Claude Code, behind the same
      // approvals. Codex, Cursor and Gemini have no hook to ask Shipmate first, so they get only
      // Shipmate's tools.
      const mcp =
        options.consultFor || codex || cursor || gemini
          ? { servers: {}, skipped: [] as string[] }
          : await this.deps.mcp.serversFor(folder);
      // Claude Code works in a Shipyard project with its own file tools and Shipmate's sandboxed
      // shell (see ClaudeCliTurns). The other CLIs refuse project work in their own turns.
      if (conv.projectId && !(codex || cursor || gemini) && !this.#workspaces) {
        throw new HttpError(503, "the Shipyard is not available on this instance");
      }
      const workspace =
        conv.projectId && !(codex || cursor || gemini) && !options.consultFor && this.#workspaces
          ? await this.#workspaces.forConversation(conv.projectId, user, folder, conv.id)
          : undefined;
      const workspaceTools = workspace
        ? [
            createBashToolDefinition(workspace.dir, {
              operations: workspace.bash,
            }) as unknown as ToolDefinition,
            ...workspace.tools,
          ]
        : [];
      const grant = options.consultFor
        ? undefined
        : this.cliTools.open(
            {
              tools: [
                ...workspaceTools,
                ...this.#cliTools(
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
                  conv.privateChat,
                ),
              ],
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
            // A chat brought over from another app: these engines were never in it either.
            ...(conv.importedFrom
              ? [await this.#imports.recap(conv.id, conv.importedFrom, user.displayName)].filter(
                  (r): r is string => r !== null,
                )
              : []),
            ...(conv.privateChat ? [PRIVATE_CHAT_NOTE] : []),
            ...((codex || cursor || gemini) && folder.manifest.mcp.length
              ? [
                  `Its MCP servers (${folder.manifest.mcp.join(", ")}) are not available on ${engine}; switch to the Shipmate or Claude Code engine to use them.`,
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
        if (codex || cursor || gemini) {
          const input: CursorTurnInput = {
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
          };
          // These engines keep their own context and do not say how full it is.
          if (!options.consultFor) {
            this.#meter(user, conv, {
              crew: { slug, name: crew.name },
              engine: codex ? "codex" : cursor ? "cursor" : "gemini",
              model: folder.manifest.model,
              tokens: null,
              window: null,
              at: new Date().toISOString(),
            });
          }
          if (gemini) {
            const { addImage: _none, ...rest } = input;
            return await this.#gemini.turn(rest);
          }
          return await (codex ? this.#codex.turn(input) : this.#cursor.turn(input));
        }
        return await this.#cli.turn({
          onMeter: (m) => {
            if (m.rateLimit && m.subscription) this.deps.meters?.noteClaude(m.rateLimit);
            if (options.consultFor) return;
            this.#meter(user, conv, {
              crew: { slug, name: crew.name },
              engine: "claude-code",
              model: m.model,
              tokens: m.context?.tokens ?? null,
              window: m.context?.window ?? null,
              at: new Date().toISOString(),
            });
          },
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
          ...(grant ? { mcpServers: Object.keys(mcp.servers) } : {}),
          ...(workspace ? { workspace: { dir: workspace.dir, prompt: workspace.prompt } } : {}),
          context,
          oneOff: options.consultFor !== undefined,
        });
      } catch (err) {
        const service = codex ? "OpenAI" : cursor ? "Cursor" : gemini ? "Gemini" : "Claude";
        throw withPartial(toModelError(err, service), stream.text);
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
      const full = contextFull(session);
      if (full && !run.aborted) throw full;
      const failure = lastError(session);
      if (failure && !run.aborted) {
        // pi has already retried temporary failures (see MODEL_RETRY in @shipmate/crew).
        throw toModelError(
          new Error(failure),
          serviceName((session.session.model ?? own).provider),
        );
      }
    } catch (err) {
      throw withPartial(err, stream.text || final);
    } finally {
      unsubscribe();
      if (!options.consultFor) {
        const used = contextUsage(session.session);
        const m = session.session.model ?? own;
        if (used) {
          this.#meter(user, conv, {
            crew: { slug, name: crew.name },
            engine: "pi",
            model: `${m.provider}/${m.id}`,
            tokens: used.tokens,
            window: used.contextWindow || null,
            at: new Date().toISOString(),
          });
        }
      }
      if (restore) await session.session.setModel(restore).catch(() => {});
      await this.#closeStream(conv, crewRow.id, stream);
      // Spend must be stored before the turn ends, or the next message could slip past a cap.
      await Promise.all(run.writes);
      const file = session.sessionFile;
      if (file && !options.consultFor && conv.sessionFiles[slug] !== file) {
        conv.sessionFiles = { ...conv.sessionFiles, [slug]: file };
        const saved = await this.deps.db
          .update(conversations)
          .set({ sessionFiles: conv.sessionFiles })
          .where(eq(conversations.id, conv.id))
          .returning({ id: conversations.id });
        // The chat was deleted while this reply was being written: its record goes too.
        if (!saved.length && conv.surface !== "watch") await removeSessionRecords([file]);
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

  /** Keep and send how full the chat's context is after a reply. */
  #meter(user: UserRow, conv: ConversationRow, context: ChatContextDto) {
    if (!this.deps.meters) return;
    this.deps.meters.setContext(conv.id, context);
    this.emit(user.id, { type: "context", conversationId: conv.id, context });
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
    // A chat brought over from another app: the agent was never in it, so it gets the end of it.
    const importRecap =
      conv.importedFrom && !mode
        ? await this.#imports.recap(conv.id, conv.importedFrom, user.displayName)
        : null;
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
      delegate: (spec, signal) => current().captain.delegate(spec, signal),
      listTasks: () => current().captain.listTasks(),
      checkTask: (number) => current().captain.checkTask(number),
      stopTask: (number) => current().captain.stopTask(number),
      createWatch: (spec) => current().captain.createWatch(spec),
      installMcp: (id, crews) => current().captain.installMcp(id, crews),
      listMcpCatalog: () => current().captain.listMcpCatalog(),
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
    const { model, missing } = await this.#model(folder);
    if (missing && !helperId) {
      // Say so instead of quietly answering on another model (a plan that rejects it, say).
      await this.#note(
        conv,
        `${folder.manifest.name}'s model ${missing} isn't set up, so ${model.name} (${model.provider}/${model.id}) answers instead. Pick another model on their Settings tab, or ask the Captain.`,
      );
    }
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
          [
            ...forChat(conv, memoryTools(memory, acting)),
            ...(this.#everyday?.tools(user, folder) ?? []),
          ]
        : [
            ...forChat(conv, memoryTools(memory, acting)),
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
        ...(importRecap ? [importRecap] : []),
        ...(conv.privateChat ? [PRIVATE_CHAT_NOTE] : []),
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
      const full = contextFull(session);
      if (full && !run.aborted) throw full;
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

  /**
   * The crew member's model, or the instance default when it has no credentials yet. `missing`
   * names the model it asked for when another one stands in.
   */
  async #model(folder: CrewFolder): Promise<{ model: Model<Api>; missing?: string }> {
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
    const wanted = folder.manifest.model === DEFAULT_MODEL ? defaultModel : folder.manifest.model;
    const exact = find(wanted);
    if (exact) return { model: exact };
    const model =
      sameProvider(wanted) ?? find(defaultModel) ?? sameProvider(defaultModel) ?? available[0];
    if (!model) {
      throw new HttpError(
        503,
        "No model provider is set up yet. An owner can add one on the Providers page.",
      );
    }
    return wanted ? { model, missing: wanted } : { model };
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
      `You are talking with ${user.displayName} (${user.role}). Today is ${new Date().toISOString().slice(0, 10)} (now ${new Date().toISOString().slice(11, 16)} UTC).`,
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
              `A task you hand over runs in the background in its own chat, and ${user.displayName} sees it on a card here. Several can run at once: call \`delegate\` once for each separate job. After handing over, say in one short line what is under way and end your reply; never wait for a task or call \`check_task\` in a loop.`,
              "",
              `Then supervise: when a task is done, Shipmate gives you its result in a note marked "Shipmate note" (that note is not from ${user.displayName}). Check the result against what was asked. If it misses, send it back with \`delegate\` and \`continue_task\` set to the task's number, with specific notes, instead of redoing it. ${user.displayName} can already read the result, so reply with the outcome in 1 to 3 short lines and any decision they need to make. Your standing orders say more.`,
            ].join("\n")
          : "## Coordinating\n\nShipmate's crew tools are not reachable from this session, so you cannot hand work to the crew right now; answer yourself and say who would normally take it.",
      );
      if (hasTools) out.push(CREW_SETUP_GUIDE);
      return out;
    }
    if (folder.manifest.captain || !hasTools) return [];
    const captain = this.deps.crew.captain().manifest.name;
    return [
      `${captain} coordinates the crew. When you are unsure what ${user.displayName} wants, what to do next, or whether something is your job, ask ${captain} with \`ask_captain\` instead of guessing.`,
      `Your tools and MCP servers are the ones listed to you, each with its own description. If a job needs one you don't have, or one fails, say which and ask ${captain} with \`ask_captain\` (${captain} can equip you); never say you used a tool you don't have.`,
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
    privateChat = false,
  ): ToolDefinition[] {
    const acting: ActingUser = { id: user.id, displayName: user.displayName, role: user.role };
    const skills = this.deps.skills;
    return [
      ...forChat({ privateChat }, memoryTools(new MemoryStore(folder.dir), acting)),
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
   * the Claude Code, Codex, Cursor or Gemini CLI the model it passes as --model
   * (`claude-code/<model>`, `codex/<model>`, `cursor/<model>`, `gemini-cli/<model>`).
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
      const id = cliModelFromRef(m.model) ?? m.cli?.model;
      return id ? `claude-code/${id}` : "claude-code/default";
    }
    if (m.backend === "codex-cli") {
      return m.model.startsWith(`${CODEX_PROVIDER}/`) ? m.model : `${CODEX_PROVIDER}/default`;
    }
    if (m.backend === "cursor-cli") {
      return m.model.startsWith(`${CURSOR_PROVIDER}/`) ? m.model : `${CURSOR_PROVIDER}/default`;
    }
    if (m.backend === "gemini-cli") {
      return m.model.startsWith(`${GEMINI_PROVIDER}/`) ? m.model : `${GEMINI_PROVIDER}/default`;
    }
    return m.model === DEFAULT_MODEL ? defaultModel : m.model;
  }

  /**
   * Refuse a model Shipmate can't run, naming the ones it can, so a typo or a made-up name
   * doesn't quietly fall back to another model at the next message.
   */
  async #checkModel(ref: string) {
    if (ref === DEFAULT_MODEL) return;
    const r = splitModelRef(ref);
    if (
      (r?.provider === "claude-code" || r?.provider === CODEX_PROVIDER) &&
      ClaudeCliSettings.shape.model.safeParse(r.id).success
    ) {
      return;
    }
    const available = await this.deps.providers.available();
    if (r && available.some((m) => m.provider === r.provider && m.id === r.id)) return;
    const some = available.slice(0, 12).map((m) => `${m.provider}/${m.id}`);
    throw new Error(
      [
        `"${ref}" is not a model Shipmate can run.`,
        'Models are written provider/model-id, or "default" for the crew default.',
        some.length
          ? `Some that work: ${some.join(", ")}, claude-code/sonnet (Claude subscription). list_models shows them all with prices.`
          : "No model provider is set up yet; an owner adds one on the Providers page.",
      ].join(" "),
    );
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
    const list = modelList(
      available,
      refs.some((r) => r.startsWith("claude-code/")),
      [
        ...(refs.some((r) => r.startsWith(`${CODEX_PROVIDER}/`)) ? codexModels() : []),
        ...(refs.some((r) => r.startsWith(`${CURSOR_PROVIDER}/`)) ? cursorModels() : []),
        ...(refs.some((r) => r.startsWith(`${GEMINI_PROVIDER}/`)) ? geminiModels() : []),
      ],
    );
    return [
      `Crew default (Settings, used by crew on model "default"): ${settings.defaultModel || "not set"}`,
      'Give crew a model as provider/model-id from this list, or "default".',
      "",
      list,
    ].join("\n");
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
    // Context size too: sessions keep the model (and compaction settings) they were made with.
    const models = available.map(
      (m) =>
        `${m.provider}/${m.id}:${m.cost.input}/${m.cost.output}:${m.contextWindow}/${m.maxTokens}`,
    );
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
    this.#cursor.abort(conversationId);
    this.#gemini.abort(conversationId);
    clearTimeout(run.idleTimer);
    this.#live.delete(conversationId);
    for (const s of run.sessions.values()) s.dispose();
    this.#runs.delete(conversationId);
  }
}

/**
 * How to set crew up, in every Captain's system prompt whatever its CREW.md says, so a fresh or
 * edited Captain (or one on a small model) uses real names instead of guessing.
 */
export const CREW_SETUP_GUIDE = [
  "## Setting up crew",
  "",
  '- Models: run `list_models` and use a name exactly as listed (`provider/model-id`), or "default" for the crew default. Never make one up; unknown names are refused.',
  "- MCP servers: run `list_mcp_catalog` for the ids, what each does and whether it is ready. Give one with `equip_crew_member`; crew on Claude Code may then use it without more setup. A server that needs a key or URL won't start until an owner enters it on the MCP page, so tell the person what to enter.",
  "- Read `crew_settings` before `edit_crew_member`. `tools: []` means every built-in tool, not none. `model` is the one model setting, on every engine.",
  "- When a crew member says a tool or server is missing or failing, check `crew_settings` and `list_mcp_catalog`, fix what you can, and tell the person what only they can do.",
].join("\n");

/** Keep what a crew member wrote before its turn failed on the error, for the Captain. */
function withPartial(err: unknown, text: string): unknown {
  const partial = text.trim();
  if (!partial || !(err instanceof Error)) return err;
  return Object.assign(err, { partial });
}

/** list_mcp_catalog: one line per server, so the Captain uses real ids instead of guessing. */
export function mcpCatalogList(servers: McpServerDto[]): string {
  if (!servers.length) return "MCP servers are turned off on this instance.";
  return servers
    .map((s) => {
      const missing = s.secrets.filter((x) => !x.set && (x.required || s.needsOneSecret));
      const status = !s.installed
        ? "not installed"
        : s.ready
          ? "ready"
          : s.google
            ? "needs Sign in with Google on the MCP page"
            : `needs ${missing.map((x) => x.label).join(s.needsOneSecret ? " or " : ", ")} on the MCP page`;
      const who = s.crews.length ? `; used by ${s.crews.join(", ")}` : "";
      return `- ${s.id}: ${s.name}. ${s.description} (${status}${who})`;
    })
    .join("\n");
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
  /** Pictures shown on the reply (Codex's or Cursor's image tool). */
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

/** The turn ended blank because the chat outgrew the model's context (see contextFullError). */
function contextFull(session: CrewSession): ModelError | undefined {
  const last = [...session.session.messages].reverse().find((m) => m.role === "assistant");
  if (last?.role !== "assistant") return undefined;
  return contextFullError(last, session.session.model ?? session.model);
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
  preview: string | null,
  access: { group: boolean; mine: boolean },
): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    kind: c.kind === "direct" ? "direct" : "bridge",
    crewSlug: slug,
    surface: c.surface,
    projectId: c.projectId,
    pinned: c.pinnedAt !== null,
    archived: c.archivedAt !== null,
    preview,
    importedFrom: c.importedFrom,
    private: c.privateChat,
    shared: c.shareToken !== null,
    group: access.group,
    mine: access.mine,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** A reply brought over from another app is shown under that app's name. */
function importedAuthor(m: typeof messages.$inferSelect): MessageDto["author"] | null {
  const from = (m.meta as { importedFrom?: unknown } | null)?.importedFrom;
  if (m.role !== "assistant" || typeof from !== "string") return null;
  return { kind: "crew", slug: `imported-${from}`, name: IMPORT_SOURCES[from] ?? "Assistant" };
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
        : (importedAuthor(m) ?? { kind: "system" });
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

/** pi's own estimate of the session's context use; undefined when it cannot say. */
function contextUsage(session: {
  getContextUsage?: () => { tokens: number | null; contextWindow: number } | undefined;
}): { tokens: number | null; contextWindow: number } | undefined {
  try {
    return session.getContextUsage?.();
  } catch {
    return undefined;
  }
}
