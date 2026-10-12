import type { LocalAiStatusDto } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";
import { settingsDto } from "./usage.js";

const Url = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//.test(u), "use an http(s) address")
  .optional();
const Model = z.string().trim().min(1).max(200);

/** Local models through Ollama (owner): find the server, pull a model, use it. */
export async function localAiRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/local-ai", async (req): Promise<{ localAi: LocalAiStatusDto }> => {
    requireRole(req.user, "owner");
    const { url } = z.object({ url: Url }).parse(req.query);
    return { localAi: await s.localAi.status(url) };
  });

  app.post("/api/local-ai/pull", async (req) => {
    requireRole(req.user, "owner");
    const body = z.object({ url: Url, model: Model }).parse(req.body);
    const pull = await s.localAi.pull(body.model, body.url);
    void s.audit
      .record({
        userId: req.user.id,
        crewMemberId: null,
        action: "local_ai.pull",
        summary: `Pulled ${pull.model} into Ollama`,
        decision: null,
      })
      .catch(() => {});
    return { pull };
  });

  app.post("/api/local-ai/use", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({ url: Url, model: Model, makeDefault: z.boolean().optional() })
      .parse(req.body);
    const provider = await s.localAi.use(body.model, body);
    return { provider, settings: await settingsDto(s) };
  });
}
