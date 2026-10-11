import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const ChatId = z.string().regex(/^-?\d{1,20}$/, "expected a Telegram chat id (a number)");

/** The Telegram bridge's settings. See "Telegram and Slack bridges (phase 5)" in api.ts. */
export async function telegramRoutes(app: FastifyInstance, s: Services) {
  const audit = (userId: string, action: string, summary: string) =>
    s.audit.record({ userId, crewMemberId: null, action, summary, decision: null });

  app.get("/api/telegram", async () => ({ telegram: await s.telegram.status() }));

  app.put("/api/telegram", async (req) => {
    requireRole(req.user, "owner");
    const { botToken } = z.object({ botToken: z.string().max(200) }).parse(req.body ?? {});
    const telegram = await s.telegram.configure(botToken);
    await audit(req.user.id, "telegram.configure", "Changed the Telegram bot token");
    return { telegram };
  });

  app.delete("/api/telegram", async (req) => {
    requireRole(req.user, "owner");
    await s.telegram.forget();
    await audit(req.user.id, "telegram.remove", "Disconnected the Telegram bot");
    return { ok: true };
  });

  app.put<{ Params: { chatId: string } }>("/api/telegram/chats/:chatId", async (req) => {
    requireRole(req.user, "admin");
    const chatId = ChatId.parse(req.params.chatId);
    const { crewSlug } = z
      .object({ crewSlug: z.string().min(1).max(64).nullable() })
      .parse(req.body ?? {});
    const telegram = await s.telegram.mapChat(chatId, crewSlug);
    await audit(
      req.user.id,
      "telegram.map",
      crewSlug
        ? `Connected Telegram chat ${chatId} to ${crewSlug}`
        : `Disconnected Telegram chat ${chatId}`,
    );
    return { telegram };
  });

  app.post("/api/telegram/link", async (req) => s.telegram.issueLinkCode(req.user));

  app.delete("/api/telegram/link", async (req) => {
    await s.telegram.unlink(req.user);
    return { ok: true };
  });
}
