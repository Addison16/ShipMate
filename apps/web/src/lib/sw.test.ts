import { describe, expect, it } from "vitest";
import src from "../../public/sw.js?raw";

type Strategy = (method: string, url: string, mode: string, origin: string) => string;

/** Load public/sw.js against a stub `self` and pull out its routing function. */
function load(): Strategy {
  const self: Record<string, unknown> = { addEventListener: () => {} };
  new Function("self", src)(self);
  return self.strategyFor as Strategy;
}

const O = "https://ship.example";

describe("service worker routing", () => {
  const strategyFor = load();

  it("never handles the API, health check or websocket upgrade path", () => {
    expect(strategyFor("GET", `${O}/api/me`, "cors", O)).toBe("network");
    expect(strategyFor("GET", `${O}/api/ws`, "websocket", O)).toBe("network");
    expect(strategyFor("GET", `${O}/api/auth/oidc/callback?code=x`, "navigate", O)).toBe("network");
    expect(strategyFor("GET", `${O}/healthz`, "cors", O)).toBe("network");
    expect(strategyFor("POST", `${O}/bridge`, "navigate", O)).toBe("network");
  });

  it("serves navigations network-first from the shell", () => {
    expect(strategyFor("GET", `${O}/bridge/abc`, "navigate", O)).toBe("shell");
    expect(strategyFor("GET", `${O}/`, "navigate", O)).toBe("shell");
  });

  it("caches hashed assets and leaves other origins and sw.js alone", () => {
    expect(strategyFor("GET", `${O}/assets/index-abc123.js`, "no-cors", O)).toBe("cache-first");
    expect(strategyFor("GET", `${O}/icons/icon-192.png`, "no-cors", O)).toBe("revalidate");
    expect(strategyFor("GET", `${O}/sw.js`, "no-cors", O)).toBe("network");
    expect(strategyFor("GET", "https://cdn.example/x.js", "no-cors", O)).toBe("network");
  });
});

describe("service worker notifications", () => {
  const self: Record<string, unknown> = { addEventListener: () => {} };
  new Function("self", src)(self);
  type Note = { title: string; options: Record<string, unknown> & { data: { url: string } } };
  const notificationFor = self.notificationFor as (d: unknown) => Note;

  it("adds Approve and Deny only to approvals that carry a token", () => {
    const n = notificationFor({
      kind: "approval",
      title: "Captain needs your OK",
      body: "Captain wants to run bash",
      url: "/#/bridge/abc",
      tag: "approval-1",
      approval: { id: "1", token: "123.abc" },
    });
    expect(n.title).toBe("Captain needs your OK");
    expect(n.options.actions).toEqual([
      { action: "allow", title: "Approve" },
      { action: "deny", title: "Deny" },
    ]);
    expect(n.options.requireInteraction).toBe(true);
    expect(n.options.data).toEqual({
      url: "/#/bridge/abc",
      approval: { id: "1", token: "123.abc" },
    });
    expect(notificationFor({ kind: "message", title: "Galley", body: "x" }).options.actions).toBe(
      undefined,
    );
  });

  it("falls back to a plain notice and keeps links inside the app", () => {
    expect(notificationFor(null).title).toBe("Shipmate");
    expect(notificationFor({ url: "https://evil.example/" }).options.data.url).toBe("/");
    expect(notificationFor({ url: "//evil.example/" }).options.data.url).toBe("/");
    expect(notificationFor({ url: "/\\evil.example/" }).options.data.url).toBe("/");
    expect(notificationFor({ url: "/#/watches" }).options.data.url).toBe("/#/watches");
  });
});
