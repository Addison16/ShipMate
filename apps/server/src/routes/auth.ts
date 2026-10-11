import type { MeResponse } from "@shipmate/core";
import { users } from "@shipmate/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, hashPassword, toUserDto, verifyPassword } from "../auth.js";
import type { Services } from "../services.js";

const Email = z.string().trim().toLowerCase().email();
const Password = z.string().min(8, "passwords need at least 8 characters").max(200);

export async function authRoutes(app: FastifyInstance, s: Services) {
  const setupRequired = async () => {
    const [row] = await s.db.select({ n: sql<number>`count(*)::int` }).from(users);
    return (row?.n ?? 0) === 0;
  };

  app.get("/api/auth/me", async (req): Promise<MeResponse> => {
    const user = await s.sessions.user(req);
    return { user: user ? toUserDto(user) : null, setupRequired: await setupRequired() };
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
      throw new HttpError(401, "wrong email or password");
    }
    await s.sessions.start(reply, user.id);
    return { user: toUserDto(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await s.sessions.end(req, reply);
    return { ok: true };
  });
}
