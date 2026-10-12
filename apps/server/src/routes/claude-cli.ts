import type { ClaudeCliStatusDto } from "@shipmate/core";
import { CLAUDE_CLI_SIGN_IN_HINT, claudeCliStatus } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

export const CLAUDE_CLI_DOCS = [
  "Use your own Claude subscription through the official Claude Code CLI. Shipmate runs the unmodified `claude` binary for crew members whose crew.yaml says `backend: claude-code-cli`, and never sees or stores your Claude login.",
  CLAUDE_CLI_SIGN_IN_HINT,
  "The CLI keeps and renews its own login in CLAUDE_CONFIG_DIR (on the /data volume in the Shipmate image), so you sign in once; Shipmate does not ping it to keep it alive.",
  'Tools: out of the box the CLI may read files in the crew member\'s working folder and search or fetch web pages; anything else is refused unless you allow it. Allow more with `cli.allowedTools` (e.g. [Read, Edit, "Bash(git *)"]) or `cli.permissionMode: acceptEdits` in crew.yaml.',
  "Shipmate's own tools (memory, lists, and for the Captain `delegate` and the other crew tools) reach the CLI as the `mcp__shipmate__*` tools, under the crew member's approval rules.",
].join("\n\n");

/** Status of the Claude Code CLI backend (no `_services` needed: it only asks the binary). */
export async function claudeCliRoutes(app: FastifyInstance, _services: Services) {
  app.get("/api/claude-cli", async (req): Promise<{ claudeCli: ClaudeCliStatusDto }> => {
    requireRole(req.user, "admin");
    const s = await claudeCliStatus();
    return {
      claudeCli: {
        installed: s.installed,
        version: s.version,
        signedIn: s.signedIn,
        authMethod: s.authMethod,
        configDir: s.configDir,
        docs: CLAUDE_CLI_DOCS,
      },
    };
  });
}
