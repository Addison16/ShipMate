import { createReadStream, mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentDto, DocumentHitDto } from "@shipmate/core";
import { type Db, documentChunks, documents } from "@shipmate/db";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { atLeast, HttpError, type UserRow } from "../auth.js";
import { cleanName, detectFile, FILE_LIMITS, type PdfReader } from "../files/service.js";

type Row = typeof documents.$inferSelect;

/** Passages are about this long, so a few of them fit any model's context. */
const CHUNK_CHARS = 1200;
/** Text kept from one document (a very long book is cut here). */
const MAX_CHARS = 2_000_000;
const MAX_DOCUMENTS = 2000;
/** Passages returned by one `read` call. */
export const PARTS_PER_READ = 6;

const readPdf: PdfReader = async (data) => {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(data, { mergePages: true });
  return text;
};

/** Split text into passages of about CHUNK_CHARS, breaking at paragraphs, then at spaces. */
export function splitPassages(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let current = "";
  const push = () => {
    const t = current.trim();
    if (t) out.push(t);
    current = "";
  };
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    let p = para.trim();
    if (!p) continue;
    if (current && current.length + p.length + 2 > size) push();
    while (p.length > size) {
      // Break at the last sentence end or space before the limit; a wordless run is cut hard.
      const head = p.slice(0, size);
      const at = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"), head.lastIndexOf(" "));
      const cut = at > size / 2 ? at + 1 : size;
      if (current) push();
      out.push(p.slice(0, cut).trim());
      p = p.slice(cut).trim();
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  push();
  return out;
}

/** The words of a question as an "any of these" full-text query, or null when it has none. */
export function searchQuery(q: string): string | null {
  const words = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 16);
  return words.length ? words.join(" | ") : null;
}

/**
 * The document library: manuals, policies and letters people add once so any crew member can
 * look things up in them. Text is split into passages and found with Postgres full-text
 * search, which needs no extra model and works the same for every engine.
 */
export class DocumentService {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly pdf: PdfReader = readPdf,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async list(user: UserRow): Promise<DocumentDto[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .where(visibleTo(user))
      .orderBy(asc(documents.name), desc(documents.createdAt));
    return rows.map((r) => toDto(r, user));
  }

