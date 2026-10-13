import type { McpServerDto } from "@shipmate/core";
import { request } from "../api.js";

export const googleMcpApi = {
  start: () => request<{ url: string }>("POST", "/api/mcp/google/start"),
  finish: (url: string) =>
    request<{ server: McpServerDto }>("POST", "/api/mcp/google/finish", { url }),
  signOut: () => request<{ server: McpServerDto }>("DELETE", "/api/mcp/google"),
};

const RESULTS: Record<string, string> = {
  state: "That sign-in expired or came from another attempt. Try again.",
  denied: "Sign-in was cancelled at Google.",
  no_client: "Save a client ID and secret first.",
  no_refresh: "Google did not send a refresh token. Try again.",
  failed: "Google could not finish the sign-in. Check the client ID, secret and redirect URI.",
};

/** The outcome in "#/mcp?google=<result>" after Google sends the browser back, or null. */
export function googleResult(hash: string): { ok: boolean; text: string } | null {
  const query = hash.split("?")[1];
  if (!query) return null;
  const result = new URLSearchParams(query).get("google");
  if (!result) return null;
  if (result === "ok") return { ok: true, text: "Signed in to Google." };
  return { ok: false, text: RESULTS[result] ?? RESULTS.failed ?? "" };
}

/** True when this browser is on the Shipmate machine itself, so a localhost redirect works. */
export function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}
