import { describe, expect, it } from "vitest";
import { memoryName } from "./memory.js";

describe("memoryName", () => {
  it("makes a short dashed name", () => {
    expect(memoryName("Sam is vegetarian!")).toBe("sam-is-vegetarian");
    expect(memoryName("  Café opens at 7  ")).toBe("cafe-opens-at-7");
    expect(memoryName("???")).toBe("note");
  });

  it("stays within the length the server accepts and avoids taken names", () => {
    const long = memoryName("a ".repeat(100));
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    expect(memoryName("Bins on Tuesday", ["bins-on-tuesday", "bins-on-tuesday-2"])).toBe(
      "bins-on-tuesday-3",
    );
  });
});
