import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory.js";

describe("MemoryStore", () => {
  const store = () => new MemoryStore(mkdtempSync(join(tmpdir(), "mem-")));

  it("keeps per-user memory apart from shared memory", () => {
    const m = store();
    m.write("shared", undefined, { name: "house-wifi", description: "wifi name", body: "Boat" });
    m.write("user", "u1", {
      name: "diet",
      description: "vegetarian",
      body: "No meat.",
      type: "user",
    });
    expect(m.list("shared").map((e) => e.name)).toEqual(["house-wifi"]);
    expect(m.list("user", "u1")[0]?.body).toBe("No meat.");
    expect(m.list("user", "u2")).toEqual([]);
    const ctx = m.contextFor("u2");
    expect(ctx).toContain("house-wifi");
    expect(ctx).not.toContain("diet");
  });

  it("maintains a MEMORY.md index and forgets", () => {
    const m = store();
    m.write("user", "u1", { name: "a-fact", description: "first", body: "x" });
    const index = readFileSync(join(m.dir("user", "u1"), "MEMORY.md"), "utf8");
    expect(index).toContain("[[a-fact]]: first");
    expect(m.remove("user", "u1", "a-fact")).toBe(true);
    expect(m.list("user", "u1")).toEqual([]);
    expect(m.remove("user", "u1", "../../escape")).toBe(false);
  });

  it("rejects unsafe names and user ids", () => {
    const m = store();
    expect(() => m.write("user", "../x", { name: "a", description: "d", body: "b" })).toThrow();
    expect(() =>
      m.write("shared", undefined, { name: "../a", description: "d", body: "b" }),
    ).toThrow();
  });
});
