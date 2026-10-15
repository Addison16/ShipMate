import type { ChatGptStatusDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { errorMessage } from "../api.js";
import { useThemeText } from "../appearance.js";
import { useUser } from "../auth.js";
import { callbackProblem, chatgptApi, planLabel } from "../lib/chatgpt.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, cx, ErrorText, focusRing, Muted, TextField } from "./ui.js";

/** Providers → ChatGPT plan (owner only): Sign in with ChatGPT, paste-back, status, sign out. */
export function ChatGptCard({ onChanged }: { onChanged: () => Promise<void> }) {
  const user = useUser();
  if (user.role !== "owner") return null;
  return <ChatGptCardInner onChanged={onChanged} />;
}

function ChatGptCardInner({ onChanged }: { onChanged: () => Promise<void> }) {
  const status = useResource(() => chatgptApi.status());
  const t = useThemeText();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");

  async function run(label: string, fn: () => Promise<ChatGptStatusDto>, models = false) {
    setBusy(label);
    setError(null);
    try {
      status.setData(await fn());
      if (models) await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function finish(e: FormEvent) {
    e.preventDefault();
    const problem = callbackProblem(pasted);
    if (problem) {
      setError(problem);
      return;
    }
    void run(
      "complete",
      async () => {
        const next = await chatgptApi.complete(pasted.trim());
        setPasted("");
        return next;
      },
      true,
    );
  }

  const s = status.data;
  const plan = planLabel(s?.plan ?? null);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">ChatGPT plan</h2>
            <Badge>Sign in with ChatGPT</Badge>
            {s?.signedIn && <Badge tone="ok">signed in</Badge>}
            {s?.signedIn && plan && <Badge tone="accent">{plan}</Badge>}
            {s?.lastError && <Badge tone="warn">needs attention</Badge>}
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t(
              "Crew use OpenAI models through the signed-in person's ChatGPT plan, so usage counts against that plan's limits instead of an API bill.",
            )}
          </p>
        </div>
        {s?.signedIn && (
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== null}
            onClick={() => {
              if (
                window.confirm(t("Sign out of ChatGPT? Crew using its models will stop working."))
              ) {
                void run("signout", () => chatgptApi.signOut(), true);
              }
            }}
          >
            {busy === "signout" ? "Signing out…" : "Sign out"}
          </Button>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <ErrorText>{status.error}</ErrorText>
        {s?.signedIn && (
          <div className="space-y-1 text-sm">
            <p>
              <span className="font-medium">Account: </span>
              {s.email ?? "unknown email"}
              {plan ? ` (${plan})` : ""}
            </p>
            <p>
              <span className="font-medium">Models: </span>
              {s.models.length
                ? `${s.models.length} available as ${s.providerId}/…`
                : "none listed yet"}
            </p>
            <Muted>
              {t("Tokens stay on the server and renew automatically when a crew member needs one.")}
            </Muted>
            {s.lastError && (
              <ErrorText>
                {`The last renewal failed: ${s.lastError}\nIf access was revoked, sign out and sign in again.`}
              </ErrorText>
            )}
          </div>
        )}

        {s && !s.signedIn && !s.pending && (
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void run("start", () => chatgptApi.start())}
          >
            {busy === "start" ? "Starting…" : "Sign in with ChatGPT"}
          </Button>
        )}

        {s?.pending && (
          <div className="space-y-4 rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <div className="space-y-2">
              <p className="text-sm font-medium">1. Sign in with OpenAI</p>
              <a
                href={s.pending.authorizeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cx(
                  "inline-flex items-center rounded-md bg-accent-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-800 dark:bg-accent-600 dark:hover:bg-accent-700",
                  focusRing,
                )}
              >
                Open ChatGPT sign-in
              </a>
              <CopyField
                label="Or copy the link to another browser"
                value={s.pending.authorizeUrl}
              />
            </div>
            <form onSubmit={finish} className="space-y-2">
              <p className="text-sm font-medium">2. Paste the address you land on</p>
              <Muted>
                After signing in, the browser goes to {s.pending.redirectUri}, which usually shows
                "can't be reached". That is expected: copy the whole address from the address bar
                and paste it here.
              </Muted>
              <TextField
                label="Address after sign-in"
                autoComplete="off"
                spellCheck={false}
                placeholder={`${s.pending.redirectUri}?code=…`}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" disabled={busy !== null || !pasted.trim()}>
                  {busy === "complete" ? "Finishing…" : "Finish sign-in"}
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={() => void run("check", () => chatgptApi.status(), true)}
                >
                  Check status
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void run("cancel", () => chatgptApi.cancel())}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
      </div>
    </Card>
  );
}
