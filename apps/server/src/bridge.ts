import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ConversationDto, MessageDto, ServerEvent } from "@shipmate/core";
import {
  type ActingUser,
  CAPTAIN_SLUG,
  type CaptainHost,
  type CrewFolder,
  type CrewSession,
  type CrewSummary,
  captainTools,
  createCrewSession,
  MemoryStore,
  memoryTools,
  splitModelRef,
} from "@shipmate/crew";
import { conversations, crewMembers, type Db, messages, users } from "@shipmate/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { HttpError, type UserRow } from "./auth.js";
import type { CrewService } from "./services/crew.js";
import type { McpService } from "./services/mcp.js";
import type { ProviderService } from "./services/providers.js";
import type { SettingsService } from "./services/settings.js";
import type { UsageService } from "./services/usage.js";

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
  agentDir: string;
}

/** Live state of one conversation: a pi session per crew member taking part. */
interface Run {
  sessions: Map<string, CrewSession>;
  /** Per crew slug, the CaptainHost of the turn in progress. */
  hosts: Map<string, CaptainHost>;
  busy: boolean;
  aborted: boolean;
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
  #runs = new Map<string, Run>();

  constructor(private readonly deps: BridgeDeps) {
    deps.crew.onChange(() => this.broadcast({ type: "crew_changed" }));
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
      .orderBy(desc(conversations.updatedAt));
    return rows.map((r) => toConversationDto(r.c, r.slug));
  }

  async createConversation(
    user: UserRow,
    input: { kind?: "bridge" | "direct" | undefined; crewSlug?: string | undefined },
  ): Promise<ConversationDto> {
    const kind = input.kind ?? "bridge";
    let crewMemberId: string | null = null;
    let slug: string | null = null;
    if (kind === "direct") {
      if (!input.crewSlug) throw new HttpError(400, "a direct conversation needs crewSlug");
      const row = await this.deps.crew.row(input.crewSlug);
      crewMemberId = row.id;
      slug = row.slug;
    }
    const [c] = await this.deps.db
      .insert(conversations)
      .values({ userId: user.id, kind, crewMemberId })
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
    await this.deps.db.delete(conversations).where(eq(conversations.id, id));
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

  /** Handle a message from a person. Resolves when the crew has finished replying. */
  async send(user: UserRow, conversationId: string, text: string): Promise<void> {
    const content = text.trim();
    if (!content) return;
    const conv = await this.conversation(user, conversationId);
    const run = this.#run(conversationId);
    if (run.busy) throw new HttpError(409, "the crew is still answering the last message");

    if (user.monthlyCapCents !== null) {
      const spent = await this.deps.usage.monthSpend(user.id);
      if (spent >= user.monthlyCapCents * 10_000) {
        throw new HttpError(
          402,
          "You have reached your monthly usage cap. An owner can raise it on the Users page.",
        );
      }
    }

    run.busy = true;
    run.aborted = false;
    clearTimeout(run.idleTimer);
    this.emit(user.id, { type: "status", conversationId, busy: true });
    try {
      const userMessage = await this.#store(conv, {
        role: "user",
        content,
        userId: user.id,
        authorName: user.displayName,
      });
      this.emit(user.id, { type: "message", conversationId, message: userMessage });
      if (!conv.title) {
        await this.deps.db
          .update(conversations)
          .set({ title: content.replace(/\s+/g, " ").slice(0, 60) })
          .where(eq(conversations.id, conv.id));
      }

      const slug = conv.kind === "direct" ? await this.#slugOf(conv.crewMemberId) : CAPTAIN_SLUG;
      if (!slug) throw new HttpError(410, "this crew member is no longer aboard");
      await this.#assertActive(slug);
      await this.#turn(user, conv, run, slug, content);
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
    await Promise.all([...run.sessions.values()].map((s) => s.abort()));
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
  ): Promise<string> {
    const folder = this.deps.crew.folder(slug);
    const crewRow = await this.deps.crew.row(slug);
    const crew = { slug, name: folder.manifest.name };
    let stream = this.#openStream(user.id, conv.id, crew);
    let final = "";

    const host: CaptainHost = {
      listCrew: () => this.#roster(),
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
      delegate: async (target, task) => {
        if (target === slug) throw new Error("you cannot delegate to yourself");
        const to = this.deps.crew.folder(target);
        await this.#assertActive(target);
        await this.#closeStream(conv, crewRow.id, stream);
        this.emit(user.id, {
          type: "handoff",
          conversationId: conv.id,
          from: crew,
          to: { slug: target, name: to.manifest.name },
          task,
        });
        try {
          return await this.#turn(user, conv, run, target, task);
        } finally {
          stream = this.#openStream(user.id, conv.id, crew);
        }
      },
    };

    const session = await this.#session(user, conv, run, folder, host);
    const unsubscribe = session.subscribe((event) => {
      this.#onEvent(user, conv, crewRow.id, session.model, stream, event);
      if (event.type === "message_end" && event.message.role === "assistant") {
        const t = textOf(event.message);
        if (t) final = t;
      }
    });
    try {
      await session.prompt(prompt);
      const failure = lastError(session);
      if (failure && !run.aborted) throw new Error(failure);
    } finally {
      unsubscribe();
      await this.#closeStream(conv, crewRow.id, stream);
      const file = session.sessionFile;
      if (file && conv.sessionFiles[slug] !== file) {
        conv.sessionFiles = { ...conv.sessionFiles, [slug]: file };
        await this.deps.db
          .update(conversations)
          .set({ sessionFiles: conv.sessionFiles })
          .where(eq(conversations.id, conv.id));
      }
    }
    return final;
  }

