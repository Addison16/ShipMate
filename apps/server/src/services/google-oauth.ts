import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretVault } from "@shipmate/providers";
import type { SettingsService } from "./settings.js";

/** Where Google sends the browser back after "Sign in with Google". */
export const GOOGLE_CALLBACK_PATH = "/api/mcp/google/callback";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const G = "https://www.googleapis.com/auth/";
/** What workspace-mcp's Gmail, Calendar, Drive, Docs, Sheets and Tasks tools ask for. */
export const GOOGLE_SCOPES = [
  "openid",
  `${G}userinfo.email`,
  `${G}userinfo.profile`,
  `${G}gmail.modify`,
  `${G}gmail.settings.basic`,
  `${G}calendar`,
  `${G}drive`,
  `${G}documents`,
  `${G}spreadsheets`,
  `${G}tasks`,
];

/** The scopes the tools need; the identity ones (openid, email, profile) only name the account. */
const SERVICE_SCOPES = GOOGLE_SCOPES.filter(
  (scope) => scope.startsWith(G) && !scope.includes("userinfo"),
);

export type GoogleFetch = typeof fetch;

/** Why a sign-in failed; the code goes back to the MCP page as ?google=<code>. */
export type GoogleErrorCode =
  | "state"
  | "denied"
  | "no_client"
  | "no_refresh"
  | "partial"
  | "failed";

export class GoogleOAuthError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

/** Stored under the "mcp-google" settings key; the refresh token is vault-encrypted. */
interface Stored {
  refreshToken: string;
  email: string;
  scopes: string[];
  clientId: string;
}

interface Pending {
  userId: string;
  verifier: string;
  redirectUri: string;
  expires: number;
}

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 100;

/**
 * Google only takes https addresses with a real domain name, or plain-http localhost. Anything
 * else (a LAN IP, http on a hostname) cannot be a redirect URI.
 */
export function googleAcceptsRedirect(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol === "http:") return loopback;
  if (url.protocol !== "https:") return false;
  const ip = /^[\d.]+$/.test(host) || host.includes(":");
  if (loopback) return true;
  if (ip || !host.includes(".")) return false;
  // Google wants a public suffix; these private and special-use ones never are.
  return !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const PRIVATE_SUFFIXES = [
  "local",
  "lan",
  "home",
  "home.arpa",
  "internal",
  "localdomain",
  "intranet",
  "corp",
  "private",
  "test",
  "example",
  "invalid",
  "localhost",
];

