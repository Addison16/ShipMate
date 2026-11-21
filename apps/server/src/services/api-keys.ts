import { createHash, randomBytes } from "node:crypto";
import type { ApiKeyDto, AskResult } from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import { apiKeys, conversations, type Db, users } from "@shipmate/db";
import { and, desc, eq } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import type { CrewService } from "./crew.js";

type Row = typeof apiKeys.$inferSelect;

const MAX_KEYS = 20;
const PREFIX = "shipmate_";
const SEEN_EVERY_MS = 60_000;
/** How long POST /api/v1/ask waits for the reply unless told otherwise, and the most it will. */
export const ASK_WAIT_SECONDS = 120;
export const ASK_WAIT_MAX_SECONDS = 600;
/** The `surface` of chats started with a key. */
export const API_SURFACE = "api";

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

const toDto = (r: Row): ApiKeyDto => ({
  id: r.id,
  name: r.name,
  hint: r.hint,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

/**
 * Personal keys for other apps. A key stands for the person who made it, but only on /api/v1:
 * it can message agents that person can see and read the chats it started. It cannot open
 * settings, other chats, files, or make more keys.
 */
export class ApiKeyService {
  constructor(private readonly deps: { db: Db; bridge: Bridge; crew: CrewService }) {}

  async list(user: UserRow): Promise<ApiKeyDto[]> {
    const rows = await this.deps.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, user.id))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toDto);
  }

  /** Make a key. The token is returned once and never stored. */
  async create(user: UserRow, name: string): Promise<{ key: ApiKeyDto; token: string }> {
    const mine = await this.list(user);
    if (mine.length >= MAX_KEYS) throw new HttpError(400, "Too many keys. Remove one first.");
    const token = PREFIX + randomBytes(32).toString("base64url");
    const [row] = await this.deps.db
      .insert(apiKeys)
      .values({
        userId: user.id,
        name,
        tokenHash: hashOf(token),
        hint: token.slice(0, PREFIX.length + 4),
      })
      .returning();
    if (!row) throw new Error("insert failed");
    return { key: toDto(row), token };
  }

  async remove(user: UserRow, id: string): Promise<void> {
    const gone = await this.deps.db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
      .returning({ id: apiKeys.id });
    if (!gone.length) throw new HttpError(404, "key not found");
  }

  /** Who an `Authorization` header stands for, or null. */
  async holder(header: string | undefined): Promise<{ user: UserRow; keyId: string } | null> {
    const token = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
    if (!token?.startsWith(PREFIX)) return null;
    const [row] = await this.deps.db
      .select({ key: apiKeys, user: users })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.userId))
      .where(eq(apiKeys.tokenHash, hashOf(token)))
      .limit(1);
    if (!row) return null;
    if (!row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > SEEN_EVERY_MS) {
      await this.deps.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.key.id))
        .catch(() => {});
    }
    return { user: row.user, keyId: row.key.id };
  }

  /** The agents a key's owner can message. */
  async agents(user: UserRow): Promise<{ id: string; name: string }[]> {
    const crew = await this.deps.crew.list(false, user);
    return crew.filter((c) => c.status === "active").map((c) => ({ id: c.slug, name: c.name }));
  }

  /**
   * Send a message and wait for the reply. Each key keeps one running chat per agent, so a
   * follow-up remembers what came before; `newChat` starts over.
   */
  async ask(
    user: UserRow,
    keyId: string,
    input: {
      message: string;
      agent?: string | undefined;
      newChat?: boolean | undefined;
      waitSeconds?: number | undefined;
    },
  ): Promise<AskResult> {
    const captain = CAPTAIN_SLUG;
    const slug = input.agent ?? captain;
    let crew: Awaited<ReturnType<CrewService["assertVisible"]>>;
    try {
      crew = await this.deps.crew.assertVisible(slug, user);
    } catch {
      throw new HttpError(404, `No agent "${slug}". GET /api/v1/agents lists them.`);
    }
    if (crew.status !== "active") throw new HttpError(409, `${crew.name} is not taking messages.`);

    const externalId = `${keyId}:${crew.slug}`;
    let chatId: string | undefined;
    if (!input.newChat) {
      const [found] = await this.deps.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(
            eq(conversations.surface, API_SURFACE),
            eq(conversations.externalId, externalId),
            eq(conversations.userId, user.id),
          ),
        )
        .orderBy(desc(conversations.createdAt))
        .limit(1);
      chatId = found?.id;
    }
    chatId ??= (
      await this.deps.bridge.createConversation(user, {
        kind: crew.slug === captain ? "bridge" : "direct",
        crewSlug: crew.slug,
        surface: API_SURFACE,
        externalId,
      })
    ).id;

    const id = chatId;
    // A failed turn leaves its own note in the chat, which is what the caller is then shown.
    let failure: unknown = null;
    const turn = this.deps.bridge.send(user, id, input.message).then(
      () => true,
      (err: unknown) => {
        failure = err;
        return true;
      },
    );
    const waitMs = Math.min(input.waitSeconds ?? ASK_WAIT_SECONDS, ASK_WAIT_MAX_SECONDS) * 1000;
    let timer: NodeJS.Timeout | undefined;
    const finished = await Promise.race([
      turn,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) return { status: "working", chatId: id, reply: null };
    // "Still answering", a spending cap, a bad request: nothing was sent, so say why.
    if (failure instanceof HttpError && failure.statusCode < 500) throw failure;
    return this.#latest(user, id);
  }

  /** The latest reply in a chat this key started. */
  async chat(user: UserRow, keyId: string, chatId: string): Promise<AskResult> {
    const [found] = await this.deps.db
      .select({ externalId: conversations.externalId })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, chatId),
          eq(conversations.userId, user.id),
          eq(conversations.surface, API_SURFACE),
        ),
      )
      .limit(1)
      .catch(() => []);
    if (!found?.externalId?.startsWith(`${keyId}:`)) throw new HttpError(404, "chat not found");
    if (this.deps.bridge.isBusy(chatId)) return { status: "working", chatId, reply: null };
    return this.#latest(user, chatId);
  }

  /** What was said after the person's last message: the agents' replies, else a failure note. */
  async #latest(user: UserRow, chatId: string): Promise<AskResult> {
    const all = await this.deps.bridge.messages(user, chatId);
    const from = all.map((m) => m.role).lastIndexOf("user");
    const after = all.slice(from + 1).filter((m) => m.content.trim());
    const replies = after.filter((m) => m.role === "assistant");
    const said = (replies.length ? replies : after).map((m) => m.content.trim());
    return { status: "done", chatId, reply: said.join("\n\n") || null };
  }
}
