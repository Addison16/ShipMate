import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretVault } from "@shipmate/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  credentialFileName,
  GOOGLE_SCOPES,
  GoogleOAuthService,
  googleAcceptsRedirect,
} from "./services/google-oauth.js";
import type { SettingsService } from "./services/settings.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

/** Stands in for Google's token, userinfo and revoke endpoints. */
function fakeGoogle() {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(String(init?.body));
      const code = body.get("code") ?? "";
      if (code === "partial-code") {
        return json({ access_token: "at", refresh_token: "rt-p", scope: "openid" });
      }
      if (!code.startsWith("good-code")) return json({ error: "invalid_grant" }, 400);
      return json({
        access_token: code === "good-code-2" ? "at-2" : "at",
        refresh_token: code === "good-code-2" ? "rt-2" : "rt-1",
        scope: GOOGLE_SCOPES.join(" "),
      });
    }
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      const auth = new Headers(init?.headers).get("authorization");
      return json({ email: auth === "Bearer at-2" ? "other@example.com" : "Addison@Example.com" });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    return json({}, 404);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Google redirect URIs", () => {
  it("accepts only what Google Cloud accepts", () => {
    expect(googleAcceptsRedirect("https://shipmate.example.com")).toBe(true);
    expect(googleAcceptsRedirect("http://localhost:3000")).toBe(true);
    expect(googleAcceptsRedirect("http://127.0.0.1:3000")).toBe(true);
    expect(googleAcceptsRedirect("http://192.168.1.20:3000")).toBe(false);
    expect(googleAcceptsRedirect("https://192.168.1.20")).toBe(false);
    expect(googleAcceptsRedirect("http://shipmate.example.com")).toBe(false);
    expect(googleAcceptsRedirect("https://tower")).toBe(false);
    expect(googleAcceptsRedirect("https://shipmate.local")).toBe(false);
    expect(googleAcceptsRedirect("https://shipmate.home.arpa")).toBe(false);
    expect(googleAcceptsRedirect("https://ship.tail1234.ts.net")).toBe(true);
  });

  it("falls back to localhost when SHIPMATE_URL cannot be used", () => {
    const make = (baseUrl: string) =>
      new GoogleOAuthService({
        settings: {} as SettingsService,
        vault: new SecretVault("x".repeat(32)),
        baseUrl,
        port: 3000,
        credentialsDir: tmpdir(),
      }).redirect;
    expect(make("https://ship.example.com/")).toEqual({
      uri: "https://ship.example.com/api/mcp/google/callback",
      pasteBack: false,
    });
    expect(make("http://192.168.1.20:8080")).toEqual({
      uri: "http://localhost:3000/api/mcp/google/callback",
      pasteBack: true,
    });
    expect(make("http://localhost:3000")).toEqual({
      uri: "http://localhost:3000/api/mcp/google/callback",
      pasteBack: true,
    });
  });

  it("names the credentials file the way workspace-mcp does", () => {
    expect(credentialFileName("me@example.com")).toBe("me@example.com");
    expect(credentialFileName("a+b@x.io")).toBe("a%2Bb@x.io");
  });
});

