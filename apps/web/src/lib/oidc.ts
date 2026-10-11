import type { OidcPublicDto, OidcSettingsDto } from "@shipmate/core";
import { request } from "../api.js";

export type OidcSettingsUpdate = Partial<{
  enabled: boolean;
  issuer: string;
  clientId: string;
  /** "" clears the stored secret; leave it out to keep it. */
  clientSecret: string;
  label: string;
  allowSignup: boolean;
  allowedDomains: string[];
}>;

export const oidcApi = {
  publicInfo: () => request<OidcPublicDto>("GET", "/api/auth/oidc"),
  getSettings: () => request<{ oidc: OidcSettingsDto }>("GET", "/api/settings/oidc"),
  updateSettings: (body: OidcSettingsUpdate) =>
    request<{ oidc: OidcSettingsDto }>("PUT", "/api/settings/oidc", body),
};

/** Where the SSO button sends the browser; `next` is the hash route to come back to. */
export function oidcStartUrl(next?: string): string {
  return next?.startsWith("#/")
    ? `/api/auth/oidc/start?next=${encodeURIComponent(next)}`
    : "/api/auth/oidc/start";
}

const ERRORS: Record<string, string> = {
  disabled: "Single sign-on is turned off on this instance.",
  state: "The sign-in took too long or was started in another tab. Please try again.",
  denied: "Sign-in was cancelled at the identity provider.",
  failed: "The identity provider could not complete the sign-in. Please try again.",
  email_unverified:
    "Your identity provider did not share a verified email address, so Shipmate cannot match your account.",
  no_account: "There is no Shipmate account for that email. Ask the owner to invite you.",
  domain: "Accounts from that email domain cannot sign up here.",
  linked_elsewhere: "That Shipmate account is already linked to a different sign-in identity.",
};

/** A readable message for the login page's ?error= code, or null when there is none. */
export function oidcErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERRORS[code] ?? "Single sign-on did not work. Please try again.";
}

/** The ?error= code in a hash like "#/login?error=no_account". */
export function loginErrorCode(hash: string): string | null {
  const q = hash.indexOf("?");
  return q === -1 ? null : new URLSearchParams(hash.slice(q + 1)).get("error");
}

/** "example.org, @Example.com\nfoo.test" → ["example.org", "example.com", "foo.test"]. */
export function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
        .filter(Boolean),
    ),
  ];
}
