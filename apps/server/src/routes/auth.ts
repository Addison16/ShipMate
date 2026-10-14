import {
  ColorTheme,
  freshOnboarding,
  type MeResponse,
  parseUserPreferences,
  ThemeMode,
} from "@shipmate/core";
import { users } from "@shipmate/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, hashPassword, toUserDto, verifyPassword } from "../auth.js";
import type { Services } from "../services.js";
import { ONBOARDING_KEY, onboardingState } from "./onboarding.js";

const Email = z.string().trim().toLowerCase().email();
const Password = z.string().min(8, "passwords need at least 8 characters").max(200);

export async function authRoutes(app: FastifyInstance, s: Services) {
  const setupRequired = async () => {
    const [row] = await s.db.select({ n: sql<number>`count(*)::int` }).from(users);
    return (row?.n ?? 0) === 0;
  };

  app.get("/api/auth/me", async (req): Promise<MeResponse> => {
    const user = await s.sessions.user(req);
    return {
      user: user ? toUserDto(user) : null,
      setupRequired: await setupRequired(),
      ...(user?.role === "owner" ? { onboarding: await onboardingState(s) } : {}),
    };
  });

  /** First run: create the owner account. Only works while there are no users. */
  app.post("/api/setup", async (req, reply) => {
    const body = z
      .object({
        email: Email,
        displayName: z.string().trim().min(1).max(80),
        password: Password,
        captainName: z.string().trim().min(1).max(60).optional(),
      })
      .parse(req.body);
    if (!(await setupRequired())) throw new HttpError(409, "setup is already done");
    const [user] = await s.db
      .insert(users)
      .values({
        email: body.email,
        displayName: body.displayName,
        passwordHash: await hashPassword(body.password),
        role: "owner",
      })
      .returning();
    if (!user) throw new Error("insert failed");
    // The web app walks the owner through the rest of first launch from here.
    await s.settings.setJson(ONBOARDING_KEY, freshOnboarding());
    if (body.captainName && body.captainName !== "Captain") {
      await s.settings.set({ captainName: body.captainName });
      await s.crew.renameCaptain(body.captainName);
    }
    await s.sessions.start(reply, user.id);
    return { user: toUserDto(user) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ email: Email, password: z.string() }).parse(req.body);
    const [user] = await s.db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      throw new HttpError(401, "Wrong email or password.");
    }
    await s.sessions.start(reply, user.id);
    return { user: toUserDto(user) };
  });

  /** Appearance settings (and the welcome being seen) belong to the signed-in user; anyone can change their own. */
  app.patch("/api/auth/preferences", async (req) => {
    const body = z
      .object({
        themeMode: ThemeMode.optional(),
        colorTheme: ColorTheme.optional(),
        customTheme: z.string().uuid().nullable().optional(),
        style: z.enum(["plain", "nautical"]).optional(),
        welcome: z.literal("done").optional(),
      })
      .strict()
      .parse(req.body);
    const { welcome, ...appearance } = body;
    if (appearance.customTheme && !(await s.themes.exists(appearance.customTheme))) {
      throw new HttpError(404, "that theme was deleted");
    }
    // Keep keys beside the appearance ones (the pending welcome) unless this request closes them.
    const stored = req.user.preferences;
    const raw = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const preferences = {
      ...raw,
      ...parseUserPreferences(raw),
      ...appearance,
      ...(welcome ? { welcome } : {}),
    };
    const [user] = await s.db
      .update(users)
      .set({ preferences })
      .where(eq(users.id, req.user.id))
      .returning();
    if (!user) throw new HttpError(404, "user not found");
    return { user: toUserDto(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await s.sessions.end(req, reply);
    return { ok: true };
  });
}
