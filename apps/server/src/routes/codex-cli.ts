import type { CodexCliStatusDto } from "@shipmate/core";
import { CODEX_SIGN_IN_COMMAND, codexCliStatus } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.js";
import { codexModels } from "../codex-cli-turn.js";
import type { Services } from "../services.js";

/** Status of the Codex CLI backend (no `_services` needed: it only asks the binary). */
export async function codexCliRoutes(app: FastifyInstance, _services: Services) {
  app.get("/api/codex-cli", async (req): Promise<{ codexCli: CodexCliStatusDto }> => {
    requireRole(req.user, "admin");
    const s = await codexCliStatus();
    return {
      codexCli: {
        installed: s.installed,
        version: s.version,
        signedIn: s.signedIn,
        authMethod: s.authMethod,
        configDir: s.configDir,
        models: codexModels(),
        signInCommand: CODEX_SIGN_IN_COMMAND,
      },
    };
  });
}
