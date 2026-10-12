import type { OidcPublicDto, OidcSettingsDto } from "@shipmate/core";
import { type Db, users } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import * as client from "openid-client";
import { HttpError, type UserRow } from "../auth.js";
import type { AuditService } from "./audit.js";
import type { SettingsService } from "./settings.js";

/** What is stored under the "oidc" settings key; the client secret is vault-encrypted. */
interface StoredOidc {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  label: string;
  allowSignup: boolean;
  allowedDomains: string[];
}

const DEFAULTS: StoredOidc = {
  enabled: false,
  issuer: "",
  clientId: "",
  clientSecret: null,
  label: "Single sign-on",
  allowSignup: false,
  allowedDomains: [],
};

export type OidcSettingsPatch = Partial<{
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** "" clears the stored secret. */
  clientSecret: string;
  label: string;
  allowSignup: boolean;
  allowedDomains: string[];
}>;

/** Reads the provider's discovery document; swappable so tests can point at a mock IdP. */
export type OidcDiscover = (
  issuer: URL,
  clientId: string,
  clientSecret: string | undefined,
) => Promise<client.Configuration>;

/** openid-client discovery. Plain-http issuers are allowed: home-lab IdPs often run on the LAN. */
export const defaultDiscover: OidcDiscover = (issuer, clientId, clientSecret) =>
  client.discovery(
    issuer,
    clientId,
    clientSecret,
    clientSecret ? client.ClientSecretPost(clientSecret) : client.None(),
    {
      timeout: 10,
      ...(issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}),
    },
  );

/** Why a sign-in failed; the code goes to the login page as ?error=<code>. */
export type OidcErrorCode =
  | "disabled"
  | "state"
  | "denied"
  | "failed"
  | "email_unverified"
  | "no_account"
  | "domain"
  | "linked_elsewhere";

