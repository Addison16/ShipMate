import type { SettingsDto } from "@shipmate/core";
import { CAPTAIN_SLUG } from "@shipmate/crew";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { currentMonth } from "../services/usage.js";
import type { Services } from "../services.js";

const UsageQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  scope: z.enum(["me", "all"]).default("me"),
});

export async function usageRoutes(app: FastifyInstance, s: Services) {
  /** Members see their own usage; scope=all (everyone's) needs admin or owner. */
  const parse = (req: FastifyRequest) => {
    const q = UsageQuery.parse(req.query);
    if (q.scope === "all") requireRole(req.user, "admin");
    return {
      month: q.month ?? currentMonth(),
      userId: q.scope === "me" ? req.user.id : undefined,
    };
  };

  app.get("/api/usage", async (req) => {
    const { month, userId } = parse(req);
    return s.usage.summary(month, {
      ...(userId ? { userId } : {}),
      crewCapUsd: (slug) => {
        try {
          return s.crew.folder(slug).manifest.monthlyCapUsd ?? null;
        } catch {
          return null; // retired or removed crew folder
        }
      },
    });
  });

  app.get("/api/usage/export", async (req, reply) => {
    const { month, userId } = parse(req);
    const csv = await s.usage.exportCsv(month, userId);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header(
        "content-disposition",
        `attachment; filename="shipmate-usage-${month}${userId ? "-me" : ""}.csv"`,
      )
      .header("cache-control", "no-store")
      .send(csv);
  });
}

/** GET /api/settings's body; also returned by routes that change a setting. */
export async function settingsDto(s: Services): Promise<SettingsDto> {
  const settings = await s.settings.get();
  return {
    captainName: s.crew.captain().manifest.name,
    captainSlug: CAPTAIN_SLUG,
    defaultModel: settings.defaultModel,
    mcpEnabled: s.mcp.isEnabled,
    visionModel: settings.visionModel,
  };
}

export async function settingsRoutes(app: FastifyInstance, s: Services) {
  const dto = () => settingsDto(s);

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
        visionModel: z
          .string()
          .regex(/^([a-z0-9-]+\/.+)?$/)
          .optional(),
      })
      .parse(req.body);
    await s.settings.set(body);
    if (body.captainName) await s.crew.renameCaptain(body.captainName);
    return dto();
  });
}
