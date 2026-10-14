import { THEME_BUILD_GUIDE, themeFile } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import type { Services } from "../services.js";

export async function themeRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/themes", async (req) => ({ themes: await s.themes.list(req.user) }));

  /** The routine an AI follows to build a theme (also in docs/custom-themes.md). */
  app.get("/api/themes/guide", async () => ({ guide: THEME_BUILD_GUIDE }));

  app.get<{ Params: { id: string } }>("/api/themes/:id", async (req) => ({
    theme: await s.themes.get(req.user, req.params.id),
  }));

  /** The theme as a file to share or import elsewhere. */
  app.get<{ Params: { id: string } }>("/api/themes/:id/file", async (req, reply) => {
    const theme = await s.themes.get(req.user, req.params.id);
    const name =
      theme.name
        .replace(/[^\w-]+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase() || "theme";
    reply.header("content-disposition", `attachment; filename="${name}.shipmate-theme.json"`);
    return themeFile(theme);
  });

  /** Import a theme file (or any theme JSON, such as one another AI wrote). */
  app.post("/api/themes", async (req) => ({ theme: await s.themes.save(req.user, req.body) }));

  app.put<{ Params: { id: string } }>("/api/themes/:id", async (req) => ({
    theme: await s.themes.save(req.user, req.body, req.params.id),
  }));

  app.delete<{ Params: { id: string } }>("/api/themes/:id", async (req) => {
    await s.themes.remove(req.user, req.params.id);
    return { ok: true };
  });
}
