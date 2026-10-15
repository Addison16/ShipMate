import type { CursorCliStatusDto } from "@shipmate/core";
import { useEffect } from "react";
import { useThemeText } from "../appearance.js";
import { isAdmin, useUser } from "../auth.js";
import { describeStatus } from "../lib/claude-cli.js";
import { cursorCliApi } from "../lib/cursor-cli.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, cx, ErrorText, focusRing } from "./ui.js";

/**
 * Providers → "Cursor" (admins): whether the official `cursor-agent` binary is installed and
 * signed in with a Cursor account, and how to install and sign it in. Shipmate never handles the
 * login itself.
 */
export function CursorCliCard({
  onStatus,
}: {
  onStatus?: (status: CursorCliStatusDto) => void;
} = {}) {
  const user = useUser();
  if (!isAdmin(user)) return null;
  return <CursorCliStatusCard onStatus={onStatus} />;
}

function CursorCliStatusCard({
  onStatus,
}: {
  onStatus: ((status: CursorCliStatusDto) => void) | undefined;
}) {
  const t = useThemeText();
  const res = useResource(() => cursorCliApi.status().then((r) => r.cursorCli));
  const s = res.data;
  useEffect(() => {
    if (s) onStatus?.(s);
  }, [s, onStatus]);
  const state = s ? describeStatus(s) : null;
  const container = "Use your container's name if it is not shipmate.";
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Cursor</h2>
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
              ? t("Ready. Pick Cursor as a crew member's engine on their Crew page.")
              : !s.installed
                ? "Run crew through Cursor on your Cursor plan. Install it once on the Docker host (a large download):"
                : "Run crew through Cursor on your Cursor plan. Sign in once on the Docker host:"}
          </p>
          {!s.installed && (
            <div className="mt-3">
              <CopyField
                label="Install"
                value={s.installCommand}
                hint={`${container} Then check again and sign in.`}
              />
            </div>
          )}
          {s.installed && !s.signedIn && (
            <div className="mt-3">
              <CopyField
                label="Sign in"
                value={s.signInCommand}
                hint={`${container} Open the link it shows and sign in.`}
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
                Shipmate runs the official <code className="font-mono text-xs">cursor-agent</code>{" "}
                app and never sees your login.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {s.signedIn && (
                  <CopyField
                    label="Sign in again"
                    value={s.signInCommand}
                    hint={`${container} Open the link it shows and sign in.`}
                  />
                )}
                {s.installed && (
                  <CopyField
                    label="Update"
                    value={s.installCommand}
                    hint="Downloads the latest version."
                  />
                )}
                <CopyField
                  label="Login kept in"
                  value={s.configDir}
                  hint="Its home folder. Shipmate never reads the files in it."
                />
              </div>
              {s.authMethod && (
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Signed in with:{" "}
                  {s.authMethod === "login" ? (s.email ?? "a Cursor account") : "an API key"}.
                </p>
              )}
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
