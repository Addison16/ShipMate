import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const Address = z.string().trim().max(500);
const Source = z.enum(["duckduckgo", "searxng", "off"]);

export async function webRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/settings/web", async () => ({ web: await s.web.getSettings() }));

  app.put("/api/settings/web", async (req) => {
    requireRole(req.user, "admin");
    const body = z
      .object({
        source: Source.optional(),
        searxngUrl: Address.optional(),
        readPages: z.boolean().optional(),
      })
      .parse(req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return { web: await s.web.updateSettings(patch) };
  });

  app.post("/api/settings/web/test", async (req) => {
    requireRole(req.user, "admin");
    const body = z.object({ source: Source, searxngUrl: Address.default("") }).parse(req.body);
    return s.web.test(body.source, body.searxngUrl);
  });
}
