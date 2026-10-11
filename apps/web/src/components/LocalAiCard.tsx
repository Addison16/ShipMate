import type { LocalAiStatusDto, LocalModelPullDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import {
  formatSize,
  isInstalled,
  LOCAL_AI_COMMAND,
  ollamaRef,
  pullFor,
  pullLabel,
  pullPercent,
} from "../lib/local-ai.js";
import { useResource } from "../lib/useResource.js";
import { CopyField } from "./CopyField.js";
import { Badge, Button, Card, cx, ErrorText, Muted, Notice, TextField } from "./ui.js";

/**
 * A local model through Ollama (owner): find the server, download a model with progress, and
 * set it up as a provider so crew can use it. Used on the Providers page and in first-run setup.
 */
export function LocalAiCard({
  onUsed,
  heading = true,
}: {
  /** Called with the model ref once a model is set up. */
  onUsed?: (ref: string) => void;
  heading?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const status = useResource(() => api.localAi(url ?? undefined).then((r) => r.localAi), [url]);
  const data = status.data;
  const [urlInput, setUrlInput] = useState("");
  const [custom, setCustom] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState<string | null>(null);

  // Show the server actually checked (the default, or the Ollama provider's) in the field.
  useEffect(() => {
    if (data && url === null) setUrlInput(data.url);
  }, [data, url]);

  // Poll while a download runs; Ollama reports progress as it goes.
  const pulling = data?.pulls.some((p) => p.status === "pulling") ?? false;
  const { reload } = status;
  useEffect(() => {
    if (!pulling) return;
    const timer = setInterval(() => void reload(), 1000);
    return () => clearInterval(timer);
  }, [pulling, reload]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const target = data?.url;
  const pull = (model: string) =>
    run(`pull:${model}`, async () => {
      await api.pullLocalModel(model, target);
      await reload();
    });
  const setUp = (model: string) =>
    run(`use:${model}`, async () => {
      await api.setUpLocalModel({ model, ...(target ? { url: target } : {}), makeDefault });
      setUsed(ollamaRef(model));
      onUsed?.(ollamaRef(model));
      await reload();
    });

  function check(e: FormEvent) {
    e.preventDefault();
    const next = urlInput.trim();
    if (next === url) void reload();
    else setUrl(next || null);
  }

  return (
    <Card>
      {heading && (
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Local model (Ollama)</h2>
          {data &&
            (data.reachable ? (
              <Badge tone="ok">found{data.version ? ` · v${data.version}` : ""}</Badge>
            ) : (
              <Badge tone="warn">not found</Badge>
            ))}
          {data?.providerId && <Badge tone="accent">provider set up</Badge>}
        </div>
      )}
      <Muted>
        Run models on your own hardware: no API key, nothing leaves your network, and no cost per
        message. Smaller models are slower and less capable than the big hosted ones.
      </Muted>

      <form onSubmit={check} className="mt-4 flex flex-wrap items-end gap-2">
        <TextField
          label="Ollama address"
          type="url"
          className="min-w-0 flex-1"
          placeholder="http://ollama:11434"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
        <Button type="submit" disabled={status.loading}>
          {status.loading ? "Checking…" : "Check"}
        </Button>
      </form>

      <div className="mt-4 space-y-4">
        <ErrorText>{status.error}</ErrorText>
        {data && !data.reachable && <NotFound status={data} />}
        {data?.reachable && (
          <>
            {data.installed.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">On this server</h3>
                <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
                  {data.installed.map((m) => (
                    <li key={m.name} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="font-mono text-sm">{m.name}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {formatSize(m.sizeBytes)}
                      </span>
                      {data.defaultModel === ollamaRef(m.name) && (
                        <Badge tone="accent">default</Badge>
                      )}
                      <Button
                        size="sm"
                        variant="primary"
                        className="ml-auto"
                        disabled={busy !== null}
                        onClick={() => void setUp(m.name)}
                      >
                        {busy === `use:${m.name}` ? "Setting up…" : "Use this model"}
                      </Button>
                    </li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={makeDefault}
                    onChange={(e) => setMakeDefault(e.target.checked)}
                  />
                  Make it the default model (crew without a working model use it)
                </label>
              </section>
            )}

            <section>
              <h3 className="mb-2 text-sm font-semibold">
                {data.installed.length ? "Download another" : "Download a model"}
              </h3>
              <ul className="space-y-2">
                {data.recommended.map((m) => (
                  <ModelRow
                    key={m.name}
                    name={m.name}
                    size={m.size}
                    note={m.note}
                    installed={isInstalled(data, m.name)}
                    pull={pullFor(data, m.name)}
                    busy={busy !== null}
                    onPull={() => void pull(m.name)}
                  />
                ))}
              </ul>
              <form
                className="mt-3 flex flex-wrap items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (custom.trim()) void pull(custom.trim());
                }}
              >
                <TextField
                  label="Or any model from ollama.com/library"
                  className="min-w-0 flex-1"
                  placeholder="mistral-nemo:12b"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                />
                <Button type="submit" disabled={busy !== null || !custom.trim()}>
                  Download
                </Button>
              </form>
              {custom.trim() && pullFor(data, custom) && (
                <div className="mt-2">
                  <PullProgress pull={pullFor(data, custom) as LocalModelPullDto} />
                </div>
              )}
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Crew call tools, so pick a model that supports them. Downloads keep going if you
                leave this page.
              </p>
            </section>
          </>
        )}
        <ErrorText>{error}</ErrorText>
        {used && (
          <Notice>
            Ollama is set up with {used}
            {makeDefault ? ", now the default model" : ""}. Crew can use it right away.
          </Notice>
        )}
      </div>
    </Card>
  );
}

function NotFound({ status }: { status: LocalAiStatusDto }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-amber-800 dark:text-amber-200">{status.error}</p>
      <CopyField
        label="Start the bundled Ollama next to Shipmate"
        value={LOCAL_AI_COMMAND}
        hint="Run it where Shipmate's docker-compose.yml is, then press Check. It also downloads a small starter model. Running Ollama elsewhere? Enter its address above."
      />
    </div>
  );
}

function ModelRow({
  name,
  size,
  note,
  installed,
  pull,
  busy,
  onPull,
}: {
  name: string;
  size: string;
  note: string;
  installed: boolean;
  pull: LocalModelPullDto | undefined;
  busy: boolean;
  onPull: () => void;
}) {
  const running = pull?.status === "pulling";
  return (
    <li className="rounded-md border border-slate-200 px-3 py-2 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{name}</span>
        <span className="text-xs text-slate-500 dark:text-slate-400">about {size}</span>
        <span className="ml-auto">
          {installed ? (
            <Badge tone="ok">downloaded</Badge>
          ) : (
            <Button size="sm" disabled={busy || running} onClick={onPull}>
              {running ? "Downloading…" : pull?.status === "failed" ? "Try again" : "Download"}
            </Button>
          )}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{note}</p>
      {pull && !installed && (
        <div className="mt-2">
          <PullProgress pull={pull} />
        </div>
      )}
    </li>
  );
}

function PullProgress({ pull }: { pull: LocalModelPullDto }) {
  const percent = pullPercent(pull);
  return (
    <div>
      {pull.status === "pulling" && (
        <div
          role="progressbar"
          aria-label={`Downloading ${pull.model}`}
          aria-valuemin={0}
          aria-valuemax={100}
          {...(percent !== null ? { "aria-valuenow": percent } : {})}
          className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        >
          <div
            className={cx(
              "h-full rounded-full bg-accent-600 transition-[width] dark:bg-accent-500",
              percent === null && "w-1/4 animate-pulse",
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
      <p
        className={cx(
          "mt-1 text-xs",
          pull.status === "failed"
            ? "text-red-700 dark:text-red-300"
            : "text-slate-500 dark:text-slate-400",
        )}
      >
        {pullLabel(pull)}
      </p>
    </div>
  );
}
