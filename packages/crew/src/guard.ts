import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export interface GuardOptions {
  /** Files outside this folder are off limits (the crew member's own folder). */
  root: string;
  /**
   * Shell commands run inside the Shipmate container and can read its secrets, so they are
   * blocked until approval gates exist (phase 2) unless the crew member's policy is `auto`.
   */
  allowShell: boolean;
}

/** True when `target` (absolute or relative to root) stays inside `root`. */
export function isInside(root: string, target: string): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Interim safety net for phase 1: keep built-in file tools inside the crew folder and block
 * the shell. The phase 2 approval gates replace the shell rule with a prompt to the person.
 */
export function guardExtension(options: GuardOptions): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (SHELL_TOOLS.has(event.toolName) && !options.allowShell) {
        return {
          block: true,
          reason:
            "Shell commands need approval, which this instance cannot ask for yet. Do the task another way, or tell the person an owner can set this crew member's approval policy to auto.",
        };
      }
      if (FILE_TOOLS.has(event.toolName)) {
        const path = (event.input as { path?: unknown }).path;
        if (typeof path === "string" && path && !isInside(options.root, path)) {
          return { block: true, reason: `Only files inside ${options.root} are available.` };
        }
      }
      return undefined;
    });
  };
}
