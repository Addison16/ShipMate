import type { MemoryEntryDto } from "@shipmate/core";
import { CrewSlug, ModelRef } from "@shipmate/core";
import { type MemoryEntry, parseManifestYaml } from "@shipmate/crew";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import { MAX_BUNDLE_BYTES } from "../services/crew-bundles.js";
import { InstallStartersSchema } from "../services/starters.js";
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
    crew: await s.crew.list(req.query.all === "1", req.user),
  }));

  app.get("/api/crew/starters", async () => ({ starters: s.starters.list() }));

  app.post("/api/crew/starters", async (req) => {
    requireRole(req.user, "admin");
    const body = InstallStartersSchema.parse(req.body);
    return s.starters.install(req.user, body);
  });

  /** One crew member as a shareable file; no memory, approvals, caps or secrets. */
  app.get<{ Params: { slug: string } }>("/api/crew/:slug/export", async (req, reply) => {
    await s.crew.assertVisible(req.params.slug, req.user);
    const { bundle, redacted } = s.crewBundles.export(req.params.slug);
    return reply
      .header("content-disposition", `attachment; filename="${bundle.slug}.shipmate-crew.json"`)
      .header("x-shipmate-redacted", String(redacted))
      .type("application/json")
      .send(JSON.stringify(bundle, null, 2));
  });

  app.post("/api/crew/import/preview", { bodyLimit: MAX_BUNDLE_BYTES * 2 }, async (req) => {
    requireRole(req.user, "admin");
    const body = z
      .object({
        text: z
          .string()
          .max(MAX_BUNDLE_BYTES * 2)
          .optional(),
        url: z.string().trim().max(2000).optional(),
      })
      .parse(req.body);
    return { preview: await s.crewBundles.preview(body) };
  });

  app.post("/api/crew/import", { bodyLimit: MAX_BUNDLE_BYTES * 2 }, async (req) => {
    requireRole(req.user, "admin");
    const body = z.object({ bundle: z.unknown(), slug: z.string() }).parse(req.body);
    const crew = await s.crewBundles.import(req.user, body);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: (await s.crew.row(crew.slug)).id,
      action: "crew.import",
      summary: `Imported ${crew.name} (${crew.slug}) for review`,
      decision: null,
      detail: { slug: crew.slug },
    });
    return { crew };
  });

  app.get<{ Params: { slug: string } }>("/api/crew/:slug", async (req) => {
    await s.crew.assertVisible(req.params.slug, req.user);
    return { crew: await s.crew.detail(req.params.slug) };
  });

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
    await s.crew.assertVisible(req.params.slug, req.user);
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
      await s.crew.assertVisible(req.params.slug, req.user);
      const ok = s.crew.memory(req.params.slug).remove(scope, req.user.id, req.params.name);
      if (!ok) throw new HttpError(404, "memory not found");
      return { ok: true };
    },
  );
}
