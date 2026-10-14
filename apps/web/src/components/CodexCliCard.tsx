import type { CodexCliStatusDto } from "@shipmate/core";
import { useEffect } from "react";
import { isAdmin, useUser } from "../auth.js";
import { describeStatus } from "../lib/claude-cli.js";
import { codexCliApi } from "../lib/codex-cli.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, cx, ErrorText, focusRing } from "./ui.js";

/**
 * Providers → "Codex" (admins): whether the official `codex` binary is installed and signed in
 * with a ChatGPT account, and how to sign it in. Shipmate never handles the login itself.
 */
export function CodexCliCard({
  onStatus,
}: {
  onStatus?: (status: CodexCliStatusDto) => void;
} = {}) {
  const user = useUser();
  if (!isAdmin(user)) return null;
  return <CodexCliStatusCard onStatus={onStatus} />;
}

function CodexCliStatusCard({
  onStatus,
}: {
  onStatus: ((status: CodexCliStatusDto) => void) | undefined;
}) {
  const res = useResource(() => codexCliApi.status().then((r) => r.codexCli));
  const s = res.data;
  useEffect(() => {
    if (s) onStatus?.(s);
  }, [s, onStatus]);
  const state = s ? describeStatus(s) : null;
  const hint =
    "Use your container's name if it is not shipmate. Open the link it shows and sign in.";
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Codex</h2>
          {state && <Badge tone={state.tone}>{state.label}</Badge>}
          {s?.version && <Badge>v{s.version}</Badge>}
        </div>
        <Button size="sm" onClick={() => void res.reload()}>
          Check again
        </Button>
      </div>
      <ErrorText>{res.error}</ErrorText>
      {s && (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {s.signedIn
              ? "Ready. Pick Codex as a crew member's engine on their Crew page."
              : "Run crew through OpenAI's Codex on your ChatGPT plan. Sign in once on the Docker host:"}
          </p>
          {!s.signedIn && (
            <div className="mt-3">
              <CopyField label="Sign in" value={s.signInCommand} hint={hint} />
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
                Shipmate runs the official <code className="font-mono text-xs">codex</code> app and
                never sees your login. This sign-in is separate from the ChatGPT plan card above.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {s.signedIn && (
                  <CopyField label="Sign in again" value={s.signInCommand} hint={hint} />
                )}
                <CopyField
                  label="Login kept in"
                  value={s.configDir}
                  hint="CODEX_HOME. Shipmate never reads the files in it."
                />
              </div>
              {s.authMethod && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Signed in with: {s.authMethod === "chatgpt" ? "ChatGPT" : "an API key"}.
                </p>
              )}
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
