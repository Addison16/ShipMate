import { createReadStream, mkdirSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttachmentDto, AttachmentKind } from "@shipmate/core";
import { attachments, conversations, type Db } from "@shipmate/db";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { HttpError } from "../auth.js";

type Row = typeof attachments.$inferSelect;

/** Per-kind size limits. The upload route's body limit is the largest of these. */
export const FILE_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 1024 * 1024,
};
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(FILE_LIMITS));
/** Files per message. */
export const MAX_FILES_PER_MESSAGE = 8;
/** Characters of text taken from one file, and from all files of a message, for the model. */
const TEXT_PER_FILE = 60_000;
const TEXT_PER_MESSAGE = 150_000;
/** Uploads never sent are removed after this long. */
const UNSENT_TTL_MS = 24 * 3600_000;

/** Text files people send: by type, or by extension when the browser does not know the type. */
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "text/xml",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "text/yaml",
]);
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ini|toml|ics|vcf|srt|py|js|ts|sh|sql)$/i;

/** The kind and real type of an upload, from its first bytes (never from what the client says). */
export function detectFile(
  data: Buffer,
  claimedType: string,
  name: string,
): { kind: AttachmentKind; mimeType: string } | null {
  const b = data;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) {
    return { kind: "image", mimeType: "image/gif" };
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("latin1") === "RIFF" &&
    b.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { kind: "image", mimeType: "image/webp" };
  }
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  const type = claimedType.split(";")[0]?.trim().toLowerCase() ?? "";
  if ((TEXT_TYPES.has(type) || TEXT_EXTENSIONS.test(name)) && isUtf8Text(b)) {
    return { kind: "text", mimeType: "text/plain" };
  }
  return null;
}

