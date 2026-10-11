import { randomUUID } from "node:crypto";
import {
  type Api,
  type AuthInteraction,
  type AuthPrompt,
  createProvider,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ChatGptStatusDto } from "@shipmate/core";
import { type Db, secrets } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError } from "../auth.js";
import { SettingsService } from "./settings.js";

/** The pi provider id ChatGPT-plan models are registered under: refs read `chatgpt/<model>`. */
export const CHATGPT_PROVIDER_ID = "chatgpt";
/** pi's Sign in with ChatGPT flow redirects here; on a server the browser cannot reach it. */
export const CHATGPT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

const SECRET_REF = "chatgpt:oauth";
const DEVICE_ID_KEY = "chatgpt.deviceId";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const PENDING_TTL_MS = 15 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 30_000;

/** Everything stored (encrypted, as one JSON value) for the signed-in ChatGPT account. */
interface StoredCredential {
  access: string;
  refresh: string;
  /** Epoch ms; pi already subtracts a safety margin. */
  expires: number;
  clientId: string;
  scopes: string[];
  email: string | null;
  plan: string | null;
  signedInAt: string;
}

interface PendingSignIn {
  authorizeUrl: string;
  state: string;
  startedAt: Date;
  expiresAt: Date;
  abort: AbortController;
  /** Hands the pasted callback URL to pi's manual-code prompt. */
  submit: (input: string) => void;
  /** Settles when pi's login finishes (credential stored) or fails. */
  done: Promise<void>;
}

/**
 * Sign in with ChatGPT (§11, §12): the owner signs in through OpenAI's own flow (pi-ai's
 * `openai-chatgpt` OAuth, a public PKCE client), and crew calls the Responses API with the
 * resulting access token so usage counts against that ChatGPT plan.
 *
 * pi's flow redirects to a localhost callback it listens on. When Shipmate runs elsewhere, the
 * browser lands on an unreachable page; the owner pastes that address back and it is fed to the
 * same flow's manual-code prompt. Tokens never leave the server: the credential is encrypted in
 * the secrets vault, and the access token is renewed on demand right before a model call that
 * needs it (single-flight), never on a timer.
 */
