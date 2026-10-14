import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import { draftPicture, PICTURE_HEADERS, petPicture } from "../pets/files.js";
import type { Services } from "../services.js";

export async function petRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/pets/settings", async (req) => {
    requireRole(req.user, "owner");
    return s.pets.config();
  });

  app.put("/api/pets/settings", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        source: z.enum(["draw", "chatgpt", "provider", "custom"]).optional(),
        providerId: z.string().uuid().nullable().optional(),
        baseUrl: z.string().max(500).nullable().optional(),
        model: z.string().trim().max(200).optional(),
        apiKey: z.string().max(500).optional(),
      })
      .strict()
      .parse(req.body);
    return s.pets.update(
      Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)),
    );
  });

  /** The pet's picture, or a draft from a pet build (?draft=<id>). */
  app.get<{ Params: { slug: string }; Querystring: { draft?: string } }>(
    "/api/crew/:slug/pet",
    async (req, reply) => {
      await s.crew.assertVisible(req.params.slug, req.user);
      const folder = s.crew.folder(req.params.slug);
      const picture = req.query.draft ? draftPicture(folder, req.query.draft) : petPicture(folder);
      if (!picture) throw new HttpError(404, "no pet picture");
      return reply.headers(PICTURE_HEADERS).type(picture.type).send(readFileSync(picture.file));
    },
  );

  /** Show or hide a crew member's pet (making one goes through the Captain). */
  app.put<{ Params: { slug: string } }>("/api/crew/:slug/pet", async (req) => {
    requireRole(req.user, "admin");
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    const folder = s.crew.folder(req.params.slug);
    const pet = folder.manifest.pet;
    if (enabled && !petPicture(folder)) {
      throw new HttpError(
        409,
        `${folder.manifest.name} has no pet yet. Ask ${s.crew.captain().manifest.name} to make one.`,
      );
    }
    if (!pet) return { crew: await s.crew.detail(req.params.slug) };
    return { crew: await s.crew.patch(req.params.slug, { pet: { ...pet, enabled } }) };
  });
}
