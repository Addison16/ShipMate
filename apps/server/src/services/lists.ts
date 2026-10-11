import type {
  ListDetailDto,
  ListDto,
  ListItemDto,
  ListKind,
  ServerEvent,
  UpdateListItemRequest,
} from "@shipmate/core";
import { crewMembers, type Db, listItems, lists, users } from "@shipmate/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { atLeast, HttpError, type UserRow } from "../auth.js";

type ListRow = typeof lists.$inferSelect;
type ItemRow = typeof listItems.$inferSelect;

export const LIST_KINDS = ["grocery", "todo", "packing", "bills", "other"] as const;
export const ListKindSchema = z.enum(LIST_KINDS);
export const DueOn = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dates look like 2026-10-31")
  .refine((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
  }, "not a real date");
const ItemText = z.string().trim().min(1).max(500);
const Note = z.string().trim().max(2000);

/** Limits that keep a runaway crew member from filling the database. */
const MAX_LISTS_PER_OWNER = 200;
const MAX_ITEMS_PER_LIST = 1000;

/** Who is changing a list: a person, or a crew member working for that person. */
export interface ListActor {
  user: UserRow;
  crew?: { slug: string; name: string };
}

/**
 * Shared lists (groceries, to-dos, packing, bills) as rows instead of crew memory text. A list
 * with no owner is shared with everyone on the instance; a list with an owner is private to
 * that person, and admins do not see other people's private lists (like conversations).
 */
export class ListService {
  constructor(
    private readonly db: Db,
    /** Tell open web apps: ownerId null = everyone, else only that person. */
    private readonly notify: (ownerId: string | null, event: ServerEvent) => void,
  ) {}

  async list(user: UserRow): Promise<ListDto[]> {
    const rows = await this.db
      .select()
      .from(lists)
      .where(or(isNull(lists.ownerId), eq(lists.ownerId, user.id)))
      .orderBy(asc(lists.name));
    return this.#dtos(rows);
  }

  async get(user: UserRow, id: string): Promise<ListDetailDto> {
    return this.#detail(await this.#visible(user, id));
  }

  async create(
    actor: ListActor,
    input: { name: string; kind?: ListKind | undefined; shared?: boolean | undefined },
  ): Promise<ListDetailDto> {
    const name = input.name.trim().slice(0, 100);
    if (!name) throw new HttpError(400, "a list needs a name");
    const ownerId = input.shared === false ? actor.user.id : null;
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(lists)
      .where(ownerId ? eq(lists.ownerId, ownerId) : isNull(lists.ownerId));
    if ((count?.n ?? 0) >= MAX_LISTS_PER_OWNER) {
      throw new HttpError(400, "that is a lot of lists already; delete some first");
    }
    const [row] = await this.db
      .insert(lists)
      .values({ name, kind: input.kind ?? "todo", ownerId, createdById: actor.user.id })
      .returning();
    if (!row) throw new Error("insert failed");
    this.#changed(row);
    return this.#detail(row);
  }

