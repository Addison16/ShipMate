import type { CreateCustomMcpRequest } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");
const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an env var name like API_KEY");

export async function mcpRoutes(app: FastifyInstance, s: Services) {
  const audit = (userId: string, action: string, summary: string) =>
    s.audit.record({ userId, crewMemberId: null, action, summary, decision: null });

  app.get("/api/mcp", async () => ({ servers: await s.mcp.list() }));

  app.post<{ Params: { id: string } }>("/api/mcp/:id/install", async (req) => {
    requireRole(req.user, "owner");
    const server = await s.mcp.install(req.params.id);
    await audit(req.user.id, "mcp.install", `Installed ${server.name}`);
    return { server };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/:id", async (req) => {
    requireRole(req.user, "owner");
    await s.mcp.uninstall(req.params.id);
    await audit(req.user.id, "mcp.uninstall", `Uninstalled ${req.params.id}`);
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/mcp/:id/secrets", async (req) => {
    requireRole(req.user, "owner");
    const { values } = z
      .object({ values: z.record(EnvName, z.string().max(8000)) })
      .parse(req.body);
    return { server: await s.mcp.setSecrets(req.params.id, values) };
  });

  app.put<{ Params: { id: string } }>("/api/mcp/:id/crews", async (req) => {
    requireRole(req.user, "admin");
    const { crews } = z.object({ crews: z.array(z.string()).max(200) }).parse(req.body);
    return { server: await s.mcp.assign(req.params.id, crews) };
  });

  app.post("/api/mcp/custom", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        id: Id,
        name: z.string().trim().min(1).max(80),
        description: z.string().max(500).optional(),
        transport: z.enum(["stdio", "http"]),
        command: z.string().max(200).optional(),
        args: z.array(z.string().max(500)).max(50).optional(),
        url: z.string().url().optional(),
        secrets: z
          .array(
            z.object({
              env: EnvName,
              label: z.string().max(80).optional(),
              required: z.boolean().optional(),
            }),
          )
          .max(20)
          .optional(),
      })
      .parse(req.body);
    const server = await s.mcp.addCustom(
      Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      ) as unknown as CreateCustomMcpRequest,
    );
    await audit(req.user.id, "mcp.custom", `Added custom server ${server.name}`);
    return { server };
  });
}
