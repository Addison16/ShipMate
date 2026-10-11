import type { CrewDetailDto } from "@shipmate/core";
import { Fragment, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import {
  BACKEND_LABEL,
  type CrewBackendName,
  claudeCliApi,
  describeStatus,
  readBackend,
  withBackend,
} from "../lib/claude-cli.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, ErrorText, SelectField } from "./ui.js";

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
export function ClaudeCliCard() {
  const user = useUser();
  if (!isAdmin(user)) return null;
  return <ClaudeCliStatusCard />;
}

function ClaudeCliStatusCard() {
  const res = useResource(() => claudeCliApi.status().then((r) => r.claudeCli));
  const s = res.data;
  const state = s ? describeStatus(s) : null;
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Claude subscription (Claude Code)</h2>
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
          <DocText text={s.docs} />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <CopyField
              label="Sign in once (on the Docker host)"
              value="docker exec -it shipmate claude"
              hint="Use your container's name if it is not shipmate. Type /login if it does not ask."
            />
            <CopyField
              label="Login kept in"
              value={s.configDir}
              hint="CLAUDE_CONFIG_DIR. Shipmate never reads the files in it."
            />
          </div>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Then set <code className="font-mono">backend: claude-code-cli</code> on a crew member
            (Crew → Manifest).
            {s.authMethod ? ` Signed in with: ${s.authMethod}.` : ""}
          </p>
        </>
      )}
    </Card>
  );
}

/** Crew → Manifest: choose what runs this crew member (rewrites `backend:` in crew.yaml). */
export function CrewBackendSelect({
  crew,
  readOnly,
  onSaved,
}: {
  crew: CrewDetailDto;
  readOnly: boolean;
  onSaved: (crew: CrewDetailDto) => void;
}) {
  const current = readBackend(crew.manifestYaml);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: CrewBackendName) {
    if (next === current) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateCrew(crew.slug, {
        manifestYaml: withBackend(crew.manifestYaml, next),
      });
      onSaved(res.crew);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 max-w-xl">
      <SelectField
        label="Backend"
        value={current}
        disabled={readOnly || busy}
        onChange={(e) => void change(e.target.value as CrewBackendName)}
        hint={
          current === "claude-code-cli"
            ? "Runs the official claude binary signed in with your own Claude account (see Providers). Shipmate approval cards do not apply: cli.allowedTools and cli.permissionMode (default dontAsk) decide which tools it may use. Not available in Shipyard projects."
            : "Uses the model in crew.yaml through the instance's providers."
        }
      >
        {(Object.keys(BACKEND_LABEL) as CrewBackendName[]).map((b) => (
          <option key={b} value={b}>
            {BACKEND_LABEL[b]}
          </option>
        ))}
      </SelectField>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
