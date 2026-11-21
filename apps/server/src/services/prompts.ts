import type { SavedPromptDto } from "@shipmate/core";
import { type Db, savedPrompts } from "@shipmate/db";
import { asc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { atLeast, HttpError, type UserRow } from "../auth.js";

type Row = typeof savedPrompts.$inferSelect;

const MAX_PROMPTS = 500;

/** Messages people send often, kept for the "/" menu in chat. Shared or private, like lists. */
export class PromptService {
  constructor(private readonly db: Db) {}

  async list(user: UserRow): Promise<SavedPromptDto[]> {
    const rows = await this.db
      .select()
      .from(savedPrompts)
      .where(or(isNull(savedPrompts.ownerId), eq(savedPrompts.ownerId, user.id)))
      .orderBy(asc(sql`lower(${savedPrompts.title})`), asc(savedPrompts.createdAt));
    return rows.map((r) => toDto(r, user));
  }

  async create(
    user: UserRow,
    input: { title: string; body: string; shared?: boolean | undefined },
  ): Promise<SavedPromptDto> {
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(savedPrompts);
    if (n >= MAX_PROMPTS) throw new HttpError(400, "Too many saved prompts. Delete some first.");
    const [row] = await this.db
      .insert(savedPrompts)
      .values({
        ownerId: input.shared ? null : user.id,
        createdById: user.id,
        title: input.title,
        body: input.body,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    return toDto(row, user);
  }

  async update(
    user: UserRow,
    id: string,
    patch: {
      title?: string | undefined;
      body?: string | undefined;
      shared?: boolean | undefined;
    },
  ): Promise<SavedPromptDto> {
    const row = await this.#mine(user, id);
    const [next] = await this.db
      .update(savedPrompts)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.shared !== undefined
          ? { ownerId: patch.shared ? null : (row.createdById ?? user.id) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(savedPrompts.id, row.id))
      .returning();
    return toDto(next ?? row, user);
  }

  async remove(user: UserRow, id: string): Promise<void> {
    const row = await this.#mine(user, id);
    await this.db.delete(savedPrompts).where(eq(savedPrompts.id, row.id));
  }

  async #mine(user: UserRow, id: string): Promise<Row> {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "prompt not found");
    const [row] = await this.db.select().from(savedPrompts).where(eq(savedPrompts.id, id));
    // 404 for someone else's private prompt, so its existence does not leak.
    if (!row || (row.ownerId !== null && row.ownerId !== user.id)) {
      throw new HttpError(404, "prompt not found");
    }
    if (!canChange(row, user)) {
      throw new HttpError(403, "Only the person who saved it, or an admin, can change it.");
    }
    return row;
  }
}

function canChange(row: Row, user: UserRow): boolean {
  if (row.ownerId) return row.ownerId === user.id;
  return row.createdById === user.id || atLeast(user.role, "admin");
}

function toDto(r: Row, user: UserRow): SavedPromptDto {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    shared: r.ownerId === null,
    mine: canChange(r, user),
    updatedAt: r.updatedAt.toISOString(),
  };
}
