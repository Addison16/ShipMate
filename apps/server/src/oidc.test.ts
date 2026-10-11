import { auditEvents, settings, users } from "@shipmate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockIdentity, MockIdp } from "./oidc-mock.js";
import { safeNext } from "./services/oidc.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe("safeNext", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("#/crew")).toBe("/#/crew");
    expect(safeNext("/#/crew/galley")).toBe("/#/crew/galley");
    for (const bad of [
      "//evil.example",
      "https://evil.example",
      "/\\evil.example",
      "evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
    ]) {
      expect(safeNext(bad)).toBeNull();
    }
  });
});

describe.skipIf(!db)("Shipmate phase 4: sign-in with OIDC", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const idp = new MockIdp();
  let ownerCookie = "";
  let memberCookie = "";

  const cookies = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    return Object.fromEntries(
      list.map((c: string) => {
        const [pair = ""] = c.split(";");
        const i = pair.indexOf("=");
        return [pair.slice(0, i), pair.slice(i + 1)];
      }),
    ) as Record<string, string>;
  };
  const sessionOf = (res: { headers: Record<string, unknown> }) => {
    const v = cookies(res).shipmate_session;
    return v ? `shipmate_session=${v}` : "";
  };

  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie = ownerCookie) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  /** start → provider → callback, as a browser would. Returns the callback response. */
  const signIn = async (identity: MockIdentity, next?: string) => {
    const start = await t.app.inject({
      method: "GET",
      url: `/api/auth/oidc/start${next ? `?next=${encodeURIComponent(next)}` : ""}`,
    });
    expect(start.statusCode).toBe(302);
    const location = String(start.headers.location);
    expect(location.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
    const state = cookies(start).shipmate_oidc;
    expect(state).toBeTruthy();
    const query = idp.authorize(location, identity);
    return t.app.inject({
      method: "GET",
      url: `/api/auth/oidc/callback?${query}`,
      headers: { cookie: `shipmate_oidc=${state}` },
    });
  };
  const errorOf = (res: { headers: Record<string, unknown> }) =>
    new URL(String(res.headers.location).replace("/#/", "/")).searchParams.get("error");

  beforeAll(async () => {
    await idp.start();
    t = await testApp(db as string);
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    ownerCookie = sessionOf(setup);
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = sessionOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
  });
  afterAll(async () => {
    await t?.app.close();
    await idp.stop();
  });

  it("keeps the settings owner-only and never returns the client secret", async () => {
    expect((await api("GET", "/api/settings/oidc", undefined, "")).statusCode).toBe(401);
    expect((await api("GET", "/api/settings/oidc", undefined, memberCookie)).statusCode).toBe(403);
    expect(
      (await api("PUT", "/api/settings/oidc", { enabled: false }, memberCookie)).statusCode,
    ).toBe(403);

    const initial = (await api("GET", "/api/settings/oidc")).json().oidc;
    expect(initial).toMatchObject({
      enabled: false,
      hasClientSecret: false,
      redirectUri: "http://localhost:3000/api/auth/oidc/callback",
    });
    expect((await api("GET", "/api/auth/oidc", undefined, "")).json()).toMatchObject({
      enabled: false,
    });
    // Sign-in is refused while it is off.
    const off = await t.app.inject({ method: "GET", url: "/api/auth/oidc/start" });
    expect(errorOf(off)).toBe("disabled");

    // Discovery is checked before sign-in can be turned on.
    const bad = await api("PUT", "/api/settings/oidc", {
      enabled: true,
      issuer: "http://127.0.0.1:1",
      clientId: "x",
    });
    expect(bad.statusCode).toBe(400);

    const put = await api("PUT", "/api/settings/oidc", {
      enabled: true,
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      label: "Authentik",
      allowSignup: false,
      allowedDomains: [" Example.ORG ", "@example.org"],
    });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain(idp.clientSecret);
    expect(put.json().oidc).toMatchObject({
      enabled: true,
      hasClientSecret: true,
      label: "Authentik",
      allowedDomains: ["example.org"],
    });
    const get = await api("GET", "/api/settings/oidc");
    expect(get.body).not.toContain(idp.clientSecret);
    const [row] = await t.app.db.select().from(settings).where(eq(settings.key, "oidc"));
    expect(JSON.stringify(row?.value)).not.toContain(idp.clientSecret);

    // "" clears the secret; leaving it out keeps it.
    const cleared = await api("PUT", "/api/settings/oidc", { clientSecret: "" });
    expect(cleared.json().oidc.hasClientSecret).toBe(false);
    await api("PUT", "/api/settings/oidc", { clientSecret: idp.clientSecret });
    const kept = await api("PUT", "/api/settings/oidc", { label: "Authentik" });
    expect(kept.json().oidc.hasClientSecret).toBe(true);

    expect((await api("GET", "/api/auth/oidc", undefined, "")).json()).toEqual({
      enabled: true,
      label: "Authentik",
    });
  });

  it("links an existing account by verified email, then signs in by subject", async () => {
    const res = await signIn(
      { sub: "owner-sub", email: "Owner@Example.com", email_verified: true, name: "Addison" },
      "#/crew",
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("http://localhost:3000/#/crew");
    const cookie = sessionOf(res);
    const me = (await api("GET", "/api/auth/me", undefined, cookie)).json();
    expect(me.user).toMatchObject({ email: "owner@example.com", role: "owner" });
    const [owner] = await t.app.db.select().from(users).where(eq(users.email, "owner@example.com"));
    expect(owner?.oidcSubject).toBe("owner-sub");

    // Later sign-ins match the subject even if the provider's email changed.
    const again = await signIn({ sub: "owner-sub", email: "renamed@elsewhere.test" });
    expect(again.headers.location).toBe("http://localhost:3000/");
    const me2 = (await api("GET", "/api/auth/me", undefined, sessionOf(again))).json();
    expect(me2.user.email).toBe("owner@example.com");

    // A different subject cannot take over an account that is already linked.
    const other = await signIn({
      sub: "intruder",
      email: "owner@example.com",
      email_verified: true,
    });
    expect(errorOf(other)).toBe("linked_elsewhere");
    expect(sessionOf(other)).toBe("");

    const actions = (await t.app.db.select().from(auditEvents)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.oidc_link", "auth.oidc_signin"]));
  });

  it("does not link an unverified email", async () => {
    const res = await signIn({ sub: "kid-sub", email: "kid@example.com", email_verified: false });
    expect(errorOf(res)).toBe("email_unverified");
    expect(sessionOf(res)).toBe("");
  });

  it("creates members only when sign-up is allowed and the domain is listed", async () => {
    const closed = await signIn({ sub: "new-1", email: "new@example.org", email_verified: true });
    expect(errorOf(closed)).toBe("no_account");

    await api("PUT", "/api/settings/oidc", { allowSignup: true });
    const blocked = await signIn({ sub: "new-2", email: "new@other.test", email_verified: true });
    expect(errorOf(blocked)).toBe("domain");

    const ok = await signIn({
      sub: "new-1",
      email: "new@example.org",
      email_verified: true,
      name: "New Sailor",
    });
    expect(ok.headers.location).toBe("http://localhost:3000/");
    const me = (await api("GET", "/api/auth/me", undefined, sessionOf(ok))).json();
    expect(me.user).toMatchObject({
      email: "new@example.org",
      displayName: "New Sailor",
      role: "member",
    });

    // An empty domain list allows any domain.
    await api("PUT", "/api/settings/oidc", { allowedDomains: [] });
    const any = await signIn({ sub: "new-3", email: "x@other.test", email_verified: true });
    expect((await api("GET", "/api/auth/me", undefined, sessionOf(any))).json().user.email).toBe(
      "x@other.test",
    );
    await api("PUT", "/api/settings/oidc", { allowSignup: false });
  });

  it("rejects a callback whose state does not match this browser", async () => {
    const start = await t.app.inject({ method: "GET", url: "/api/auth/oidc/start" });
    const state = cookies(start).shipmate_oidc;
    const query = idp.authorize(String(start.headers.location), {
      sub: "owner-sub",
      email: "owner@example.com",
      email_verified: true,
    });
    const url = `/api/auth/oidc/callback?${query}`;

    const noCookie = await t.app.inject({ method: "GET", url });
    expect(errorOf(noCookie)).toBe("state");
    const wrong = await t.app.inject({
      method: "GET",
      url,
      headers: { cookie: "shipmate_oidc=not-the-state" },
    });
    expect(errorOf(wrong)).toBe("state");
    const forged = await t.app.inject({
      method: "GET",
      url: "/api/auth/oidc/callback?code=x&state=made-up",
      headers: { cookie: "shipmate_oidc=made-up" },
    });
    expect(errorOf(forged)).toBe("state");

    const good = await t.app.inject({
      method: "GET",
      url,
      headers: { cookie: `shipmate_oidc=${state}` },
    });
    expect(sessionOf(good)).not.toBe("");
    // A state works once.
    const replay = await t.app.inject({
      method: "GET",
      url,
      headers: { cookie: `shipmate_oidc=${state}` },
    });
    expect(errorOf(replay)).toBe("state");
  });

  it("refuses a next that leaves the instance", async () => {
    for (const next of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const res = await t.app.inject({
        method: "GET",
        url: `/api/auth/oidc/start?next=${encodeURIComponent(next)}`,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
