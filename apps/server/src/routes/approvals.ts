import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { atLeast } from "../auth.js";
import type { Services } from "../services.js";

export const DecisionSchema = z.enum(["allow", "deny", "always"]);

export async function approvalRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/approvals", async (req) => ({ approvals: s.approvals.list(req.user.id) }));

  app.post<{ Params: { id: string } }>("/api/approvals/:id", async (req) => {
    const { decision, answer } = z
      .object({ decision: DecisionSchema, answer: z.string().max(4000).optional() })
      .parse(req.body);
    s.approvals.decide(req.user.id, req.params.id, decision, answer);
    return { ok: true };
  });

  app.get("/api/audit", async (req) => {
    const q = z
      .object({
        crew: z.string().optional(),
        user: z.string().uuid().optional(),
        before: z.coerce.date().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    // Members see only what was done for them.
    const userId = atLeast(req.user.role, "admin") ? q.user : req.user.id;
    return {
      events: await s.audit.list({ userId, crewSlug: q.crew, before: q.before, limit: q.limit }),
    };
  });
}
