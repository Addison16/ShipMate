import type { SkillDetailDto, SkillDto } from "@shipmate/core";
import { SkillError, type SkillRecord, type SkillScope, SkillStore } from "@shipmate/crew";
import { atLeast, HttpError, type UserRow } from "../auth.js";

/**
 * Skills in three scopes. People write skills directly; crew members write them through
 * `create_skill`, and those wait as pending until a person approves them (§6).
 */
export class SkillService {
  readonly store: SkillStore;
  #listeners = new Set<() => void>();

  constructor(dataDir: string, crewDir: string) {
    this.store = new SkillStore(dataDir, crewDir);
  }

  onChange(listener: () => void) {
    this.#listeners.add(listener);
  }

  #changed() {
    for (const l of this.#listeners) l();
  }

  /** Active skill folders pi should load for a session with this person (besides the crew's). */
  pathsFor(userId: string): string[] {
    return [this.store.dirs("instance", null).active, this.store.dirs("user", userId).active];
  }

  list(user: UserRow): SkillDto[] {
    return this.store
      .list()
      .filter((s) => s.scope !== "user" || s.ownerUserId === user.id)
      .map(toDto);
  }

  get(user: UserRow, id: string): SkillDetailDto {
    const s = this.#wrap(() => this.store.get(id));
    if (s.scope === "user" && s.ownerUserId !== user.id)
      throw new HttpError(404, "skill not found");
    return { ...toDto(s), content: s.content };
  }

  /** A person writes or edits a skill; it is active right away. */
  write(
    user: UserRow,
    scope: SkillScope,
    crewSlug: string | undefined,
    content: string,
  ): SkillDetailDto {
    const owner = this.#owner(user, scope, crewSlug);
    const s = this.#wrap(() =>
      this.store.write(scope, owner, content, { author: "user", pending: false }),
    );
    this.#changed();
    return { ...toDto(s), content: s.content };
  }

  update(user: UserRow, id: string, content: string): SkillDetailDto {
    const current = this.get(user, id);
    this.#owner(user, current.scope, current.crewSlug ?? undefined);
    const { name } = SkillStore.parseId(id);
    if (!content.includes(`name: ${name}`)) {
      throw new HttpError(400, `the frontmatter name must stay "${name}"`);
    }
    return this.write(user, current.scope, current.crewSlug ?? undefined, content);
  }

  /** A crew member writes a skill; pending unless that crew member auto-approves. */
  createByCrew(
    crewSlug: string,
    userId: string,
    scope: "crew" | "user",
    content: string,
    autoApprove: boolean,
  ) {
    const owner = scope === "crew" ? crewSlug : userId;
    const s = this.#wrap(() =>
      this.store.write(scope, owner, content, { author: crewSlug, pending: !autoApprove }),
    );
    this.#changed();
    return s;
  }

  approve(user: UserRow, id: string): SkillDetailDto {
    const current = this.get(user, id);
    this.#owner(user, current.scope, current.crewSlug ?? undefined);
    const s = this.#wrap(() => this.store.approve(id));
    this.#changed();
    return { ...toDto(s), content: s.content };
  }

  remove(user: UserRow, id: string): void {
    const current = this.get(user, id);
    this.#owner(user, current.scope, current.crewSlug ?? undefined);
    this.#wrap(() => this.store.remove(id));
    this.#changed();
  }

  /** Who may change skills in a scope: admins for crew and instance, the person for their own. */
  #owner(user: UserRow, scope: SkillScope, crewSlug: string | undefined): string | null {
    if (scope === "user") return user.id;
    if (!atLeast(user.role, "admin")) throw new HttpError(403, "needs the admin role");
    if (scope === "crew") {
      if (!crewSlug) throw new HttpError(400, "crew skills need crewSlug");
      return crewSlug;
    }
    return null;
  }

  #wrap<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof SkillError) throw new HttpError(400, err.message);
      throw err;
    }
  }
}

function toDto(s: SkillRecord): SkillDto {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    scope: s.scope,
    crewSlug: s.crewSlug,
    ownerUserId: s.ownerUserId,
    status: s.status,
    author: s.author,
    updatedAt: s.updatedAt.toISOString(),
  };
}
