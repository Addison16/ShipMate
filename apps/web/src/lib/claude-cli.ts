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

const BACKEND_LINE = /^backend:[ \t]*["']?([A-Za-z0-9-]+)["']?[ \t]*(#.*)?$/m;

/** The `backend` of a crew.yaml (pi when absent). */
export function readBackend(yaml: string): CrewBackendName {
  return BACKEND_LINE.exec(yaml)?.[1] === "claude-code-cli" ? "claude-code-cli" : "pi";
}

/** crew.yaml with its top-level `backend` set, other lines untouched. */
export function withBackend(yaml: string, backend: CrewBackendName): string {
  const line = `backend: ${backend}`;
  if (BACKEND_LINE.test(yaml)) return yaml.replace(BACKEND_LINE, line);
  const model = /^model:.*$/m.exec(yaml);
  if (model) {
    const end = model.index + model[0].length;
    return `${yaml.slice(0, end)}\n${line}${yaml.slice(end)}`;
  }
  return `${yaml.replace(/\s*$/, "")}\n${line}\n`;
}

/** One-line state for the Providers card. */
export function describeStatus(s: ClaudeCliStatusDto): {
  label: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (!s.installed) return { label: "Not installed", tone: "neutral" };
  if (!s.signedIn) return { label: "Not signed in", tone: "warn" };
  return { label: "Signed in", tone: "ok" };
}
