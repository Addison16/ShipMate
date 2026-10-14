import type { GeminiCliStatusDto } from "@shipmate/core";
import { GEMINI_SIGN_IN_COMMAND, geminiCliStatus } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { geminiModels } from "../gemini-cli-turn.js";
import type { Services } from "../services.js";

const SetKey = z.object({ key: z.string().max(500).nullable() });

/** Status of the Gemini CLI backend, and the Gemini API key an owner can give it. */
export async function geminiCliRoutes(app: FastifyInstance, s: Services) {
  const status = async (): Promise<{ geminiCli: GeminiCliStatusDto }> => {
    const keySaved = await s.geminiKey.saved();
    const st = await geminiCliStatus({ apiKey: keySaved ? await s.geminiKey.get() : null });
    return {
      geminiCli: {
        installed: st.installed,
        version: st.version,
        signedIn: st.signedIn,
        authMethod: st.authMethod,
        email: st.email,
        keySaved,
        keyInEnv: st.keyInEnv,
        configDir: st.configDir,
        models: geminiModels(),
        signInCommand: GEMINI_SIGN_IN_COMMAND,
      },
    };
  };

  app.get("/api/gemini-cli", async (req) => {
    requireRole(req.user, "admin");
    return status();
  });

  app.put("/api/gemini-cli/key", async (req) => {
    requireRole(req.user, "owner");
    const { key } = SetKey.parse(req.body ?? {});
    await s.geminiKey.set(key);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "gemini-cli.key",
      summary: key?.trim() ? "Saved the Gemini API key" : "Removed the Gemini API key",
      decision: null,
    });
    return status();
  });
}