export class ChatGptService {
  #cred: StoredCredential | null | undefined;
  #pending: PendingSignIn | null = null;
  #refreshing: Promise<StoredCredential> | null = null;
  /** Bumped on every sign-in and sign-out so a refresh that raced one does not resurrect tokens. */
  #generation = 0;
  #registered = false;
  #booted = false;
  #lastError: string | null = null;
  readonly #settings: SettingsService;
  readonly #oauth: OAuthAuth;

  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    private readonly runtime: ModelRuntime,
    oauth?: OAuthAuth,
  ) {
    this.#settings = new SettingsService(db);
    const piOAuth = oauth ?? openaiProvider().auth.oauth;
    if (!piOAuth) throw new Error("pi-ai's OpenAI provider has no Sign in with ChatGPT flow");
    this.#oauth = piOAuth;
  }

  /** Load a stored sign-in and register the models. Safe to call repeatedly. */
  async boot(): Promise<void> {
    if (this.#booted) return;
    this.#booted = true;
    if (await this.#load()) this.#register();
  }

  /** Whether `providerId` is ChatGPT and someone is signed in (counts as configured). */
  configures(providerId: string): boolean {
    return providerId === CHATGPT_PROVIDER_ID && Boolean(this.#cred);
  }

  async status(): Promise<ChatGptStatusDto> {
    const cred = await this.#load();
    const pending = this.#livePending();
    return {
      signedIn: Boolean(cred),
      email: cred?.email ?? null,
      plan: cred?.plan ?? null,
      signedInAt: cred?.signedInAt ?? null,
      accessExpiresAt: cred ? new Date(cred.expires).toISOString() : null,
      providerId: CHATGPT_PROVIDER_ID,
      models: cred
        ? this.runtime.getModels(CHATGPT_PROVIDER_ID).map((m) => `${m.provider}/${m.id}`)
        : [],
      pending: pending
        ? {
            authorizeUrl: pending.authorizeUrl,
            redirectUri: CHATGPT_REDIRECT_URI,
            startedAt: pending.startedAt.toISOString(),
            expiresAt: pending.expiresAt.toISOString(),
          }
        : null,
      lastError: this.#lastError,
    };
  }

  /** Start pi's login flow and return once it has produced the authorize URL. */
  async start(): Promise<ChatGptStatusDto> {
    this.#cancelPending();
    const deviceId = await this.#deviceId();
    const abort = new AbortController();
    let resolveUrl: (url: string) => void = () => {};
    const urlReady = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    let queued: string | undefined;
    let deliver: ((input: string) => void) | undefined;
    const interaction: ProviderAuthInteraction = {
      signal: abort.signal,
      notify: (event) => {
        if (event.type === "auth_url") resolveUrl(event.url);
      },
      prompt: (prompt: AuthPrompt) => {
        if (prompt.type !== "manual_code") {
          return Promise.reject(new Error(`unexpected sign-in prompt "${prompt.type}"`));
        }
        return new Promise<string>((resolve, reject) => {
          if (queued !== undefined) return resolve(queued);
          deliver = resolve;
          const signal = prompt.signal ?? abort.signal;
          if (signal.aborted) return reject(new Error("sign-in cancelled"));
          signal.addEventListener("abort", () => reject(new Error("sign-in cancelled")), {
            once: true,
          });
        });
      },
    } satisfies AuthInteraction;

    const generation = this.#generation;
    const login = this.#oauth
      .login(interaction, { getDeviceId: () => deviceId, agentName: "Shipmate" })
      .then(async (credential) => {
        if (abort.signal.aborted || generation !== this.#generation) return;
        await this.#store(fromPi(credential, null));
      });
    const pending: PendingSignIn = {
      authorizeUrl: "",
      state: "",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      abort,
      submit: (input) => {
        if (deliver) deliver(input);
        else queued = input;
      },
      done: login.finally(() => {
        if (this.#pending === pending) this.#pending = null;
      }),
    };
    // Failures surface through `complete` or `start`; an abandoned flow must not crash the process.
    pending.done.catch(() => {});

    const endedEarly = login.then(() => {
      throw new Error("sign-in ended before it produced a URL");
    });
    endedEarly.catch(() => {});
    let url: string;
    try {
      url = await Promise.race([urlReady, endedEarly]);
    } catch (err) {
      abort.abort();
      throw new HttpError(409, `could not start Sign in with ChatGPT: ${(err as Error).message}`);
    }
    pending.authorizeUrl = url;
    pending.state = new URL(url).searchParams.get("state") ?? "";
    this.#pending = pending;
    return this.status();
  }

  /** Finish a pending sign-in with the address the browser landed on. */
  async complete(callbackUrl: string): Promise<ChatGptStatusDto> {
    const pending = this.#livePending();
    if (!pending) {
      // The browser may have reached pi's callback directly (Shipmate on the same computer).
      if (await this.#load()) return this.status();
      throw new HttpError(409, "No sign-in is in progress (or it expired). Start again.");
    }
    const url = normalizeCallback(callbackUrl);
    const error = url.searchParams.get("error");
    if (error) {
      this.#cancelPending();
      throw new HttpError(400, `ChatGPT sign-in was not completed: ${error}`);
    }
    if (!url.searchParams.get("code") || !url.searchParams.get("client_id")) {
      throw new HttpError(
        400,
        "That address has no sign-in code. Copy the whole address from the browser's address bar after signing in.",
      );
    }
    if (url.searchParams.get("state") !== pending.state) {
      throw new HttpError(
        400,
        "That address belongs to a different sign-in attempt. Use the latest link.",
      );
    }
    pending.submit(url.toString());
    try {
      await pending.done;
    } catch (err) {
      throw new HttpError(400, `ChatGPT sign-in failed: ${(err as Error).message}`);
    }
    return this.status();
  }

  cancel(): Promise<ChatGptStatusDto> {
    this.#cancelPending();
    return this.status();
  }

  /** Delete the stored tokens and drop the models. */
  async signOut(): Promise<ChatGptStatusDto> {
    this.#cancelPending();
    this.#generation++;
    await this.db.delete(secrets).where(eq(secrets.ref, SECRET_REF));
    this.#cred = null;
    this.#lastError = null;
    this.#unregister();
    return this.status();
  }

  /**
   * A valid access token for one model call. Refreshes through pi's flow when the stored one has
   * expired; concurrent callers share a single refresh, and a rotated refresh token is persisted.
   */
  async accessToken(): Promise<string> {
    const cred = await this.#load();
    if (!cred)
      throw new Error("ChatGPT is not signed in. An owner can sign in on the Providers page.");
    if (Date.now() < cred.expires) return cred.access;
    if (!this.#refreshing) {
      this.#refreshing = this.#refresh(cred).finally(() => {
        this.#refreshing = null;
      });
    }
    return (await this.#refreshing).access;
  }

  async #refresh(cred: StoredCredential): Promise<StoredCredential> {
    const generation = this.#generation;
    let next: OAuthCredential;
    try {
      next = await this.#oauth.refresh(
        {
          type: "oauth",
          access: cred.access,
          refresh: cred.refresh,
          expires: cred.expires,
          clientId: cred.clientId,
          scopes: cred.scopes,
        },
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch (err) {
      this.#lastError = (err as Error).message;
      throw new Error(
        `Could not renew the ChatGPT sign-in (${(err as Error).message}). If access was revoked, an owner can sign in again on the Providers page.`,
      );
    }
    const stored = fromPi(next, cred);
    if (generation !== this.#generation) {
      throw new Error("ChatGPT was signed out while the sign-in was being renewed");
    }
    await this.#store(stored, false);
    return stored;
  }

  async #store(cred: StoredCredential, newSignIn = true): Promise<void> {
    const ciphertext = this.vault.encrypt(JSON.stringify(cred));
    await this.db
      .insert(secrets)
      .values({ ref: SECRET_REF, ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
    if (newSignIn) this.#generation++;
    this.#cred = cred;
    this.#lastError = null;
    this.#register();
  }

  async #load(): Promise<StoredCredential | null> {
    if (this.#cred !== undefined) return this.#cred;
    const [row] = await this.db.select().from(secrets).where(eq(secrets.ref, SECRET_REF)).limit(1);
    this.#cred = row ? (JSON.parse(this.vault.decrypt(row.ciphertext)) as StoredCredential) : null;
    return this.#cred;
  }

  async #deviceId(): Promise<string> {
    const existing = await this.#settings.getJson<string>(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = randomUUID();
    await this.#settings.setJson(DEVICE_ID_KEY, id);
    return id;
  }

  #livePending(): PendingSignIn | null {
    if (this.#pending && this.#pending.expiresAt.getTime() <= Date.now()) this.#cancelPending();
    return this.#pending;
  }

  #cancelPending() {
    const p = this.#pending;
    this.#pending = null;
    p?.abort.abort();
  }

  #register() {
    if (this.#registered) return;
    this.runtime.registerNativeProvider(chatGptProvider(this));
    this.#registered = true;
  }

  #unregister() {
    if (!this.#registered) return;
    this.runtime.unregisterProvider(CHATGPT_PROVIDER_ID);
    this.#registered = false;
  }
}

/**
 * pi provider for ChatGPT-plan models: OpenAI's catalog, priced at zero (the plan pays), with
 * auth resolved per request from `ChatGptService.accessToken()`. Requests go through pi's
 * OpenAI Responses implementation as provider "openai" so its Sign in with ChatGPT handling
 * (which drops request fields those tokens reject) applies.
 */
export function chatGptProvider(
  service: Pick<ChatGptService, "accessToken" | "configures">,
): Provider {
  const inner = openAIResponsesApi();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = openaiProvider()
    .getModels()
    .filter((m) => m.api === "openai-responses")
    .map((m) => ({ ...m, provider: CHATGPT_PROVIDER_ID, cost: zero }) as Model<Api>);
  const asOpenAI = (m: Model<Api>): Model<Api> => ({
    ...m,
    provider: "openai",
    baseUrl: OPENAI_BASE_URL,
  });
  return createProvider<Api>({
    id: CHATGPT_PROVIDER_ID,
    name: "ChatGPT plan",
    baseUrl: OPENAI_BASE_URL,
    auth: {
      apiKey: {
        name: "Sign in with ChatGPT",
        // Availability checks must not refresh tokens; only real requests do.
        check: async () =>
          service.configures(CHATGPT_PROVIDER_ID)
            ? { type: "oauth", source: "Sign in with ChatGPT" }
            : undefined,
        resolve: async () =>
          service.configures(CHATGPT_PROVIDER_ID)
            ? { auth: { apiKey: await service.accessToken() }, source: "Sign in with ChatGPT" }
            : undefined,
      },
    },
    models,
    api: {
      stream: (model, context, options) => inner.stream(asOpenAI(model), context, options),
      streamSimple: (model, context, options) =>
        inner.streamSimple(asOpenAI(model), context, options),
    },
  });
}

function fromPi(credential: OAuthCredential, previous: StoredCredential | null): StoredCredential {
  const claims = jwtClaims(credential.access);
  const profile = claims["https://api.openai.com/profile"] as { email?: unknown } | undefined;
  const auth = claims["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown } | undefined;
  const email = str(profile?.email) ?? str(claims.email) ?? previous?.email ?? null;
  const plan = str(auth?.chatgpt_plan_type) ?? previous?.plan ?? null;
  const clientId = str(credential.clientId) ?? previous?.clientId;
  if (!clientId) throw new Error("the sign-in did not return a client id");
  return {
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    clientId,
    scopes: Array.isArray(credential.scopes)
      ? credential.scopes.filter((s): s is string => typeof s === "string")
      : (previous?.scopes ?? []),
    email,
    plan,
    signedInAt: previous?.signedInAt ?? new Date().toISOString(),
  };
}

/** Unverified claims of a JWT access token, for display only (email, plan). */
function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

/**
 * Accepts the full callback address, the same with `localhost` instead of 127.0.0.1, or just its
 * query string, and returns it on pi's exact redirect URI.
 */
export function normalizeCallback(input: string): URL {
  const text = input.trim();
  const expected = new URL(CHATGPT_REDIRECT_URI);
  let url: URL;
  try {
    if (/^[?]?(code|state|client_id|error)=/.test(text)) {
      url = new URL(`${CHATGPT_REDIRECT_URI}?${text.replace(/^\?/, "")}`);
    } else {
      url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
    }
  } catch {
    throw new HttpError(400, "Paste the whole address from the browser's address bar.");
  }
  if (url.pathname !== expected.pathname) {
    throw new HttpError(400, `The address should start with ${CHATGPT_REDIRECT_URI}`);
  }
  const out = new URL(CHATGPT_REDIRECT_URI);
  out.search = url.search;
  return out;
}
