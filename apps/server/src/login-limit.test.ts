import { describe, expect, it } from "vitest";
import { LoginLimiter, waitWords } from "./login-limit.js";

function limiter(perAddress = 30) {
  let now = 1_000_000;
  const l = new LoginLimiter({ perEmail: 3, perAddress, windowMs: 60_000, now: () => now });
  return { l, tick: (ms: number) => (now += ms) };
}

describe("LoginLimiter", () => {
  it("allows tries until the limit, then makes that email wait", () => {
    const { l, tick } = limiter();
    l.failed("a@x.io", "1.1.1.1");
    l.failed("A@x.io", "1.1.1.1");
    expect(l.waitSeconds("a@x.io", "1.1.1.1")).toBe(0);
    l.failed("a@x.io", "1.1.1.1");
    expect(l.waitSeconds("a@x.io", "1.1.1.1")).toBe(60);
    // Someone else, or the same person from another address, is not held up.
    expect(l.waitSeconds("b@x.io", "1.1.1.1")).toBe(0);
    expect(l.waitSeconds("a@x.io", "2.2.2.2")).toBe(0);
    tick(60_000);
    expect(l.waitSeconds("a@x.io", "1.1.1.1")).toBe(0);
  });

  it("forgets wrong tries older than the window", () => {
    const { l, tick } = limiter();
    l.failed("a@x.io", "1.1.1.1");
    l.failed("a@x.io", "1.1.1.1");
    tick(61_000);
    l.failed("a@x.io", "1.1.1.1");
    expect(l.waitSeconds("a@x.io", "1.1.1.1")).toBe(0);
  });

  it("a right password clears the count", () => {
    const { l } = limiter();
    l.failed("a@x.io", "1.1.1.1");
    l.failed("a@x.io", "1.1.1.1");
    l.succeeded("a@x.io", "1.1.1.1");
    l.failed("a@x.io", "1.1.1.1");
    l.failed("a@x.io", "1.1.1.1");
    expect(l.waitSeconds("a@x.io", "1.1.1.1")).toBe(0);
  });

  it("makes one address wait after many wrong tries across emails", () => {
    const { l } = limiter(4);
    for (const n of [1, 2, 3, 4]) l.failed(`u${n}@x.io`, "1.1.1.1");
    expect(l.waitSeconds("new@x.io", "1.1.1.1")).toBe(60);
    expect(l.waitSeconds("new@x.io", "2.2.2.2")).toBe(0);
  });
});

describe("waitWords", () => {
  it("says the wait plainly", () => {
    expect(waitWords(1)).toBe("1 second");
    expect(waitWords(45)).toBe("45 seconds");
    expect(waitWords(60)).toBe("1 minute");
    expect(waitWords(61)).toBe("2 minutes");
  });
  it("counts tries sent together one at a time", async () => {
    const limiter = new LoginLimiter();
    const attempt = () =>
      limiter.inTurn("1.2.3.4", async () => {
        if (limiter.waitSeconds("a@example.com", "1.2.3.4") > 0) return "blocked";
        await new Promise((r) => setTimeout(r, 5));
        limiter.failed("a@example.com", "1.2.3.4");
        return "wrong";
      });
    const results = await Promise.all(Array.from({ length: 12 }, attempt));
    expect(results.filter((r) => r === "wrong")).toHaveLength(5);
    expect(results.filter((r) => r === "blocked")).toHaveLength(7);
    // A failing check does not stop the ones queued behind it.
    const mixed = await Promise.allSettled([
      limiter.inTurn("9.9.9.9", async () => {
        throw new Error("boom");
      }),
      limiter.inTurn("9.9.9.9", async () => "ok"),
    ]);
    expect(mixed.map((m) => m.status)).toEqual(["rejected", "fulfilled"]);
  });
});
