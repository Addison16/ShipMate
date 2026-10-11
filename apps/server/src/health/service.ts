import type { HealthDto } from "@shipmate/core";
import { HttpError } from "../auth.js";
import { type HealthDeps, runChecks } from "./checks.js";
import type { ReleaseChecker } from "./releases.js";
import type { Updater } from "./updater.js";

/** The Health page: version and releases, checks, and the update path. */
export class HealthService {
  #updateStartedAt = 0;

  constructor(
    private readonly deps: HealthDeps,
    readonly releases: ReleaseChecker,
    readonly updater: Updater,
    private readonly version: string,
  ) {}

  async report(refresh = false): Promise<HealthDto> {
    const [release, checks] = await Promise.all([
      this.releases.check(refresh),
      runChecks(this.deps),
    ]);
    const { self: _self, ...update } = await this.updater.plan(release.latest?.version ?? null);
    return {
      version: this.version,
      release,
      checks,
      update,
      checkedAt: new Date().toISOString(),
    };
  }

  /** Start the one-click update; refuses a second one while the first is likely running. */
  async update(): Promise<{ helper: string }> {
    if (Date.now() - this.#updateStartedAt < 5 * 60_000) {
      throw new HttpError(409, "An update is already running; Shipmate restarts when it is done.");
    }
    // Claim the slot before the first await, so a second click (or a second owner) arriving
    // while the helper is being pulled and created cannot start another one.
    this.#updateStartedAt = Date.now();
    try {
      const release = await this.releases.check();
      return await this.updater.run(release.latest?.version ?? null);
    } catch (err) {
      this.#updateStartedAt = 0;
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  }
}
