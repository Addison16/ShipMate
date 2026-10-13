import type { McpServerDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { googleMcpApi, isLoopbackHost } from "../lib/google-mcp.js";
import { CopyField } from "./CopyField.js";
import { Button, ErrorText, Muted, TextField } from "./ui.js";

const ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
const SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";
const GUIDE = "https://github.com/Addison16/ShipMate/blob/main/docs/google-workspace.md";

/**
 * Sign in with Google using the owner's own Google Cloud OAuth client: the redirect URI to
 * register, the client ID and secret, and the sign-in itself.
 */
export function GoogleMcpSetup({
  server,
  onChange,
}: {
  server: McpServerDto;
  onChange: (s: McpServerDto) => void;
}) {
  const g = server.google;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [editing, setEditing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!g) return null;

  const idSet = server.secrets.find((s) => s.env === ID_ENV)?.set ?? false;
  const secretSet = server.secrets.find((s) => s.env === SECRET_ENV)?.set ?? false;
  const clientSaved = idSet && secretSet;
  const signedIn = g.signedIn && !g.stale;
  // The redirect is localhost: from any other device the landing page won't load, so paste it.
  const pasteBack = g.pasteBack && !isLoopbackHost(window.location.hostname);
  const showClient = !signedIn || editing;

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const values: Record<string, string> = {};
    if (clientId.trim()) values[ID_ENV] = clientId.trim();
    if (clientSecret.trim()) values[SECRET_ENV] = clientSecret.trim();
    if (!Object.keys(values).length) return;
    void run("save", async () => {
      const { server: s } = await api.setMcpSecrets(server.id, values);
      onChange(s);
      setClientId("");
      setClientSecret("");
      setEditing(false);
    });
  }

  function signIn() {
    // Open the tab now, inside the tap, so phone browsers don't block it.
    const tab = pasteBack ? window.open("", "_blank") : null;
    void run("start", async () => {
      try {
        const { url } = await googleMcpApi.start();
        if (!pasteBack) {
          window.location.assign(url);
          return;
        }
        if (tab) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          window.open(url, "_blank", "noopener");
        }
        setPasting(true);
      } catch (err) {
        tab?.close();
        throw err;
      }
    });
  }

  function finish(e: FormEvent) {
    e.preventDefault();
    void run("finish", async () => {
      const { server: s } = await googleMcpApi.finish(pasted.trim());
      onChange(s);
      setPasting(false);
      setPasted("");
    });
  }

  function signOut() {
    if (!window.confirm("Sign out of Google? Crew lose Gmail, Calendar and Drive.")) return;
    void run("signout", async () => {
      const { server: s } = await googleMcpApi.signOut();
      onChange(s);
    });
  }

  return (
    <div className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700">
      {signedIn && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 text-sm break-all">
            Signed in as <span className="font-medium">{g.email}</span>
          </p>
          <div className="flex gap-2">
            {!editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                Change client
              </Button>
            )}
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={signOut}>
              {busy === "signout" ? "Signing out…" : "Sign out"}
            </Button>
          </div>
        </div>
      )}

      {showClient && (
        <>
          <CopyField
            label="Redirect URI"
            value={g.redirectUri}
            hint={
              <>
                Add this to your OAuth client (Web application) in Google Cloud, under Authorized
                redirect URIs.{" "}
                <a
                  href={GUIDE}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-700 underline dark:text-accent-300"
                >
                  Steps
                </a>
              </>
            }
          />
          <form onSubmit={save} className="space-y-3">
            <TextField
              label="Client ID"
              autoComplete="off"
              spellCheck={false}
              placeholder={idSet ? "Saved; type to replace" : "…apps.googleusercontent.com"}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
            <TextField
              label="Client secret"
              type="password"
              autoComplete="off"
              placeholder={secretSet ? "Saved; type to replace" : "GOCSPX-…"}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={busy !== null || (!clientId.trim() && !clientSecret.trim())}
              >
                {busy === "save" ? "Saving…" : "Save"}
              </Button>
              {editing && (
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        </>
      )}

      {!signedIn && (
        <div className="space-y-2">
          {g.stale && <Muted>The client changed. Sign in again.</Muted>}
          <Button
            variant="primary"
            disabled={busy !== null || !clientSaved}
            onClick={signIn}
            className="w-full sm:w-auto"
          >
            {busy === "start" ? "Opening Google…" : "Sign in with Google"}
          </Button>
          {!clientSaved && <Muted>Save the client ID and secret first.</Muted>}
        </div>
      )}

      {pasting && !signedIn && (
        <form onSubmit={finish} className="space-y-2">
          <Muted>
            After you allow access, Google opens a page that won't load. Copy that page's address
            and paste it here.
          </Muted>
          <TextField
            label="Address after sign-in"
            autoComplete="off"
            spellCheck={false}
            placeholder={`${g.redirectUri}?code=…`}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              variant="primary"
              disabled={busy !== null || !pasted.trim()}
            >
              {busy === "finish" ? "Finishing…" : "Finish sign-in"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {pasteBack && showClient && (
        <Muted>
          Google only redirects to https addresses or localhost. Set SHIPMATE_URL to an https
          address to skip the paste step.
        </Muted>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
