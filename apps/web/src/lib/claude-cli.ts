import type { ClaudeCliStatusDto } from "@shipmate/core";
import { request } from "../api.js";

export const claudeCliApi = {
  status: () => request<{ claudeCli: ClaudeCliStatusDto }>("GET", "/api/claude-cli"),
};

export type CrewBackendName = "pi" | "claude-code-cli";

export const BACKEND_LABEL: Record<CrewBackendName, string> = {
  pi: "Shipmate (pi) with the instance's providers",
  "claude-code-cli": "Claude subscription (Claude Code CLI)",
};

/** One-line state for the Providers card. */
export function describeStatus(s: ClaudeCliStatusDto): {
  label: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (!s.installed) return { label: "Not installed", tone: "neutral" };
  if (!s.signedIn) return { label: "Not signed in", tone: "warn" };
  return { label: "Signed in", tone: "ok" };
}
