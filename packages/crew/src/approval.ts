import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CrewManifest } from "@shipmate/core";

export type ApprovalAnswer = "allow" | "deny" | "always";
export type AuditDecision = "auto" | "approved" | "denied" | "blocked" | "always";

export interface ApprovalHost {
  /** Ask the person who started this turn; resolves when they decide (or it expires: deny). */
  request(call: { toolName: string; input: Record<string, unknown> }): Promise<ApprovalAnswer>;
  /** Record the call and how it was decided. */
  audit(call: { toolName: string; input: Record<string, unknown>; decision: AuditDecision }): void;
  /** Persist "always allow" for this crew member (adds the tool to crew.yaml `allow`). */
  remember(toolName: string): Promise<void>;
}

const SHELL = new Set(["bash", "powershell"]);
/** Shipmate tools that change the instance beyond the conversation. */
const SHIPMATE_CONSEQUENTIAL = new Set(["create_watch", "install_mcp_server"]);
/** MCP tool names that send, publish, buy, delete, push or otherwise act on the world. */
const ACTING_VERB =
  /(^|_)(send|post|publish|create|delete|remove|destroy|update|edit|write|push|merge|close|reopen|purchase|buy|pay|order|transfer|execute|run|deploy|invite|share|move|rename|archive|reply|comment|approve|cancel|book|schedule|set|toggle|turn)(_|$)/i;

/** Whether a tool call needs a person's approval under the `ask` policy. */
export function isConsequential(toolName: string): boolean {
  if (SHELL.has(toolName) || SHIPMATE_CONSEQUENTIAL.has(toolName)) return true;
  if (toolName.startsWith("mcp__")) {
    const tool = toolName.split("__").slice(2).join("__");
    return ACTING_VERB.test(tool);
  }
  return false;
}

/** `*` wildcards in allow and never-for lists, e.g. `mcp__github__*`. */
export function matches(patterns: readonly string[], toolName: string): boolean {
  return patterns.some((p) => {
    if (!p.includes("*")) return p === toolName;
    const re = new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`);
    return re.test(toolName);
  });
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Approval gates (§13): consequential tool calls pause for the person, with an "always allow
 * for this crew member" option, and every call lands in the audit log.
 *
 *   approval: ask              ask before consequential calls (default)
 *   approval: auto             never ask
 *   approval: { never-for: [send_email] }   never run these; everything else runs
 */
export function approvalExtension(options: {
  manifest: CrewManifest;
  host: () => ApprovalHost;
}): ExtensionFactory {
  const allowed = new Set(options.manifest.allow);
  const policy = options.manifest.approval;
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const call = { toolName: event.toolName, input: event.input as Record<string, unknown> };
      const host = options.host();
      if (typeof policy === "object" && matches(policy["never-for"], call.toolName)) {
        host.audit({ ...call, decision: "blocked" });
        return { block: true, reason: `${call.toolName} is never allowed for this crew member.` };
      }
      const ask =
        policy === "ask" && isConsequential(call.toolName) && !matches([...allowed], call.toolName);
      if (!ask) {
        host.audit({ ...call, decision: "auto" });
        return undefined;
      }
      const answer = await host.request(call);
      if (answer === "deny") {
        host.audit({ ...call, decision: "denied" });
        return {
          block: true,
          reason: "The person declined this action. Ask what they would like instead.",
        };
      }
      if (answer === "always") {
        allowed.add(call.toolName);
        await host.remember(call.toolName);
      }
      host.audit({ ...call, decision: answer === "always" ? "always" : "approved" });
      return undefined;
    });
  };
}
