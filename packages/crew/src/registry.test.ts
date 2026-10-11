import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrewRegistry, CrewValidationError } from "./registry.js";

const template = new URL("../../../templates/crew/captain", import.meta.url).pathname;
const previousCaptain = new URL(
  "../../../templates/crew/.previous/captain/1.0.0.md",
  import.meta.url,
).pathname;

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

  it("upgrades an untouched stock Captain persona and keeps edited ones", () => {
    // An install from 1.0.0: the old stock CREW.md, renamed at setup.
    const old = mkdtempSync(join(tmpdir(), "tpl-"));
    cpSync(template, old, { recursive: true });
    writeFileSync(join(old, "CREW.md"), readFileSync(previousCaptain, "utf8"));
    const r = registry();
    r.seedCaptain(old, { name: "Skipper" });
    const stock = {
      current: readFileSync(join(template, "CREW.md"), "utf8"),
      previous: [readFileSync(previousCaptain, "utf8")],
    };

    expect(r.upgradeStockPersona("captain", stock)).toBe(true);
    const upgraded = r.get("captain").persona;
    expect(upgraded).toMatch(/^# Skipper$/m);
    expect(upgraded).toContain("You are Skipper, the Captain");
    expect(upgraded).toContain("ask_captain");
    // Already current: nothing to do.
    expect(r.upgradeStockPersona("captain", stock)).toBe(false);

    r.update("captain", { persona: `${upgraded}\nAlways answer in French.\n` });
    expect(r.upgradeStockPersona("captain", { ...stock, previous: [upgraded] })).toBe(false);
    expect(r.get("captain").persona).toContain("Always answer in French.");
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
