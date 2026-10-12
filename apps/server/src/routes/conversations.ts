import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../services.js";

export async function conversationRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/conversations", async (req) => ({
    conversations: await s.bridge.listConversations(req.user.id),
  }));

  app.get("/api/conversations/search", async (req) => {
    const { q, limit } = z
      .object({
        q: z.string().max(200).default(""),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);
    return { results: await s.bridge.searchConversations(req.user, q, limit) };
  });

  app.post("/api/conversations", async (req) => {
    const body = z
      .object({
        kind: z.enum(["bridge", "direct"]).optional(),
        crewSlug: z.string().optional(),
        reuse: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return { conversation: await s.bridge.createConversation(req.user, body) };
  });

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        pinned: z.boolean().optional(),
      })
      .refine((b) => b.title !== undefined || b.pinned !== undefined, "give a title or pinned")
      .parse(req.body);
    let conversation = body.title
      ? await s.bridge.renameConversation(req.user, req.params.id, body.title)
      : undefined;
    if (body.pinned !== undefined) {
      conversation = await s.bridge.pinConversation(req.user, req.params.id, body.pinned);
    }
    return { conversation };
  });

  app.delete<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    await s.bridge.deleteConversation(req.user, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/conversations/:id/reset", async (req) => ({
    message: await s.bridge.resetConversation(req.user, req.params.id),
  }));

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => ({
    messages: await s.bridge.messages(req.user, req.params.id),
  }));
}
