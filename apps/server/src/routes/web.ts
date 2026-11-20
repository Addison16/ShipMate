import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const Address = z.string().trim().max(500);

export async function webRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/settings/web", async () => ({ web: await s.web.getSettings() }));

  app.put("/api/settings/web", async (req) => {
    requireRole(req.user, "admin");
    const body = z
      .object({ searxngUrl: Address.optional(), readPages: z.boolean().optional() })
      .parse(req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return { web: await s.web.updateSettings(patch) };
  });

  app.post("/api/settings/web/test", async (req) => {
    requireRole(req.user, "admin");
    const { searxngUrl } = z.object({ searxngUrl: Address }).parse(req.body);
    return s.web.test(searxngUrl);
  });
}
