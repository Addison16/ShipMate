import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("sign-in safety", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    cookie: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie, ...headers },
    });
  const login = (password: string, agent = "test", address = "10.0.0.1") =>
    t.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "owner@example.com", password },
      headers: { "user-agent": agent },
      remoteAddress: address,
    });

  let ownerId = "";
  beforeAll(async () => {
    t = await testApp(db as string);
    const setup = await t.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
    });
    ownerId = setup.json().user.id;
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("lists devices, this one first, and signs one out", async () => {
    const phone = cookieOf(await login("correct horse", "PhoneAgent"));
    const laptop = cookieOf(await login("correct horse", "LaptopAgent"));
    const { sessions } = (await call("GET", "/api/auth/sessions", laptop)).json();
    expect(sessions[0]).toMatchObject({ current: true, userAgent: "LaptopAgent" });
    const other = sessions.find((s: { userAgent: string }) => s.userAgent === "PhoneAgent");
    expect(other.current).toBe(false);

    expect((await call("DELETE", `/api/auth/sessions/${other.id}`, laptop)).statusCode).toBe(200);
    expect((await call("GET", "/api/auth/sessions", phone)).statusCode).toBe(401);
    expect((await call("DELETE", `/api/auth/sessions/${other.id}`, laptop)).statusCode).toBe(404);
    expect((await call("GET", "/api/auth/sessions", laptop)).statusCode).toBe(200);
  });

  it("signs out every other device, and so does a password change", async () => {
    const a = cookieOf(await login("correct horse"));
    const b = cookieOf(await login("correct horse"));
    const ended = (await call("POST", "/api/auth/sessions/end-others", a)).json().ended;
    expect(ended).toBeGreaterThanOrEqual(1);
    expect((await call("GET", "/api/auth/me", b)).json().user).toBeNull();
    expect((await call("GET", "/api/auth/me", a)).json().user).not.toBeNull();

    const c = cookieOf(await login("correct horse"));
    const changed = await call("PATCH", `/api/users/${ownerId}`, a, { password: "new horse 123" });
    expect(changed.statusCode).toBe(200);
    expect((await call("GET", "/api/auth/me", c)).json().user).toBeNull();
    expect((await call("GET", "/api/auth/me", a)).json().user).not.toBeNull();
  });

  it("pauses sign-in after five wrong passwords, even for the right one", async () => {
    const from = "10.9.9.9";
    for (let i = 0; i < 4; i++) expect((await login("nope", "x", from)).statusCode).toBe(401);
    expect((await login("nope", "x", from)).statusCode).toBe(401);
    const blocked = await login("new horse 123", "x", from);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatch(/Too many wrong tries\. Wait 15 minutes/);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Another address is not held up.
    expect((await login("new horse 123", "x", "10.8.8.8")).statusCode).toBe(200);
  });
});
