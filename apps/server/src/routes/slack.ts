import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const ChannelId = z.string().regex(/^[CG][A-Z0-9]{6,}$/, "expected a Slack channel id (C…)");

const Configure = z.object({
  botToken: z.string().max(500).optional(),
  appToken: z.string().max(500).optional(),
});

/** The Slack bridge's settings. See "Telegram and Slack bridges (phase 5)" in api.ts. */
export async function slackRoutes(app: FastifyInstance, s: Services) {
  const audit = (userId: string, action: string, summary: string) =>
    s.audit.record({ userId, crewMemberId: null, action, summary, decision: null });

  app.get("/api/slack", async () => ({ slack: await s.slack.status() }));

  app.put("/api/slack", async (req) => {
    requireRole(req.user, "owner");
    const body = Configure.parse(req.body ?? {});
    const slack = await s.slack.configure({
      ...(body.botToken ? { botToken: body.botToken } : {}),
      ...(body.appToken ? { appToken: body.appToken } : {}),
    });
    await audit(req.user.id, "slack.configure", "Changed the Slack app tokens");
    return { slack };
  });

  app.delete("/api/slack", async (req) => {
    requireRole(req.user, "owner");
    await s.slack.forget();
    await audit(req.user.id, "slack.remove", "Disconnected the Slack app");
    return { ok: true };
  });

  app.put<{ Params: { slug: string } }>("/api/slack/channels/:slug", async (req) => {
    requireRole(req.user, "admin");
    const { channelId } = z.object({ channelId: ChannelId.nullable() }).parse(req.body ?? {});
    const slack = await s.slack.bind(req.params.slug, channelId);
    await audit(
      req.user.id,
      "slack.bind",
      channelId
        ? `Bound ${req.params.slug} to a Slack channel`
        : `Unbound ${req.params.slug} from Slack`,
    );
    return { slack };
  });

  app.post("/api/slack/link", async (req) => s.slack.issueLinkCode(req.user));

  app.delete("/api/slack/link", async (req) => {
    await s.slack.unlink(req.user);
    return { ok: true };
  });
}
