import type { HealthCheckDto, HealthDto } from "@shipmate/core";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useUser } from "../auth.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  Muted,
  Notice,
  Page,
  PageHeader,
} from "../components/ui.js";
import {
  groupChecks,
  nextProgress,
  STATUS_LABEL,
  STATUS_TONE,
  summarize,
  type UpdateProgress,
} from "../lib/health.js";
import { useResource } from "../lib/useResource.js";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Health (owner and admin): running version, newer releases, checks, and updating. */
export function HealthPage() {
  const [refresh, setRefresh] = useState(0);
  const health = useResource(() => api.health(refresh > 0).then((r) => r.health), [refresh]);
  const data = health.data;
  const summary = data ? summarize(data.checks) : null;

  return (
    <Page>
      <PageHeader
        icon="health"
        title="Health"
        description="The running version, newer releases, and whether everything Shipmate depends on is working."
        actions={
          <Button disabled={health.loading} onClick={() => setRefresh((n) => n + 1)}>
            {health.loading ? "Checking…" : "Check again"}
          </Button>
        }
      />
      <ErrorText>{health.error}</ErrorText>
      {!data && health.loading && <Muted>Running checks…</Muted>}
      {data && summary && (
        <div className="space-y-6">
          <VersionCard health={data} />
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Checks</h2>
              <Badge tone={STATUS_TONE[summary.status]}>{summary.label}</Badge>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                at {timeFmt.format(new Date(data.checkedAt))}
              </span>
            </div>
            <div className="space-y-4">
              {groupChecks(data.checks).map(([group, checks]) => (
                <Card key={group}>
                  <h3 className="mb-1 text-sm font-semibold text-slate-600 dark:text-slate-300">
                    {group}
                  </h3>
                  <ul className="divide-y divide-slate-200 dark:divide-slate-700">
                    {checks.map((c) => (
                      <CheckRow key={c.id} check={c} />
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Provider checks use free requests (model lists, key info) and never call a model.
              Docker healthchecks can use <code className="font-mono">/healthz</code>, which needs
              no sign-in.
            </p>
          </section>
        </div>
      )}
    </Page>
  );
}

function CheckRow({ check }: { check: HealthCheckDto }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5">
      <span className="w-20 shrink-0 pt-0.5">
        <Badge tone={STATUS_TONE[check.status]}>{STATUS_LABEL[check.status]}</Badge>
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{check.name}</p>
        <p className="text-sm break-words text-slate-600 dark:text-slate-300">{check.detail}</p>
        {check.hint && (
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{check.hint}</p>
        )}
      </div>
    </li>
  );
}

function VersionCard({ health }: { health: HealthDto }) {
  const { release, update } = health;
  const latest = release.latest;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-semibold">Shipmate {health.version}</h2>
        {release.updateAvailable && latest ? (
          <Badge tone="accent">{latest.version} available</Badge>
        ) : release.enabled && latest && !release.error ? (
          <Badge tone="ok">up to date</Badge>
        ) : null}
      </div>
      <div className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {!release.enabled && (
          <p>Release checks are off on this instance (SHIPMATE_UPDATE_CHECK=off).</p>
        )}
        {release.enabled && latest && (
          <p>
            Latest release: {latest.name}
            {latest.publishedAt ? `, ${dateFmt.format(new Date(latest.publishedAt))}` : ""}.{" "}
            <a
              href={latest.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent-700 underline dark:text-accent-300"
            >
              Release notes
            </a>
          </p>
        )}
        {release.enabled && !latest && !release.error && <p>No releases published yet.</p>}
        {release.error && (
          <p className="text-amber-800 dark:text-amber-200">
            Could not check for a newer release: {release.error}.
          </p>
        )}
      </div>
      {(release.updateAvailable || !release.enabled || release.error) && (
        <UpdatePanel health={health} />
      )}
      {!release.updateAvailable && release.enabled && !release.error && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-300">
            How to update by hand
          </summary>
          <Commands commands={update.commands} />
        </details>
      )}
    </Card>
  );
}

/** One-click when Docker allows it (owner only, after a confirm); otherwise the commands. */
function UpdatePanel({ health }: { health: HealthDto }) {
  const user = useUser();
  const owner = user.role === "owner";
  const { update } = health;
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const state = useRef({ sawDown: false, startedAt: 0 });

  useEffect(() => {
    if (progress !== "waiting" && progress !== "restarting") return;
    const timer = setInterval(async () => {
      const result = await api.meta().catch(() => null);
      if (!result) state.current.sawDown = true;
      const next = nextProgress(state.current, result, health.version, Date.now());
      setProgress(next);
      if (next === "updated") window.location.reload();
    }, 3000);
    return () => clearInterval(timer);
  }, [progress, health.version]);

  async function start() {
    const target = health.release.latest?.version;
    const ok = window.confirm(
      [
        `Update Shipmate${target ? ` to ${target}` : ""} now?`,
        "",
        `A helper container (${update.updaterImage}) pulls the new image and recreates the "${update.container}" container with the same settings, then removes itself.`,
        "Shipmate is offline for about a minute and everyone's open chats reconnect. Running replies are cut off.",
        "Your data, settings and database stay as they are; new migrations run on start.",
      ].join("\n"),
    );
    if (!ok) return;
    setError(null);
    try {
      await api.startUpdate();
      state.current = { sawDown: false, startedAt: Date.now() };
      setProgress("waiting");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700">
      <h3 className="mb-1 text-sm font-semibold">Update</h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{update.reason}</p>
      {update.oneClick && owner && progress === null && (
        <div className="mt-3">
          <Button variant="primary" onClick={() => void start()}>
            Update now
          </Button>
        </div>
      )}
      {update.oneClick && !owner && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Only the owner can start an update.
        </p>
      )}
      {progress && (
        <div className="mt-3">
          <Notice>
            {progress === "waiting" && "Update started. Pulling the new image…"}
            {progress === "restarting" &&
              "Shipmate is restarting. This page reloads when it is back."}
            {progress === "unchanged" &&
              "Shipmate is back, still on the same version: the image for this tag had nothing newer yet. Try again later, or update by hand."}
            {progress === "timeout" &&
              "Shipmate has not come back after five minutes. Check `docker ps` and the container logs on the host."}
          </Notice>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {(!update.oneClick || progress === "timeout") && <Commands commands={update.commands} />}
    </div>
  );
}

function Commands({ commands }: { commands: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = commands.join("\n");
  return (
    <div className="mt-3">
      <div className="relative">
        <pre
          className={cx(
            "overflow-x-auto rounded-md border border-slate-200 bg-slate-50 p-3 pr-16 font-mono text-xs leading-relaxed text-slate-800",
            "dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100",
          )}
        >
          {text}
        </pre>
        <Button
          size="sm"
          className="absolute top-2 right-2"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              },
              () => setCopied(false),
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Run on the host where Shipmate's container runs. Migrations run when it starts.
      </p>
    </div>
  );
}