export class OidcError extends Error {
  constructor(
    readonly code: OidcErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

interface Pending {
  verifier: string;
  nonce: string;
  next: string;
  expires: number;
}

export const OIDC_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;

/**
 * A same-origin path to land on after signing in: "/", "/#/crew", "#/crew". Returns null for
 * anything that could leave the instance ("//evil", "https://…", backslashes, control chars).
 */
export function safeNext(next: string | undefined): string | null {
  if (next === undefined || next === "") return "/";
  if (next.length > 500 || next.includes("\\")) return null;
  if ([...next].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return null;
  if (next.startsWith("#/")) return `/${next}`;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next;
}

/** Sign-in with an OpenID Connect provider (§16 phase 4): settings, the code flow, user matching. */
export class OidcService {
  readonly #pending = new Map<string, Pending>();
  #config: { key: string; config: client.Configuration } | null = null;
  readonly #discover: OidcDiscover;
  readonly #base: string;

  constructor(
    private readonly deps: {
      db: Db;
      settings: SettingsService;
      vault: SecretVault;
      audit: AuditService;
      baseUrl: string;
      discover?: OidcDiscover | undefined;
    },
  ) {
    this.#discover = deps.discover ?? defaultDiscover;
    this.#base = deps.baseUrl.replace(/\/+$/, "");
  }

  get redirectUri(): string {
    return `${this.#base}/api/auth/oidc/callback`;
  }

  /** An absolute URL on this instance for a path from safeNext (or "/"). */
  url(path: string): string {
    return `${this.#base}${path}`;
  }

  async #stored(): Promise<StoredOidc> {
    const raw = await this.deps.settings.getJson<Partial<StoredOidc>>("oidc");
    return { ...DEFAULTS, ...(raw ?? {}) };
  }

  #usable(s: StoredOidc): boolean {
    return s.enabled && s.issuer !== "" && s.clientId !== "";
  }

  async publicInfo(): Promise<OidcPublicDto> {
    const s = await this.#stored();
    return { enabled: this.#usable(s), label: s.label };
  }

  async settings(): Promise<OidcSettingsDto> {
    const s = await this.#stored();
    return {
      enabled: s.enabled,
      issuer: s.issuer,
      clientId: s.clientId,
      hasClientSecret: Boolean(s.clientSecret),
      label: s.label,
      allowSignup: s.allowSignup,
      allowedDomains: s.allowedDomains,
      redirectUri: this.redirectUri,
    };
  }

  async update(patch: OidcSettingsPatch): Promise<OidcSettingsDto> {
    const cur = await this.#stored();
    const next: StoredOidc = {
      enabled: patch.enabled ?? cur.enabled,
      issuer: patch.issuer !== undefined ? patch.issuer.replace(/\/+$/, "") : cur.issuer,
      clientId: patch.clientId ?? cur.clientId,
      clientSecret:
        patch.clientSecret === undefined
          ? cur.clientSecret
          : patch.clientSecret === ""
            ? null
            : this.deps.vault.encrypt(patch.clientSecret),
      label: patch.label ?? cur.label,
      allowSignup: patch.allowSignup ?? cur.allowSignup,
      allowedDomains: patch.allowedDomains
        ? [...new Set(patch.allowedDomains.map((d) => d.trim().toLowerCase().replace(/^@/, "")))]
            .filter(Boolean)
            .sort()
        : cur.allowedDomains,
    };
    if (next.enabled) {
      if (!next.issuer || !next.clientId) {
        throw new HttpError(400, "an issuer and client ID are needed to turn sign-in on");
      }
      try {
        await this.#discover(new URL(next.issuer), next.clientId, this.#secret(next));
      } catch (err) {
        throw new HttpError(
          400,
          `could not read the provider's discovery document: ${(err as Error).message}`,
        );
      }
    }
    await this.deps.settings.setJson("oidc", next);
    this.#config = null;
    return this.settings();
  }

  #secret(s: StoredOidc): string | undefined {
    return s.clientSecret ? this.deps.vault.decrypt(s.clientSecret) : undefined;
  }

  async #configuration(s: StoredOidc): Promise<client.Configuration> {
    const key = JSON.stringify([s.issuer, s.clientId, s.clientSecret]);
    if (this.#config?.key === key) return this.#config.config;
    const config = await this.#discover(new URL(s.issuer), s.clientId, this.#secret(s));
    this.#config = { key, config };
    return config;
  }

  /** Begin the code flow: the provider URL to send the browser to, and the state to pin. */
  async start(next: string): Promise<{ url: string; state: string }> {
    const s = await this.#stored();
    if (!this.#usable(s)) throw new OidcError("disabled");
    let config: client.Configuration;
    try {
      config = await this.#configuration(s);
    } catch (err) {
      throw new OidcError("failed", (err as Error).message);
    }
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    this.#remember(state, { verifier, nonce, next, expires: Date.now() + OIDC_STATE_TTL_MS });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: "openid email profile",
      response_type: "code",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return { url: url.href, state };
  }

  #remember(state: string, p: Pending) {
    const now = Date.now();
    for (const [k, v] of this.#pending) if (v.expires < now) this.#pending.delete(k);
    while (this.#pending.size >= MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(state, p);
  }

  /**
   * Finish the code flow. `query` is the callback's raw query string; `cookieState` is the state
   * pinned to this browser at start. Returns the user to sign in and where to send them.
   */
  async finish(
    query: string,
    cookieState: string | undefined,
  ): Promise<{ user: UserRow; next: string }> {
    const params = new URLSearchParams(query);
    const state = params.get("state");
    if (!state || !cookieState || state !== cookieState) throw new OidcError("state");
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new OidcError("state");
    if (params.get("error")) {
      throw new OidcError(params.get("error") === "access_denied" ? "denied" : "failed");
    }

    const s = await this.#stored();
    if (!this.#usable(s)) throw new OidcError("disabled");
    let claims: client.IDToken;
    try {
      const config = await this.#configuration(s);
      const current = new URL(this.redirectUri);
      current.search = params.toString();
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: pending.verifier,
        expectedState: state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      const c = tokens.claims();
      if (!c) throw new Error("no ID token");
      claims = c;
    } catch (err) {
      throw new OidcError("failed", (err as Error).message);
    }
    return { user: await this.#resolveUser(s, claims), next: pending.next };
  }

  async #resolveUser(s: StoredOidc, claims: client.IDToken): Promise<UserRow> {
    const { db, audit } = this.deps;
    const subject = claims.sub;
    const [bySubject] = await db
      .select()
      .from(users)
      .where(eq(users.oidcSubject, subject))
      .limit(1);
    if (bySubject) {
      await audit.record({
        userId: bySubject.id,
        crewMemberId: null,
        action: "auth.oidc_signin",
        summary: `${bySubject.email} signed in with ${s.label}`,
        decision: null,
      });
      return bySubject;
    }

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email || claims.email_verified !== true) throw new OidcError("email_unverified");

    const [byEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (byEmail) {
      if (byEmail.oidcSubject && byEmail.oidcSubject !== subject) {
        throw new OidcError("linked_elsewhere");
      }
      const [linked] = await db
        .update(users)
        .set({ oidcSubject: subject })
        .where(eq(users.id, byEmail.id))
        .returning();
      await audit.record({
        userId: byEmail.id,
        crewMemberId: null,
        action: "auth.oidc_link",
        summary: `${email} linked a ${s.label} identity and signed in`,
        decision: null,
      });
      return linked ?? byEmail;
    }

    if (!s.allowSignup) throw new OidcError("no_account");
    const domain = email.split("@").pop() ?? "";
    if (s.allowedDomains.length > 0 && !s.allowedDomains.includes(domain)) {
      throw new OidcError("domain");
    }
    const name =
      [claims.name, claims.preferred_username].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      ) ?? email.split("@")[0];
    const [created] = await db
      .insert(users)
      .values({
        email,
        displayName: (name ?? email).trim().slice(0, 80),
        oidcSubject: subject,
        role: "member",
        preferences: { welcome: "pending" },
      })
      .returning();
    if (!created) throw new Error("insert failed");
    await audit.record({
      userId: created.id,
      crewMemberId: null,
      action: "auth.oidc_signup",
      summary: `${email} joined as a member through ${s.label}`,
      decision: null,
    });
    return created;
  }
}
