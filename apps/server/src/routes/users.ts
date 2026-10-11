import { UserRole } from "@shipmate/core";
import { users } from "@shipmate/db";
import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, hashPassword, requireRole, toUserDto } from "../auth.js";
import type { Services } from "../services.js";

export async function userRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/users", async (req) => {
    requireRole(req.user, "admin");
    const rows = await s.db.select().from(users).orderBy(asc(users.createdAt));
    return { users: rows.map(toUserDto) };
  });

  app.post("/api/users", async (req) => {
    requireRole(req.user, "admin");
    const body = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        displayName: z.string().trim().min(1).max(80),
        password: z.string().min(8).max(200),
        role: UserRole,
      })
      .parse(req.body);
    if (body.role === "owner") throw new HttpError(400, "there is only one owner");
    if (body.role === "admin") requireRole(req.user, "owner");
    const [taken] = await s.db.select().from(users).where(eq(users.email, body.email));
    if (taken) throw new HttpError(409, "that email already has an account");
    const [user] = await s.db
      .insert(users)
      .values({
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      })
      .returning();
    if (!user) throw new Error("insert failed");
    return { user: toUserDto(user) };
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const body = z
      .object({
        displayName: z.string().trim().min(1).max(80).optional(),
        role: UserRole.optional(),
        monthlyCapCents: z.number().int().min(0).nullable().optional(),
        password: z.string().min(8).max(200).optional(),
      })
      .parse(req.body);
    const self = req.params.id === req.user.id;
    const [target] = await s.db.select().from(users).where(eq(users.id, req.params.id));
    if (!target) throw new HttpError(404, "user not found");
    if (!self) requireRole(req.user, "owner");
    if (body.role !== undefined || body.monthlyCapCents !== undefined) {
      requireRole(req.user, "owner");
      if (body.role === "owner" && target.role !== "owner") {
        throw new HttpError(400, "there is only one owner");
      }
      if (target.role === "owner" && body.role && body.role !== "owner") {
        throw new HttpError(400, "the owner cannot be demoted");
      }
    }
    const values: Partial<typeof users.$inferInsert> = {};
    if (body.displayName !== undefined) values.displayName = body.displayName;
    if (body.role !== undefined) values.role = body.role;
    if (body.monthlyCapCents !== undefined) values.monthlyCapCents = body.monthlyCapCents;
    if (body.password !== undefined) values.passwordHash = await hashPassword(body.password);
    const [user] = Object.keys(values).length
      ? await s.db.update(users).set(values).where(eq(users.id, target.id)).returning()
      : [target];
    if (!user) throw new Error("update failed");
    return { user: toUserDto(user) };
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    requireRole(req.user, "owner");
    if (req.params.id === req.user.id) throw new HttpError(400, "you cannot delete yourself");
    const [deleted] = await s.db.delete(users).where(eq(users.id, req.params.id)).returning();
    if (!deleted) throw new HttpError(404, "user not found");
    return { ok: true };
  });
}