/** workspace-mcp's file name for an account: Python's quote(email, safe="@._-"). */
export function credentialFileName(email: string): string {
  return [...new TextEncoder().encode(email)]
    .map((b) => {
      const ch = String.fromCharCode(b);
      return /[A-Za-z0-9@._~-]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/**
 * "Sign in with Google" for the Google Workspace MCP server, with the owner's own Google Cloud
 * OAuth client. Shipmate runs the code flow, keeps the refresh token in the vault, and writes the
 * credentials file workspace-mcp reads, so the server never has to open its own sign-in page.
 */
export class GoogleOAuthService {
  readonly #pending = new Map<string, Pending>();
  readonly #base: string;

  constructor(
    private readonly deps: {
      settings: SettingsService;
      vault: SecretVault;
      /** SHIPMATE_URL. */
      baseUrl: string;
      /** The port Shipmate listens on, for the localhost fallback. */
      port: number;
      /** Where workspace-mcp's credentials file is written. */
      credentialsDir: string;
      fetch?: GoogleFetch | undefined;
    },
  ) {
    this.#base = deps.baseUrl.replace(/\/+$/, "");
  }

  get #fetch(): GoogleFetch {
    return this.deps.fetch ?? fetch;
  }

  /**
   * The redirect URI to register in Google Cloud. It follows SHIPMATE_URL when Google accepts it;
   * otherwise it is localhost, and the person pastes the address they land on back into Shipmate.
   */
  get redirect(): { uri: string; pasteBack: boolean } {
    if (googleAcceptsRedirect(this.#base)) {
      const host = new URL(this.#base).hostname;
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host);
      return { uri: `${this.#base}${GOOGLE_CALLBACK_PATH}`, pasteBack: loopback };
    }
    return { uri: `http://localhost:${this.deps.port}${GOOGLE_CALLBACK_PATH}`, pasteBack: true };
  }

  /** Where to send the browser when a sign-in finishes. */
  doneUrl(result: "ok" | GoogleErrorCode): string {
    return `${this.#base}/#/mcp?google=${result}`;
  }

  async #stored(): Promise<Stored | null> {
    const s = await this.deps.settings.getJson<Partial<Stored>>("mcp-google");
    return s?.refreshToken ? (s as Stored) : null;
  }

  async status(client: GoogleClient | null): Promise<{
    signedIn: boolean;
    email: string | null;
    stale: boolean;
  }> {
    const s = await this.#stored();
    if (!s) return { signedIn: false, email: null, stale: false };
    return { signedIn: true, email: s.email, stale: !client || client.clientId !== s.clientId };
  }

  /** The Google sign-in URL for `userId` (an owner) to open. */
  start(client: GoogleClient | null, userId: string): string {
    if (!client) throw new GoogleOAuthError("no_client", "save a client ID and secret first");
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const { uri } = this.redirect;
    const now = Date.now();
    for (const [k, v] of this.#pending) if (v.expires < now) this.#pending.delete(k);
    while (this.#pending.size >= MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    this.#pending.set(state, { userId, verifier, redirectUri: uri, expires: now + STATE_TTL_MS });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: uri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      // A refresh token comes only with offline access, and again only when consent is shown.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  /** Finish from the callback's query string (or the pasted landing address's). */
  async finish(
    query: string,
    client: GoogleClient | null,
  ): Promise<{ email: string; userId: string }> {
    const params = new URLSearchParams(query);
    const state = params.get("state") ?? "";
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new GoogleOAuthError("state");
    if (params.get("error")) {
      throw new GoogleOAuthError(params.get("error") === "access_denied" ? "denied" : "failed");
    }
    const code = params.get("code");
    if (!code) throw new GoogleOAuthError("failed", "no code in the address");
    if (!client) throw new GoogleOAuthError("no_client");

    const res = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: pending.redirectUri,
        grant_type: "authorization_code",
        code_verifier: pending.verifier,
      }).toString(),
    });
    const tokens = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !tokens.access_token) {
      throw new GoogleOAuthError(
        "failed",
        tokens.error_description ?? tokens.error ?? `Google answered ${res.status}`,
      );
    }
    if (!tokens.refresh_token) throw new GoogleOAuthError("no_refresh");

    const who = await this.#fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const info = (await who.json().catch(() => ({}))) as { email?: string };
    if (!who.ok || !info.email) throw new GoogleOAuthError("failed", "could not read the email");

    // Google's consent screen lets people untick services; the tools need all of them.
    const granted = new Set(tokens.scope ? tokens.scope.split(" ") : GOOGLE_SCOPES);
    if (SERVICE_SCOPES.some((scope) => !granted.has(scope))) {
      await this.#revoke(tokens.refresh_token);
      throw new GoogleOAuthError("partial", "some of the requested access was not allowed");
    }

    // A different account replaces the old one: its file and grant go too.
    const previous = await this.#stored();
    if (previous && previous.email !== info.email.toLowerCase()) await this.#forget(previous);

    const stored: Stored = {
      refreshToken: this.deps.vault.encrypt(tokens.refresh_token),
      email: info.email.toLowerCase(),
      scopes: tokens.scope ? tokens.scope.split(" ") : GOOGLE_SCOPES,
      clientId: client.clientId,
    };
    await this.deps.settings.setJson("mcp-google", stored);
    return { email: stored.email, userId: pending.userId };
  }

  async signOut(): Promise<void> {
    const s = await this.#stored();
    if (!s) return;
    await this.deps.settings.setJson("mcp-google", {});
    await this.#forget(s);
  }

  /** Remove an account's credentials file and revoke its grant. */
  async #forget(s: Stored): Promise<void> {
    rmSync(join(this.deps.credentialsDir, `${credentialFileName(s.email)}.json`), { force: true });
    await this.#revoke(this.deps.vault.decrypt(s.refreshToken));
  }

  /** Best effort: the token is gone from Shipmate either way. */
  async #revoke(token: string): Promise<void> {
    await this.#fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
    }).catch(() => undefined);
  }

  /**
   * The env workspace-mcp needs to act as the signed-in account, after writing its credentials
   * file. Null when nobody is signed in with the current client.
   */
  async serverEnv(client: GoogleClient | null): Promise<Record<string, string> | null> {
    const s = await this.#stored();
    if (!s || !client || client.clientId !== s.clientId) return null;
    const refreshToken = this.deps.vault.decrypt(s.refreshToken);
    mkdirSync(this.deps.credentialsDir, { recursive: true, mode: 0o700 });
    const file = join(this.deps.credentialsDir, `${credentialFileName(s.email)}.json`);
    let current: { refresh_token?: string; client_secret?: string } = {};
    try {
      current = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      current = {};
    }
    // Keep a file workspace-mcp already refreshed; only replace it when the grant changed.
    if (current.refresh_token !== refreshToken || current.client_secret !== client.clientSecret) {
      const creds = {
        token: null,
        refresh_token: refreshToken,
        token_uri: TOKEN_URL,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        scopes: s.scopes,
        expiry: null,
      };
      writeFileSync(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
    }
    return {
      WORKSPACE_MCP_CREDENTIALS_DIR: this.deps.credentialsDir,
      USER_GOOGLE_EMAIL: s.email,
      MCP_SINGLE_USER_MODE: "1",
    };
  }
}
