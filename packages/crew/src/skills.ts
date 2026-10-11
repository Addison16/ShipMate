import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CREW_FILES, CrewSlug } from "@shipmate/core";
import { parse as parseYaml } from "yaml";

export type SkillScope = "crew" | "user" | "instance";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  crewSlug: string | null;
  ownerUserId: string | null;
  status: "active" | "pending";
  author: string;
  dir: string;
  updatedAt: Date;
}

export class SkillError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse SKILL.md frontmatter; returns name, description and the Shipmate author. */
export function parseSkill(content: string): {
  name: string;
  description: string;
  author: string | null;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) throw new SkillError("SKILL.md must start with --- frontmatter ---");
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
  } catch (err) {
    throw new SkillError(`frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  const name = fm.name;
  const description = fm.description;
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new SkillError("frontmatter needs a name: lowercase letters, digits and dashes");
  }
  if (typeof description !== "string" || !description.trim() || description.length > 1024) {
    throw new SkillError("frontmatter needs a description (what it does and when to use it)");
  }
  const meta = fm.metadata as Record<string, unknown> | undefined;
  const author =
    typeof meta?.["shipmate-author"] === "string" ? (meta["shipmate-author"] as string) : null;
  return { name, description: description.trim(), author };
}

/** Add or replace `metadata.shipmate-author` in the frontmatter. */
export function withAuthor(content: string, author: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return content;
  const lines = (m[1] ?? "").split(/\r?\n/).filter((l) => !/^\s+shipmate-author:/.test(l));
  const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (metaIdx >= 0) lines.splice(metaIdx + 1, 0, `  shipmate-author: ${JSON.stringify(author)}`);
  else lines.push("metadata:", `  shipmate-author: ${JSON.stringify(author)}`);
  return `---\n${lines.join("\n")}\n---${content.slice(m[0].length)}`;
}

/**
 * Skills on disk in the Agent Skills format. Each scope has an active folder pi loads and a
 * pending folder it does not; approving moves the skill across.
 *
 *   instance  /data/skills/<name>/SKILL.md            /data/skills-pending/<name>
 *   user      /data/users/<id>/skills/<name>          /data/users/<id>/skills-pending/<name>
 *   crew      /data/crew/<slug>/skills/<name>         /data/crew/<slug>/skills-pending/<name>
 */
export class SkillStore {
  constructor(
    readonly dataDir: string,
    readonly crewRoot: string,
  ) {}

  dirs(scope: SkillScope, owner: string | null): { active: string; pending: string } {
    if (scope === "instance") {
      return {
        active: join(this.dataDir, "skills"),
        pending: join(this.dataDir, "skills-pending"),
      };
    }
    if (scope === "user") {
      if (!owner || !USER_ID.test(owner)) throw new SkillError("user skills need a user id");
      const base = join(this.dataDir, "users", owner);
      return { active: join(base, "skills"), pending: join(base, "skills-pending") };
    }
    if (!owner || !CrewSlug.safeParse(owner).success)
      throw new SkillError("crew skills need a crew slug");
    const base = join(this.crewRoot, owner);
    return {
      active: join(base, CREW_FILES.skillsDir),
      pending: join(base, CREW_FILES.pendingSkillsDir),
    };
  }

  static id(scope: SkillScope, owner: string | null, name: string) {
    return `${scope}:${owner ?? "-"}:${name}`;
  }

  static parseId(id: string): { scope: SkillScope; owner: string | null; name: string } {
    const [scope, owner, name] = id.split(":");
    if (
      (scope !== "crew" && scope !== "user" && scope !== "instance") ||
      !owner ||
      !name ||
      !NAME.test(name)
    ) {
      throw new SkillError("bad skill id");
    }
    return { scope, owner: owner === "-" ? null : owner, name };
  }

  list(): SkillRecord[] {
    const out: SkillRecord[] = [];
    out.push(...this.#scan("instance", null));
    for (const user of subdirs(join(this.dataDir, "users"))) out.push(...this.#scan("user", user));
    for (const slug of subdirs(this.crewRoot)) {
      if (CrewSlug.safeParse(slug).success) out.push(...this.#scan("crew", slug));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): SkillRecord & { content: string } {
    const { scope, owner, name } = SkillStore.parseId(id);
    const dirs = this.dirs(scope, owner);
    for (const [status, dir] of [
      ["active", dirs.active],
      ["pending", dirs.pending],
    ] as const) {
      const file = join(dir, name, "SKILL.md");
      if (existsSync(file)) {
        const rec = this.#record(scope, owner, status, join(dir, name));
        if (rec) return { ...rec, content: readFileSync(file, "utf8") };
      }
    }
    throw new SkillError(`no skill ${id}`);
  }

  /** Create or replace a skill. `pending` puts new skills in the pending folder. */
  write(
    scope: SkillScope,
    owner: string | null,
    content: string,
    options: { author: string; pending: boolean },
  ) {
    const { name } = parseSkill(content);
    const dirs = this.dirs(scope, owner);
    const existingActive = existsSync(join(dirs.active, name, "SKILL.md"));
    const existingPending = existsSync(join(dirs.pending, name, "SKILL.md"));
    // Editing keeps a skill where it is; a bot rewriting an active skill sends it back to review.
    const pending = options.pending ? true : existingPending && !existingActive;
    const target = join(pending ? dirs.pending : dirs.active, name);
    const other = join(pending ? dirs.active : dirs.pending, name);
    if (existsSync(other)) rmSync(other, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), withAuthor(content, options.author));
    return this.get(SkillStore.id(scope, owner, name));
  }

  approve(id: string) {
    const skill = this.get(id);
    if (skill.status === "active") return skill;
    const dirs = this.dirs(
      skill.scope,
      skill.scope === "crew" ? skill.crewSlug : skill.ownerUserId,
    );
    mkdirSync(dirs.active, { recursive: true });
    const target = join(dirs.active, skill.name);
    if (existsSync(target)) rmSync(target, { recursive: true });
    renameSync(skill.dir, target);
    return this.get(id);
  }

  remove(id: string): void {
    const skill = this.get(id);
    rmSync(skill.dir, { recursive: true });
  }

  #scan(scope: SkillScope, owner: string | null): SkillRecord[] {
    const dirs = this.dirs(scope, owner);
    const out: SkillRecord[] = [];
    for (const [status, dir] of [
      ["active", dirs.active],
      ["pending", dirs.pending],
    ] as const) {
      for (const name of subdirs(dir)) {
        const rec = this.#record(scope, owner, status, join(dir, name));
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  #record(
    scope: SkillScope,
    owner: string | null,
    status: "active" | "pending",
    dir: string,
  ): SkillRecord | undefined {
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) return undefined;
    try {
      const parsed = parseSkill(readFileSync(file, "utf8"));
      return {
        id: SkillStore.id(scope, owner, parsed.name),
        name: parsed.name,
        description: parsed.description,
        scope,
        crewSlug: scope === "crew" ? owner : null,
        ownerUserId: scope === "user" ? owner : null,
        status,
        author: parsed.author ?? "user",
        dir,
        updatedAt: statSync(file).mtime,
      };
    } catch {
      return undefined;
    }
  }
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