  async update(
    user: UserRow,
    id: string,
    patch: { name?: string | undefined; kind?: ListKind | undefined },
  ): Promise<ListDetailDto> {
    await this.#visible(user, id);
    const [row] = await this.db
      .update(lists)
      .set({
        ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 100) } : {}),
        ...(patch.kind ? { kind: patch.kind } : {}),
        updatedAt: new Date(),
      })
      .where(eq(lists.id, id))
      .returning();
    if (!row) throw new HttpError(404, "list not found");
    this.#changed(row);
    return this.#detail(row);
  }

  async remove(user: UserRow, id: string): Promise<void> {
    const row = await this.#visible(user, id);
    if (row.ownerId === null && row.createdById !== user.id && !atLeast(user.role, "admin")) {
      throw new HttpError(403, "only whoever made a shared list or an admin can delete it");
    }
    await this.db.delete(lists).where(eq(lists.id, id));
    this.notify(row.ownerId, { type: "list_changed", listId: id, deleted: true });
  }

  async addItems(
    actor: ListActor,
    id: string,
    items: Array<{
      text: string;
      dueOn?: string | null | undefined;
      note?: string | null | undefined;
    }>,
  ): Promise<{ list: ListDetailDto; added: string[]; skipped: string[] }> {
    const row = await this.#visible(actor.user, id);
    const existing = await this.#items(id);
    if (existing.length + items.length > MAX_ITEMS_PER_LIST) {
      throw new HttpError(400, `a list holds at most ${MAX_ITEMS_PER_LIST} items`);
    }
    // Something already on the list and not checked off is not added twice.
    const open = new Set(existing.filter((i) => !i.checked).map((i) => norm(i.text)));
    let position = existing.reduce((max, i) => Math.max(max, i.position), 0);
    const added: string[] = [];
    const skipped: string[] = [];
    const values = [];
    for (const item of items) {
      const text = ItemText.parse(item.text);
      if (open.has(norm(text))) {
        skipped.push(text);
        continue;
      }
      open.add(norm(text));
      added.push(text);
      values.push({
        listId: id,
        text,
        position: ++position,
        dueOn: item.dueOn ? DueOn.parse(item.dueOn) : null,
        note: item.note ? Note.parse(item.note) || null : null,
        createdById: actor.user.id,
        createdByCrew: actor.crew?.slug ?? null,
      });
    }
    if (values.length) {
      await this.db.insert(listItems).values(values);
      await this.#touch(row);
    }
    return { list: await this.#detail(row), added, skipped };
  }

  async updateItem(
    user: UserRow,
    id: string,
    itemId: string,
    patch: UpdateListItemRequest,
  ): Promise<ListDetailDto> {
    const row = await this.#visible(user, id);
    const [item] = await this.db
      .select()
      .from(listItems)
      .where(and(eq(listItems.id, itemId), eq(listItems.listId, id)));
    if (!item) throw new HttpError(404, "item not found");
    await this.db
      .update(listItems)
      .set({
        ...(patch.text !== undefined ? { text: ItemText.parse(patch.text) } : {}),
        ...(patch.checked !== undefined
          ? { checked: patch.checked, checkedAt: patch.checked ? new Date() : null }
          : {}),
        ...(patch.dueOn !== undefined
          ? { dueOn: patch.dueOn ? DueOn.parse(patch.dueOn) : null }
          : {}),
        ...(patch.note !== undefined
          ? { note: patch.note ? Note.parse(patch.note) || null : null }
          : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
        updatedAt: new Date(),
      })
      .where(eq(listItems.id, itemId));
    await this.#touch(row);
    return this.#detail(row);
  }

  async removeItem(user: UserRow, id: string, itemId: string): Promise<ListDetailDto> {
    const row = await this.#visible(user, id);
    const gone = await this.db
      .delete(listItems)
      .where(and(eq(listItems.id, itemId), eq(listItems.listId, id)))
      .returning({ id: listItems.id });
    if (!gone.length) throw new HttpError(404, "item not found");
    await this.#touch(row);
    return this.#detail(row);
  }

  async clearChecked(user: UserRow, id: string): Promise<ListDetailDto> {
    const row = await this.#visible(user, id);
    await this.db
      .delete(listItems)
      .where(and(eq(listItems.listId, id), eq(listItems.checked, true)));
    await this.#touch(row);
    return this.#detail(row);
  }

  // ---------- for crew tools: lists and items by name ----------

  /** A visible list by id or name (case-insensitive); private lists win a tie with shared ones. */
  async find(user: UserRow, ref: string): Promise<ListDetailDto> {
    const key = norm(ref);
    const rows = await this.db
      .select()
      .from(lists)
      .where(or(isNull(lists.ownerId), eq(lists.ownerId, user.id)));
    const byId = rows.find((r) => r.id === ref.trim());
    if (byId) return this.#detail(byId);
    const named = rows.filter((r) => norm(r.name) === key);
    const pick = named.find((r) => r.ownerId) ?? named[0];
    if (!pick) {
      const names = rows.map((r) => `"${r.name}"`).join(", ");
      throw new HttpError(
        404,
        `no list called "${ref}"${names ? `; there are ${names}` : "; there are no lists yet"}`,
      );
    }
    return this.#detail(pick);
  }

  /**
   * Check, uncheck or remove items named by their text (or id): an exact match first, else the
   * one item whose text contains it. Ambiguous or unknown names are reported, not guessed.
   */
  async changeByText(
    actor: ListActor,
    listId: string,
    names: string[],
    change: { checked: boolean } | "remove",
  ): Promise<{ list: ListDetailDto; changed: string[]; missing: string[] }> {
    const row = await this.#visible(actor.user, listId);
    const items = await this.#items(listId);
    const changed: ItemRow[] = [];
    const missing: string[] = [];
    for (const name of names) {
      // A checked "Milk" from last week and today's open "Milk" can both be on the list:
      // checking off or removing means the open one, unchecking means the checked one.
      const hit = matchItem(items, name, (i) =>
        change === "remove" ? !i.checked : i.checked !== change.checked,
      );
      if (hit) changed.push(hit);
      else missing.push(name);
    }
    const ids = changed.map((i) => i.id);
    if (ids.length) {
      if (change === "remove") {
        await this.db.delete(listItems).where(inArray(listItems.id, ids));
      } else {
        await this.db
          .update(listItems)
          .set({
            checked: change.checked,
            checkedAt: change.checked ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(inArray(listItems.id, ids));
      }
      await this.#touch(row);
    }
    return { list: await this.#detail(row), changed: changed.map((i) => i.text), missing };
  }

  /** Unchecked items due on or before `until` (YYYY-MM-DD) on lists `user` can see. */
  async dueBy(user: UserRow, until: string): Promise<Array<{ list: string; item: ListItemDto }>> {
    const rows = await this.db
      .select({ item: listItems, listName: lists.name })
      .from(listItems)
      .innerJoin(lists, eq(lists.id, listItems.listId))
      .where(
        and(
          or(isNull(lists.ownerId), eq(lists.ownerId, user.id)),
          eq(listItems.checked, false),
          sql`${listItems.dueOn} <= ${until}`,
        ),
      )
      .orderBy(asc(listItems.dueOn));
    const names = await this.#names(rows.map((r) => r.item));
    return rows.map((r) => ({ list: r.listName, item: toItemDto(r.item, names) }));
  }

  // ---------- helpers ----------

  async #visible(user: UserRow, id: string): Promise<ListRow> {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "list not found");
    const [row] = await this.db.select().from(lists).where(eq(lists.id, id));
    // 404 for someone else's private list, so its existence does not leak.
    if (!row || (row.ownerId !== null && row.ownerId !== user.id)) {
      throw new HttpError(404, "list not found");
    }
    return row;
  }

  #items(listId: string): Promise<ItemRow[]> {
    return this.db
      .select()
      .from(listItems)
      .where(eq(listItems.listId, listId))
      .orderBy(asc(listItems.position), asc(listItems.createdAt));
  }

  async #touch(row: ListRow) {
    await this.db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, row.id));
    this.#changed(row);
  }

  #changed(row: ListRow) {
    this.notify(row.ownerId, { type: "list_changed", listId: row.id });
  }

  /** Display names of the people (by id) and crew members (by slug) who added items. */
  async #names(items: ItemRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(items.map((i) => i.createdById).filter((x): x is string => !!x))];
    const slugs = [...new Set(items.map((i) => i.createdByCrew).filter((x): x is string => !!x))];
    const people = ids.length
      ? await this.db
          .select({ id: users.id, name: users.displayName })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const crew = slugs.length
      ? await this.db
          .select({ id: crewMembers.slug, name: crewMembers.name })
          .from(crewMembers)
          .where(inArray(crewMembers.slug, slugs))
      : [];
    return new Map([...people, ...crew].map((r) => [r.id, r.name]));
  }

  async #dtos(rows: ListRow[]): Promise<ListDto[]> {
    if (!rows.length) return [];
    const counts = await this.db
      .select({
        listId: listItems.listId,
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where not ${listItems.checked})::int`,
      })
      .from(listItems)
      .where(
        inArray(
          listItems.listId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(listItems.listId);
    const byList = new Map(counts.map((c) => [c.listId, c]));
    const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((x): x is string => !!x))];
    const owners = ownerIds.length
      ? new Map(
          (
            await this.db
              .select({ id: users.id, name: users.displayName })
              .from(users)
              .where(inArray(users.id, ownerIds))
          ).map((u) => [u.id, u.name]),
        )
      : new Map<string, string>();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: ListKindSchema.catch("other").parse(r.kind),
      shared: r.ownerId === null,
      owner: r.ownerId ? { id: r.ownerId, name: owners.get(r.ownerId) ?? "someone" } : null,
      createdById: r.createdById,
      openCount: byList.get(r.id)?.open ?? 0,
      itemCount: byList.get(r.id)?.total ?? 0,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async #detail(row: ListRow): Promise<ListDetailDto> {
    const [fresh] = await this.db.select().from(lists).where(eq(lists.id, row.id));
    const [dto] = await this.#dtos([fresh ?? row]);
    if (!dto) throw new HttpError(404, "list not found");
    const items = await this.#items(row.id);
    const names = await this.#names(items);
    const sorted = [...items.filter((i) => !i.checked), ...items.filter((i) => i.checked)];
    return { ...dto, items: sorted.map((i) => toItemDto(i, names)) };
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The item `name` refers to. Among several candidates, those `prefer` accepts win (e.g. the open
 * copy of an item when checking it off), so a stale checked duplicate is not picked instead.
 */
export function matchItem<T extends { id: string; text: string }>(
  items: T[],
  name: string,
  prefer: (item: T) => boolean = () => true,
): T | undefined {
  const key = norm(name);
  if (!key) return undefined;
  const exact = items.filter((i) => i.id === name.trim() || norm(i.text) === key);
  if (exact.length) return exact.find(prefer) ?? exact[0];
  const partial = items.filter((i) => norm(i.text).includes(key));
  if (partial.length === 1) return partial[0];
  const preferred = partial.filter(prefer);
  return preferred.length === 1 ? preferred[0] : undefined;
}

function toItemDto(i: ItemRow, names: Map<string, string>): ListItemDto {
  const person = i.createdById ? (names.get(i.createdById) ?? null) : null;
  const crew = i.createdByCrew ? (names.get(i.createdByCrew) ?? i.createdByCrew) : null;
  return {
    id: i.id,
    text: i.text,
    checked: i.checked,
    dueOn: i.dueOn,
    note: i.note,
    position: i.position,
    addedBy: crew ? `${crew}${person ? ` for ${person}` : ""}` : person,
    checkedAt: i.checkedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  };
}
