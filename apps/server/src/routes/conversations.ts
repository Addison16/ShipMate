import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../services.js";

export async function conversationRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/conversations", async (req) => ({
    conversations: await s.bridge.listConversations(req.user.id),
  }));

  app.post("/api/conversations", async (req) => {
    const body = z
      .object({
        kind: z.enum(["bridge", "direct"]).optional(),
        crewSlug: z.string().optional(),
      })
      .parse(req.body ?? {});
    return { conversation: await s.bridge.createConversation(req.user, body) };
  });

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    const body = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body);
    return { conversation: await s.bridge.renameConversation(req.user, req.params.id, body.title) };
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    await s.bridge.deleteConversation(req.user, req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => ({
    messages: await s.bridge.messages(req.user, req.params.id),
  }));
}
