import { createHash, randomBytes } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import {
  parseUserPreferences,
  type SessionDto,
  type UserDto,
  type UserRole,
  welcomePending,
} from "@shipmate/core";
import { authSessions, type Db, users } from "@shipmate/db";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "shipmate_session";
const SESSION_DAYS = 30;
const SEEN_EVERY_MS = 10 * 60_000;

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
    welcomePending: welcomePending(u.preferences),
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

/**
 * Whether a cookie set on this request may be marked Secure: only when the browser reached
 * Shipmate over https (directly, or through a trusted proxy's X-Forwarded-Proto). Browsers drop a
 * Secure cookie sent over plain http, which left sign-in silently doing nothing when the instance
 * was opened at its LAN address while SHIPMATE_URL named the https one.
 */
export const secureCookie = (request: FastifyRequest) => request.protocol === "https";

/** Browser sessions: a random token in an http-only cookie, its hash in the database. */
export class SessionStore {
  constructor(private readonly db: Db) {}

  async start(reply: FastifyReply, userId: string): Promise<void> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    const agent = reply.request.headers["user-agent"];
    await this.db.insert(authSessions).values({
      id: tokenId(token),
      userId,
      expiresAt,
      userAgent: typeof agent === "string" ? agent.slice(0, 300) : null,
      lastSeenAt: new Date(),
    });
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie(reply.request),
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
    const id = tokenId(token);
    const [row] = await this.db
      .select({ user: users, lastSeenAt: authSessions.lastSeenAt })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.id, id), gt(authSessions.expiresAt, new Date())))
      .limit(1);
    if (!row) return null;
    // "Last used" only needs to be roughly right, so most requests write nothing.
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > SEEN_EVERY_MS) {
      await this.db
        .update(authSessions)
        .set({ lastSeenAt: new Date() })
        .where(eq(authSessions.id, id))
        .catch(() => {});
    }
    return row.user;
  }

  /** The id of the session a request is signed in with (what `list` calls `current`). */
  currentId(request: FastifyRequest): string | null {
    const token = request.cookies[SESSION_COOKIE];
    return token ? tokenId(token) : null;
  }

  /** A person's signed-in devices, most recently used first. */
  async list(userId: string, currentId: string | null): Promise<SessionDto[]> {
    const rows = await this.db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), gt(authSessions.expiresAt, new Date())));
    return rows
      .map((r) => ({
        id: r.id,
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: (r.lastSeenAt ?? r.createdAt).toISOString(),
        current: r.id === currentId,
      }))
      .sort(
        (a, b) => Number(b.current) - Number(a.current) || (a.lastSeenAt < b.lastSeenAt ? 1 : -1),
      );
  }

  /** Sign one of a person's own devices out. False when it is not theirs (or already gone). */
  async endOne(userId: string, id: string): Promise<boolean> {
    const gone = await this.db
      .delete(authSessions)
      .where(and(eq(authSessions.userId, userId), eq(authSessions.id, id)))
      .returning({ id: authSessions.id });
    return gone.length > 0;
  }

  /** Sign a person out everywhere except the session given. */
  async endOthers(userId: string, keepId: string | null): Promise<number> {
    const gone = await this.db
      .delete(authSessions)
      .where(
        keepId
          ? and(eq(authSessions.userId, userId), ne(authSessions.id, keepId))
          : eq(authSessions.userId, userId),
      )
      .returning({ id: authSessions.id });
    return gone.length;
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
