import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { IMPORT_SOURCES } from "../services/chat-import.js";
import type { Services } from "../services.js";

/** One batch of imported chats; the browser keeps each batch well under this. */
const IMPORT_BODY_BYTES = 8 * 1024 * 1024;
const IMPORT_MESSAGE_CHARS = 200_000;

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
        private: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    return { conversation: await s.bridge.createConversation(req.user, body) };
  });

  // Chats from a ChatGPT or Claude export; the browser reads the file and sends them in batches.
  app.post("/api/conversations/import", { bodyLimit: IMPORT_BODY_BYTES }, async (req) => {
    const body = z
      .object({
        source: z.enum(["chatgpt", "claude"]),
        archive: z.boolean().optional(),
        chats: z
          .array(
            z.object({
              externalId: z.string().min(1).max(200),
              title: z.string().max(500),
              createdAt: z.string().max(40),
              updatedAt: z.string().max(40),
              messages: z
                .array(
                  z.object({
                    role: z.enum(["user", "assistant"]),
                    text: z.string().max(IMPORT_MESSAGE_CHARS),
                    at: z.string().max(40),
                  }),
                )
                .max(5000),
            }),
          )
          .min(1)
          .max(100),
      })
      .parse(req.body);
    const result = await s.chatImport.import(req.user, body.source, body.chats, {
      archive: body.archive,
    });
    if (result.imported > 0) {
      await s.audit.record({
        userId: req.user.id,
        crewMemberId: null,
        action: "chats.import",
        summary: `Imported ${result.imported} chat${result.imported === 1 ? "" : "s"} from ${IMPORT_SOURCES[body.source]}`,
        decision: null,
      });
    }
    return result;
  });

  app.patch<{ Params: { id: string } }>("/api/conversations/:id", async (req) => {
    const body = z
      .object({
        title: z.string().trim().min(1).max(120).optional(),
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .refine(
        (b) => b.title !== undefined || b.pinned !== undefined || b.archived !== undefined,
        "give a title, pinned or archived",
      )
      .parse(req.body);
    let conversation = body.title
      ? await s.bridge.renameConversation(req.user, req.params.id, body.title)
      : undefined;
    if (body.pinned !== undefined) {
      conversation = await s.bridge.pinConversation(req.user, req.params.id, body.pinned);
    }
    if (body.archived !== undefined) {
      conversation = await s.bridge.archiveConversation(req.user, req.params.id, body.archived);
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

  app.get<{ Params: { id: string } }>("/api/conversations/:id/messages", async (req) => {
    const { limit, before } = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).optional(),
        before: z.string().uuid().optional(),
      })
      .parse(req.query);
    // No limit: the whole conversation, as before (other clients and older pages rely on it).
    if (limit === undefined && !before) {
      return { messages: await s.bridge.messages(req.user, req.params.id), more: false };
    }
    return s.bridge.messagePage(req.user, req.params.id, { limit: limit ?? 100, before });
  });
}
