import type { ClaudeCliStatusDto } from "@shipmate/core";
import { request } from "../api.js";

export const claudeCliApi = {
  status: () => request<{ claudeCli: ClaudeCliStatusDto }>("GET", "/api/claude-cli"),
};

export type CrewBackendName = "pi" | "claude-code-cli" | "codex-cli";

export const BACKEND_LABEL: Record<CrewBackendName, string> = {
  pi: "Shipmate (pi) with the instance's providers",
  "claude-code-cli": "Claude subscription (Claude Code CLI)",
  "codex-cli": "ChatGPT plan (Codex CLI)",
};

const BACKEND_LINE = /^backend:[ \t]*["']?([A-Za-z0-9-]+)["']?[ \t]*(#.*)?$/m;

/** The `backend` of a crew.yaml (pi when absent). */
export function readBackend(yaml: string): CrewBackendName {
  const b = BACKEND_LINE.exec(yaml)?.[1];
  return b === "claude-code-cli" || b === "codex-cli" ? b : "pi";
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
export function describeStatus(s: Pick<ClaudeCliStatusDto, "installed" | "signedIn">): {
  label: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (!s.installed) return { label: "Not installed", tone: "neutral" };
  if (!s.signedIn) return { label: "Not signed in", tone: "warn" };
  return { label: "Signed in", tone: "ok" };
}

/** The models a signed-in Claude Code CLI offers, as crew.yaml refs (`claude-code/<alias>`). */
export const CLAUDE_CODE_MODELS = [
  { ref: "claude-code/opus", name: "Claude Opus (latest)" },
  { ref: "claude-code/sonnet", name: "Claude Sonnet (latest)" },
  { ref: "claude-code/haiku", name: "Claude Haiku (latest)" },
] as const;

/** A row of the Providers page's model list: something a crew member can run on right now. */
export interface UsableModel {
  ref: string;
  name: string;
  /** The provider id it comes from, e.g. `anthropic` or `claude-code`. */
  source: string;
}

/**
 * Models usable with what is signed in or configured: the provider models the server reports as
 * available, plus the Claude Code models when the CLI is signed in and the Codex models when
 * Codex is. pi's full catalog (every
 * model of every provider it knows) is left out.
 */
export function usableModels(
  models: readonly { ref: string; name: string; provider: string; available: boolean }[],
  cliSignedIn: boolean,
  codex: readonly { ref: string; name: string }[] = [],
): UsableModel[] {
  const out: UsableModel[] = models
    .filter((m) => m.available)
    .map((m) => ({ ref: m.ref, name: m.name, source: m.provider }));
  if (cliSignedIn) {
    out.push(...CLAUDE_CODE_MODELS.map((m) => ({ ...m, source: "claude-code" })));
  }
  out.push(...codex.map((m) => ({ ...m, source: "codex" })));
  return out;
}
