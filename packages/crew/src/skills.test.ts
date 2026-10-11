import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkill, SkillError, SkillStore } from "./skills.js";

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Plans meals for the week.${extra}\n---\n\n# Steps\n`;

describe("SkillStore", () => {
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    return new SkillStore(root, join(root, "crew"));
  };

  it("keeps bot-made skills pending until approved", () => {
    const s = store();
    const created = s.write("crew", "galley", skill("meal-plan"), {
      author: "galley",
      pending: true,
    });
    expect(created).toMatchObject({
      id: "crew:galley:meal-plan",
      status: "pending",
      author: "galley",
    });
    expect(created.dir).toContain("skills-pending");
    const approved = s.approve(created.id);
    expect(approved.status).toBe("active");
    expect(approved.dir).toMatch(/galley\/skills\/meal-plan$/);
    expect(s.list().map((k) => k.id)).toEqual(["crew:galley:meal-plan"]);
  });

  it("sends an active skill back to review when a bot rewrites it", () => {
    const s = store();
    s.write("instance", null, skill("pdf-tools"), { author: "user", pending: false });
    const rewritten = s.write("instance", null, skill("pdf-tools", "\nlicense: MIT"), {
      author: "captain",
      pending: true,
    });
    expect(rewritten.status).toBe("pending");
    expect(s.list()).toHaveLength(1);
    s.remove(rewritten.id);
    expect(s.list()).toHaveLength(0);
  });

  it("validates frontmatter and ids", () => {
    expect(() => parseSkill("# no frontmatter")).toThrow(SkillError);
    expect(() => parseSkill("---\nname: Bad Name\ndescription: x\n---\n")).toThrow(/name/);
    expect(() => SkillStore.parseId("crew:../x:y")).not.toThrow();
    expect(() => store().dirs("crew", "../x")).toThrow(SkillError);
    expect(() => SkillStore.parseId("nope")).toThrow(SkillError);
  });
});
