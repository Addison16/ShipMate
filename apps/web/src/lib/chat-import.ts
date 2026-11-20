import type { ChatImportResult, ChatImportSource, ImportedChat } from "@shipmate/core";
import { Unzip, UnzipInflate } from "fflate";
import { request } from "../api.js";

/** What one export file holds, ready to send. */
export interface ParsedExport {
  source: ChatImportSource;
  chats: ImportedChat[];
}

const MAX_MESSAGE_CHARS = 200_000;
const MAX_MESSAGES = 5000;
/** A batch stays well under the server's body limit. */
const BATCH_CHARS = 1_500_000;
const BATCH_CHATS = 50;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Seconds since 1970 (ChatGPT) or an ISO string (Claude) → ISO; "" when neither. */
function iso(v: unknown): string {
  const d = typeof v === "number" ? new Date(v * 1000) : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : "";
}

/**
 * One ChatGPT conversation. The export keeps every edit and retry as a tree; the chat as it was
 * last shown is the path from `current_node` back to the root. Hidden, system and tool
 * messages are left out, and a picture becomes a short note.
 */
function fromChatGpt(c: Json): ImportedChat | null {
  const mapping = isObject(c.mapping) ? c.mapping : null;
  if (!mapping) return null;
  let nodeId = text(c.current_node);
  if (!nodeId) {
    // Older exports: take the newest leaf.
    let newest = -1;
    for (const [id, node] of Object.entries(mapping)) {
      if (!isObject(node) || (Array.isArray(node.children) && node.children.length)) continue;
      const at = isObject(node.message) ? Number(node.message.create_time ?? 0) : 0;
      if (at >= newest) {
        newest = at;
        nodeId = id;
      }
    }
  }
  const messages: ImportedChat["messages"] = [];
  const seen = new Set<string>();
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!isObject(node)) break;
    const m = isObject(node.message) ? node.message : null;
    const role = m && isObject(m.author) ? text(m.author.role) : "";
    const hidden =
      m && isObject(m.metadata) && m.metadata.is_visually_hidden_from_conversation === true;
    // An assistant message addressed to a tool is a tool call, not something it said.
    const toTool = m && typeof m.recipient === "string" && m.recipient !== "all";
    if (m && (role === "user" || role === "assistant") && !hidden && !toTool) {
      const content = isObject(m.content) ? m.content : {};
      const kind = text(content.content_type);
      const parts = Array.isArray(content.parts) ? content.parts : [];
      const said =
        kind === "text" || kind === "multimodal_text"
          ? parts
              .map((p) => (typeof p === "string" ? p : isObject(p) ? "[picture or file]" : ""))
              .filter(Boolean)
              .join("\n\n")
          : "";
      if (said.trim()) {
        messages.push({
          role,
          text: said.slice(0, MAX_MESSAGE_CHARS),
          at: iso(m.create_time),
        });
      }
    }
    nodeId = text(node.parent);
  }
  messages.reverse();
  const externalId = text(c.conversation_id) || text(c.id);
  if (!externalId || !messages.length) return null;
  const createdAt = iso(c.create_time) || messages[0]?.at || "";
  return {
    externalId,
    title: text(c.title) || "Untitled chat",
    createdAt,
    updatedAt: iso(c.update_time) || createdAt,
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/** One Claude conversation: a flat list of what each side said. */
function fromClaude(c: Json): ImportedChat | null {
  const list = Array.isArray(c.chat_messages) ? c.chat_messages : null;
  if (!list) return null;
  const messages: ImportedChat["messages"] = [];
  for (const m of list) {
    if (!isObject(m)) continue;
    const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const blocks = Array.isArray(m.content)
      ? m.content
          .map((b) => (isObject(b) && b.type === "text" ? text(b.text) : ""))
          .filter(Boolean)
          .join("\n\n")
      : "";
    const said = blocks || text(m.text);
    if (!said.trim()) continue;
    messages.push({ role, text: said.slice(0, MAX_MESSAGE_CHARS), at: iso(m.created_at) });
  }
  const externalId = text(c.uuid);
  if (!externalId || !messages.length) return null;
  const createdAt = iso(c.created_at) || messages[0]?.at || "";
  return {
    externalId,
    title: text(c.name) || "Untitled chat",
    createdAt,
    updatedAt: iso(c.updated_at) || createdAt,
    messages: messages.slice(-MAX_MESSAGES),
  };
}

/**
 * Read the parsed contents of a `conversations.json`. Which app it came from is told from its
 * shape. Throws a plain sentence when it is neither.
 */
export function parseExport(data: unknown): ParsedExport {
  const list = Array.isArray(data) ? data.filter(isObject) : [];
  const first = list[0];
  const source: ChatImportSource | null = !first
    ? null
    : "mapping" in first
      ? "chatgpt"
      : "chat_messages" in first
        ? "claude"
        : null;
  if (!source) {
    throw new Error("This file does not look like a ChatGPT or Claude export.");
  }
  const chats: ImportedChat[] = [];
  for (const c of list) {
    const chat = source === "chatgpt" ? fromChatGpt(c) : fromClaude(c);
    if (chat) chats.push(chat);
  }
  return { source, chats };
}

/** The files inside an export zip that hold chats (newer ChatGPT exports split them up). */
export const isChatsFile = (name: string) => /(^|\/)conversations(-\d+)?\.json$/i.test(name);

/**
 * Pull the chat files out of an export zip, a piece at a time, so the pictures and recordings
 * in a large export are never unpacked or held in memory.
 */
async function chatFilesFromZip(file: Blob): Promise<string[]> {
  const found: Array<{ chunks: Uint8Array[]; done: boolean }> = [];
  let failed: unknown = null;
  const unzip = new Unzip((entry) => {
    if (!isChatsFile(entry.name)) return;
    const slot = { chunks: [] as Uint8Array[], done: false };
    found.push(slot);
    entry.ondata = (err, chunk, final) => {
      if (err) failed = err;
      else slot.chunks.push(chunk);
      if (final) slot.done = true;
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (failed) throw new Error("This zip file could not be read.");
    if (done) break;
    unzip.push(value, false);
  }
  unzip.push(new Uint8Array(0), true);
  if (failed) throw new Error("This zip file could not be read.");
  return found.filter((f) => f.done).map((f) => new TextDecoder().decode(joinChunks(f.chunks)));
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Read an export: the .zip as downloaded, or the conversations.json from inside it. */
export async function readExportFile(file: File): Promise<ParsedExport> {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const zipped = head[0] === 0x50 && head[1] === 0x4b;
  let texts: string[];
  try {
    texts = zipped ? await chatFilesFromZip(file) : [await file.text()];
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "This file could not be read.");
  }
  if (!texts.length) throw new Error("No conversations.json was found in this zip file.");
  let result: ParsedExport | null = null;
  for (const t of texts) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      throw new Error("This file is not a readable export. Pick the .zip or conversations.json.");
    }
    const part = parseExport(data);
    if (!result) result = part;
    else if (result.source === part.source) result.chats.push(...part.chats);
  }
  if (!result) throw new Error("This file does not look like a ChatGPT or Claude export.");
  // Newest first, so the chats that matter most arrive first if the import is stopped.
  result.chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return result;
}

/** Split chats into batches small enough to send. */
export function batches(chats: ImportedChat[]): ImportedChat[][] {
  const out: ImportedChat[][] = [];
  let current: ImportedChat[] = [];
  let size = 0;
  const sizeOf = (c: ImportedChat) =>
    c.messages.reduce((n, m) => n + m.text.length + 60, c.title.length + 200);
  for (let chat of chats) {
    let chars = sizeOf(chat);
    if (chars > BATCH_CHARS) {
      // One enormous chat: keep as much of its end as fits in a batch.
      const kept: ImportedChat["messages"] = [];
      let used = 0;
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        const m = chat.messages[i];
        if (!m) continue;
        if (used + m.text.length + 60 > BATCH_CHARS - 1000 && kept.length) break;
        const fits = m.text.slice(0, BATCH_CHARS - 1000 - used);
        used += fits.length + 60;
        kept.unshift({ ...m, text: fits });
      }
      chat = { ...chat, messages: kept };
      chars = sizeOf(chat);
    }
    if (current.length && (size + chars > BATCH_CHARS || current.length >= BATCH_CHATS)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(chat);
    size += chars;
  }
  if (current.length) out.push(current);
  return out;
}

/** Send a parsed export, batch by batch; `onProgress` gets the number of chats handled so far. */
export async function sendExport(
  parsed: ParsedExport,
  options: { archive: boolean; onProgress: (done: number) => void; stopped?: () => boolean },
): Promise<ChatImportResult> {
  const total: ChatImportResult = { imported: 0, skipped: 0 };
  let done = 0;
  for (const batch of batches(parsed.chats)) {
    if (options.stopped?.()) break;
    const r = await request<ChatImportResult>("POST", "/api/conversations/import", {
      source: parsed.source,
      archive: options.archive,
      chats: batch,
    });
    total.imported += r.imported;
    total.skipped += r.skipped;
    done += batch.length;
    options.onProgress(done);
  }
  return total;
}
