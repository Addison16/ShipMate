import type { AttachmentDto, AttachmentKind, MessageDto } from "@shipmate/core";
import { ApiError, request } from "../api.js";

const enc = encodeURIComponent;

/** Mirrors the server's limits, so people hear about a too-big file before uploading it. */
export const FILE_LIMITS: Record<AttachmentKind, number> = {
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  text: 1024 * 1024,
};
export const MAX_FILES = 8;

/** What the file pickers offer. */
export const ACCEPT =
  "image/jpeg,image/png,image/webp,image/gif,application/pdf,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.xml,.log,.ics,.vcf";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|log|ini|toml|ics|vcf|srt)$/i;

/** The kind a file will be, from what the browser says (the server checks the bytes). */
export function kindOf(file: { name: string; type: string }): AttachmentKind | null {
  const t = file.type.toLowerCase();
  if (/^image\/(jpeg|png|webp|gif)$/.test(t)) return "image";
  if (t === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (t.startsWith("text/") || t === "application/json" || TEXT_EXT.test(file.name)) return "text";
  if (/^image\/hei[cf]$/.test(t) || /\.hei[cf]$/i.test(file.name)) return null;
  return null;
}

/** Why a file cannot be attached, or null when it can. */
export function fileProblem(file: { name: string; type: string; size: number }): string | null {
  const kind = kindOf(file);
  if (!kind) {
    return /hei[cf]/i.test(`${file.type} ${file.name}`)
      ? `${file.name} is a HEIC photo. Share it as JPEG (or set Camera → Formats → Most Compatible).`
      : `${file.name}: Shipmate takes photos, PDFs and text files.`;
  }
  if (file.size > FILE_LIMITS[kind]) {
    return `${file.name} is over ${FILE_LIMITS[kind] / 1024 / 1024} MB.`;
  }
  if (!file.size) return `${file.name} is empty.`;
  return null;
}

/** Files a sent message carries in `meta.attachments`; read defensively. */
export function messageAttachments(message: MessageDto): AttachmentDto[] {
  const list = message.meta?.attachments;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a): AttachmentDto[] => {
    if (!a || typeof a !== "object") return [];
    const o = a as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.name !== "string") return [];
    const kind = o.kind === "image" || o.kind === "pdf" || o.kind === "text" ? o.kind : "text";
    return [
      {
        id: o.id,
        name: o.name,
        kind,
        mimeType: typeof o.mimeType === "string" ? o.mimeType : "",
        size: typeof o.size === "number" ? o.size : 0,
      },
    ];
  });
}

export const attachmentUrl = (id: string) => `/api/attachments/${enc(id)}`;

export const filesApi = {
  async upload(conversationId: string, file: File): Promise<AttachmentDto> {
    let res: Response;
    try {
      res = await fetch(`/api/conversations/${enc(conversationId)}/attachments`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": enc(file.name),
          "x-file-type": file.type,
        },
        body: file,
      });
    } catch {
      throw new ApiError(0, "Cannot reach the Shipmate server.");
    }
    const data = (await res.json().catch(() => null)) as {
      attachment?: AttachmentDto;
      error?: string;
    } | null;
    if (!res.ok || !data?.attachment) {
      throw new ApiError(res.status, data?.error ?? `Upload failed (${res.status}).`);
    }
    return data.attachment;
  },
  discard: (id: string) => request<{ ok: true }>("DELETE", attachmentUrl(id)),
};
