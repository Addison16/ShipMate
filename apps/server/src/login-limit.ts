/**
 * Slows down password guessing. After a few wrong tries for the same email from the same
 * address, or many wrong tries from one address, sign-in is refused for a while. Kept in
 * memory: Shipmate is one process, and a restart only forgives a wait of minutes.
 */

export interface LoginLimitOptions {
  /** Wrong tries for one email from one address before a wait. */
  perEmail?: number;
  /** Wrong tries from one address, across all emails, before a wait. */
  perAddress?: number;
  /** How far back wrong tries count, and how long the wait lasts. */
  windowMs?: number;
  now?: () => number;
}

interface Entry {
  fails: number[];
  blockedUntil: number;
}

/** Most entries kept; past this the oldest are dropped so a flood cannot grow memory. */
const MAX_ENTRIES = 10_000;

export class LoginLimiter {
  readonly #perEmail: number;
  readonly #perAddress: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry>();

  constructor(options: LoginLimitOptions = {}) {
    this.#perEmail = options.perEmail ?? 5;
    this.#perAddress = options.perAddress ?? 30;
    this.#windowMs = options.windowMs ?? 15 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  #keys(email: string, address: string): Array<[string, number]> {
    return [
      [`e:${address}:${email.toLowerCase()}`, this.#perEmail],
      [`a:${address}`, this.#perAddress],
    ];
  }

  /** Seconds to wait before another try, or 0 when a try is allowed now. */
  waitSeconds(email: string, address: string): number {
    const now = this.#now();
    let until = 0;
    for (const [key] of this.#keys(email, address)) {
      until = Math.max(until, this.#entries.get(key)?.blockedUntil ?? 0);
    }
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }

  /** Record a wrong password. */
  failed(email: string, address: string): void {
    const now = this.#now();
    for (const [key, limit] of this.#keys(email, address)) {
      const entry = this.#entries.get(key) ?? { fails: [], blockedUntil: 0 };
      entry.fails = entry.fails.filter((t) => now - t < this.#windowMs);
      entry.fails.push(now);
      if (entry.fails.length >= limit) {
        entry.blockedUntil = now + this.#windowMs;
        entry.fails = [];
      }
      // Re-inserted so the map stays in order of last use.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
    }
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  readonly #queues = new Map<string, Promise<unknown>>();

  /**
   * Run sign-in checks from one address one at a time, so a burst of requests sent together
   * cannot all pass the wait check before any of them is counted as wrong.
   */
  async inTurn<T>(address: string, run: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(address) ?? Promise.resolve();
    const mine = before.then(run, run);
    const tail = mine.catch(() => {});
    this.#queues.set(address, tail);
    try {
      return await mine;
    } finally {
      if (this.#queues.get(address) === tail) this.#queues.delete(address);
    }
  }

  /** A right password forgives the wrong tries for that email from that address. */
  succeeded(email: string, address: string): void {
    this.#entries.delete(`e:${address}:${email.toLowerCase()}`);
  }
}

/** "about 15 minutes", "1 minute", "30 seconds": a wait in plain words. */
export function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
