import type { ClaudeCliStatusDto } from "@shipmate/core";
import { Fragment, useEffect } from "react";
import { useThemeText } from "../appearance.js";
import { isAdmin, useUser } from "../auth.js";
import { claudeCliApi, describeStatus } from "../lib/claude-cli.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, cx, ErrorText, focusRing } from "./ui.js";

/** Split text into plain and `code` parts, each keyed by its offset (stable for a given text). */
function codeParts(text: string): Array<{ key: number; code: boolean; text: string }> {
  const out: Array<{ key: number; code: boolean; text: string }> = [];
  let offset = 0;
  for (const part of text.split(/(`[^`]+`)/)) {
    const code = part.length > 1 && part.startsWith("`") && part.endsWith("`");
    if (part) out.push({ key: offset, code, text: code ? part.slice(1, -1) : part });
    offset += part.length;
  }
  return out;
}

/** The server's plain-text docs: paragraphs with `code` spans. */
function DocText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n\n").map((para) => (
        <p key={para} className="mb-2 text-sm text-slate-600 dark:text-slate-300">
          {codeParts(para).map((p) =>
            p.code ? (
              <code key={p.key} className="font-mono text-xs">
                {p.text}
              </code>
            ) : (
              <Fragment key={p.key}>{p.text}</Fragment>
            ),
          )}
        </p>
      ))}
    </>
  );
}

/**
 * Providers → "Claude subscription (Claude Code)" (admins): whether the official `claude` binary
 * is installed and signed in, and how to sign it in. Shipmate never handles the login itself.
 */
export function ClaudeCliCard({
  onStatus,
}: {
  /** Called with each status the card loads (the setup guide follows the sign-in this way). */
  onStatus?: (status: ClaudeCliStatusDto) => void;
} = {}) {
  const user = useUser();
  if (!isAdmin(user)) return null;
  return <ClaudeCliStatusCard onStatus={onStatus} />;
}

function ClaudeCliStatusCard({
  onStatus,
}: {
  onStatus: ((status: ClaudeCliStatusDto) => void) | undefined;
}) {
  const res = useResource(() => claudeCliApi.status().then((r) => r.claudeCli));
  const t = useThemeText();
  const s = res.data;
  useEffect(() => {
    if (s) onStatus?.(s);
  }, [s, onStatus]);
  const state = s ? describeStatus(s) : null;
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Claude subscription</h2>
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
              ? t("Ready. Pick Claude subscription as a crew member's model on their Crew page.")
              : "Use your own Claude plan for your crew. Sign in once on the Docker host:"}
          </p>
          {!s.signedIn && (
            <div className="mt-3">
              <CopyField
                label="Sign in"
                value="docker exec -it shipmate claude"
                hint="Use your container's name if it is not shipmate. Type /login if it does not ask."
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
            <div className="mt-2">
              <DocText text={s.docs} />
              <div className="grid gap-3 sm:grid-cols-2">
                {s.signedIn && (
                  <CopyField
                    label="Sign in again (on the Docker host)"
                    value="docker exec -it shipmate claude"
                    hint="Use your container's name if it is not shipmate. Type /login if it does not ask."
                  />
                )}
                <CopyField
                  label="Login kept in"
                  value={s.configDir}
                  hint="CLAUDE_CONFIG_DIR. Shipmate never reads the files in it."
                />
              </div>
              {s.authMethod && (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Signed in with: {s.authMethod}.
                </p>
              )}
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
