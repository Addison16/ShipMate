import type { ChatGptStatusDto, CompleteChatGptSignInRequest } from "@shipmate/core";
import { request } from "../api.js";

type Reply = { chatgpt: ChatGptStatusDto };

/** Sign in with ChatGPT (owner only). No call ever receives a token. */
export const chatgptApi = {
  status: () => request<Reply>("GET", "/api/providers/chatgpt").then((r) => r.chatgpt),
  start: () => request<Reply>("POST", "/api/providers/chatgpt/start").then((r) => r.chatgpt),
  cancel: () => request<Reply>("DELETE", "/api/providers/chatgpt/start").then((r) => r.chatgpt),
  complete: (callbackUrl: string) =>
    request<Reply>("POST", "/api/providers/chatgpt/complete", {
      callbackUrl,
    } satisfies CompleteChatGptSignInRequest).then((r) => r.chatgpt),
  signOut: () => request<Reply>("DELETE", "/api/providers/chatgpt").then((r) => r.chatgpt),
};

/**
 * Quick client-side check of a pasted callback address, so an obvious mistake (copying the
 * sign-in link itself, or an address without a code) is explained before the round trip.
 * Returns an error message, or null when it looks right.
 */
export function callbackProblem(input: string): string | null {
  const text = input.trim();
  if (!text) return "Paste the address your browser ended up on.";
  if (text.includes("auth.openai.com")) {
    return "That is the sign-in link. Paste the address the browser lands on afterwards (it starts with http://127.0.0.1:1455 or http://localhost:1455).";
  }
  const query = text.includes("?") ? text.slice(text.indexOf("?") + 1) : text;
  const params = new URLSearchParams(query);
  if (params.get("error")) return `ChatGPT reported: ${params.get("error")}`;
  if (!params.get("code")) {
    return "That address has no sign-in code. Copy the whole address from the address bar.";
  }
  return null;
}

/** "plus" → "Plus", "pro" → "Pro"; null stays null. */
export function planLabel(plan: string | null): string | null {
  if (!plan) return null;
  return plan
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}
