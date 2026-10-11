import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DueOn, ListKindSchema } from "../services/lists.js";
import type { Services } from "../services.js";

const Item = z.object({
  text: z.string().trim().min(1).max(500),
  dueOn: DueOn.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

export async function listRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/lists", async (req) => ({ lists: await s.lists.list(req.user) }));

  app.post("/api/lists", async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        kind: ListKindSchema.optional(),
        shared: z.boolean().optional(),
      })
      .parse(req.body);
    return { list: await s.lists.create({ user: req.user }, body) };
  });

  app.get<{ Params: { id: string } }>("/api/lists/:id", async (req) => ({
    list: await s.lists.get(req.user, req.params.id),
  }));

  app.patch<{ Params: { id: string } }>("/api/lists/:id", async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        kind: ListKindSchema.optional(),
      })
      .parse(req.body);
    return { list: await s.lists.update(req.user, req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>("/api/lists/:id", async (req) => {
    await s.lists.remove(req.user, req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/lists/:id/items", async (req) => {
    const body = Item.parse(req.body);
    const { list } = await s.lists.addItems({ user: req.user }, req.params.id, [body]);
    return { list };
  });

  app.patch<{ Params: { id: string; itemId: string } }>(
    "/api/lists/:id/items/:itemId",
    async (req) => {
      const body = Item.partial()
        .extend({
          checked: z.boolean().optional(),
          position: z.number().int().min(0).max(1_000_000).optional(),
        })
        .parse(req.body);
      const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
      return { list: await s.lists.updateItem(req.user, req.params.id, req.params.itemId, patch) };
    },
  );

  app.delete<{ Params: { id: string; itemId: string } }>(
    "/api/lists/:id/items/:itemId",
    async (req) => ({
      list: await s.lists.removeItem(req.user, req.params.id, req.params.itemId),
    }),
  );

  app.post<{ Params: { id: string } }>("/api/lists/:id/clear", async (req) => ({
    list: await s.lists.clearChecked(req.user, req.params.id),
  }));
}
