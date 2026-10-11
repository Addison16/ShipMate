import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const Settings = z.object({
  hourUtc: z.number().int().min(0).max(23).nullable().optional(),
  keep: z.number().int().min(1).max(365).optional(),
});

export async function backupRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/backups", async (req) => {
    requireRole(req.user, "owner");
    const [backups, settings] = await Promise.all([s.backups.list(), s.backups.getSettings()]);
    return { backups, settings };
  });

  app.post("/api/backups", async (req) => {
    requireRole(req.user, "owner");
    return { backup: await s.backups.run("manual", req.user.id) };
  });

  // Registered before /:name so "settings" is never taken for a file name.
  app.put("/api/backups/settings", async (req) => {
    requireRole(req.user, "owner");
    const patch = Settings.parse(req.body ?? {});
    return { settings: await s.backups.updateSettings(patch) };
  });

  app.get<{ Params: { name: string } }>("/api/backups/:name", async (req, reply) => {
    requireRole(req.user, "owner");
    const { stream, size } = await s.backups.stream(req.params.name);
    return reply
      .header("content-type", "application/gzip")
      .header("content-length", size)
      .header("content-disposition", `attachment; filename="${req.params.name}"`)
      .send(stream);
  });

  app.delete<{ Params: { name: string } }>("/api/backups/:name", async (req) => {
    requireRole(req.user, "owner");
    await s.backups.remove(req.params.name, req.user.id);
    return { ok: true };
  });
}
