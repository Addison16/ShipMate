import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Claims the mock provider puts in the next ID token (sub is required). */
export interface MockIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

interface IssuedCode {
  identity: MockIdentity;
  nonce: string;
  challenge: string;
  redirectUri: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * A tiny in-process OpenID provider for tests: discovery, JWKS and a token endpoint that signs
 * RS256 ID tokens. `authorize` stands in for the person signing in at the provider.
 */
export class MockIdp {
  readonly clientId = "shipmate-test";
  readonly clientSecret = "s3cret-value";
  issuer = "";
  #server: Server | null = null;
  readonly #key: KeyObject;
  readonly #jwk: Record<string, unknown>;
  readonly #codes = new Map<string, IssuedCode>();

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.#key = privateKey;
    this.#jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return json(200, {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`,
          jwks_uri: `${this.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      }
      if (req.method === "GET" && url.pathname === "/jwks") return json(200, { keys: [this.#jwk] });
      if (req.method === "POST" && url.pathname === "/token") {
        let raw = "";
        req.on("data", (c: Buffer) => {
          raw += c.toString();
        });
        req.on("end", () => {
          const p = new URLSearchParams(raw);
          const issued = this.#codes.get(p.get("code") ?? "");
          if (p.get("code")) this.#codes.delete(p.get("code") ?? "");
          const verifier = p.get("code_verifier") ?? "";
          const ok =
            issued &&
            p.get("client_id") === this.clientId &&
            p.get("client_secret") === this.clientSecret &&
            p.get("redirect_uri") === issued.redirectUri &&
            b64url(createHash("sha256").update(verifier).digest()) === issued.challenge;
          if (!ok || !issued) return json(400, { error: "invalid_grant" });
          return json(200, {
            access_token: b64url(randomBytes(16)),
            token_type: "Bearer",
            expires_in: 300,
            id_token: this.#idToken(issued),
          });
        });
        return;
      }
      json(404, { error: "not_found" });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.issuer = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server ? this.#server.close(() => resolve()) : resolve(),
    );
  }

  /**
   * The person signs in at the provider: given the authorization URL Shipmate redirected to,
   * returns the callback query string the provider would send the browser back with.
   */
  authorize(authorizationUrl: string, identity: MockIdentity): string {
    const u = new URL(authorizationUrl);
    const code = b64url(randomBytes(16));
    this.#codes.set(code, {
      identity,
      nonce: u.searchParams.get("nonce") ?? "",
      challenge: u.searchParams.get("code_challenge") ?? "",
      redirectUri: u.searchParams.get("redirect_uri") ?? "",
    });
    return new URLSearchParams({ code, state: u.searchParams.get("state") ?? "" }).toString();
  }

  #idToken(issued: IssuedCode): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const payload = b64url(
      JSON.stringify({
        iss: this.issuer,
        aud: this.clientId,
        iat: now,
        exp: now + 300,
        nonce: issued.nonce,
        ...issued.identity,
      }),
    );
    const sig = sign("sha256", Buffer.from(`${header}.${payload}`), this.#key);
    return `${header}.${payload}.${b64url(sig)}`;
  }
}
