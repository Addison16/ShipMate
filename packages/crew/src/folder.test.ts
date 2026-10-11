import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCrewFolder, writeCrewFolder } from "./folder.js";

describe("crew folders", () => {
  it("writes and reads back a crew member", () => {
    const root = mkdtempSync(join(tmpdir(), "crew-"));
    const dir = join(root, "galley");
    writeCrewFolder(
      dir,
      { name: "Galley", role: "meals", model: "ollama/qwen3:32b" },
      "# Galley\nYou plan meals.",
    );
    const loaded = loadCrewFolder(dir);
    expect(loaded.slug).toBe("galley");
    expect(loaded.manifest.name).toBe("Galley");
    expect(loaded.manifest.approval).toBe("ask");
    expect(loaded.persona).toContain("plan meals");
  });
  it("loads the shipped Captain template", () => {
    const captain = loadCrewFolder(
      new URL("../../../templates/crew/captain", import.meta.url).pathname,
    );
    expect(captain.manifest.captain).toBe(true);
    expect(captain.persona).toMatch(/Captain/);
  });
});
