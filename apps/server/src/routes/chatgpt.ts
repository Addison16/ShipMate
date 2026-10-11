import type { ChatGptStatusDto } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

type Reply = { chatgpt: ChatGptStatusDto };

/** Sign in with ChatGPT (owner only). No route ever returns a token. */
export async function chatgptRoutes(app: FastifyInstance, s: Services) {
  const chatgpt = s.providers.chatgpt;
  const audit = (userId: string, action: string, summary: string) =>
    s.audit.record({ userId, crewMemberId: null, action, summary, decision: null });

  app.get("/api/providers/chatgpt", async (req): Promise<Reply> => {
    requireRole(req.user, "owner");
    return { chatgpt: await chatgpt.status() };
  });

  app.post("/api/providers/chatgpt/start", async (req): Promise<Reply> => {
    requireRole(req.user, "owner");
    return { chatgpt: await chatgpt.start() };
  });

  app.delete("/api/providers/chatgpt/start", async (req): Promise<Reply> => {
    requireRole(req.user, "owner");
    return { chatgpt: await chatgpt.cancel() };
  });

  app.post("/api/providers/chatgpt/complete", async (req): Promise<Reply> => {
    requireRole(req.user, "owner");
    const body = z.object({ callbackUrl: z.string().trim().min(1).max(8000) }).parse(req.body);
    const status = await chatgpt.complete(body.callbackUrl);
    await audit(
      req.user.id,
      "chatgpt.sign_in",
      `Signed in with ChatGPT${status.email ? ` as ${status.email}` : ""}`,
    );
    return { chatgpt: status };
  });

  app.delete("/api/providers/chatgpt", async (req): Promise<Reply> => {
    requireRole(req.user, "owner");
    const status = await chatgpt.signOut();
    await audit(req.user.id, "chatgpt.sign_out", "Signed out of ChatGPT and deleted its tokens");
    return { chatgpt: status };
  });
}
