import type { CliLoginProvider, CliLoginResponse } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import { CliLogins } from "../cli-login.js";
import type { Services } from "../services.js";

const Provider = z.object({ provider: z.enum(["claude", "codex", "gemini"]) });
const Answer = z.object({ code: z.string().min(1).max(4_000) });

const NAMES: Record<CliLoginProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini CLI",
};

/** "Sign in" buttons on the Providers page (admins): see cli-login.ts. */
export async function cliLoginRoutes(
  app: FastifyInstance,
  services: Services,
  logins = new CliLogins(),
) {
  app.addHook("onClose", async () => logins.close());

  app.get("/api/cli-login/:provider", async (req): Promise<CliLoginResponse> => {
    requireRole(req.user, "admin");
    const { provider } = Provider.parse(req.params);
    return { login: logins.get(provider) };
  });

  app.post("/api/cli-login/:provider", async (req): Promise<CliLoginResponse> => {
    requireRole(req.user, "admin");
    const { provider } = Provider.parse(req.params);
    await services.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "cli.sign_in",
      summary: `Started signing in ${NAMES[provider]} from the Providers page`,
      decision: null,
    });
    return { login: logins.start(provider) };
  });

  app.post("/api/cli-login/:provider/answer", async (req): Promise<CliLoginResponse> => {
    requireRole(req.user, "admin");
    const { provider } = Provider.parse(req.params);
    const { code } = Answer.parse(req.body);
    const login = logins.answer(provider, code);
    if (!login) throw new HttpError(404, "Start the sign-in first.");
    return { login };
  });

  app.delete("/api/cli-login/:provider", async (req): Promise<CliLoginResponse> => {
    requireRole(req.user, "admin");
    const { provider } = Provider.parse(req.params);
    logins.cancel(provider);
    return { login: null };
  });
}