function isUtf8Text(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Keep the name readable but harmless: no paths, no control characters, not too long. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const s = base.replace(/[\u0000-\u001f\u007f"<>]/g, "").trim();
  return s.slice(-120) || "file";
}

/** Reads a PDF's text layer (injectable for tests). */
export type PdfReader = (data: Uint8Array) => Promise<string>;

const readPdf: PdfReader = async (data) => {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(data, { mergePages: true });
  return text;
};

export interface PreparedFiles {
  /** Text to append to the person's message for the model (PDF and text files). */
  text: string;
  /** Images to pass as image content. */
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  /** Names of the images, for a note when the model cannot see them. */
  imageNames: string[];
}

/**
 * Files in chat: uploads into <data>/files/<id> with a row per file, readable only by the
 * person who uploaded it. A file is uploaded first (unsent), then claimed by the message it
 * is sent with; unsent ones are cleaned up after a day.
 */
export class AttachmentService {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly pdf: PdfReader = readPdf,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async upload(
    userId: string,
    conversationId: string,
    input: { name: string; type: string; data: Buffer },
  ): Promise<AttachmentDto> {
    const [conv] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conv) throw new HttpError(404, "conversation not found");
    const name = cleanName(input.name);
    const found = detectFile(input.data, input.type, name);
    if (!found) {
      throw new HttpError(
        415,
        "Shipmate takes photos (JPEG, PNG, WebP, GIF), PDFs and text files. On an iPhone, set Camera → Formats to Most Compatible, or share the photo as JPEG.",
      );
    }
    const limit = FILE_LIMITS[found.kind];
    if (input.data.length > limit) {
      throw new HttpError(
        413,
        `That ${found.kind === "image" ? "photo" : "file"} is over ${limit / 1024 / 1024} MB.`,
      );
    }
    if (!input.data.length) throw new HttpError(400, "That file is empty.");

    let text: string | null = null;
    if (found.kind === "pdf") {
      try {
        // Text layers of some PDFs carry NUL for unmapped glyphs; Postgres text refuses them.
        text = (await this.pdf(new Uint8Array(input.data))).replaceAll("\u0000", "").trim();
      } catch {
        throw new HttpError(
          422,
          "Could not read that PDF. It may be damaged or password protected.",
        );
      }
    } else if (found.kind === "text") {
      text = input.data.toString("utf8");
    }

    await this.#sweepUnsent(userId);
    const [row] = await this.db
      .insert(attachments)
      .values({
        userId,
        conversationId,
        name,
        mimeType: found.mimeType,
        kind: found.kind,
        size: input.data.length,
        text,
      })
      .returning();
    if (!row) throw new Error("insert failed");
    try {
      await writeFile(this.#path(row.id), input.data, { mode: 0o600 });
    } catch (err) {
      await this.db.delete(attachments).where(eq(attachments.id, row.id));
      throw err;
    }
    return toDto(row);
  }

  /**
   * The person's unsent uploads in this conversation, for the message they are sending.
   * Throws when any id is not theirs, not here, or already sent.
   */
  async claim(userId: string, conversationId: string, ids: string[]): Promise<Row[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    if (unique.length > MAX_FILES_PER_MESSAGE) {
      throw new HttpError(400, `Send at most ${MAX_FILES_PER_MESSAGE} files at once.`);
    }
    const rows = await this.db
      .select()
      .from(attachments)
      .where(
        and(
          inArray(attachments.id, unique),
          eq(attachments.userId, userId),
          eq(attachments.conversationId, conversationId),
          isNull(attachments.messageId),
        ),
      );
    if (rows.length !== unique.length) {
      throw new HttpError(400, "An attached file is missing or was already sent. Attach it again.");
    }
    return unique.map((id) => rows.find((r) => r.id === id) as Row);
  }

  async attach(ids: string[], messageId: string): Promise<void> {
    if (!ids.length) return;
    await this.db.update(attachments).set({ messageId }).where(inArray(attachments.id, ids));
  }

  /** Turn claimed files into what the model gets: text blocks and image content. */
  async prepare(rows: Row[]): Promise<PreparedFiles> {
    const out: PreparedFiles = { text: "", images: [], imageNames: [] };
    let budget = TEXT_PER_MESSAGE;
    const blocks: string[] = [];
    for (const r of rows) {
      if (r.kind === "image") {
        const data = await readFile(this.#path(r.id));
        out.images.push({ type: "image", data: data.toString("base64"), mimeType: r.mimeType });
        out.imageNames.push(r.name);
        continue;
      }
      const raw = r.text ?? "";
      const take = Math.max(0, Math.min(TEXT_PER_FILE, budget));
      budget -= Math.min(raw.length, take);
      const body = raw
        ? `${raw.slice(0, take)}${raw.length > take ? "\n[… the rest of the file was cut to fit]" : ""}`
        : r.kind === "pdf"
          ? "[This PDF has no text layer; it is probably a scan. Ask for a photo of the pages instead.]"
          : "[empty file]";
      blocks.push(`<attached-file name="${r.name}" type="${r.kind}">\n${body}\n</attached-file>`);
    }
    out.text = blocks.join("\n\n");
    return out;
  }

  /** The file for download, if it is this person's. */
  async open(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
      .limit(1);
    if (!row) throw new HttpError(404, "file not found");
    return { row, stream: () => createReadStream(this.#path(row.id)) };
  }

  /** Remove an upload that was not sent (the × on the composer chip). */
  async discard(userId: string, id: string): Promise<void> {
    const [row] = await this.db
      .delete(attachments)
      .where(
        and(eq(attachments.id, id), eq(attachments.userId, userId), isNull(attachments.messageId)),
      )
      .returning({ id: attachments.id });
    if (!row) throw new HttpError(404, "file not found");
    await rm(this.#path(row.id), { force: true });
  }

  /** Ids of every file in a conversation (to remove the bytes once it is deleted). */
  async idsIn(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.conversationId, conversationId));
    return rows.map((r) => r.id);
  }

  async removeFiles(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => rm(this.#path(id), { force: true })));
  }

  /**
   * Remove uploads never sent within a day (anyone's), and files whose rows are gone (deleted
   * conversations, users). Run at boot and then hourly.
   */
  async sweep(): Promise<number> {
    await this.#sweepUnsent();
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    const ids = names.filter((n) => /^[0-9a-f-]{36}$/.test(n));
    const known = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .select({ id: attachments.id })
        .from(attachments)
        .where(inArray(attachments.id, ids.slice(i, i + 500)));
      for (const r of rows) known.add(r.id);
    }
    const orphans = ids.filter((id) => !known.has(id));
    await Promise.all(orphans.map((id) => rm(this.#path(id), { force: true })));
    return orphans.length;
  }

  async #sweepUnsent(userId?: string) {
    const old = await this.db
      .delete(attachments)
      .where(
        and(
          userId ? eq(attachments.userId, userId) : undefined,
          isNull(attachments.messageId),
          lt(attachments.createdAt, new Date(Date.now() - UNSENT_TTL_MS)),
        ),
      )
      .returning({ id: attachments.id });
    await Promise.all(old.map((r) => rm(this.#path(r.id), { force: true })));
  }

  #path(id: string): string {
    // Ids are uuids from the database, never names from the client.
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad file id");
    return join(this.dir, id);
  }
}

export function toDto(r: Row): AttachmentDto {
  return {
    id: r.id,
    name: r.name,
    mimeType: r.mimeType,
    kind: r.kind as AttachmentKind,
    size: r.size,
  };
}
