import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../services.js";

/** Background tasks: what the Captain handed over, as the person's pages show it. */
export async function taskRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/tasks", async (req) => {
    const { conversationId } = z
      .object({ conversationId: z.string().uuid().optional() })
      .parse(req.query);
    return { tasks: await s.tasks.list(req.user, conversationId) };
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/stop", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { task: await s.tasks.stop(req.user, id) };
  });
}
