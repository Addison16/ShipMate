import { users } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";
import { base32Decode, base32Encode, matchTotp, totpCode, totpStep } from "./totp.js";

const db = TEST_DATABASE_URL;

describe("sign-in code maths", () => {
  // The published test values for these codes (RFC 6238, SHA-1 column, last six digits).
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the standard's examples", () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(totpCode(secret, totpStep(59_000))).toBe("287082");
    expect(totpCode(secret, totpStep(1111111109_000))).toBe("081804");
    expect(totpCode(secret, totpStep(2000000000_000))).toBe("279037");
  });
  it("allows a clock one step off, and no code twice", () => {
    const now = 1111111109_000;
    const step = totpStep(now);
    expect(matchTotp(secret, "081804", now)).toBe(step);
    expect(matchTotp(secret, "081 804", now + 30_000)).toBe(step);
    expect(matchTotp(secret, "081804", now - 30_000)).toBe(step);
    expect(matchTotp(secret, "081804", now + 60_000)).toBeNull();
    expect(matchTotp(secret, "081804", now, step)).toBeNull();
    expect(matchTotp(secret, "000000", now)).toBeNull();
    expect(matchTotp(secret, "81804", now)).toBeNull();
  });
});

describe.skipIf(!db)("Sign-in codes", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let kid = "";
  let kidId = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST" | "PATCH", url: string, body?: unknown, cookie = kid) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: cookie ? { cookie } : {},
    });
  const login = (extra: object = {}) =>
    api(
      "POST",
      "/api/auth/login",
      { email: "kid@example.com", password: "password1", ...extra },
      "",
    );
  /** A code the server has not seen yet: the next step's (allowed, for a fast clock). */
  let secret = "";
  const code = async (ahead = 0) => totpCode(secret, totpStep(Date.now()) + ahead);

  beforeAll(async () => {
    t = await testApp(db as string);
    owner = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    const made = await api(
      "POST",
      "/api/users",
      { email: "kid@example.com", displayName: "Kid", password: "password1", role: "member" },
      owner,
    );
    kidId = made.json().user.id;
    kid = cookieOf(await login());
  });
  afterAll(async () => {
    await t?.app.close();
  });

  let backup: string[] = [];

  it("turns on only with the password and a right code", async () => {
    expect((await api("GET", "/api/auth/me")).json().user).toMatchObject({
      twoStep: false,
      hasPassword: true,
    });
    const setup = (await api("POST", "/api/auth/two-step/setup")).json();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    secret = setup.secret;
    // Kept encrypted, not as typed.
    const [stored] = await t.app.db.select().from(users).where(eq(users.id, kidId));
    expect(stored?.totpSecret).toBeTruthy();
    expect(stored?.totpSecret).not.toContain(secret);
    expect(setup.uri).toContain(`secret=${setup.secret}`);
    expect(setup.uri).toContain("kid%40example.com");
    // Not on yet: sign-in still takes just the password.
    expect((await login()).json().user).toBeTruthy();

    const enable = (body: object) => api("POST", "/api/auth/two-step/enable", body);
    expect((await enable({ code: "000000", password: "password1" })).statusCode).toBe(400);
    expect((await enable({ code: await code(), password: "wrong" })).statusCode).toBe(400);
    const other = cookieOf(await login());
    const res = await enable({ code: await code(), password: "password1" });
    expect(res.statusCode).toBe(200);
    backup = res.json().backupCodes;
    expect(backup).toHaveLength(8);
    expect(new Set(backup).size).toBe(8);
    expect((await api("GET", "/api/auth/me")).json().user.twoStep).toBe(true);
    // Devices signed in before codes were on are signed out; this one stays.
    expect((await api("GET", "/api/auth/me", undefined, other)).json().user).toBeNull();
  });

  it("asks for the code at sign-in and takes each code once", async () => {
    const first = await login();
    expect(first.json()).toEqual({ needsCode: true });
    expect(first.headers["set-cookie"]).toBeUndefined();
    expect((await login({ code: "123456" })).statusCode).toBe(401);
    const next = await code(1);
    const ok = await login({ code: next });
    expect(ok.json().user).toMatchObject({ email: "kid@example.com", twoStep: true });
    expect(cookieOf(ok)).toContain("shipmate_session=");
    // The same code again is refused.
    expect((await login({ code: next })).statusCode).toBe(401);
  });

  it("takes a backup code once, however it is typed", async () => {
    const typed = ` ${(backup[0] ?? "").toUpperCase().replace("-", " ")} `;
    expect((await login({ code: typed })).json().user).toBeTruthy();
    expect((await login({ code: backup[0] })).statusCode).toBe(401);
  });

  it("takes a code once even when it is sent twice at the same moment", async () => {
    const twoStep = t.app.services.twoStep;
    const row = async () => {
      const [u] = await t.app.db.select().from(users).where(eq(users.id, kidId));
      if (!u) throw new Error("no user");
      return u;
    };
    // Both checks start from the same saved state, as two sign-ins at once would.
    await t.app.db.update(users).set({ totpLastStep: null }).where(eq(users.id, kidId));
    let seen = await row();
    const next = await code();
    const app = await Promise.all([twoStep.check(seen, next), twoStep.check(seen, next)]);
    expect(app.filter(Boolean)).toHaveLength(1);

    seen = await row();
    const same = await Promise.all([
      twoStep.check(seen, backup[5] ?? ""),
      twoStep.check(seen, backup[5] ?? ""),
    ]);
    expect(same.filter(Boolean)).toHaveLength(1);

    // Two different backup codes at once: both are spent, neither comes back.
    seen = await row();
    const two = await Promise.all([
      twoStep.check(seen, backup[6] ?? ""),
      twoStep.check(seen, backup[7] ?? ""),
    ]);
    expect(two).toEqual([true, true]);
    expect((await row()).totpBackupCodes).toHaveLength(4);
  });

  it("turns off with a code, or by the owner for someone else", async () => {
    expect((await api("POST", "/api/auth/two-step/disable", { code: "nope" })).statusCode).toBe(
      400,
    );
    // Only the owner can turn it off for someone, and not for themselves this way.
    expect((await api("PATCH", `/api/users/${kidId}`, { twoStep: false })).statusCode).toBe(400);
    expect((await api("POST", "/api/auth/two-step/disable", { code: backup[1] })).statusCode).toBe(
      200,
    );
    expect((await login()).json().user).toMatchObject({ twoStep: false });

    secret = (await api("POST", "/api/auth/two-step/setup")).json().secret;
    await api("POST", "/api/auth/two-step/enable", { code: await code(), password: "password1" });
    expect((await login()).json()).toEqual({ needsCode: true });
    const reset = await api("PATCH", `/api/users/${kidId}`, { twoStep: false }, owner);
    expect(reset.json().user).toMatchObject({ twoStep: false });
    expect((await login()).json().user).toBeTruthy();
  });
});

describe.skipIf(!db)("Sign-in codes with the rescue switch", () => {
  it("asks nobody for a code and lets them turn codes off", async () => {
    const t = await testApp(db as string, { env: { SHIPMATE_SIGN_IN_CODES: "off" } });
    try {
      const owner = { email: "owner@example.com", password: "correct horse" };
      const first = await t.app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { ...owner, displayName: "Addison" },
      });
      const cookie = String(first.headers["set-cookie"]).split(";")[0] ?? "";
      const post = (url: string, payload: object = {}) =>
        t.app.inject({ method: "POST", url, payload, headers: { cookie } });
      const { secret } = (await post("/api/auth/two-step/setup")).json();
      const on = await post("/api/auth/two-step/enable", {
        code: totpCode(secret, totpStep(Date.now())),
        password: owner.password,
      });
      expect(on.statusCode).toBe(200);
      const login = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: owner });
      expect(login.json().user).toMatchObject({ twoStep: true });
      expect((await post("/api/auth/two-step/disable", { code: "lost it" })).statusCode).toBe(200);
      const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(me.json().user.twoStep).toBe(false);
    } finally {
      await t.app.close();
    }
  });
});
