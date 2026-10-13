import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type {
  ApprovalDto,
  PushDeviceDto,
  PushEvents,
  PushPayload,
  PushStatusDto,
  ServerEvent,
} from "@shipmate/core";
import { conversations, type Db, pushSubscriptions, secrets } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { and, eq } from "drizzle-orm";
import { HttpError } from "../auth.js";
import { generateVapidKeys, type PushFetch, sendPush, type VapidKeys } from "./webpush.js";

type Row = typeof pushSubscriptions.$inferSelect;

const VAPID_REF = "push:vapid";

/** Push services of the browsers people use; others can be allowed with SHIPMATE_PUSH_HOSTS. */
const KNOWN_PUSH_HOSTS = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export const DEFAULT_PUSH_EVENTS: PushEvents = { approvals: true, watches: true, messages: true };

/** How long the Approve and Deny buttons on a notification work. */
const ACTION_TOKEN_MS = 30 * 60_000;

export interface PushServiceOptions {
  db: Db;
  vault: SecretVault;
  /** SHIPMATE_SECRET; approval action tokens are signed with a key derived from it. */
  secret: string;
  /** SHIPMATE_URL: the VAPID contact and the base of links in notifications. */
  publicUrl: string;
  /** Extra push service hosts (SHIPMATE_PUSH_HOSTS), e.g. a self-hosted one. */
  extraHosts?: string[];
  /** Stand-in for the push services (tests). */
  fetch?: PushFetch;
}

/**
 * Web Push: devices subscribe per person, and approval requests, finished watches and crew
 * replies (while the person has no tab open) reach their phone or desktop as notifications.
 * Approval notifications carry a short-lived one-time token, so their Approve and Deny
 * buttons work from the service worker without a session cookie.
 */
export class PushService {
  #keys: Promise<VapidKeys> | undefined;
  #open = new Map<string, number>();
  #used = new Map<string, number>();
  readonly #tokenKey: Buffer;
  readonly #hosts: string[];

