import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../services.js";

const Content = z.string().min(1).max(200_000);

export async function skillRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/skills", async (req) => ({ skills: await s.skills.list(req.user) }));

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (req) => ({
    skill: await s.skills.get(req.user, req.params.id),
  }));

  app.post("/api/skills", async (req) => {
    const body = z
      .object({
        scope: z.enum(["crew", "user", "instance"]),
        crewSlug: z.string().optional(),
        content: Content,
      })
      .parse(req.body);
    return { skill: s.skills.write(req.user, body.scope, body.crewSlug, body.content) };
  });

  app.put<{ Params: { id: string } }>("/api/skills/:id", async (req) => {
    const { content } = z.object({ content: Content }).parse(req.body);
    return { skill: await s.skills.update(req.user, req.params.id, content) };
  });

  app.post<{ Params: { id: string } }>("/api/skills/:id/approve", async (req) => {
    const skill = await s.skills.approve(req.user, req.params.id);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "skill.approve",
      summary: `Approved skill ${skill.name}`,
      decision: null,
    });
    return { skill };
  });

  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (req) => {
    await s.skills.remove(req.user, req.params.id);
    return { ok: true };
  });
}
