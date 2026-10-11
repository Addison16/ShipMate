import type { PushEvents } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../auth.js";
import { DEFAULT_PUSH_EVENTS } from "../push/service.js";
import type { Services } from "../services.js";

const Events = z
  .object({ approvals: z.boolean(), watches: z.boolean(), messages: z.boolean() })
  .partial()
  .strict();

const base64url = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/);

export async function pushRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/push", async (req) => s.push.status(req.user.id));

  app.post("/api/push/devices", async (req) => {
    const body = z
      .object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: base64url, auth: base64url }),
        label: z.string().max(200).default(""),
        events: Events.optional(),
      })
      .parse(req.body);
    const device = await s.push.subscribe(req.user.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh.replace(/=+$/, ""),
      auth: body.keys.auth.replace(/=+$/, ""),
      label: body.label,
      ...(body.events ? { events: { ...DEFAULT_PUSH_EVENTS, ...defined(body.events) } } : {}),
    });
    return { device };
  });

  app.patch<{ Params: { id: string } }>("/api/push/devices/:id", async (req) => {
    const { events } = z.object({ events: Events }).parse(req.body);
    return { device: await s.push.update(req.user.id, uuid(req.params.id), defined(events)) };
  });

  app.delete<{ Params: { id: string } }>("/api/push/devices/:id", async (req) => {
    await s.push.remove(req.user.id, uuid(req.params.id));
    return { ok: true };
  });

  app.post("/api/push/test", async (req) => s.push.test(req.user.id));

  // Approve or Deny from a notification. The service worker has no session cookie to rely on
  // (and must not ride on one), so the one-time token from the notification is the credential.
  app.post<{ Params: { id: string } }>("/api/push/act/approvals/:id", async (req) => {
    const body = z
      .object({ token: z.string().max(200), decision: z.enum(["allow", "deny"]) })
      .parse(req.body);
    const userId = s.push.redeem(body.token, req.params.id, (id) => s.approvals.ownerOf(id));
    if (!userId) {
      throw new HttpError(410, "This request is no longer waiting for an answer.");
    }
    s.approvals.decide(userId, req.params.id, body.decision);
    return { ok: true };
  });
}

/** Drop keys zod left undefined. */
function defined(events: z.infer<typeof Events>): Partial<PushEvents> {
  return Object.fromEntries(Object.entries(events).filter(([, v]) => v !== undefined));
}

function uuid(id: string): string {
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(404, "device not found");
  return id;
}
