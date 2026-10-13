import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { csvText } from "./services/usage.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe("csvText", () => {
  it("quotes and neutralises fields", () => {
    expect(csvText("plain")).toBe("plain");
    expect(csvText('a, "b"')).toBe('"a, ""b"""');
    expect(csvText("two\nlines")).toBe('"two\nlines"');
    expect(csvText("=SUM(A1)")).toBe("'=SUM(A1)");
  });
});

describe.skipIf(!db)("Shipmate phase 4: cost ceilings and the cost page", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let sql: postgres.Sql;
  let ownerCookie = "";
  let memberCookie = "";
  let ownerId = "";
  let memberId = "";
  let captainId = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";

  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  const until = async (check: () => Promise<boolean> | boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  /** Record spend directly: the faux model is free. */
  const spend = async (row: {
    userId: string;
    costMicroUsd: number;
    crewMemberId?: string;
    routineId?: string;
    at?: Date;
  }) => {
    await sql`
      insert into usage_events (user_id, crew_member_id, routine_id, model, input_tokens,
        output_tokens, cost_micro_usd, created_at)
      values (${row.userId}, ${row.crewMemberId ?? null}, ${row.routineId ?? null}, 'faux/m',
        10, 5, ${row.costMicroUsd}, ${row.at ?? new Date()})`;
  };

  /** Send a message over the socket and resolve with the turn's error, or null. */
  const send = async (cookie: string, text: string) => {
    const conv = (await api("POST", "/api/conversations", {}, cookie)).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text }));
    await until(() => events.some((e) => e.type === "error" || (e.type === "status" && !e.busy)));
    ws.terminate();
    const err = events.find((e) => e.type === "error");
    return err?.type === "error" ? err.message : null;
  };

  const runWatch = async (id: string) => {
    expect((await api("POST", `/api/watches/${id}/run`)).statusCode).toBe(200);
    let run = { status: "running", error: null as string | null };
    await until(async () => {
      run = (await api("GET", `/api/watches/${id}/runs`)).json().runs[0];
      return run.status !== "running";
    });
    return run;
  };

  beforeAll(async () => {
    t = await testApp(db as string, { watches: false });
    sql = postgres(db as string, { max: 2, onnotice: () => {} });
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    ownerCookie = cookieOf(setup);
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: 'Kid, "the" kid',
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
    const users = (await api("GET", "/api/users")).json().users as Array<{
      id: string;
      role: string;
    }>;
    ownerId = users.find((u) => u.role === "owner")?.id ?? "";
    memberId = users.find((u) => u.role === "member")?.id ?? "";
    const [captain] = await sql`select id from crew_members where slug = 'captain'`;
    captainId = captain?.id;
  });
  afterAll(async () => {
    await sql?.end();
    await t?.app.close();
  });

  it("blocks a person at their monthly cap", async () => {
    await api("PATCH", `/api/users/${memberId}`, { monthlyCapCents: 100 });
    t.faux.setResponses([fauxAssistantMessage("Hello.")]);
    expect(await send(memberCookie, "hi")).toBeNull();
    await spend({ userId: memberId, crewMemberId: captainId, costMicroUsd: 1_000_000 });
    expect(await send(memberCookie, "hi again")).toMatch(/monthly usage cap \(\$1\.00\)/);
    await api("PATCH", `/api/users/${memberId}`, { monthlyCapCents: null });
  });

  it("blocks a crew member at its monthlyCapUsd, which round-trips through crew.yaml", async () => {
    const detail = (await api("GET", "/api/crew/captain")).json().crew;
    const yaml = `${detail.manifestYaml.replace(/^monthlyCapUsd:.*\n?/m, "").trimEnd()}\nmonthlyCapUsd: 2\n`;
    expect((await api("PUT", "/api/crew/captain", { manifestYaml: yaml })).statusCode).toBe(200);
    expect((await api("GET", "/api/crew/captain")).json().crew.manifestYaml).toMatch(
      /^monthlyCapUsd: 2$/m,
    );
    const bad = await api("PUT", "/api/crew/captain", {
      manifestYaml: yaml.replace("monthlyCapUsd: 2", "monthlyCapUsd: -3"),
    });
    expect(bad.statusCode).toBe(400);

    let usage = (await api("GET", "/api/usage?scope=all")).json();
    expect(usage.byCrew.find((c: { slug: string }) => c.slug === "captain")).toMatchObject({
      capUsd: 2,
      costMicroUsd: 1_000_000,
    });

    // Everyone's spend counts toward the crew member's ceiling: the member spent $1 above.
    await spend({ userId: ownerId, crewMemberId: captainId, costMicroUsd: 1_000_000 });
    expect(await send(ownerCookie, "plan my week")).toMatch(
      /Captain has reached its monthly ceiling \(\$2\.00\)/,
    );
    usage = (await api("GET", "/api/usage?scope=all")).json();
    expect(usage.byCrew.find((c: { slug: string }) => c.slug === "captain").costMicroUsd).toBe(
      2_000_000,
    );

    const raised = yaml.replace("monthlyCapUsd: 2", "monthlyCapUsd: 1000");
    await api("PUT", "/api/crew/captain", { manifestYaml: raised });
    t.faux.setResponses([fauxAssistantMessage("Sure.")]);
    expect(await send(ownerCookie, "plan my week")).toBeNull();
  });

  let watchId = "";

  it("validates a watch's cap and fails its runs once the cap is reached", async () => {
    const invalid = await api("POST", "/api/watches", {
      name: "Bad",
      crewSlug: "captain",
      prompt: "Go.",
      trigger: { kind: "webhook" },
      monthlyCapCents: -5,
    });
    expect(invalid.statusCode).toBe(400);

    const created = await api("POST", "/api/watches", {
      name: 'Nightly, "big"',
      crewSlug: "captain",
      prompt: "Go.",
      trigger: { kind: "webhook" },
      monthlyCapCents: 50,
    });
    expect(created.statusCode).toBe(200);
    const watch = created.json().watch;
    watchId = watch.id;
    expect(watch.monthlyCapCents).toBe(50);
    expect(
      (await api("PATCH", `/api/watches/${watch.id}`, { monthlyCapCents: 1.5 })).statusCode,
    ).toBe(400);
    const patched = await api("PATCH", `/api/watches/${watch.id}`, { monthlyCapCents: 100 });
    expect(patched.json().watch.monthlyCapCents).toBe(100);
    // Other edits keep the cap.
    const renamed = await api("PATCH", `/api/watches/${watch.id}`, { prompt: "Go now." });
    expect(renamed.json().watch.monthlyCapCents).toBe(100);

    await spend({
      userId: ownerId,
      crewMemberId: captainId,
      routineId: watch.id,
      costMicroUsd: 1_000_000,
    });
    const blocked = await runWatch(watch.id);
    expect(blocked).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/watch "Nightly, "big"" has reached its monthly ceiling/),
    });

    const cleared = await api("PATCH", `/api/watches/${watch.id}`, { monthlyCapCents: null });
    expect(cleared.json().watch.monthlyCapCents).toBeNull();
    t.faux.setResponses([fauxAssistantMessage("Ran.")]);
    expect(await runWatch(watch.id)).toMatchObject({ status: "succeeded", output: "Ran." });
  });

  it("reports spend by watch and per day", async () => {
    await spend({
      userId: ownerId,
      costMicroUsd: 250_000,
      at: new Date(Date.UTC(2026, 8, 15, 12)),
    });
    const usage = (await api("GET", "/api/usage?scope=all")).json();
    const watch = usage.byWatch.find((w: { watchId: string }) => w.watchId === watchId);
    // The inserted $1 plus the successful run's (free) model call.
    expect(watch).toMatchObject({
      name: 'Nightly, "big"',
      capCents: null,
      calls: 2,
      costMicroUsd: 1_000_000,
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(usage.daily).toHaveLength(new Date().getUTCDate());
    expect(usage.daily[0].date).toBe(`${today.slice(0, 7)}-01`);
    const todays = usage.daily.at(-1);
    expect(todays.date).toBe(today);
    expect(todays.costMicroUsd).toBe(usage.totals.costMicroUsd);
    expect(todays.calls).toBe(usage.totals.calls);

    // Real (free, faux) model calls record how long they took; rows inserted by spend() do not.
    const timed = await sql`select duration_ms from usage_events where cost_micro_usd = 0`;
    expect(timed.length).toBeGreaterThan(0);
    expect(timed.every((r) => typeof r.duration_ms === "number" && r.duration_ms >= 0)).toBe(true);
    const faux = usage.byModel.find((m: { model: string }) => m.model === "faux/m");
    expect(faux.avgResponseMs).toEqual(expect.any(Number));
    expect(faux.p95ResponseMs).toBeGreaterThanOrEqual(0);
    expect(todays.avgResponseMs).toEqual(expect.any(Number));

    const past = (await api("GET", "/api/usage?month=2026-09&scope=all")).json();
    expect(past.totals.avgResponseMs).toBeNull();
    expect(past.daily).toHaveLength(30);
    expect(past.daily[14]).toEqual({
      date: "2026-09-15",
      costMicroUsd: 250_000,
      apiEquivalentMicroUsd: 0,
      calls: 1,
      tokens: 15,
      avgResponseMs: null,
    });
    expect(past.daily.filter((d: { calls: number }) => d.calls > 0)).toHaveLength(1);
    expect(past.byWatch).toEqual([]);

    // Members see only their own usage.
    const mine = (await api("GET", "/api/usage", undefined, memberCookie)).json();
    expect(mine.byUser.map((u: { userId: string }) => u.userId)).toEqual([memberId]);
    expect(mine.byWatch).toEqual([]);
    expect((await api("GET", "/api/usage?scope=all", undefined, memberCookie)).statusCode).toBe(
      403,
    );
  });

  it("exports usage as CSV with the same visibility rules", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await api("GET", "/api/usage/export?scope=all");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="shipmate-usage-${month}.csv"`,
    );
    const lines = res.body.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "time,person,crew,watch,watch_id,conversation_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_usd,response_ms,billing,api_equivalent_usd",
    );
    const usage = (await api("GET", "/api/usage?scope=all")).json();
    expect(lines).toHaveLength(usage.totals.calls + 1);
    expect(res.body).toContain(`"Nightly, ""big""",${watchId},`);
    expect(res.body).toContain('"Kid, ""the"" kid",captain,');
    expect(res.body).toContain(",1.000000");

    expect(
      (await api("GET", "/api/usage/export?scope=all", undefined, memberCookie)).statusCode,
    ).toBe(403);
    const mine = await api("GET", "/api/usage/export", undefined, memberCookie);
    expect(mine.headers["content-disposition"]).toBe(
      `attachment; filename="shipmate-usage-${month}-me.csv"`,
    );
    const rows = mine.body.trimEnd().split("\r\n").slice(1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.includes('"Kid, ""the"" kid"'))).toBe(true);
    expect((await api("GET", "/api/usage/export?month=2026-13")).statusCode).toBe(400);
  });

  it("keeps subscription use apart from API spend and caps, with its API-price estimate", async () => {
    // A Claude Code CLI turn on a Claude subscription: no spend, $5 at API prices.
    await sql`
      insert into usage_events (user_id, crew_member_id, model, input_tokens, output_tokens,
        cost_micro_usd, billing, api_equivalent_micro_usd)
      values (${memberId}, ${captainId}, 'claude-code/opus', 1000, 200, 0, 'subscription',
        5000000)`;
    const before = (await api("GET", "/api/usage?scope=all")).json();
    const member = before.byUser.find((u: { userId: string }) => u.userId === memberId);
    expect(member.subscriptionCalls).toBe(1);
    expect(member.apiEquivalentMicroUsd).toBe(5_000_000);
    expect(before.totals.subscriptionCalls).toBe(1);
    expect(before.totals.apiEquivalentMicroUsd).toBe(5_000_000);
    const cli = before.byModel.find((m: { model: string }) => m.model === "claude-code/opus");
    expect(cli).toMatchObject({ costMicroUsd: 0, subscriptionCalls: 1 });
    expect(before.daily.at(-1).apiEquivalentMicroUsd).toBe(5_000_000);

    // A $1 cap is not reached by $5 of subscription use: only API spend counts.
    const spent = member.costMicroUsd;
    await api("PATCH", `/api/users/${memberId}`, {
      monthlyCapCents: Math.ceil(spent / 10_000) + 100,
    });
    t.faux.setResponses([fauxAssistantMessage("Still here.")]);
    expect(await send(memberCookie, "hello")).toBeNull();
    await api("PATCH", `/api/users/${memberId}`, { monthlyCapCents: null });

    const csv = (await api("GET", "/api/usage/export?scope=all")).body;
    expect(csv).toContain(",claude-code/opus,1000,200,0,0,0.000000,,subscription,5.000000");
    expect(csv).toMatch(/,faux\/m,[^\r]*,api,\r\n/);
  });
});
