import type { CursorCliStatusDto } from "@shipmate/core";
import { CURSOR_INSTALL_COMMAND, CURSOR_SIGN_IN_COMMAND, cursorCliStatus } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.js";
import { cursorModels, rememberCursorModels } from "../cursor-cli-turn.js";
import type { Services } from "../services.js";

/** Status of the Cursor CLI backend (no `_services` needed: it only asks the binary). */
export async function cursorCliRoutes(app: FastifyInstance, _services: Services) {
  app.get("/api/cursor-cli", async (req): Promise<{ cursorCli: CursorCliStatusDto }> => {
    requireRole(req.user, "admin");
    const s = await cursorCliStatus({ models: true });
    if (s.signedIn) rememberCursorModels(s.models);
    return {
      cursorCli: {
        installed: s.installed,
        version: s.version,
        signedIn: s.signedIn,
        authMethod: s.authMethod,
        email: s.email,
        configDir: s.configDir,
        models: cursorModels(),
        signInCommand: CURSOR_SIGN_IN_COMMAND,
        installCommand: CURSOR_INSTALL_COMMAND,
      },
    };
  });
}