  constructor(private readonly options: PushServiceOptions) {
    this.#tokenKey = Buffer.from(
      hkdfSync("sha256", options.secret, "shipmate-push", "approval-actions-v1", 32),
    );
    this.#hosts = [
      ...KNOWN_PUSH_HOSTS,
      ...(options.extraHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean),
    ];
  }

  // ---------- keys and devices ----------

  /** The VAPID key pair, made on first use and kept encrypted in the vault. */
  keys(): Promise<VapidKeys> {
    this.#keys ??= this.#loadKeys().catch((err) => {
      this.#keys = undefined;
      throw err;
    });
    return this.#keys;
  }

  async status(userId: string): Promise<PushStatusDto> {
    const rows = await this.options.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(pushSubscriptions.createdAt);
    return {
      publicKey: (await this.keys()).publicKey,
      devices: rows.map(toDeviceDto),
    };
  }

  async subscribe(
    userId: string,
    input: { endpoint: string; p256dh: string; auth: string; label: string; events?: PushEvents },
  ): Promise<PushDeviceDto> {
    this.#checkEndpoint(input.endpoint);
    const p256dh = Buffer.from(input.p256dh, "base64url");
    const auth = Buffer.from(input.auth, "base64url");
    if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length < 16) {
      throw new HttpError(400, "that subscription's keys are not valid");
    }
    const values = {
      userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      label: input.label.trim().slice(0, 80) || "This device",
      events: { ...DEFAULT_PUSH_EVENTS, ...input.events },
    };
    // The same browser signing in as someone else takes the subscription over.
    const [row] = await this.options.db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values })
      .returning();
    if (!row) throw new Error("insert failed");
    return toDeviceDto(row);
  }

  async update(userId: string, id: string, events: Partial<PushEvents>): Promise<PushDeviceDto> {
    const row = await this.#own(userId, id);
    const [updated] = await this.options.db
      .update(pushSubscriptions)
      .set({ events: { ...readEvents(row.events), ...events } })
      .where(eq(pushSubscriptions.id, id))
      .returning();
    if (!updated) throw new HttpError(404, "device not found");
    return toDeviceDto(updated);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.#own(userId, id);
    await this.options.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
  }

  /** Send a test notification to every device of this person. */
  async test(userId: string): Promise<{ sent: number; failed: number; removed: number }> {
    return this.#deliver(userId, null, {
      kind: "test",
      title: "Shipmate",
      body: "Notifications work on this device. The crew can reach you here.",
      url: "/#/settings",
      tag: "shipmate-test",
    });
  }

  // ---------- presence ----------

  /** A web app tab connected; returns the matching disconnect. Crew replies push only without one. */
  opened(userId: string): () => void {
    this.#open.set(userId, (this.#open.get(userId) ?? 0) + 1);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (this.#open.get(userId) ?? 1) - 1;
      if (n > 0) this.#open.set(userId, n);
      else this.#open.delete(userId);
    };
  }

  // ---------- events ----------

  /** One of the Bridge's events for `userId`; sends what deserves a notification. Never throws. */
  handle(userId: string, event: ServerEvent): void {
    void this.#handle(userId, event).catch((err) =>
      console.error(`shipmate: push failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  async #handle(userId: string, event: ServerEvent): Promise<void> {
    if (event.type === "approval_request") {
      await this.#deliver(userId, "approvals", this.approvalPayload(userId, event.approval), {
        urgency: "high",
        ttl: Math.floor(ACTION_TOKEN_MS / 1000),
        topic: event.approval.id,
      });
    } else if (event.type === "watch_run") {
      const run = event.run;
      if (run.status !== "succeeded" && run.status !== "failed") return;
      const failed = run.status === "failed";
      await this.#deliver(userId, "watches", {
        kind: "watch",
        title: failed ? `Watch failed: ${event.watchName}` : event.watchName,
        body: preview(failed ? (run.error ?? "The run failed.") : (run.output ?? "Done.")),
        url: "/#/watches",
        tag: `watch-${run.watchId}`,
      });
    } else if (event.type === "message") {
      const m = event.message;
      if (m.author.kind !== "crew" || this.#open.has(userId)) return;
      // Chat bridges and watch runs reach people their own way.
      const [conv] = await this.options.db
        .select({ surface: conversations.surface })
        .from(conversations)
        .where(eq(conversations.id, event.conversationId))
        .limit(1);
      if (conv?.surface !== "web") return;
      await this.#deliver(userId, "messages", {
        kind: "message",
        title: m.author.name,
        body: preview(m.content),
        url: `/#/bridge/${event.conversationId}`,
        tag: `conversation-${event.conversationId}`,
      });
    }
  }

  /** The notification for an approval request, with a token for its Approve and Deny buttons. */
  approvalPayload(userId: string, a: ApprovalDto, now = Date.now()): PushPayload {
    // A question is answered in the app: a notification has no room for its choices.
    if (a.question) {
      return {
        kind: "message",
        title: `${a.crew.name} asks`,
        body: preview(a.question.text),
        url: a.conversationId ? `/#/bridge/${a.conversationId}` : "/#/watches",
        tag: `approval-${a.id}`,
      };
    }
    return {
      kind: "approval",
      title: `${a.crew.name} needs your OK`,
      body: preview(a.summary),
      url: a.conversationId ? `/#/bridge/${a.conversationId}` : "/#/watches",
      tag: `approval-${a.id}`,
      approval: {
        id: a.id,
        token: this.approvalToken(userId, a.id, now + ACTION_TOKEN_MS),
      },
    };
  }

  // ---------- approval action tokens ----------

  /** `<expiry>.<signature>`, bound to one approval and one person. */
  approvalToken(userId: string, approvalId: string, expiresAt: number): string {
    return `${expiresAt}.${this.#sign(userId, approvalId, expiresAt)}`;
  }

  /**
   * The person a token was issued to, or null when it is forged, expired, for another approval,
   * or already used. Each token works once.
   */
  redeem(
    token: string,
    approvalId: string,
    userIdOf: (id: string) => string | null,
  ): string | null {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) return null;
    const expiresAt = Number(m[1]);
    const now = Date.now();
    if (expiresAt < now || expiresAt > now + ACTION_TOKEN_MS + 60_000) return null;
    const userId = userIdOf(approvalId);
    if (!userId) return null;
    const expected = Buffer.from(this.#sign(userId, approvalId, expiresAt));
    const given = Buffer.from(m[2] as string);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const key = createHash("sha256").update(token).digest("hex");
    for (const [k, exp] of this.#used) if (exp < now) this.#used.delete(k);
    if (this.#used.has(key)) return null;
    this.#used.set(key, expiresAt);
    return userId;
  }

  #sign(userId: string, approvalId: string, expiresAt: number): string {
    return createHmac("sha256", this.#tokenKey)
      .update(`${userId}\n${approvalId}\n${expiresAt}`)
      .digest("base64url");
  }

  // ---------- internals ----------

  async #deliver(
    userId: string,
    kind: keyof PushEvents | null,
    payload: PushPayload,
    options: { urgency?: "normal" | "high"; ttl?: number; topic?: string } = {},
  ): Promise<{ sent: number; failed: number; removed: number }> {
    const rows = await this.options.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    const targets = rows.filter((r) => kind === null || readEvents(r.events)[kind]);
    const result = { sent: 0, failed: 0, removed: 0 };
    if (!targets.length) return result;
    const keys = await this.keys();
    await Promise.all(
      targets.map(async (row) => {
        const outcome = await sendPush(row, payload, {
          keys,
          subject: this.#subject(),
          ...options,
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        if (outcome === "gone") {
          result.removed++;
          await this.options.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, row.id));
        } else if (outcome === "sent") {
          result.sent++;
          await this.options.db
            .update(pushSubscriptions)
            .set({ lastSentAt: new Date() })
            .where(eq(pushSubscriptions.id, row.id));
        } else {
          result.failed++;
        }
      }),
    );
    return result;
  }

  /** VAPID wants a mailto: or https: contact; push services ignore a localhost one. */
  #subject(): string {
    const url = this.options.publicUrl;
    return url.startsWith("https://") ? url : "mailto:shipmate@localhost";
  }

  #checkEndpoint(endpoint: string) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new HttpError(400, "that is not a push subscription");
    }
    const host = url.hostname.toLowerCase();
    const known = this.#hosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (url.protocol !== "https:" || !known || url.username || url.password) {
      throw new HttpError(
        400,
        `push service ${host} is not one Shipmate knows; an owner can allow it with SHIPMATE_PUSH_HOSTS`,
      );
    }
  }

  async #own(userId: string, id: string): Promise<Row> {
    const [row] = await this.options.db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId)))
      .limit(1);
    if (!row) throw new HttpError(404, "device not found");
    return row;
  }

  async #loadKeys(): Promise<VapidKeys> {
    const { db, vault } = this.options;
    const [row] = await db.select().from(secrets).where(eq(secrets.ref, VAPID_REF)).limit(1);
    if (row) return JSON.parse(vault.decrypt(row.ciphertext)) as VapidKeys;
    const keys = generateVapidKeys();
    // Two first requests at once must agree on one key pair; the first insert wins.
    await db
      .insert(secrets)
      .values({ ref: VAPID_REF, ciphertext: vault.encrypt(JSON.stringify(keys)) })
      .onConflictDoNothing();
    const [stored] = await db.select().from(secrets).where(eq(secrets.ref, VAPID_REF)).limit(1);
    if (!stored) throw new Error("could not store the push keys");
    return JSON.parse(vault.decrypt(stored.ciphertext)) as VapidKeys;
  }
}

function readEvents(value: unknown): PushEvents {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    approvals: v.approvals !== false,
    watches: v.watches !== false,
    messages: v.messages !== false,
  };
}

function toDeviceDto(r: Row): PushDeviceDto {
  return {
    id: r.id,
    endpoint: r.endpoint,
    label: r.label,
    events: readEvents(r.events),
    lastSentAt: r.lastSentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Notification text: one paragraph, Markdown marks dropped, short enough for a lock screen. */
export function preview(text: string, max = 180): string {
  const s = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
