import { describe, expect, it } from "vitest";
import { coreServers, loadCatalog } from "./index.js";

describe("catalog", () => {
  it("parses and has unique ids", () => {
    const all = loadCatalog();
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(coreServers().length).toBeGreaterThanOrEqual(8);
  });
});
