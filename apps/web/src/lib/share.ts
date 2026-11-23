import type { ChatShareDto, SharedChatDto } from "@shipmate/core";
import { request } from "../api.js";

const enc = encodeURIComponent;

export const shareApi = {
  get: (id: string) =>
    request<{ share: ChatShareDto | null }>("GET", `/api/conversations/${enc(id)}/share`),
  share: (id: string) =>
    request<{ share: ChatShareDto }>("POST", `/api/conversations/${enc(id)}/share`),
  stop: (id: string) => request<{ ok: true }>("DELETE", `/api/conversations/${enc(id)}/share`),
  view: (token: string) => request<SharedChatDto>("GET", `/api/shared/${enc(token)}`),
};

/** The address to hand out for a share token, on whatever address the app is open at. */
export function shareUrl(token: string, origin = window.location.origin): string {
  return `${origin}/#/shared/${enc(token)}`;
}

/** The share token in a hash like "#/shared/abc", or null on any other page. */
export function sharedToken(hash: string): string | null {
  const m = /^#\/shared\/([\w-]+)$/.exec(hash);
  return m?.[1] ?? null;
}
