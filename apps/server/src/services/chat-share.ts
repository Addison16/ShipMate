import { randomBytes } from "node:crypto";
import type { ChatShareDto, SharedChatDto } from "@shipmate/core";
import { conversations, type Db, messages, users } from "@shipmate/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";

/**
 * Read-only links to single chats. The link carries a random secret; whoever has it sees the
 * chat's messages up to the moment it was shared, and nothing else.
 */
export class ChatShareService {
  constructor(
    private readonly db: Db,
    private readonly bridge: Bridge,
  ) {}

  async get(user: UserRow, id: string): Promise<ChatShareDto | null> {
    const c = await this.bridge.conversation(user, id);
    if (!c.shareToken || !c.sharedThrough) return null;
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, id),
          inArray(messages.role, ["user", "assistant"]),
          gt(messages.createdAt, c.sharedThrough),
        ),
      );
    return { token: c.shareToken, sharedThrough: c.sharedThrough.toISOString(), newer: n };
  }

  /** Make the link, or keep it and show everything up to now. */
  async share(user: UserRow, id: string): Promise<ChatShareDto> {
    const c = await this.bridge.conversation(user, id);
    if (c.privateChat) throw new HttpError(400, "A private chat cannot be shared.");
    if (this.bridge.isBusy(id)) {
      throw new HttpError(409, "Wait for the reply to finish, then share.");
    }
    const sharedThrough = new Date();
    const token = c.shareToken ?? randomBytes(24).toString("base64url");
    await this.db
      .update(conversations)
      // updatedAt is kept: sharing is not activity, and must not reorder the chat list.
      .set({ shareToken: token, sharedThrough, updatedAt: c.updatedAt })
      .where(eq(conversations.id, id));
    return { token, sharedThrough: sharedThrough.toISOString(), newer: 0 };
  }

  async stop(user: UserRow, id: string): Promise<void> {
    const c = await this.bridge.conversation(user, id);
    await this.db
      .update(conversations)
      .set({ shareToken: null, sharedThrough: null, updatedAt: c.updatedAt })
      .where(eq(conversations.id, id));
  }

  /** What a link shows: the words only. No files, tool details, notes or ids. */
  async view(token: string): Promise<SharedChatDto> {
    const [row] = await this.db
      .select({ c: conversations, owner: users })
      .from(conversations)
      .innerJoin(users, eq(users.id, conversations.userId))
      .where(eq(conversations.shareToken, token))
      .limit(1);
    const through = row?.c.sharedThrough;
    if (!row || !through || row.c.privateChat) {
      throw new HttpError(404, "This link does not work any more.");
    }
    const all = await this.bridge.messages(row.owner, row.c.id);
    const shown: SharedChatDto["messages"] = [];
    for (const m of all) {
      if (m.role === "system" || !m.content.trim()) continue;
      if (new Date(m.createdAt) > through) continue;
      shown.push({
        role: m.role,
        name: m.author.kind === "system" ? "Assistant" : m.author.name,
        content: m.content,
        createdAt: m.createdAt,
      });
    }
    return {
      title: row.c.title ?? "Chat",
      sharedBy: row.owner.displayName,
      sharedThrough: through.toISOString(),
      messages: shown,
    };
  }
}
