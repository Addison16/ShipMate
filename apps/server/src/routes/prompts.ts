import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../services.js";

const Title = z.string().trim().min(1).max(80);
const Body = z.string().trim().min(1).max(8000);

export async function promptRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/prompts", async (req) => ({ prompts: await s.prompts.list(req.user) }));

  app.post("/api/prompts", async (req) => {
    const body = z
      .object({ title: Title, body: Body, shared: z.boolean().optional() })
      .parse(req.body);
    return { prompt: await s.prompts.create(req.user, body) };
  });

  app.patch<{ Params: { id: string } }>("/api/prompts/:id", async (req) => {
    const body = z
      .object({ title: Title.optional(), body: Body.optional(), shared: z.boolean().optional() })
      .parse(req.body);
    return { prompt: await s.prompts.update(req.user, req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>("/api/prompts/:id", async (req) => {
    await s.prompts.remove(req.user, req.params.id);
    return { ok: true };
  });
}