  async add(
    user: UserRow,
    input: { name: string; type: string; data: Buffer; shared: boolean },
  ): Promise<DocumentDto> {
    const name = cleanName(input.name);
    const found = detectFile(input.data, input.type, name);
    if (!found || found.kind === "image") {
      throw new HttpError(415, "The library takes PDFs and text files.");
    }
    if (!input.data.length) throw new HttpError(400, "That file is empty.");
    const limit = FILE_LIMITS[found.kind];
    if (input.data.length > limit) {
      throw new HttpError(413, `That file is over ${limit / 1024 / 1024} MB.`);
    }
    let text: string;
    if (found.kind === "pdf") {
      try {
        text = (await this.pdf(new Uint8Array(input.data))).replaceAll("\u0000", "");
      } catch {
        throw new HttpError(
          422,
          "Could not read that PDF. It may be damaged or password protected.",
        );
      }
    } else {
      text = input.data.toString("utf8");
    }
    text = text.trim().slice(0, MAX_CHARS);
    if (!text) {
      throw new HttpError(
        422,
        "There is no text in that file to read. A scanned PDF needs a version with text.",
      );
    }
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(documents);
    if (n >= MAX_DOCUMENTS) throw new HttpError(400, "The library is full. Delete some first.");

    const passages = splitPassages(text);
    const stored = await this.#freeName(name);
    const row = await this.db.transaction(async (tx) => {
      const [doc] = await tx
        .insert(documents)
        .values({
          ownerId: input.shared ? null : user.id,
          createdById: user.id,
          name: stored,
          kind: found.kind,
          size: input.data.length,
          chars: text.length,
          parts: passages.length,
        })
        .returning();
      if (!doc) throw new Error("insert failed");
      for (let i = 0; i < passages.length; i += 200) {
        await tx.insert(documentChunks).values(
          passages.slice(i, i + 200).map((t, j) => ({
            documentId: doc.id,
            position: i + j,
            text: t,
          })),
        );
      }
      return doc;
    });
    try {
      await writeFile(this.#path(row.id), input.data, { mode: 0o600 });
    } catch (err) {
      await this.db.delete(documents).where(eq(documents.id, row.id));
      throw err;
    }
    return toDto(row, user);
  }

  async update(
    user: UserRow,
    id: string,
    patch: { name?: string | undefined; shared?: boolean | undefined },
  ): Promise<DocumentDto> {
    const row = await this.#mine(user, id);
    const [next] = await this.db
      .update(documents)
      .set({
        ...(patch.name !== undefined
          ? { name: await this.#freeName(cleanName(patch.name), row.id) }
          : {}),
        ...(patch.shared !== undefined
          ? { ownerId: patch.shared ? null : (row.createdById ?? user.id) }
          : {}),
      })
      .where(eq(documents.id, row.id))
      .returning();
    return toDto(next ?? row, user);
  }

  async remove(user: UserRow, id: string): Promise<void> {
    const row = await this.#mine(user, id);
    await this.db.delete(documents).where(eq(documents.id, row.id));
    await rm(this.#path(row.id), { force: true });
  }

  /** The original file for download, if this person can see it. */
  async open(user: UserRow, id: string) {
    const row = await this.#visible(user, id);
    return { row, stream: () => createReadStream(this.#path(row.id)) };
  }

  /** The passages that best match the words of a question, best first. */
  async search(user: UserRow, query: string, limit = 5): Promise<DocumentHitDto[]> {
    const q = searchQuery(query);
    if (!q) return [];
    const rows = await this.db
      .select({
        documentId: documents.id,
        name: documents.name,
        parts: documents.parts,
        position: documentChunks.position,
        text: documentChunks.text,
        rank: sql<number>`ts_rank_cd(to_tsvector('english', ${documentChunks.text} || ' ' || ${documents.name}), to_tsquery('english', ${q}))`.as(
          "rank",
        ),
      })
      .from(documentChunks)
      .innerJoin(documents, eq(documents.id, documentChunks.documentId))
      .where(
        and(
          visibleTo(user),
          sql`to_tsvector('english', ${documentChunks.text} || ' ' || ${documents.name}) @@ to_tsquery('english', ${q})`,
        ),
      )
      .orderBy(sql`rank desc`, asc(documentChunks.position))
      .limit(Math.min(20, Math.max(1, limit)));
    return rows.map((r) => ({
      documentId: r.documentId,
      name: r.name,
      part: r.position + 1,
      parts: r.parts,
      text: r.text,
    }));
  }

  /**
   * A stretch of a document for a crew member: PARTS_PER_READ passages from `part` (1-based).
   * The document is found by id, exact name, or a part of the name only one document has.
   */
  async read(
    user: UserRow,
    ref: string,
    part = 1,
  ): Promise<{ document: DocumentDto; from: number; to: number; parts: number; text: string }> {
    const all = await this.db.select().from(documents).where(visibleTo(user));
    const want = ref.trim().toLowerCase();
    const exact = all.filter((d) => d.id === want || d.name.toLowerCase() === want);
    const loose = exact.length ? exact : all.filter((d) => d.name.toLowerCase().includes(want));
    if (!want || !loose.length) {
      throw new HttpError(404, `No document named "${ref}". Use list_documents for the names.`);
    }
    if (loose.length > 1 && !exact.length) {
      throw new HttpError(
        400,
        `"${ref}" matches several documents: ${loose
          .slice(0, 8)
          .map((d) => d.name)
          .join(", ")}. Use the full name.`,
      );
    }
    // Two documents with the same name: a private one wins over a shared one.
    const doc = loose.find((d) => d.ownerId) ?? (loose[0] as Row);
    const from = Math.min(Math.max(1, Math.floor(part) || 1), Math.max(1, doc.parts));
    const chunks = await this.db
      .select({ text: documentChunks.text })
      .from(documentChunks)
      .where(
        and(
          eq(documentChunks.documentId, doc.id),
          sql`${documentChunks.position} >= ${from - 1}`,
          sql`${documentChunks.position} < ${from - 1 + PARTS_PER_READ}`,
        ),
      )
      .orderBy(asc(documentChunks.position));
    return {
      document: toDto(doc, user),
      from,
      to: from + chunks.length - 1,
      parts: doc.parts,
      text: chunks.map((c) => c.text).join("\n\n"),
    };
  }

  /**
   * A name no other document has: "manual.pdf" becomes "manual (2).pdf". Crew find documents
   * by name, so two with the same name would let a search hit lead to the wrong one.
   */
  async #freeName(name: string, except?: string): Promise<string> {
    const rows = await this.db.select({ id: documents.id, name: documents.name }).from(documents);
    const taken = new Set(rows.filter((r) => r.id !== except).map((r) => r.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    for (let n = 2; ; n++) {
      const next = `${base} (${n})${ext}`;
      if (!taken.has(next.toLowerCase())) return next;
    }
  }

  async #visible(user: UserRow, id: string): Promise<Row> {
    if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "document not found");
    const [row] = await this.db.select().from(documents).where(eq(documents.id, id));
    // 404 for someone else's private document, so its existence does not leak.
    if (!row || (row.ownerId !== null && row.ownerId !== user.id)) {
      throw new HttpError(404, "document not found");
    }
    return row;
  }

  async #mine(user: UserRow, id: string): Promise<Row> {
    const row = await this.#visible(user, id);
    if (!canChange(row, user)) {
      throw new HttpError(403, "Only the person who added it, or an admin, can change it.");
    }
    return row;
  }

  #path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad document id");
    return join(this.dir, id);
  }
}

const visibleTo = (user: UserRow) => or(isNull(documents.ownerId), eq(documents.ownerId, user.id));

function canChange(row: Row, user: UserRow): boolean {
  if (row.ownerId) return row.ownerId === user.id;
  return row.createdById === user.id || atLeast(user.role, "admin");
}

function toDto(r: Row, user: UserRow): DocumentDto {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === "pdf" ? "pdf" : "text",
    size: r.size,
    chars: r.chars,
    shared: r.ownerId === null,
    mine: canChange(r, user),
    createdAt: r.createdAt.toISOString(),
  };
}
