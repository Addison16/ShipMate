import { type FormEvent, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { useUser } from "../auth.js";
import { type OidcSettingsUpdate, oidcApi, parseDomains } from "../lib/oidc.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, ErrorText, TextAreaField, TextField } from "./ui.js";

/** Settings → Single sign-on (owner only): connect an OpenID Connect provider. */
export function OidcSettings() {
  const user = useUser();
  if (user.role !== "owner") return null;
  return <OidcSettingsCard />;
}

function OidcSettingsCard() {
  const settings = useResource(() => oidcApi.getSettings().then((r) => r.oidc));
  const [enabled, setEnabled] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [label, setLabel] = useState("");
  const [allowSignup, setAllowSignup] = useState(false);
  const [domains, setDomains] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setEnabled(d.enabled);
    setIssuer(d.issuer);
    setClientId(d.clientId);
    setClientSecret("");
    setClearSecret(false);
    setLabel(d.label);
    setAllowSignup(d.allowSignup);
    setDomains(d.allowedDomains.join(", "));
  }, [settings.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const body: OidcSettingsUpdate = {
        enabled,
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        label: label.trim() || "Single sign-on",
        allowSignup,
        allowedDomains: parseDomains(domains),
      };
      if (clearSecret) body.clientSecret = "";
      else if (clientSecret) body.clientSecret = clientSecret;
      const { oidc } = await oidcApi.updateSettings(body);
      settings.setData(oidc);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const d = settings.data;
  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="font-semibold">Single sign-on</h2>
        {d && (d.enabled ? <Badge tone="ok">on</Badge> : <Badge>off</Badge>)}
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Let people sign in with an OpenID Connect provider such as Authentik, Authelia, Keycloak or
        Google. Existing accounts are matched by verified email.
      </p>
      <ErrorText>{settings.error}</ErrorText>
      {d && (
        <form onSubmit={save} className="space-y-4">
          <CopyField
            label="Redirect URI"
            value={d.redirectUri}
            hint="Register this as the redirect (callback) URL of the client in your provider."
          />
          <TextField
            label="Issuer URL"
            placeholder="https://auth.example.com/application/o/shipmate"
            hint="Shipmate reads <issuer>/.well-known/openid-configuration."
            type="url"
            value={issuer}
            onChange={(e) => setIssuer(e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Client ID"
              autoComplete="off"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <TextField
              label="Client secret"
              type="password"
              autoComplete="new-password"
              placeholder={
                d.hasClientSecret ? "Stored — leave blank to keep" : "None (public client)"
              }
              disabled={clearSecret}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
          {d.hasClientSecret && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={clearSecret}
                onChange={(e) => setClearSecret(e.target.checked)}
                className="size-4 accent-teal-700"
              />
              Remove the stored client secret
            </label>
          )}
          <TextField
            label="Button label"
            hint={`The login page shows "Sign in with ${label.trim() || "Single sign-on"}".`}
            maxLength={60}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={allowSignup}
              onChange={(e) => setAllowSignup(e.target.checked)}
              className="size-4 accent-teal-700"
            />
            Create a member account on first sign-in
          </label>
          {allowSignup && (
            <TextAreaField
              label="Allowed email domains"
              hint="Comma- or line-separated, e.g. example.com. Leave empty to allow any domain."
              rows={2}
              value={domains}
              onChange={(e) => setDomains(e.target.value)}
            />
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4 accent-teal-700"
            />
            Show the single sign-on button on the login page
          </label>
          <ErrorText>{error}</ErrorText>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Checking…" : "Save"}
            </Button>
            {saved && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>}
          </div>
        </form>
      )}
    </Card>
  );
}
