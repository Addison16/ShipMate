import type { HealthDto } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

export async function healthRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/health", async (req): Promise<{ health: HealthDto }> => {
    requireRole(req.user, "admin");
    const { refresh } = z.object({ refresh: z.enum(["0", "1"]).optional() }).parse(req.query);
    const seen = {
      protocol: req.protocol,
      host: req.host,
      forwarded: Boolean(req.headers["x-forwarded-proto"] || req.headers["x-forwarded-host"]),
    };
    return { health: await s.health.report(refresh === "1", seen) };
  });

  /** Owner only, and only after the page's confirm: Shipmate restarts. */
  app.post("/api/health/update", async (req) => {
    requireRole(req.user, "owner");
    z.object({ confirm: z.literal(true) }).parse(req.body);
    const { helper } = await s.health.update();
    await s.audit
      .record({
        userId: req.user.id,
        crewMemberId: null,
        action: "shipmate.update",
        summary: `Started a one-click update (helper container ${helper})`,
        decision: null,
      })
      .catch(() => {});
    return { started: true, helper };
  });
}
