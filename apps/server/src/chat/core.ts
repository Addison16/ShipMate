import type { ServerEvent } from "@shipmate/core";
import { conversations, type Db, secrets, settings, users } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { and, eq, isNotNull } from "drizzle-orm";
import { HttpError, type UserRow } from "../auth.js";
import type { Bridge } from "../bridge.js";
import type { CrewService } from "../services/crew.js";
import { LinkCodes } from "./link-codes.js";

/**
 * Pieces every chat bridge (Telegram, Slack) needs around its chat app: vault secrets and id
 * settings, linked accounts, Bridge listeners for linked people, and running a message as a
 * turn in a per-chat conversation.
 */

/** Vault secrets and small id settings. */
export class BridgeStore {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
  ) {}

  async secret(ref: string): Promise<string | null> {
    const [s] = await this.db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
    if (!s) return null;
    try {
      return this.vault.decrypt(s.ciphertext);
    } catch {
      return null;
    }
  }

  async hasSecret(ref: string): Promise<boolean> {
    const [s] = await this.db
      .select({ ref: secrets.ref })
      .from(secrets)
      .where(eq(secrets.ref, ref))
      .limit(1);
    return Boolean(s);
  }

  async putSecret(ref: string, value: string) {
    const ciphertext = this.vault.encrypt(value);
    await this.db
      .insert(secrets)
      .values({ ref, ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
  }

  async deleteSecret(ref: string) {
    await this.db.delete(secrets).where(eq(secrets.ref, ref));
  }

  /** Stored as { id } so an all-digit id is never re-parsed into a lossy number. */
  async setting(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    const value = row?.value as { id?: unknown } | undefined;
    return typeof value?.id === "string" ? value.id : null;
  }

  async setSetting(key: string, id: string) {
    const value = { id };
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }

  async deleteSetting(key: string) {
    await this.db.delete(settings).where(eq(settings.key, key));
  }
}

export type AccountColumn = "telegramUserId" | "slackUserId";

/** Chat app accounts linked to Shipmate people, by one-time code. */
export class LinkedAccounts {
  readonly codes = new LinkCodes();

  constructor(
    private readonly db: Db,
    private readonly column: AccountColumn,
    /** "Telegram", "Slack": used in replies. */
    private readonly app: string,
  ) {}

  async user(externalUserId: string): Promise<UserRow | null> {
    const [u] = await this.db
      .select()
      .from(users)
      .where(eq(users[this.column], externalUserId))
      .limit(1);
    return u ?? null;
  }

  async linkedUserIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(isNotNull(users[this.column]));
    return rows.map((r) => r.id);
  }

  /** Link the account that typed `code`. `user` is set when it worked. */
  async link(
    externalUserId: string,
    code: string,
  ): Promise<{ reply: string; user: UserRow | null }> {
    const userId = this.codes.consume(code);
    if (!userId) {
      return {
        reply: "That code is not valid or has expired. Make a new one in Shipmate.",
        user: null,
      };
    }
    const existing = await this.user(externalUserId);
    if (existing && existing.id !== userId) {
      return {
        reply: `This ${this.app} account is already linked to ${existing.displayName}. Unlink it in Shipmate first.`,
        user: null,
      };
    }
    let linked: UserRow | undefined;
    try {
      [linked] = await this.db
        .update(users)
        .set({ [this.column]: externalUserId })
        .where(eq(users.id, userId))
        .returning();
    } catch {
      return { reply: `This ${this.app} account is already linked to someone else.`, user: null };
    }
    if (!linked) return { reply: "That Shipmate account no longer exists.", user: null };
    return {
      reply: `Linked to ${linked.displayName}'s Shipmate account. You can talk to the crew here now.`,
      user: linked,
    };
  }

  async unlink(userId: string) {
    await this.db
      .update(users)
      .set({ [this.column]: null })
      .where(eq(users.id, userId));
  }
}

/** Bridge listeners for linked people while a chat app is connected. */
export class BridgeListeners {
  #off = new Map<string, () => void>();

  constructor(
    private readonly bridge: Bridge,
    private readonly handle: (userId: string, event: ServerEvent) => void,
  ) {}

  listen(userId: string) {
    if (this.#off.has(userId)) return;
    this.#off.set(
      userId,
      this.bridge.connect(userId, (event) => this.handle(userId, event)),
    );
  }

  drop(userId: string) {
    this.#off.get(userId)?.();
    this.#off.delete(userId);
  }

  clear() {
    for (const off of this.#off.values()) off();
    this.#off.clear();
  }
}

export type DeliverOutcome =
  | { kind: "sent" }
  /** The crew member is private to someone else, or gone. */
  | { kind: "hidden" }
  | { kind: "inactive"; crewName: string }
  | { kind: "busy"; crewName: string }
  | { kind: "failed"; message: string; serverError: boolean };

/** What to tell the person for an outcome other than "sent". */
export function outcomeText(o: Exclude<DeliverOutcome, { kind: "sent" }>): string {
  switch (o.kind) {
    case "hidden":
      return "This crew member is not available to you.";
    case "inactive":
      return `${o.crewName} is not taking messages right now.`;
    case "busy":
      return `${o.crewName} is still answering your last message. Send this again once it's done.`;
    case "failed":
      return o.message;
  }
}

/**
 * Run `text` as `user`'s turn with crew member `slug`, in the conversation for this chat and
 * person (made on first use). Resolves once the turn is over. `onConversation` gets the id as
 * soon as it is known, before the turn starts, so replies can be routed.
 */
export async function deliver(
  deps: { db: Db; crew: CrewService; bridge: Bridge },
  input: {
    user: UserRow;
    slug: string;
    text: string;
    surface: string;
    externalId: string;
    title: (crewName: string) => string;
    onConversation?: (conversationId: string) => void;
  },
): Promise<DeliverOutcome> {
  let crew: Awaited<ReturnType<CrewService["assertVisible"]>>;
  try {
    crew = await deps.crew.assertVisible(input.slug, input.user);
  } catch {
    return { kind: "hidden" };
  }
  if (crew.status !== "active") return { kind: "inactive", crewName: crew.name };

  const [found] = await deps.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.surface, input.surface),
        eq(conversations.externalId, input.externalId),
        eq(conversations.userId, input.user.id),
      ),
    )
    .limit(1);
  const conversationId =
    found?.id ??
    (
      await deps.bridge.createConversation(input.user, {
        kind: crew.captain ? "bridge" : "direct",
        crewSlug: crew.slug,
        surface: input.surface,
        externalId: input.externalId,
        title: input.title(crew.name),
      })
    ).id;
  input.onConversation?.(conversationId);

  try {
    await deps.bridge.send(input.user, conversationId, input.text);
    return { kind: "sent" };
  } catch (err) {
    const status = err instanceof HttpError ? err.statusCode : 500;
    if (status === 409) return { kind: "busy", crewName: crew.name };
    return {
      kind: "failed",
      message: err instanceof HttpError ? err.message : "Something went wrong on the server.",
      serverError: status >= 500,
    };
  }
}

/** A log function that prefixes `[name]` and the error's message. */
export function bridgeLog(name: string): (message: string, err?: unknown) => void {
  return (message, err) =>
    console.error(
      `[${name}] ${message}${err ? `: ${err instanceof Error ? err.message : String(err)}` : ""}`,
    );
}
