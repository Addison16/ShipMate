import { describe, expect, it } from "vitest";
import { documentProblem, roughLength } from "./documents.js";

describe("documents", () => {
  it("catches files the library cannot take before uploading", () => {
    expect(documentProblem({ name: "a.pdf", type: "application/pdf", size: 5000 })).toBeNull();
    expect(documentProblem({ name: "notes.md", type: "", size: 10 })).toBeNull();
    expect(documentProblem({ name: "p.jpg", type: "image/jpeg", size: 10 })).toContain("picture");
    expect(documentProblem({ name: "a.txt", type: "text/plain", size: 0 })).toContain("empty");
    expect(documentProblem({ name: "a.txt", type: "text/plain", size: 2 * 1024 * 1024 })).toContain(
      "over 1 MB",
    );
    expect(
      documentProblem({ name: "a.pdf", type: "application/pdf", size: 21 * 1024 * 1024 }),
    ).toContain("over 20 MB");
  });

  it("gives a rough length in pages", () => {
    expect(roughLength(200)).toBe("under a page");
    expect(roughLength(3100)).toBe("about 1 page");
    expect(roughLength(36000)).toBe("about 12 pages");
  });
});
