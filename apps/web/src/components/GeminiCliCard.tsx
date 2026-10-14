import type { GeminiCliStatusDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import { geminiCliApi } from "../lib/gemini-cli.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, cx, ErrorText, focusRing, TextField } from "./ui.js";

/** The one thing to know before setting it up. */
export const GEMINI_PLAN_NOTE =
  "Needs a Gemini API key or a Gemini Code Assist work login. Google AI Pro plans don't work with Gemini CLI.";

/** One-line state for the card. */
export function describeGemini(
  s: Pick<GeminiCliStatusDto, "installed" | "signedIn" | "authMethod">,
): {
  label: string;
  tone: "ok" | "warn" | "neutral";
} {
  if (!s.installed) return { label: "Not installed", tone: "neutral" };
  if (!s.signedIn) return { label: "Not set up", tone: "warn" };
  return { label: s.authMethod === "api_key" ? "API key" : "Signed in", tone: "ok" };
}

/**
 * Providers → "Gemini CLI" (admins): whether the official `gemini` binary is installed and has an
 * API key or a Google work login, a place for owners to give it a key (kept encrypted), and how
 * to sign it in. Shipmate never handles the Google login itself.
 */
export function GeminiCliCard({
  onStatus,
}: {
  onStatus?: (status: GeminiCliStatusDto) => void;
} = {}) {
  const user = useUser();
  if (!isAdmin(user)) return null;
  return <GeminiCliStatusCard onStatus={onStatus} owner={user.role === "owner"} />;
}

function GeminiCliStatusCard({
  onStatus,
  owner,
}: {
  onStatus: ((status: GeminiCliStatusDto) => void) | undefined;
  owner: boolean;
}) {
  const res = useResource(() => geminiCliApi.status().then((r) => r.geminiCli));
  const s = res.data;
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (s) onStatus?.(s);
  }, [s, onStatus]);
  const state = s ? describeGemini(s) : null;
  const hint =
    "Use your container's name if it is not shipmate. Open the link, sign in, then paste the code it gives you.";

  async function save(value: string | null) {
    setSaving(true);
    setError(null);
    try {
      res.setData((await geminiCliApi.setKey(value)).geminiCli);
      setKey("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) void save(key.trim());
  };

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Gemini CLI</h2>
          {state && <Badge tone={state.tone}>{state.label}</Badge>}
          {s?.version && <Badge>v{s.version}</Badge>}
        </div>
        <Button size="sm" onClick={() => void res.reload()}>
          Check again
        </Button>
      </div>
      <ErrorText>{res.error ?? error}</ErrorText>
      {s && (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {s.signedIn
              ? "Ready. Pick Gemini CLI as a crew member's engine on their Crew page."
              : "Run crew through Google's Gemini CLI."}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{GEMINI_PLAN_NOTE}</p>
          {owner && (
            <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2">
              <TextField
                className="min-w-0 flex-1"
                label={s.keySaved ? "Replace API key" : "Gemini API key"}
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                hint="Kept encrypted. Use is billed by Google per token."
              />
              <Button type="submit" variant="primary" disabled={saving || !key.trim()}>
                Save
              </Button>
              {s.keySaved && (
                <Button variant="danger" disabled={saving} onClick={() => void save(null)}>
                  Remove
                </Button>
              )}
            </form>
          )}
          {s.installed && !s.signedIn && (
            <div className="mt-3">
              <CopyField
                label="Or sign in with a work account"
                value={s.signInCommand}
                hint={hint}
              />
            </div>
          )}
          <details className="mt-3">
            <summary
              className={cx(
                "cursor-pointer rounded text-sm font-medium text-slate-600 dark:text-slate-300",
                focusRing,
              )}
            >
              More details
            </summary>
            <div className="mt-2 space-y-3">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                Shipmate runs the official <code className="font-mono text-xs">gemini</code> app and
                never sees your Google login. An API key is used ahead of a login.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {s.installed && s.authMethod !== "login" && s.signedIn && (
                  <CopyField
                    label="Sign in with a work account"
                    value={s.signInCommand}
                    hint={hint}
                  />
                )}
                {s.authMethod === "login" && (
                  <CopyField label="Sign in again" value={s.signInCommand} hint={hint} />
                )}
                <CopyField
                  label="Login kept in"
                  value={s.configDir}
                  hint="GEMINI_CLI_HOME. Shipmate never reads the files in it."
                />
              </div>
              {s.authMethod && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Uses:{" "}
                  {s.authMethod === "login"
                    ? (s.email ?? "a Google work login")
                    : s.keySaved
                      ? "the API key saved here"
                      : "GEMINI_API_KEY from the server's settings"}
                  .
                </p>
              )}
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
