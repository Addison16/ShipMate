import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const READ_TOOLS = new Set(["read", "ls", "grep", "find"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

export interface GuardOptions {
  /** The crew member's own folder: readable and writable. */
  root: string;
  /** Extra folders the file tools may read but not change (instance and user skills). */
  readable?: string[];
}

/** True when `target` (absolute or relative to root) stays inside `root`. */
export function isInside(root: string, target: string, base = root): boolean {
  const abs = isAbsolute(target) ? resolve(target) : resolve(base, target);
  const rel = relative(resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Keeps pi's built-in file tools inside the crew folder, so a crew member cannot read
 * Shipmate's secrets or another crew member's memory. Shell commands are not confined here;
 * the approval gate asks a person before they run.
 */
export function guardExtension(options: GuardOptions): ExtensionFactory {
  const readable = [options.root, ...(options.readable ?? [])];
  return (pi) => {
    pi.on("tool_call", (event) => {
      const isRead = READ_TOOLS.has(event.toolName);
      if (!isRead && !WRITE_TOOLS.has(event.toolName)) return undefined;
      const path = (event.input as { path?: unknown }).path;
      if (typeof path !== "string" || !path) return undefined;
      const roots = isRead ? readable : [options.root];
      if (roots.some((r) => isInside(r, path, options.root))) return undefined;
      return {
        block: true,
        reason: isRead
          ? `Only files inside ${options.root} (and shared skills) are available.`
          : `Only files inside ${options.root} can be changed.`,
      };
    });
  };
}
