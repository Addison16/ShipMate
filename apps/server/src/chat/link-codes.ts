import { randomInt } from "node:crypto";

export const LINK_CODE_TTL_MS = 10 * 60_000;

interface Entry {
  userId: string;
  expiresAt: number;
}

/**
 * Short-lived six-digit codes a person types in a chat app (Discord, Telegram, Slack) to link
 * their account. They live in memory only, work once, and a new code replaces that person's
 * previous one.
 */
export class LinkCodes {
  #codes = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = LINK_CODE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  issue(userId: string): { code: string; expiresAt: Date } {
    this.#prune();
    for (const [code, e] of this.#codes) if (e.userId === userId) this.#codes.delete(code);
    let code = "";
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (this.#codes.has(code));
    const expiresAt = this.now() + this.ttlMs;
    this.#codes.set(code, { userId, expiresAt });
    return { code, expiresAt: new Date(expiresAt) };
  }

  /** The user the code was issued to, or null if it is unknown, used or expired. */
  consume(code: string): string | null {
    const key = code.trim();
    const e = this.#codes.get(key);
    if (!e) return null;
    this.#codes.delete(key);
    return e.expiresAt > this.now() ? e.userId : null;
  }

  #prune() {
    const now = this.now();
    for (const [code, e] of this.#codes) if (e.expiresAt <= now) this.#codes.delete(code);
  }
}
