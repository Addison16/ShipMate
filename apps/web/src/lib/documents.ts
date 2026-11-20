import type { DocumentDto, DocumentHitDto } from "@shipmate/core";
import { ApiError, request } from "../api.js";

const enc = encodeURIComponent;

/** Mirrors the server's limits, so people hear about a too-big file before uploading it. */
const PDF_LIMIT = 20 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;

/** What the file picker offers. */
export const DOCUMENT_ACCEPT = "application/pdf,text/*,.md,.csv,.tsv,.json,.yaml,.yml,.log";

/** Why a file cannot go in the library, or null when it can (the server checks the bytes). */
export function documentProblem(file: { name: string; type: string; size: number }): string | null {
  const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (file.type.startsWith("image/")) {
    return `${file.name} is a picture. Documents takes PDFs and text files.`;
  }
  if (!file.size) return `${file.name} is empty.`;
  const limit = pdf ? PDF_LIMIT : TEXT_LIMIT;
  if (file.size > limit) return `${file.name} is over ${limit / 1024 / 1024} MB.`;
  return null;
}

/** "about 12 pages" from a character count (a printed page holds roughly 3,000). */
export function roughLength(chars: number): string {
  const pages = Math.round(chars / 3000);
  if (pages < 1) return "under a page";
  return pages === 1 ? "about 1 page" : `about ${pages.toLocaleString()} pages`;
}

export const documentUrl = (id: string) => `/api/documents/${enc(id)}`;

export const documentsApi = {
  list: () => request<{ documents: DocumentDto[] }>("GET", "/api/documents"),
  search: (q: string) =>
    request<{ hits: DocumentHitDto[] }>("GET", `/api/documents/search?q=${enc(q)}`),
  update: (id: string, body: { name?: string; shared?: boolean }) =>
    request<{ document: DocumentDto }>("PATCH", documentUrl(id), body),
  remove: (id: string) => request<{ ok: true }>("DELETE", documentUrl(id)),
  async add(file: File, onlyMe: boolean): Promise<DocumentDto> {
    let res: Response;
    try {
      res = await fetch(`/api/documents${onlyMe ? "?private=1" : ""}`, {
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
      document?: DocumentDto;
      error?: string;
    } | null;
    if (!res.ok || !data?.document) {
      throw new ApiError(res.status, data?.error ?? `Upload failed (${res.status}).`);
    }
    return data.document;
  },
};
