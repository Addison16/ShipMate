import type { CreateWatchRequest } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { WatchTriggerSchema } from "../services/watches.js";
import type { Services } from "../services.js";

const Watch = z.object({
  name: z.string().trim().min(1).max(100),
  crewSlug: z.string().min(1),
  trigger: WatchTriggerSchema,
  prompt: z.string().trim().min(1).max(20_000),
  enabled: z.boolean().optional(),
  session: z.enum(["fresh", "continue"]).optional(),
});

export async function watchRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/watches", async () => ({ watches: await s.watches.list() }));

  app.get<{ Params: { id: string } }>("/api/watches/:id", async (req) => ({
    watch: await s.watches.get(req.params.id),
  }));

  app.post("/api/watches", async (req) => ({
    watch: await s.watches.create(req.user, strip(Watch.parse(req.body)) as CreateWatchRequest),
  }));

  app.patch<{ Params: { id: string } }>("/api/watches/:id", async (req) => ({
    watch: await s.watches.update(
      req.user,
      req.params.id,
      strip(Watch.partial().parse(req.body)) as Partial<CreateWatchRequest>,
    ),
  }));

  app.delete<{ Params: { id: string } }>("/api/watches/:id", async (req) => {
    await s.watches.remove(req.user, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/watches/:id/run", async (req) => {
    await s.watches.canEdit(req.user, req.params.id);
    return { run: await s.watches.run(req.params.id, "manual") };
  });

  app.get<{ Params: { id: string } }>("/api/watches/:id/runs", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(20) })
      .parse(req.query);
    return { runs: await s.watches.runs(req.params.id, limit) };
  });

  // Public: the token in the path is the credential. Any body is passed along as text.
  app.post<{ Params: { id: string; token: string } }>(
    "/api/hooks/watches/:id/:token",
    async (req) => {
      const body =
        typeof req.body === "string" ? req.body : req.body ? JSON.stringify(req.body) : "";
      return {
        run: await s.watches.runFromWebhook(req.params.id, req.params.token, body.slice(0, 20_000)),
      };
    },
  );
}

/** Drop undefined keys (exactOptionalPropertyTypes). */
function strip(o: object): unknown {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
