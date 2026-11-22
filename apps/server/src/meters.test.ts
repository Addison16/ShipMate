import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ChatContextDto, LimitsResponse, ServerEvent } from "@shipmate/core";
import { codexRateLimits, parseRateLimits } from "@shipmate/crew";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatgptLimit, claudeLimit } from "./services/meters.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/** A stand-in for `codex app-server`: answers initialize, then account/rateLimits/read. */
const FAKE_CODEX = `#!/usr/bin/env node
if (process.argv[2] !== "app-server") process.exit(2);
let buf = "";
process.stdin.setEncoding("utf8");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let ready = false;
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === "initialize") out({ id: msg.id, result: { userAgent: "fake" } });
    else if (msg.method === "initialized") ready = true;
    else if (msg.method === "account/rateLimits/read") {
      if (!ready) out({ id: msg.id, error: { message: "Not initialized" } });
      else if (process.env.FAKE_CODEX_SIGNED_OUT) out({ id: msg.id, error: { message: "not logged in" } });
      else out({ id: msg.id, result: { rateLimits: { limitId: "codex", limitName: "Plus", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: { usedPercent: 91, windowDurationMins: 10080, resetsAt: 1900500000 } } } });
    }
  }
});
`;
const dir = mkdtempSync(join(tmpdir(), "shipmate-fake-codex-"));
const fakeCodex = join(dir, "codex");
writeFileSync(fakeCodex, FAKE_CODEX);
chmodSync(fakeCodex, 0o755);

describe("plan limits from the official CLIs", () => {
  it("reads the ChatGPT plan's limits from Codex's app server", async () => {
    const limits = await codexRateLimits({ bin: fakeCodex, env: { ...process.env } });
    expect(limits).toEqual({
      name: "Plus",
      primary: { usedPercent: 42, windowMinutes: 300, resetsAt: 1900000000 * 1000 },
      secondary: { usedPercent: 91, windowMinutes: 10080, resetsAt: 1900500000 * 1000 },
    });
    const dto = chatgptLimit({ limits, at: "2026-11-22T10:00:00.000Z" });
    expect(dto.windows.map((w) => [w.label, w.used])).toEqual([
      ["5-hour", 0.42],
      ["Weekly", 0.91],
    ]);
    expect(dto.status).toBe("warning");
  });

  it("passes on Codex's own error, and says when Codex is missing", async () => {
    await expect(
      codexRateLimits({ bin: fakeCodex, env: { ...process.env, FAKE_CODEX_SIGNED_OUT: "1" } }),
    ).rejects.toThrow(/not logged in/);
    await expect(codexRateLimits({ bin: join(dir, "nope") })).rejects.toThrow(/codex/i);
  });

  it("keeps odd answers in range", () => {
    expect(parseRateLimits({ primary: { usedPercent: 140 }, secondary: "x" })).toEqual({
      name: null,
      primary: { usedPercent: 100, windowMinutes: null, resetsAt: null },
      secondary: null,
    });
    expect(parseRateLimits(undefined)).toEqual({ name: null, primary: null, secondary: null });
  });

  it("turns Claude Code's rate limit event into a meter", () => {
    const soon = Date.now() + 3600_000;
    expect(claudeLimit(undefined)).toMatchObject({ status: "unknown", windows: [] });
    expect(
      claudeLimit({
        limit: { status: "allowed", resetsAt: soon, utilization: 0.3 },
        at: new Date().toISOString(),
      }),
    ).toMatchObject({ status: "ok", windows: [{ label: "Current", used: 0.3 }] });
    expect(
      claudeLimit({
        limit: { status: "rejected", resetsAt: soon, utilization: null },
        at: new Date().toISOString(),
      }).status,
    ).toBe("limited");
    // Figures from a window that has since reset are not shown as current.
    expect(
      claudeLimit({
        limit: { status: "rejected", resetsAt: Date.now() - 1000, utilization: 1 },
        at: new Date().toISOString(),
      }),
    ).toMatchObject({ status: "ok", windows: [] });
  });
});

describe.skipIf(!db)("context and limit meters", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  beforeAll(async () => {
    t = await testApp(db as string);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "o@example.com", displayName: "Addison", password: "correct horse" },
    });
    cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("shows how full a chat's context is after a reply, and empties it on Start fresh", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    expect((await api("GET", `/api/conversations/${conv.id}/context`)).json()).toEqual({
      context: null,
    });
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    t.faux.setResponses([fauxAssistantMessage("Hello!")]);
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: "Hi" }));
    let live: ChatContextDto | undefined;
    for (let i = 0; i < 200 && !live; i++) {
      const e = events.find((x) => x.type === "context");
      if (e?.type === "context") live = e.context;
      else await new Promise((r) => setTimeout(r, 20));
    }
    ws.terminate();
    expect(live).toMatchObject({ engine: "pi", model: "faux/m" });
    expect(live?.window).toBeGreaterThan(0);
    expect(live?.tokens).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) {
      const busy = await t.app.db
        .$client`select turn_started_at from conversations where id = ${conv.id}`;
      if (!busy[0]?.turn_started_at) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const got = (await api("GET", `/api/conversations/${conv.id}/context`)).json().context;
    expect(got).toEqual(live);

    // Someone else's chat is not readable.
    const other = await api(
      "GET",
      "/api/conversations/00000000-0000-0000-0000-000000000000/context",
    );
    expect(other.statusCode).toBe(404);

    expect((await api("POST", `/api/conversations/${conv.id}/reset`)).statusCode).toBe(200);
    expect((await api("GET", `/api/conversations/${conv.id}/context`)).json().context).toBeNull();
  });

  it("lists limits per provider and the person's own cap", async () => {
    const res = (await api("GET", "/api/limits")).json() as LimitsResponse;
    expect(res.me).toMatchObject({ capCents: null });
    // Only the test's faux model is set up: no plans, no API-key providers.
    expect(res.limits).toEqual([]);
    const check = await api("POST", "/api/limits/claude-plan/check");
    expect(check.statusCode).toBe(404);
  });
});
