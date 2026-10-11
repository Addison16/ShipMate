import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrewRegistry, CrewValidationError } from "./registry.js";

const template = new URL("../../../templates/crew/captain", import.meta.url).pathname;

describe("CrewRegistry", () => {
  const registry = () => new CrewRegistry(mkdtempSync(join(tmpdir(), "crew-")));

  it("seeds the Captain with a custom name and model", () => {
    const r = registry();
    const c = r.seedCaptain(template, { name: "Skipper", model: "ollama/qwen3:32b" });
    expect(c.slug).toBe("captain");
    expect(c.manifest.name).toBe("Skipper");
    expect(c.manifest.captain).toBe(true);
    expect(c.persona).toMatch(/^# Skipper$/m);
    expect(c.persona).toContain("You are Skipper, the Captain");
    // Seeding again is idempotent.
    expect(r.seedCaptain(template).manifest.name).toBe("Skipper");
  });

  it("creates, edits and validates crew members", () => {
    const r = registry();
    r.create("galley", { name: "Galley", role: "meals", model: "ollama/qwen3:32b" }, "# Galley");
    expect(() => r.create("galley", { name: "G", role: "x", model: "ollama/a" }, "dup")).toThrow(
      CrewValidationError,
    );
    expect(() => r.update("galley", { manifestYaml: "name: [" })).toThrow(/not valid YAML/);
    expect(() => r.update("galley", { manifestYaml: "name: x\nrole: y\nmodel: bad" })).toThrow(
      /model/,
    );
    const edited = r.patchManifest("galley", { role: "meal planning" });
    expect(edited.manifest.role).toBe("meal planning");
    r.update("galley", { persona: "new persona" });
    expect(readFileSync(join(r.root, "galley", "CREW.md"), "utf8")).toBe("new persona\n");
    expect(r.list().map((c) => c.slug)).toEqual(["galley"]);
  });

  it("refuses a second captain", () => {
    const r = registry();
    expect(() =>
      r.create("boss", { name: "B", role: "x", model: "ollama/a", captain: true }, "x"),
    ).toThrow(/only one Captain/);
  });
});
