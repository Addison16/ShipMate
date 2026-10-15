import type { AttachmentDto, MessageDto } from "@shipmate/core";

/** Pictures sent with one crew reply, at most. */
export const MAX_PICTURES = 8;

/** A picture ready to upload to a chat app. */
export interface Picture {
  name: string;
  mimeType: string;
  data: Buffer;
}

/** Reads a stored file's bytes for its owner (AttachmentService.read). */
export type ReadFile = (userId: string, fileId: string) => Promise<Buffer>;

/** The picture attachments of a reply (`meta.attachments`), read defensively, capped. */
export function replyPictures(message: Pick<MessageDto, "meta">): AttachmentDto[] {
  const list = message.meta?.attachments;
  if (!Array.isArray(list)) return [];
  const out: AttachmentDto[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (o.kind !== "image" || typeof o.id !== "string") continue;
    out.push({
      id: o.id,
      name: typeof o.name === "string" && o.name ? o.name : "picture",
      kind: "image",
      mimeType: typeof o.mimeType === "string" ? o.mimeType : "",
      size: typeof o.size === "number" ? o.size : 0,
    });
  }
  return out.slice(0, MAX_PICTURES);
}

/**
 * Load the pictures' bytes. A picture that cannot be read or is over `maxBytes` is skipped
 * with one log line; the rest still go.
 */
export async function loadPictures(
  userId: string,
  pictures: AttachmentDto[],
  options: { read: ReadFile; maxBytes: number; log?: (message: string, err?: unknown) => void },
): Promise<Picture[]> {
  const out: Picture[] = [];
  for (const p of pictures) {
    const tooBig = () => options.log?.(`skipped picture ${p.name}: over the size limit`);
    if (p.size > options.maxBytes) {
      tooBig();
      continue;
    }
    let data: Buffer;
    try {
      data = await options.read(userId, p.id);
    } catch (err) {
      options.log?.(`skipped picture ${p.name}: could not read it`, err);
      continue;
    }
    if (data.length > options.maxBytes) {
      tooBig();
      continue;
    }
    if (!data.length) continue;
    out.push({ name: p.name, mimeType: p.mimeType || "application/octet-stream", data });
  }
  return out;
}
