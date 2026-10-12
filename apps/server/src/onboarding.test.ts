import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("First-launch onboarding", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
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

  beforeAll(async () => {
    t = await testApp(db as string);
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("starts the guide when the owner account is created and resumes it", async () => {
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
      "",
    );
    expect(setup.statusCode).toBe(200);
    ownerCookie = cookieOf(setup);

    const me = (await api("GET", "/api/auth/me")).json();
    expect(me.onboarding).toMatchObject({ step: "purpose", done: ["account"], pending: true });

    const moved = await api("PUT", "/api/onboarding", { step: "captain", skipped: "model" });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().onboarding).toMatchObject({ step: "captain", skipped: ["model"] });

    // A new sign-in (another tab, after the session expires) lands on the same step.
    const login = await api(
      "POST",
      "/api/auth/login",
      { email: "owner@example.com", password: "correct horse" },
      "",
    );
    const again = (await api("GET", "/api/auth/me", undefined, cookieOf(login))).json();
    expect(again.onboarding).toMatchObject({ step: "captain", pending: true });

    expect((await api("PUT", "/api/onboarding", { step: "nowhere" })).statusCode).toBe(400);
    expect((await api("PUT", "/api/onboarding", { extra: true })).statusCode).toBe(400);
  });

  it("names the Captain and writes its personality into CREW.md", async () => {
    const before = (await api("GET", "/api/onboarding/captain")).json();
    expect(before).toMatchObject({ name: "Captain", voiceId: "steady" });
    expect(before.voices.map((v: { id: string }) => v.id)).toContain("salty");

    const crewMd = () => readFileSync(join(t.config.dirs.crew, "captain", "CREW.md"), "utf8");
    const stock = crewMd();
    // Picking the stock voice leaves the file alone, so template upgrades still apply.
    await api("PUT", "/api/onboarding/captain", { voice: "steady" });
    expect(crewMd()).toBe(stock);

    const res = await api("PUT", "/api/onboarding/captain", { name: "Skipper", voice: "salty" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Skipper", voiceId: "salty" });
    expect(crewMd()).toContain("# Skipper");
    expect(crewMd()).toContain("seasoned ship's captain");
    expect(crewMd()).not.toContain("Plain, warm, brief.");
    expect((await api("GET", "/api/settings")).json().captainName).toBe("Skipper");

    const custom = await api("PUT", "/api/onboarding/captain", {
      voice: "Reply in Spanish, briefly.",
    });
    expect(custom.json()).toMatchObject({ voiceId: "custom", voice: "Reply in Spanish, briefly." });
    // Everything before the Voice section survives.
    expect(crewMd()).toContain("## Recruiting crew");
  });

  it("finishes, stays finished, and can be run again", async () => {
    const done = await api("PUT", "/api/onboarding", { finish: true });
    expect(done.json().onboarding).toMatchObject({ step: "finish", pending: false });
    expect((await api("GET", "/api/auth/me")).json().onboarding.pending).toBe(false);

    const restart = await api("PUT", "/api/onboarding", { restart: true });
    expect(restart.json().onboarding).toMatchObject({ step: "purpose", pending: true });
    await api("PUT", "/api/onboarding", { finish: true });
  });

  it("is owner only and only sent to the owner", async () => {
    const created = await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    expect(created.json().user.welcomePending).toBe(true);
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    const me = (await api("GET", "/api/auth/me", undefined, memberCookie)).json();
    expect(me.onboarding).toBeUndefined();
    expect((await api("GET", "/api/onboarding", undefined, memberCookie)).statusCode).toBe(403);
    expect(
      (await api("PUT", "/api/onboarding/captain", { voice: "brisk" }, memberCookie)).statusCode,
    ).toBe(403);
  });

  it("shows people added later a welcome once, kept through theme changes", async () => {
    const themed = await api("PATCH", "/api/auth/preferences", { themeMode: "dark" }, memberCookie);
    expect(themed.json().user).toMatchObject({
      welcomePending: true,
      preferences: { themeMode: "dark", colorTheme: "harbor" },
    });
    const done = await api("PATCH", "/api/auth/preferences", { welcome: "done" }, memberCookie);
    expect(done.json().user.welcomePending).toBe(false);
    expect(
      (await api("PATCH", "/api/auth/preferences", { welcome: "pending" }, memberCookie))
        .statusCode,
    ).toBe(400);
    // The owner never gets the member welcome.
    expect((await api("GET", "/api/auth/me")).json().user.welcomePending).toBe(false);
  });
});

describe.skipIf(!db)("Onboarding on an instance set up before the guide", () => {
  it("does not show the guide to an existing owner", async () => {
    const t = await testApp(db as string);
    try {
      const setup = await t.app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { email: "old@example.com", displayName: "Old", password: "correct horse" },
      });
      const cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
      // Older versions never wrote the onboarding key.
      const sql = postgres(db as string, { max: 1, onnotice: () => {} });
      await sql`delete from settings where key = 'onboarding'`;
      await sql.end();
      const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(me.json().onboarding.pending).toBe(false);
    } finally {
      await t.app.close();
    }
  });
});
