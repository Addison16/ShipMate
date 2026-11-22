import type { ChatContextDto, LimitsResponse, ProviderLimitDto } from "@shipmate/core";
import { CodexCliMissingError } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { atLeast, HttpError } from "../auth.js";
import type { Services } from "../services.js";

/** Context and usage-limit meters (see MeterService). */
export async function limitRoutes(app: FastifyInstance, s: Services) {
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/context",
    async (req): Promise<{ context: ChatContextDto | null }> => {
      await s.bridge.conversation(req.user, req.params.id);
      return { context: await s.meters.context(req.params.id) };
    },
  );

  app.get(
    "/api/limits",
    async (req): Promise<LimitsResponse> =>
      s.meters.limits(req.user, atLeast(req.user.role, "admin")),
  );

  app.post<{ Params: { id: string } }>(
    "/api/limits/:id/check",
    async (req): Promise<{ limit: ProviderLimitDto }> => {
      if (req.params.id !== "chatgpt-plan") throw new HttpError(404, "nothing to check here");
      try {
        return { limit: await s.meters.checkChatgpt() };
      } catch (err) {
        if (err instanceof CodexCliMissingError) {
          throw new HttpError(
            409,
            "Codex isn't installed, so the ChatGPT plan's limits can't be read. Set it up on the Providers page.",
          );
        }
        const why = (err as Error).message;
        throw new HttpError(
          502,
          /log ?in|sign|auth|401/i.test(why)
            ? "Sign in to Codex on the Providers page to see the ChatGPT plan's limits."
            : `Codex couldn't read the limits: ${why}`,
        );
      }
    },
  );
}