describe("Google sign-in service", () => {
  it("writes the credentials file workspace-mcp reads", async () => {
    const store = new Map<string, unknown>();
    const settings = {
      getJson: async (k: string) => store.get(k) ?? null,
      setJson: async (k: string, v: unknown) => void store.set(k, v),
    } as unknown as SettingsService;
    const dir = mkdtempSync(join(tmpdir(), "shipmate-google-"));
    const { fetchImpl } = fakeGoogle();
    const google = new GoogleOAuthService({
      settings,
      vault: new SecretVault("x".repeat(32)),
      baseUrl: "https://ship.example.com",
      port: 3000,
      credentialsDir: dir,
      fetch: fetchImpl,
    });
    const client = { clientId: "cid", clientSecret: "csecret" };
    const url = new URL(google.start(client, "u1"));
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ship.example.com/api/mcp/google/callback",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state") ?? "";
    await google.finish(`state=${state}&code=good-code`, client);

    const env = await google.serverEnv(client);
    expect(env).toEqual({
      WORKSPACE_MCP_CREDENTIALS_DIR: dir,
      USER_GOOGLE_EMAIL: "addison@example.com",
      MCP_SINGLE_USER_MODE: "1",
    });
    const file = JSON.parse(readFileSync(join(dir, "addison@example.com.json"), "utf8"));
    expect(file).toMatchObject({
      refresh_token: "rt-1",
      client_id: "cid",
      client_secret: "csecret",
      token_uri: "https://oauth2.googleapis.com/token",
    });
    // Signing in as another account removes the first one's file.
    const again = new URL(google.start(client, "u1")).searchParams.get("state");
    await google.finish(`state=${again}&code=good-code-2`, client);
    await google.serverEnv(client);
    expect(() => readFileSync(join(dir, "addison@example.com.json"))).toThrow();
    expect(
      JSON.parse(readFileSync(join(dir, "other@example.com.json"), "utf8")).refresh_token,
    ).toBe("rt-2");

    // Unticked services on Google's consent screen are refused.
    const partial = new URL(google.start(client, "u1")).searchParams.get("state");
    await expect(google.finish(`state=${partial}&code=partial-code`, client)).rejects.toMatchObject(
      {
        code: "partial",
      },
    );
    expect((await google.status(client)).email).toBe("other@example.com");

    // A different client means signing in again.
    expect(await google.serverEnv({ clientId: "other", clientSecret: "s" })).toBeNull();
    expect((await google.status({ clientId: "other", clientSecret: "s" })).stale).toBe(true);
  });
});

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("Sign in with Google for the Google Workspace server", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let cookie = "";
  const google = fakeGoogle();
  const api = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
    c = cookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie: c },
    });
  const server = async () =>
    (await api("GET", "/api/mcp"))
      .json()
      .servers.find((s: { id: string }) => s.id === "google-workspace");

  beforeAll(async () => {
    t = await testApp(db as string, {
      googleFetch: google.fetchImpl,
      env: { SHIPMATE_URL: "https://ship.example.com" },
    });
    const setup = await api(
      "POST",
      "/api/setup",
      { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
      "",
    );
    cookie = String(setup.headers["set-cookie"]).split(";")[0] ?? "";
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("shows the redirect URI, signs in through the callback, and signs out", async () => {
    let s = await server();
    expect(s.google).toMatchObject({
      redirectUri: "https://ship.example.com/api/mcp/google/callback",
      pasteBack: false,
      signedIn: false,
    });
    expect((await api("POST", "/api/mcp/google/start")).statusCode).toBe(400);

    await api("POST", "/api/mcp/google-workspace/install");
    await api("PUT", "/api/mcp/google-workspace/secrets", {
      values: { GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "csecret" },
    });
    s = await server();
    expect(s.ready).toBe(false);

    const { url } = (await api("POST", "/api/mcp/google/start")).json();
    const state = new URL(url).searchParams.get("state");
    // Google's redirect may land without Shipmate's cookie; the state is what counts.
    const back = await api(
      "GET",
      `/api/mcp/google/callback?state=${state}&code=good-code`,
      undefined,
      "",
    );
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("https://ship.example.com/#/mcp?google=ok");
    s = await server();
    expect(s.google).toMatchObject({ signedIn: true, email: "addison@example.com", stale: false });
    expect(s.ready).toBe(true);

    // Members don't see which Google account it is.
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    const login = await api(
      "POST",
      "/api/auth/login",
      { email: "kid@example.com", password: "password1" },
      "",
    );
    const kid = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const seen = (await api("GET", "/api/mcp", undefined, kid))
      .json()
      .servers.find((x: { id: string }) => x.id === "google-workspace");
    expect(seen.google).toMatchObject({ signedIn: true, email: null });

    // A replayed callback is refused.
    const replay = await api("GET", `/api/mcp/google/callback?state=${state}&code=good-code`);
    expect(replay.headers.location).toBe("https://ship.example.com/#/mcp?google=state");

    const out = (await api("DELETE", "/api/mcp/google")).json().server;
    expect(out.google.signedIn).toBe(false);
    expect(google.calls.some((c) => c.url.startsWith("https://oauth2.googleapis.com/revoke"))).toBe(
      true,
    );
  });

  it("finishes from a pasted landing address", async () => {
    const { url } = (await api("POST", "/api/mcp/google/start")).json();
    const state = new URL(url).searchParams.get("state");
    const bad = await api("POST", "/api/mcp/google/finish", {
      url: `http://localhost:3000/api/mcp/google/callback?state=${state}&code=nope`,
    });
    expect(bad.statusCode).toBe(400);

    const again = (await api("POST", "/api/mcp/google/start")).json();
    const s2 = new URL(again.url).searchParams.get("state");
    const ok = await api("POST", "/api/mcp/google/finish", {
      url: `http://localhost:3000/api/mcp/google/callback?state=${s2}&code=good-code&scope=x`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().server.google.signedIn).toBe(true);
  });
});
