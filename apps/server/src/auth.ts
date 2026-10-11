import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { parseUserPreferences, type UserDto, type UserRole } from "@shipmate/core";
import { authSessions, type Db, users } from "@shipmate/db";
import { and, eq, gt, lt } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "shipmate_session";
const SESSION_DAYS = 30;

export type UserRow = typeof users.$inferSelect;

export function toUserDto(u: UserRow): UserDto {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    monthlyCapCents: u.monthlyCapCents,
    discordUserId: u.discordUserId,
    telegramUserId: u.telegramUserId,
    slackUserId: u.slackUserId,
    preferences: parseUserPreferences(u.preferences),
    createdAt: u.createdAt.toISOString(),
  };
}

export const hashPassword = (password: string) => hash(password);
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

/** Browser sessions: a random token in an http-only cookie, its hash in the database. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly secureCookies: boolean,
  ) {}

  async start(reply: FastifyReply, userId: string): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    await this.db.insert(authSessions).values({ id: tokenId(token), userId, expiresAt });
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: this.secureCookies,
      expires: expiresAt,
    });
  }

  async end(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await this.db.delete(authSessions).where(eq(authSessions.id, tokenId(token)));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }

  /** The signed-in user for a request, or null. */
  async user(request: FastifyRequest): Promise<UserRow | null> {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return null;
    const [row] = await this.db
      .select({ user: users })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.id, tokenId(token)), gt(authSessions.expiresAt, new Date())))
      .limit(1);
    return row?.user ?? null;
  }

  async endAllFor(userId: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.userId, userId));
  }

  async prune(): Promise<void> {
    await this.db.delete(authSessions).where(lt(authSessions.expiresAt, new Date()));
  }
}

const RANK: Record<UserRole, number> = { member: 0, admin: 1, owner: 2 };
export const atLeast = (role: UserRole, min: UserRole) => RANK[role] >= RANK[min];

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireRole(user: UserRow, min: UserRole): void {
  if (!atLeast(user.role, min)) throw new HttpError(403, `needs the ${min} role`);
}
