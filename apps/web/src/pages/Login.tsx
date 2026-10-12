import type { OidcPublicDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth } from "../auth.js";
import { AuthLayout } from "../components/AuthLayout.js";
import { Button, cx, ErrorText, focusRing, TextField } from "../components/ui.js";
import { loginErrorCode, oidcApi, oidcErrorMessage, oidcStartUrl } from "../lib/oidc.js";

/** The hash to return to after single sign-on; the login route itself is not worth returning to. */
function returnRoute(hash: string): string | undefined {
  return hash.startsWith("#/") && !hash.startsWith("#/login") ? hash : undefined;
}

export function LoginPage() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() =>
    oidcErrorMessage(loginErrorCode(window.location.hash)),
  );
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<OidcPublicDto | null>(null);
  const [next] = useState(() => returnRoute(window.location.hash));

  useEffect(() => {
    // The error came from a single sign-on redirect; drop it from the address bar once shown.
    if (window.location.hash.startsWith("#/login")) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
    }
    let live = true;
    oidcApi
      .publicInfo()
      .then((info) => {
        if (live) setSso(info);
      })
      .catch(() => {
        // No button when the server cannot say; password sign-in still works.
      });
    return () => {
      live = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login({ email: email.trim(), password });
      // Reload who is signed in, with the owner's setup guide state if it is still running.
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in">
      {sso?.enabled && (
        <>
          <a
            href={oidcStartUrl(next)}
            className={cx(
              "inline-flex w-full items-center justify-center rounded-md bg-accent-700 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-800 dark:bg-accent-600 dark:hover:bg-accent-500",
              focusRing,
            )}
          >
            Sign in with {sso.label}
          </a>
          <div className="my-5 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
            or with a password
            <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          </div>
        </>
      )}
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
        <Button
          type="submit"
          variant={sso?.enabled ? "secondary" : "primary"}
          disabled={busy}
          className="w-full"
        >
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </AuthLayout>
  );
}
