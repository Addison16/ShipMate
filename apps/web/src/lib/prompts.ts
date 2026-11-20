import type { SavedPromptDto } from "@shipmate/core";
import { request } from "../api.js";

const enc = encodeURIComponent;

export const promptsApi = {
  list: () => request<{ prompts: SavedPromptDto[] }>("GET", "/api/prompts"),
  create: (body: { title: string; body: string; shared: boolean }) =>
    request<{ prompt: SavedPromptDto }>("POST", "/api/prompts", body),
  update: (id: string, body: { title?: string; body?: string; shared?: boolean }) =>
    request<{ prompt: SavedPromptDto }>("PATCH", `/api/prompts/${enc(id)}`, body),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/prompts/${enc(id)}`),
};

/**
 * What is typed after a leading "/" while the message is still only that (one line, starting
 * with "/"), or null when the "/" menu should not show. "/meal pl" → "meal pl".
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/") || text.includes("\n") || text.length > 40) return null;
  return text.slice(1).toLowerCase();
}

/** Saved prompts whose title has every typed word; titles that start with the text come first. */
export function matchPrompts<T extends { title: string }>(prompts: T[], query: string): T[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const q = query.trim();
  return prompts
    .filter((p) => {
      const title = p.title.toLowerCase();
      return words.every((w) => title.includes(w));
    })
    .map((p, index) => ({ p, index, first: q !== "" && p.title.toLowerCase().startsWith(q) }))
    .sort((a, b) => Number(b.first) - Number(a.first) || a.index - b.index)
    .map((x) => x.p);
}
