import type { SkillDto, UserDto } from "@shipmate/core";

export const SKILL_TEMPLATE = `---
name: my-skill
description: What it does and when to use it.
---

# My skill

Instructions...
`;

const isAdminRole = (u: Pick<UserDto, "role">) => u.role === "owner" || u.role === "admin";

/** Who may edit, delete or approve a skill: admins for crew/instance, the owner for user scope. */
export function canManageSkill(skill: SkillDto, user: Pick<UserDto, "id" | "role">): boolean {
  if (skill.scope === "user") return skill.ownerUserId === user.id || isAdminRole(user);
  return isAdminRole(user);
}

/** Scopes the person may create skills in. */
export function creatableScopes(user: Pick<UserDto, "role">): SkillDto["scope"][] {
  return isAdminRole(user) ? ["user", "crew", "instance"] : ["user"];
}

/** "you", "a person", or the crew member's name. */
export function skillAuthor(
  skill: SkillDto,
  userId: string,
  crewNames: Record<string, string>,
): string {
  if (skill.author === "user") return skill.ownerUserId === userId ? "you" : "a person";
  return crewNames[skill.author] ?? skill.author;
}

export interface SkillGroups {
  instance: SkillDto[];
  /** By crew slug, in slug order. */
  crew: Array<{ slug: string; skills: SkillDto[] }>;
  mine: SkillDto[];
}

const byPendingThenName = (a: SkillDto, b: SkillDto) =>
  a.status !== b.status ? (a.status === "pending" ? -1 : 1) : a.name.localeCompare(b.name);

/** Group by scope, pending first within each group. */
export function groupSkills(skills: SkillDto[]): SkillGroups {
  const crew = new Map<string, SkillDto[]>();
  const out: SkillGroups = { instance: [], crew: [], mine: [] };
  for (const s of skills) {
    if (s.scope === "instance") out.instance.push(s);
    else if (s.scope === "user") out.mine.push(s);
    else {
      const slug = s.crewSlug ?? "";
      crew.set(slug, [...(crew.get(slug) ?? []), s]);
    }
  }
  out.instance.sort(byPendingThenName);
  out.mine.sort(byPendingThenName);
  out.crew = [...crew.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slug, list]) => ({ slug, skills: list.sort(byPendingThenName) }));
  return out;
}
