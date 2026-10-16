import type { ProvidersResponse } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";
import { chatgptRoutes } from "./chatgpt.js";

const Models = z.array(z.string().trim().min(1).max(200)).max(500);

export async function providerRoutes(app: FastifyInstance, s: Services) {
  await chatgptRoutes(app, s);

  app.get(
    "/api/providers",
    async (): Promise<ProvidersResponse> => ({
      providers: await s.providers.list(),
      kinds: s.providers.kinds(),
    }),
  );

  app.post("/api/providers", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        kind: z.string(),
        label: z.string().max(60).optional(),
        baseUrl: z.string().url().optional(),
        apiKey: z.string().max(4000).optional(),
        models: Models.optional(),
      })
      .parse(req.body);
    return { provider: await s.providers.create(body) };
  });

  app.patch<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        label: z.string().max(60).optional(),
        baseUrl: z.string().url().nullable().optional(),
        apiKey: z.string().max(4000).optional(),
        enabled: z.boolean().optional(),
        models: Models.optional(),
        contextWindow: z.number().int().min(1024).max(16_777_216).nullable().optional(),
      })
      .parse(req.body);
    return { provider: await s.providers.update(req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => {
    requireRole(req.user, "owner");
    await s.providers.remove(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/providers/:id/probe", async (req) => {
    requireRole(req.user, "owner");
    return { models: await s.providers.probe(req.params.id) };
  });

  app.get("/api/models", async () => ({ models: await s.providers.models() }));
}
