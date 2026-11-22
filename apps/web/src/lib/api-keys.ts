import type { ApiKeyDto } from "@shipmate/core";
import { request } from "../api.js";

export const apiKeysApi = {
  list: () => request<{ keys: ApiKeyDto[] }>("GET", "/api/keys"),
  create: (name: string) =>
    request<{ key: ApiKeyDto; token: string }>("POST", "/api/keys", { name }),
  remove: (id: string) => request<{ ok: true }>("DELETE", `/api/keys/${encodeURIComponent(id)}`),
};

/** A ready-to-paste command that sends one message with a key. */
export function askExample(origin: string, token: string): string {
  return [
    `curl ${origin}/api/v1/ask \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"message": "What is on the grocery list?"}'`,
  ].join("\n");
}
