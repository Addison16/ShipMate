import type { MemoryEntryDto } from "@shipmate/core";
import { CrewSlug, ModelRef } from "@shipmate/core";
import { type MemoryEntry, parseManifestYaml } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import type { Services } from "../services.js";

const toMemoryDto = (e: MemoryEntry): MemoryEntryDto => ({
  name: e.name,
  description: e.description,
  body: e.body,
  scope: e.scope,
  updatedAt: e.updatedAt.toISOString(),
});

export async function crewRoutes(app: FastifyInstance, s: Services) {
  app.get<{ Querystring: { all?: string } }>("/api/crew", async (req) => ({
    crew: await s.crew.list(req.query.all === "1"),
  }));

  app.get<{ Params: { slug: string } }>("/api/crew/:slug", async (req) => ({
    crew: await s.crew.detail(req.params.slug),
  }));

  app.post("/api/crew", async (req) => {
    requireRole(req.user, "admin");
    const body = z
      .object({
        slug: CrewSlug,
        manifestYaml: z.string().optional(),
        name: z.string().min(1).max(60).optional(),
        role: z.string().min(1).max(200).optional(),
        model: ModelRef.optional(),
        persona: z.string().max(100_000),
      })
      .parse(req.body);
    const defaults = await s.settings.get();
    let manifest: Record<string, unknown>;
    if (body.manifestYaml) {
      try {
        manifest = parseManifestYaml(body.manifestYaml);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    } else {
      if (!body.name || !body.role) throw new HttpError(400, "name and role are required");
      manifest = { name: body.name, role: body.role, model: body.model ?? defaults.defaultModel };
    }
    return {
      crew: await s.crew.create({
        slug: body.slug,
        manifest: manifest as { name: string; role: string; model: string },
        persona: body.persona,
        createdById: req.user.id,
        status: "active",
      }),
    };
  });

  app.put<{ Params: { slug: string } }>("/api/crew/:slug", async (req) => {
    requireRole(req.user, "admin");
    const body = z
      .object({
        manifestYaml: z.string().max(100_000).optional(),
        persona: z.string().max(100_000).optional(),
      })
      .parse(req.body);
    return {
      crew: await s.crew.update(req.params.slug, {
        ...(body.manifestYaml !== undefined ? { manifestYaml: body.manifestYaml } : {}),
        ...(body.persona !== undefined ? { persona: body.persona } : {}),
      }),
    };
  });

  app.post<{ Params: { slug: string } }>("/api/crew/:slug/approve", async (req) => {
    requireRole(req.user, "admin");
    return { crew: await s.crew.setStatus(req.params.slug, "active") };
  });

  app.delete<{ Params: { slug: string } }>("/api/crew/:slug", async (req) => {
    requireRole(req.user, "admin");
    await s.crew.setStatus(req.params.slug, "retired");
    return { ok: true };
  });

  app.get<{ Params: { slug: string } }>("/api/crew/:slug/memory", async (req) => {
    const memory = s.crew.memory(req.params.slug);
    return {
      shared: memory.list("shared").map(toMemoryDto),
      mine: memory.list("user", req.user.id).map(toMemoryDto),
    };
  });

  app.delete<{ Params: { slug: string; scope: string; name: string } }>(
    "/api/crew/:slug/memory/:scope/:name",
    async (req) => {
      const scope = z.enum(["shared", "user"]).parse(req.params.scope);
      if (scope === "shared") requireRole(req.user, "admin");
      const ok = s.crew.memory(req.params.slug).remove(scope, req.user.id, req.params.name);
      if (!ok) throw new HttpError(404, "memory not found");
      return { ok: true };
    },
  );
}
