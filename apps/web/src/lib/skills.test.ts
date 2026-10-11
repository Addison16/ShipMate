import type { SkillDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { canManageSkill, creatableScopes, groupSkills, skillAuthor } from "./skills.js";

function skill(id: string, over: Partial<SkillDto> = {}): SkillDto {
  return {
    id,
    name: id,
    description: "",
    scope: "instance",
    crewSlug: null,
    ownerUserId: null,
    status: "active",
    author: "user",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...over,
  };
}

const member = { id: "u2", role: "member" as const };
const admin = { id: "u1", role: "admin" as const };

describe("skills", () => {
  it("groups by scope with pending first", () => {
    const g = groupSkills([
      skill("b", { scope: "crew", crewSlug: "galley" }),
      skill("a", { scope: "crew", crewSlug: "galley", status: "pending" }),
      skill("z", { scope: "crew", crewSlug: "bosun" }),
      skill("m", { scope: "user", ownerUserId: "u2" }),
      skill("i"),
    ]);
    expect(g.instance.map((s) => s.id)).toEqual(["i"]);
    expect(g.mine.map((s) => s.id)).toEqual(["m"]);
    expect(g.crew.map((c) => [c.slug, c.skills.map((s) => s.id)])).toEqual([
      ["bosun", ["z"]],
      ["galley", ["a", "b"]],
    ]);
  });

  it("applies the permission rules", () => {
    expect(canManageSkill(skill("i"), member)).toBe(false);
    expect(canManageSkill(skill("i"), admin)).toBe(true);
    expect(canManageSkill(skill("m", { scope: "user", ownerUserId: "u2" }), member)).toBe(true);
    expect(canManageSkill(skill("m", { scope: "user", ownerUserId: "u9" }), member)).toBe(false);
    expect(creatableScopes(member)).toEqual(["user"]);
    expect(creatableScopes(admin)).toContain("instance");
  });

  it("names the author", () => {
    const names = { galley: "Galley" };
    expect(skillAuthor(skill("a", { scope: "user", ownerUserId: "u2" }), "u2", names)).toBe("you");
    expect(skillAuthor(skill("a"), "u2", names)).toBe("a person");
    expect(skillAuthor(skill("a", { author: "galley" }), "u2", names)).toBe("Galley");
    expect(skillAuthor(skill("a", { author: "ghost" }), "u2", names)).toBe("ghost");
  });
});
