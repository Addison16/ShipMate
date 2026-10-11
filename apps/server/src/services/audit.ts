import type { AuditEventDto } from "@shipmate/core";
import { auditEvents, crewMembers, type Db, users } from "@shipmate/db";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";

/** Audit log of every tool call and Shipmate action, viewable per crew and per user (§13). */
export class AuditService {
  constructor(private readonly db: Db) {}

  async record(e: {
    userId: string | null;
    crewMemberId: string | null;
    action: string;
    summary: string;
    decision: string | null;
    detail?: unknown;
  }): Promise<void> {
    await this.db.insert(auditEvents).values({
      userId: e.userId,
      crewMemberId: e.crewMemberId,
      action: e.action,
      summary: e.summary.slice(0, 500),
      decision: e.decision,
      detail: e.detail ?? null,
    });
  }

  async list(q: {
    userId?: string | undefined;
    crewSlug?: string | undefined;
    before?: Date | undefined;
    limit: number;
  }): Promise<AuditEventDto[]> {
    const filters: SQL[] = [];
    if (q.userId) filters.push(eq(auditEvents.userId, q.userId));
    if (q.crewSlug) filters.push(eq(crewMembers.slug, q.crewSlug));
    if (q.before) filters.push(lt(auditEvents.createdAt, q.before));
    const rows = await this.db
      .select({
        e: auditEvents,
        userName: users.displayName,
        slug: crewMembers.slug,
        crewName: crewMembers.name,
      })
      .from(auditEvents)
      .leftJoin(users, eq(users.id, auditEvents.userId))
      .leftJoin(crewMembers, eq(crewMembers.id, auditEvents.crewMemberId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(auditEvents.createdAt))
      .limit(q.limit);
    return rows.map((r) => ({
      id: r.e.id,
      user: r.e.userId && r.userName ? { id: r.e.userId, name: r.userName } : null,
      crew: r.slug ? { slug: r.slug, name: r.crewName ?? r.slug } : null,
      action: r.e.action,
      summary: r.e.summary,
      decision: r.e.decision,
      createdAt: r.e.createdAt.toISOString(),
    }));
  }
}
