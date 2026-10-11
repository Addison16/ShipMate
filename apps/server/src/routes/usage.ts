import type { SettingsDto } from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { currentMonth } from "../services/usage.js";
import type { Services } from "../services.js";

export async function usageRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/usage", async (req) => {
    const q = z
      .object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional(),
        scope: z.enum(["me", "all"]).default("me"),
      })
      .parse(req.query);
    if (q.scope === "all") requireRole(req.user, "admin");
    return s.usage.summary(q.month ?? currentMonth(), q.scope === "me" ? req.user.id : undefined);
  });
}

export async function settingsRoutes(app: FastifyInstance, s: Services) {
  const dto = async (): Promise<SettingsDto> => {
    const settings = await s.settings.get();
    return {
      captainName: s.crew.captain().manifest.name,
      captainSlug: CAPTAIN_SLUG,
      defaultModel: settings.defaultModel,
      mcpEnabled: s.mcp.isEnabled,
    };
  };

  app.get("/api/settings", dto);

  app.put("/api/settings", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        captainName: z.string().trim().min(1).max(60).optional(),
        defaultModel: z
          .string()
          .regex(/^[a-z0-9-]+\/.+$/)
          .optional(),
      })
      .parse(req.body);
    await s.settings.set(body);
    if (body.captainName) await s.crew.renameCaptain(body.captainName);
    return dto();
  });
}
