import { secrets } from "@shipmate/db";
import { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHATGPT_REDIRECT_URI, normalizeCallback, planModelIds } from "./services/chatgpt.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const RESPONSES_URL = "https://api.openai.com/v1/responses";
const responsesRequests: Array<{ authorization: string | null; body: Record<string, unknown> }> =
  [];

/** An unsigned JWT-shaped access token with the claims OpenAI puts in them. */
function accessToken(n: number) {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return [
    b64({ alg: "none" }),
    b64({
      n,
      "https://api.openai.com/profile": { email: "addison@example.com" },
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    }),
    "sig",
  ].join(".");
}

describe("normalizeCallback", () => {
  it("accepts the address, a localhost variant or just the query", () => {
    const want = `${CHATGPT_REDIRECT_URI}?code=c&state=s&client_id=i`;
    expect(normalizeCallback(` ${want} `).toString()).toBe(want);
    expect(
      normalizeCallback(
        "http://localhost:1455/auth/callback?code=c&state=s&client_id=i",
      ).toString(),
    ).toBe(want);
    expect(normalizeCallback("?code=c&state=s&client_id=i").toString()).toBe(want);
    expect(() => normalizeCallback("https://example.com/elsewhere?code=c")).toThrow();
  });
});

describe.skipIf(!db)("Shipmate phase 5: Sign in with ChatGPT", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  const realFetch = globalThis.fetch;
  /** Every request pi made to OpenAI's token endpoint. */
  const tokenRequests: URLSearchParams[] = [];
  let accessCounter = 0;
  /** expires_in for the next token response; pi subtracts 3 minutes, so 60 is already expired. */
  let nextExpiresIn = 3600;

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "DELETE",
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
  const modelRefs = async () =>
    ((await api("GET", "/api/models")).json().models as Array<{ ref: string; available: boolean }>)
      .filter((m) => m.ref.startsWith("chatgpt/"))
      .map((m) => ({ ref: m.ref, available: m.available }));
  const service = () => t.app.services.providers.chatgpt;

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === RESPONSES_URL) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : {}),
        );
        responsesRequests.push({
          authorization: headers.get("authorization"),
          body: JSON.parse(String(init?.body ?? "{}")),
        });
        return new Response(JSON.stringify({ error: { message: "stubbed" } }), { status: 400 });
      }
      if (url !== TOKEN_URL) return realFetch(input, init);
      const body = new URLSearchParams(String(init?.body));
      tokenRequests.push(body);
      // Slow enough that concurrent callers overlap.
      await new Promise((r) => setTimeout(r, 30));
      if (body.get("grant_type") === "refresh_token" && body.get("refresh_token") === "revoked") {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      accessCounter++;
      return Response.json({
        access_token: accessToken(accessCounter),
        refresh_token: `refresh-${accessCounter}`,
        id_token: "id",
        expires_in: nextExpiresIn,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        token_type: "Bearer",
      });
    });
    t = await testApp(db as string);
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    ownerCookie = cookieOf(setup);
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
  });
  afterAll(async () => {
    await t?.app.services.providers.chatgpt.cancel();
    await t?.app.close();
    vi.unstubAllGlobals();
  });

  it("is owner-only", async () => {
    for (const [method, url] of [
      ["GET", "/api/providers/chatgpt"],
      ["POST", "/api/providers/chatgpt/start"],
      ["DELETE", "/api/providers/chatgpt/start"],
      ["POST", "/api/providers/chatgpt/complete"],
      ["DELETE", "/api/providers/chatgpt"],
    ] as const) {
      const body = method === "POST" ? { callbackUrl: "x" } : undefined;
      expect((await api(method, url, body, memberCookie)).statusCode, url).toBe(403);
    }
    // The generic create path does not take this kind.
    expect((await api("POST", "/api/providers", { kind: "openai-chatgpt" })).statusCode).toBe(400);
  });

  it("starts, takes the pasted callback, stores encrypted tokens and never returns them", async () => {
    const before = (await api("GET", "/api/providers/chatgpt")).json().chatgpt;
    expect(before).toMatchObject({ signedIn: false, pending: null, models: [] });
    expect(await modelRefs()).toEqual([]);

    const started = await api("POST", "/api/providers/chatgpt/start");
    expect(started.statusCode).toBe(200);
    const pending = started.json().chatgpt.pending;
    expect(pending.redirectUri).toBe(CHATGPT_REDIRECT_URI);
    const authorize = new URL(pending.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://auth.openai.com/api/accounts/authorize",
    );
    expect(authorize.searchParams.get("redirect_uri")).toBe(CHATGPT_REDIRECT_URI);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("agent_name_hint")).toBe("Shipmate");
    expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
    const state = authorize.searchParams.get("state");

    // A paste from another attempt or without a code is refused, and the sign-in stays open.
    const wrong = await api("POST", "/api/providers/chatgpt/complete", {
      callbackUrl: `${CHATGPT_REDIRECT_URI}?code=abc&state=nope&client_id=client-1`,
    });
    expect(wrong.statusCode).toBe(400);
    const noCode = await api("POST", "/api/providers/chatgpt/complete", {
      callbackUrl: `${CHATGPT_REDIRECT_URI}?state=${state}`,
    });
    expect(noCode.statusCode).toBe(400);
    expect(tokenRequests).toHaveLength(0);

    // The browser landed on the unreachable localhost page; the owner pastes its address.
    const done = await api("POST", "/api/providers/chatgpt/complete", {
      callbackUrl: `http://localhost:1455/auth/callback?code=abc&state=${state}&client_id=client-1`,
    });
    expect(done.statusCode).toBe(200);
    const status = done.json().chatgpt;
    expect(status).toMatchObject({
      signedIn: true,
      email: "addison@example.com",
      plan: "plus",
      pending: null,
      providerId: "chatgpt",
    });
    expect(status.models.length).toBeGreaterThan(0);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("grant_type")).toBe("authorization_code");
    expect(tokenRequests[0]?.get("code")).toBe("abc");
    expect(tokenRequests[0]?.get("client_id")).toBe("client-1");
    expect(tokenRequests[0]?.get("code_verifier")).toBeTruthy();

    // Encrypted at rest, and no response carries a token.
    const [row] = await t.app.db.select().from(secrets).where(eq(secrets.ref, "chatgpt:oauth"));
    expect(row).toBeDefined();
    expect(row?.ciphertext).not.toContain("refresh-1");
    expect(Buffer.from(row?.ciphertext ?? "", "base64").toString("utf8")).not.toContain(
      "refresh-1",
    );
    for (const res of [done, await api("GET", "/api/providers/chatgpt")]) {
      expect(res.body).not.toContain("refresh-1");
      expect(res.body).not.toContain(accessToken(1));
    }
    expect((await api("GET", "/api/providers")).body).not.toContain("refresh-1");
  });

  it("lists the plan's models for crew while signed in", async () => {
    const refs = await modelRefs();
    expect(refs.length).toBeGreaterThan(0);
    // Only what a ChatGPT plan can run, newest first: no API-only models like gpt-4.
    expect(refs.map((m) => m.ref)).toEqual(planModelIds().map((id) => `chatgpt/${id}`));
    expect(refs.some((m) => m.ref === "chatgpt/gpt-4")).toBe(false);
    expect(refs.every((m) => m.available)).toBe(true);
    const available = await t.app.services.providers.available();
    const model = available.find((m) => m.provider === "chatgpt");
    expect(model?.cost.input).toBe(0);
    // A fresh token needs no refresh.
    const auth = await t.app.services.providers.runtime.getAuth(model as NonNullable<typeof model>);
    expect(auth?.auth.apiKey).toBe(accessToken(1));
    expect(tokenRequests).toHaveLength(1);
  });

  it("refreshes an expired token on demand, once for concurrent calls, and keeps the rotation", async () => {
    // Sign in again with a token that is already inside pi's expiry margin.
    nextExpiresIn = 60;
    const started = (await api("POST", "/api/providers/chatgpt/start")).json().chatgpt;
    const state = new URL(started.pending.authorizeUrl).searchParams.get("state");
    const done = await api("POST", "/api/providers/chatgpt/complete", {
      callbackUrl: `${CHATGPT_REDIRECT_URI}?code=again&state=${state}&client_id=client-2`,
    });
    expect(done.statusCode).toBe(200);
    expect(new Date(done.json().chatgpt.accessExpiresAt).getTime()).toBeLessThan(Date.now());
    const signInAccess = accessToken(accessCounter);
    nextExpiresIn = 3600;
    tokenRequests.length = 0;

    // Listing models never refreshes.
    await modelRefs();
    expect(tokenRequests).toHaveLength(0);

    const model = (await t.app.services.providers.available()).find(
      (m) => m.provider === "chatgpt",
    );
    if (!model) throw new Error("no chatgpt model");
    const results = await Promise.all([
      t.app.services.providers.runtime.getAuth(model),
      t.app.services.providers.runtime.getAuth(model),
      service().accessToken(),
      service().accessToken(),
    ]);
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(tokenRequests[0]?.get("refresh_token")).toBe("refresh-2");
    expect(tokenRequests[0]?.get("client_id")).toBe("client-2");
    const fresh = accessToken(accessCounter);
    expect(fresh).not.toBe(signInAccess);
    expect(results.map((r) => (typeof r === "string" ? r : r?.auth.apiKey))).toEqual([
      fresh,
      fresh,
      fresh,
      fresh,
    ]);

    // The rotated refresh token is what is stored now.
    const [row] = await t.app.db.select().from(secrets).where(eq(secrets.ref, "chatgpt:oauth"));
    const stored = JSON.parse(
      new SecretVault(t.config.SHIPMATE_SECRET).decrypt(row?.ciphertext ?? ""),
    );
    expect(stored.refresh).toBe(`refresh-${accessCounter}`);
    expect(stored.email).toBe("addison@example.com");

    // Still valid: no further refresh.
    await service().accessToken();
    expect(tokenRequests).toHaveLength(1);

    // A model call sends that token to the Responses API, without the fields ChatGPT tokens reject.
    await t.app.services.providers.runtime.completeSimple(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { maxTokens: 100, temperature: 0.2 },
    );
    expect(responsesRequests.at(-1)?.authorization).toBe(`Bearer ${fresh}`);
    expect(responsesRequests.at(-1)?.body).toMatchObject({ model: model.id });
    expect(responsesRequests.at(-1)?.body).not.toHaveProperty("max_output_tokens");
    expect(responsesRequests.at(-1)?.body).not.toHaveProperty("temperature");
    expect(tokenRequests).toHaveLength(1);
  });

  it("signs out: deletes the tokens and the models", async () => {
    const res = await api("DELETE", "/api/providers/chatgpt");
    expect(res.statusCode).toBe(200);
    expect(res.json().chatgpt).toMatchObject({ signedIn: false, email: null, models: [] });
    const rows = await t.app.db.select().from(secrets).where(eq(secrets.ref, "chatgpt:oauth"));
    expect(rows).toHaveLength(0);
    expect(await modelRefs()).toEqual([]);
    expect((await t.app.services.providers.available()).some((m) => m.provider === "chatgpt")).toBe(
      false,
    );
    await expect(service().accessToken()).rejects.toThrow(/not signed in/);
  });

  it("cancels a pending sign-in", async () => {
    const started = (await api("POST", "/api/providers/chatgpt/start")).json().chatgpt;
    expect(started.pending).not.toBeNull();
    const cancelled = (await api("DELETE", "/api/providers/chatgpt/start")).json().chatgpt;
    expect(cancelled.pending).toBeNull();
    const late = await api("POST", "/api/providers/chatgpt/complete", { callbackUrl: "?code=x" });
    expect(late.statusCode).toBe(409);
    // The localhost callback port is free again, so a new sign-in can start.
    const again = await api("POST", "/api/providers/chatgpt/start");
    expect(again.statusCode).toBe(200);
  });
});
