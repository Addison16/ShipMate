/**
 * Plain one-line cards for the Captain's requests to change what a crew member may do, so the
 * person reads "Captain wants to give Navigator: GitHub" instead of a tool name and JSON.
 * Undefined for any other call (the card then shows the tool name and its arguments).
 */
export function accessSummary(
  who: string,
  toolName: string,
  input: Record<string, unknown>,
  names: { crew: (slug: string) => string; server: (id: string) => string },
): string | undefined {
  const target = typeof input.slug === "string" ? names.crew(input.slug) : "a crew member";
  const list = (key: string, name: (s: string) => string = (s) => s) => {
    const v = input[key];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(name) : [];
  };
  const why = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "";

  switch (toolName) {
    case "equip_crew_member": {
      const parts = [
        ...list("mcp", names.server),
        ...list("tools").map((t) => `the ${t} tool`),
        ...list("skills").map((s) => `the ${s} skill`),
        ...list("claudeCodeTools").map((t) => `Claude Code ${t}`),
      ];
      return `${who} wants to give ${target}: ${parts.join(", ")}${why ? `. Why: ${why}` : ""}`;
    }
    case "install_mcp_server": {
      const server = typeof input.id === "string" ? names.server(input.id) : "a server";
      const crews = list("crews", names.crew);
      return `${who} wants to install ${server}${crews.length ? ` for ${crews.join(", ")}` : ""}`;
    }
    case "approve_crew_member":
      return `${who} wants to put ${target} to work`;
    case "edit_crew_member": {
      const changes = [
        input.backend !== undefined &&
          `runs on ${input.backend === "claude-code-cli" ? "Claude Code" : "Shipmate"}`,
        input.mcp !== undefined && `servers: ${list("mcp", names.server).join(", ") || "none"}`,
        input.tools !== undefined && `tools: ${list("tools").join(", ") || "all built-in"}`,
        input.skills !== undefined && `skills: ${list("skills").join(", ") || "none"}`,
        input.allow !== undefined && `runs without asking: ${list("allow").join(", ") || "none"}`,
        input.approval !== undefined && `approvals: ${String(input.approval)}`,
        input.neverFor !== undefined && `never runs: ${list("neverFor").join(", ")}`,
        input.autoApproveSkills !== undefined &&
          `own skills ${input.autoApproveSkills ? "load right away" : "wait for approval"}`,
        input.cliPermissionMode !== undefined &&
          `Claude Code permissions: ${String(input.cliPermissionMode)}`,
        input.cliAllowedTools !== undefined &&
          `Claude Code tools: ${list("cliAllowedTools").join(", ") || "none"}`,
      ].filter((c): c is string => typeof c === "string");
      return changes.length
        ? `${who} wants to change what ${target} may do (${changes.join("; ")})`
        : undefined;
    }
    default:
      return undefined;
  }
}
