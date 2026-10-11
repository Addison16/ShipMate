import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const Snowflake = z.string().regex(/^\d{5,25}$/, "expected a Discord id (digits)");

const Configure = z.object({
  botToken: z.string().max(500).optional(),
  guildId: z.union([Snowflake, z.literal("")]).optional(),
});

/** The Discord bridge's settings. See "Discord bridge (phase 3)" in @shipmate/core's api.ts. */
export async function discordRoutes(app: FastifyInstance, s: Services) {
  const audit = (userId: string, action: string, summary: string) =>
    s.audit.record({ userId, crewMemberId: null, action, summary, decision: null });

  app.get("/api/discord", async () => ({ discord: await s.discord.status() }));

  app.put("/api/discord", async (req) => {
    requireRole(req.user, "owner");
    const body = Configure.parse(req.body ?? {});
    const input = {
      ...(body.botToken !== undefined ? { botToken: body.botToken } : {}),
      ...(body.guildId !== undefined ? { guildId: body.guildId } : {}),
    };
    const discord = await s.discord.configure(input);
    await audit(req.user.id, "discord.configure", "Changed the Discord bot settings");
    return { discord };
  });

  app.delete("/api/discord", async (req) => {
    requireRole(req.user, "owner");
    await s.discord.forget();
    await audit(req.user.id, "discord.remove", "Disconnected the Discord bot");
    return { ok: true };
  });

  app.post("/api/discord/sync", async (req) => {
    requireRole(req.user, "admin");
    const discord = await s.discord.sync();
    await audit(req.user.id, "discord.sync", "Synced the Discord channels");
    return { discord };
  });

  app.put<{ Params: { slug: string } }>("/api/discord/channels/:slug", async (req) => {
    requireRole(req.user, "admin");
    const { channelId } = z.object({ channelId: Snowflake.nullable() }).parse(req.body);
    const discord = await s.discord.bind(req.params.slug, channelId);
    await audit(
      req.user.id,
      "discord.bind",
      channelId
        ? `Bound ${req.params.slug} to a Discord channel`
        : `Unbound ${req.params.slug} from Discord`,
    );
    return { discord };
  });

  app.post("/api/discord/link", async (req) => s.discord.issueLinkCode(req.user));

  app.delete("/api/discord/link", async (req) => {
    await s.discord.unlink(req.user);
    return { ok: true };
  });
}