  #onEvent(
    user: UserRow,
    conv: ConversationRow,
    crewMemberId: string,
    model: Model<Api>,
    stream: Stream,
    event: AgentSessionEvent,
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
          void this.deps.usage
            .record(
              { userId: user.id, crewMemberId, conversationId: conv.id },
              model,
              event.message.usage,
            )
            .catch(() => {});
        }
        break;
      case "tool_execution_start":
        if (event.toolName === "delegate") break;
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
        if (event.toolName === "delegate") break;
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
    host: CaptainHost,
  ): Promise<CrewSession> {
    run.hosts.set(folder.slug, host);
    const existing = run.sessions.get(folder.slug);
    if (existing) return existing;
    const acting: ActingUser = { id: user.id, displayName: user.displayName, role: user.role };
    const memory = new MemoryStore(folder.dir);
    const isCaptain = folder.manifest.captain && conv.kind === "bridge";
    // A cached session's tools outlive the turn that created them, so they look up the host of
    // the turn in progress.
    const current = (): CaptainHost => {
      const h = run.hosts.get(folder.slug);
      if (!h) throw new Error("no turn in progress");
      return h;
    };
    const proxy: CaptainHost = {
      listCrew: () => current().listCrew(),
      recruit: (s) => current().recruit(s),
      edit: (slug, s) => current().edit(slug, s),
      retire: (slug) => current().retire(slug),
      delegate: (slug, task, signal) => current().delegate(slug, task, signal),
    };
    const { servers, skipped } = await this.deps.mcp.serversFor(folder);
    const model = await this.#model(folder);
    const created = await createCrewSession({
      crew: folder,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.providers.runtime,
      model,
      customTools: [
        ...memoryTools(memory, acting),
        ...(isCaptain ? captainTools(proxy, acting) : []),
      ],
      mcpServers: servers,
      appendSystemPrompt: [await this.#context(user, folder, memory, isCaptain, skipped)],
      ...(conv.sessionFiles[folder.slug] ? { sessionFile: conv.sessionFiles[folder.slug] } : {}),
    });
    run.sessions.set(folder.slug, created);
    return created;
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
      const roster = (await this.#roster())
        .filter((c) => !c.captain && c.status !== "retired")
        .map(
          (c) =>
            `- ${c.slug}: ${c.name}, ${c.role}${c.status === "pending_review" ? " (awaiting review)" : ""}`,
        );
      parts.push("", "## Crew aboard", "", roster.join("\n") || "(only you so far)");
    }
    if (skippedMcp.length) {
      parts.push("", `MCP servers not started (missing setup): ${skippedMcp.join(", ")}.`);
    }
    return parts.join("\n");
  }

  async #roster(): Promise<CrewSummary[]> {
    return (await this.deps.crew.list()).map((c) => ({
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

  async #assertActive(slug: string) {
    const crew = (await this.deps.crew.list(true)).find((c) => c.slug === slug);
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
    };
    this.#runs.set(conversationId, run);
    return run;
  }

  #dispose(conversationId: string) {
    const run = this.#runs.get(conversationId);
    if (!run) return;
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

/** A short one-line summary of tool arguments or results for the UI. */
export function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content?: Array<{ type: string; text?: string }> }).content;
    const t = content?.find((c) => c.type === "text")?.text ?? "";
    return oneLine(t);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${k}: ${String(v)}`);
    return oneLine(entries.join(", "));
  }
  return oneLine(String(value));
}

const oneLine = (s: string) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
};

function toConversationDto(c: ConversationRow, slug: string | null): ConversationDto {
  return {
    id: c.id,
    title: c.title,
    kind: c.kind === "direct" ? "direct" : "bridge",
    crewSlug: slug,
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
