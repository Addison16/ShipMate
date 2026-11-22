import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError } from "../auth.js";
import { ASK_WAIT_MAX_SECONDS } from "../services/api-keys.js";
import type { Services } from "../services.js";

/** Where keys work. Listed as public in app.ts: each route here checks the key itself. */
export const API_V1_PREFIX = "/api/v1/";

export async function apiKeyRoutes(app: FastifyInstance, s: Services) {
  // ---------- managing keys (signed in, in the app) ----------

  app.get("/api/keys", async (req) => ({ keys: await s.apiKeys.list(req.user) }));

  app.post("/api/keys", async (req) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    const made = await s.apiKeys.create(req.user, name);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "keys.create",
      summary: `Made a key for another app: ${name}`,
      decision: null,
    });
    return made;
  });

  app.delete<{ Params: { id: string } }>("/api/keys/:id", async (req) => {
    await s.apiKeys.remove(req.user, req.params.id);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "keys.remove",
      summary: "Removed a key for another app",
      decision: null,
    });
    return { ok: true };
  });

  // ---------- what a key can do ----------

  const holder = async (req: FastifyRequest) => {
    const who = await s.apiKeys.holder(req.headers.authorization);
    if (!who) throw new HttpError(401, "Send your key as: Authorization: Bearer <key>");
    return who;
  };

  app.get(`${API_V1_PREFIX}agents`, async (req) => {
    const { user } = await holder(req);
    return { agents: await s.apiKeys.agents(user) };
  });

  app.post(`${API_V1_PREFIX}ask`, async (req) => {
    const { user, keyId } = await holder(req);
    const body = z
      .object({
        message: z.string().trim().min(1).max(20_000),
        agent: z.string().trim().min(1).max(80).optional(),
        newChat: z.boolean().optional(),
        waitSeconds: z.number().int().min(1).max(ASK_WAIT_MAX_SECONDS).optional(),
      })
      .parse(req.body);
    return s.apiKeys.ask(user, keyId, body);
  });

  app.get<{ Params: { id: string } }>(`${API_V1_PREFIX}chats/:id`, async (req) => {
    const { user, keyId } = await holder(req);
    return s.apiKeys.chat(user, keyId, req.params.id);
  });
}
