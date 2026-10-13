import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CrewManifest } from "@shipmate/core";

export type ApprovalAnswer = "allow" | "deny" | "always";
export type AuditDecision = "auto" | "approved" | "denied" | "blocked" | "always";

export interface ApprovalHost {
  /**
   * Ask the person who started this turn; resolves when they decide (or it expires: deny).
   * `everyTime`: the card offers only Approve and Decline.
   */
  request(call: {
    toolName: string;
    input: Record<string, unknown>;
    everyTime?: boolean;
  }): Promise<ApprovalAnswer>;
  /** Record the call and how it was decided. */
  audit(call: { toolName: string; input: Record<string, unknown>; decision: AuditDecision }): void;
  /** Persist "always allow" for this crew member (adds the tool to crew.yaml `allow`). */
  remember(toolName: string): Promise<void>;
}

const SHELL = new Set(["bash", "powershell"]);
/** Shipmate tools that change the instance beyond the conversation. */
const SHIPMATE_CONSEQUENTIAL = new Set([
  "create_watch",
  "install_mcp_server",
  // Shipyard: these act on GitHub with the project's token.
  "git_push",
  "open_pull_request",
  "comment_on_github",
  "submit_pull_request_review",
]);
/**
 * Shipmate tools that always wait for the person, whatever the approval policy or allow list:
 * putting a new crew member to work, or giving one more access, is never left to a bot alone.
 */
const ALWAYS_ASK = new Set(["approve_crew_member", "equip_crew_member", "install_mcp_server"]);
/** edit_crew_member fields that change what a crew member may do; changing one always asks. */
const ACCESS_FIELDS = [
  "tools",
  "mcp",
  "allow",
  "approval",
  "neverFor",
  "autoApproveSkills",
  "cliAllowedTools",
  "cliPermissionMode",
];

/** Whether this call waits for the person every time, whatever the policy and allow list. */
export function asksEveryTime(toolName: string, input: Record<string, unknown>): boolean {
  if (ALWAYS_ASK.has(toolName)) return true;
  return toolName === "edit_crew_member" && ACCESS_FIELDS.some((k) => input[k] !== undefined);
}

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
  return (pi) => {
    pi.on("tool_call", async (event) =>
      gateToolCall({ approval: options.manifest.approval, allowed }, options.host(), {
        toolName: event.toolName,
        input: event.input as Record<string, unknown>,
      }),
    );
  };
}

/**
 * One tool call through the approval policy: audits it, asks the person when the policy says
 * so, and returns why it is blocked (or undefined to let it run). `allowed` grows when the
 * person picks "always allow". Also used for Shipmate's tools on the Claude Code CLI backend.
 */
export async function gateToolCall(
  policy: { approval: CrewManifest["approval"]; allowed: Set<string> },
  host: ApprovalHost,
  call: { toolName: string; input: Record<string, unknown> },
): Promise<{ block: true; reason: string } | undefined> {
  const { approval, allowed } = policy;
  if (typeof approval === "object" && matches(approval["never-for"], call.toolName)) {
    host.audit({ ...call, decision: "blocked" });
    return { block: true, reason: `${call.toolName} is never allowed for this crew member.` };
  }
  const always = asksEveryTime(call.toolName, call.input);
  const ask =
    always ||
    (approval === "ask" && isConsequential(call.toolName) && !matches([...allowed], call.toolName));
  if (!ask) {
    host.audit({ ...call, decision: "auto" });
    return undefined;
  }
  // "Always allow" counts as a one-time yes for these.
  const answer = always
    ? (await host.request({ ...call, everyTime: true })) === "deny"
      ? "deny"
      : "allow"
    : await host.request(call);
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
}
