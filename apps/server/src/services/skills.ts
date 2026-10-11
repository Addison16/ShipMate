import type { SkillDetailDto, SkillDto } from "@shipmate/core";
import {
  parseSkill,
  SkillError,
  type SkillRecord,
  type SkillScope,
  SkillStore,
} from "@shipmate/crew";
import { atLeast, HttpError, type UserRow } from "../auth.js";
import type { CrewService } from "./crew.js";

/**
 * Skills in three scopes. People write skills directly; crew members write them through
 * `create_skill`, and those wait as pending until a person approves them (§6).
 */
export class SkillService {
  readonly store: SkillStore;
  #listeners = new Set<() => void>();

  constructor(
    dataDir: string,
    private readonly crew: CrewService,
  ) {
    this.store = new SkillStore(dataDir, crew.registry.root);
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

  /** Skills `user` may see: instance skills, their own, and those of crew they can see. */
  async list(user: UserRow): Promise<SkillDto[]> {
    const crew = new Set((await this.crew.list(true, user)).map((c) => c.slug));
    return this.store
      .list()
      .filter((s) => visible(s, user, crew))
      .map(toDto);
  }

  async get(user: UserRow, id: string): Promise<SkillDetailDto> {
    const s = this.#wrap(() => this.store.get(id));
    const crew = new Set((await this.crew.list(true, user)).map((c) => c.slug));
    if (!visible(s, user, crew)) throw new HttpError(404, "skill not found");
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

  async update(user: UserRow, id: string, content: string): Promise<SkillDetailDto> {
    const current = await this.get(user, id);
    this.#owner(user, current.scope, current.crewSlug ?? undefined);
    const { name } = SkillStore.parseId(id);
    if (this.#wrap(() => parseSkill(content)).name !== name) {
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

  async approve(user: UserRow, id: string): Promise<SkillDetailDto> {
    const current = await this.get(user, id);
    this.#owner(user, current.scope, current.crewSlug ?? undefined);
    const s = this.#wrap(() => this.store.approve(id));
    this.#changed();
    return { ...toDto(s), content: s.content };
  }

  async remove(user: UserRow, id: string): Promise<void> {
    const current = await this.get(user, id);
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
      this.crew.folder(crewSlug);
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

function visible(s: SkillRecord, user: UserRow, crew: Set<string>): boolean {
  if (s.scope === "user") return s.ownerUserId === user.id;
  if (s.scope === "crew") return s.crewSlug !== null && crew.has(s.crewSlug);
  return true;
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
