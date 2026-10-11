import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import { OIDC_STATE_TTL_MS, OidcError, safeNext } from "../services/oidc.js";
import type { Services } from "../services.js";

/** Pins the flow's state to the browser that started it (login CSRF protection). */
export const OIDC_STATE_COOKIE = "shipmate_oidc";
const COOKIE_PATH = "/api/auth/oidc";

const Settings = z.object({
  enabled: z.boolean().optional(),
  issuer: z.union([z.literal(""), z.string().trim().url().max(500)]).optional(),
  clientId: z.string().trim().max(500).optional(),
  clientSecret: z.string().max(2000).optional(),
  label: z.string().trim().min(1).max(60).optional(),
  allowSignup: z.boolean().optional(),
  allowedDomains: z.array(z.string().trim().max(253)).max(100).optional(),
});

export async function oidcRoutes(
  app: FastifyInstance,
  s: Services,
  options: { secureCookies: boolean },
) {
  const loginError = (err: unknown) =>
    s.oidc.url(`/#/login?error=${err instanceof OidcError ? err.code : "failed"}`);

  app.get("/api/auth/oidc", () => s.oidc.publicInfo());

  app.get("/api/auth/oidc/start", async (req, reply) => {
    const { next } = z.object({ next: z.string().optional() }).parse(req.query);
    const target = safeNext(next);
    if (target === null) throw new HttpError(400, "next must be a path on this instance");
    try {
      const { url, state } = await s.oidc.start(target);
      reply.setCookie(OIDC_STATE_COOKIE, state, {
        path: COOKIE_PATH,
        httpOnly: true,
        sameSite: "lax",
        secure: options.secureCookies,
        maxAge: OIDC_STATE_TTL_MS / 1000,
      });
      return reply.redirect(url);
    } catch (err) {
      return reply.redirect(loginError(err));
    }
  });

  app.get("/api/auth/oidc/callback", async (req, reply) => {
    const query = req.url.split("?")[1] ?? "";
    const cookieState = req.cookies[OIDC_STATE_COOKIE];
    reply.clearCookie(OIDC_STATE_COOKIE, { path: COOKIE_PATH });
    try {
      const { user, next } = await s.oidc.finish(query, cookieState);
      await s.sessions.start(reply, user.id);
      return reply.redirect(s.oidc.url(next));
    } catch (err) {
      if (!(err instanceof OidcError)) req.log.error(err);
      else if (err.code === "failed") req.log.warn({ reason: err.message }, "OIDC sign-in failed");
      return reply.redirect(loginError(err));
    }
  });

  app.get("/api/settings/oidc", async (req) => {
    requireRole(req.user, "owner");
    return { oidc: await s.oidc.settings() };
  });

  app.put("/api/settings/oidc", async (req) => {
    requireRole(req.user, "owner");
    const body = Settings.parse(req.body);
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    return { oidc: await s.oidc.update(patch) };
  });
}
