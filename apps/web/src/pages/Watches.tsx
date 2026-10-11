import type {
  CreateWatchRequest,
  CrewDto,
  MessageDto,
  WatchDto,
  WatchRunDto,
  WatchTrigger,
} from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useApprovals } from "../approvals.js";
import { isAdmin, useUser } from "../auth.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import { Markdown } from "../components/Markdown.js";
import { TimelineView } from "../components/Timeline.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  Page,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/ui.js";
import { formatCost } from "../lib/format.js";
import type { TimelineItem } from "../lib/timeline.js";
import { useResource } from "../lib/useResource.js";
import {
  afterCandidates,
  CRON_PRESETS,
  describeTrigger,
  formatDuration,
  RUN_STATUS_LABEL,
  runTone,
} from "../lib/watches.js";
import { href, navigate } from "../router.js";
import { useServerEvents } from "../ws.js";

export function WatchesPage({ watchId, runId }: { watchId: string | null; runId: string | null }) {
  if (watchId === "new") return <NewWatch />;
  if (watchId && runId) return <RunTranscript key={runId} watchId={watchId} runId={runId} />;
  if (watchId) return <WatchDetail key={watchId} id={watchId} />;
  return <WatchList />;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function canEdit(w: WatchDto, user: ReturnType<typeof useUser>): boolean {
  return w.owner.id === user.id || isAdmin(user);
}

function useWatches() {
  const watches = useResource(() => api.listWatches().then((r) => r.watches));
  useServerEvents((ev) => {
    if (ev.type === "watch_run") void watches.reload();
  });
  return watches;
}

function useCrew() {
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void crew.reload();
  });
  return crew.data ?? [];
}

function RunBadge({ run }: { run: WatchRunDto | null }) {
  if (!run) return <span className="text-xs text-slate-500 dark:text-slate-400">Never run</span>;
  return <Badge tone={runTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>;
}

/** Approvals raised by watch runs, answered here since there is no conversation to show them. */
function RoutineApprovals({ watchId }: { watchId?: string }) {
  const { pending } = useApprovals();
  const mine = pending.filter((a) => a.routineId && (!watchId || a.routineId === watchId));
  if (mine.length === 0) return null;
  return (
    <div className="mb-6 space-y-3">
      <h2 className="font-semibold">Waiting for your approval</h2>
      {mine.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
    </div>
  );
}

function EnabledToggle({
  watch,
  disabled,
  onChange,
}: {
  watch: WatchDto;
  disabled: boolean;
  onChange: (w: WatchDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const { watch: w } = await api.updateWatch(watch.id, { enabled: !watch.enabled });
      onChange(w);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={watch.enabled}
        aria-label={`${watch.name} enabled`}
        disabled={disabled || busy}
        onClick={() => void toggle()}
        className={cx(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          watch.enabled ? "bg-teal-700 dark:bg-teal-500" : "bg-slate-300 dark:bg-slate-600",
          focusRing,
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            "inline-block size-4 rounded-full bg-white shadow transition-transform",
            watch.enabled ? "translate-x-4.5" : "translate-x-0.5",
          )}
        />
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </span>
  );
}

function RunNow({ watch, onRun }: { watch: WatchDto; onRun?: (run: WatchRunDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const { run } = await api.runWatch(watch.id);
      onRun?.(run);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? "Starting…" : "Run now"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </span>
  );
}

function WatchList() {
  const user = useUser();
  const watches = useWatches();
  const crew = useCrew();
  const crewName = (slug: string) => crew.find((c) => c.slug === slug)?.name ?? slug;
  const all = watches.data ?? [];

  const replace = (w: WatchDto) => watches.setData(all.map((x) => (x.id === w.id ? w : x)));

  return (
    <Page wide>
      <PageHeader
        title="Watches"
        description="Jobs a crew member runs on a schedule, on a webhook, or after another watch finishes."
        actions={
          <Button variant="primary" onClick={() => navigate("/watches/new")}>
            New watch
          </Button>
        }
      />
      <RoutineApprovals />
      <ErrorText>{watches.error}</ErrorText>
      {watches.loading && !watches.data && <Muted>Loading…</Muted>}
      {watches.data?.length === 0 && (
        <Card>
          <Muted>
            No watches yet. A watch could send you a morning brief every weekday, plan meals each
            Monday, or triage a repository every night.
          </Muted>
        </Card>
      )}
      <ul className="space-y-3">
        {all.map((w) => {
          const editable = canEdit(w, user);
          return (
            <li key={w.id}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={href(`/watches/${w.id}`)}
                        className={cx(
                          "rounded font-semibold text-teal-800 hover:underline dark:text-teal-300",
                          focusRing,
                        )}
                      >
                        {w.name}
                      </a>
                      {!w.enabled && <Badge>paused</Badge>}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                      {crewName(w.crewSlug)} · {describeTrigger(w.trigger, all)}
                    </p>
                    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                      <div className="flex items-center gap-1.5">
                        <dt>Last run:</dt>
                        <dd className="flex items-center gap-1.5">
                          <RunBadge run={w.lastRun} />
                          {w.lastRun && <span>{formatWhen(w.lastRun.startedAt)}</span>}
                        </dd>
                      </div>
                      {w.enabled && w.nextRunAt && (
                        <div className="flex gap-1.5">
                          <dt>Next:</dt>
                          <dd>{formatWhen(w.nextRunAt)}</dd>
                        </div>
                      )}
                      <div className="flex gap-1.5">
                        <dt>Owner:</dt>
                        <dd>{w.owner.id === user.id ? "you" : w.owner.name}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <EnabledToggle watch={w} disabled={!editable} onChange={replace} />
                    {editable && <RunNow watch={w} onRun={() => void watches.reload()} />}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}

type TriggerKind = WatchTrigger["kind"];

interface FormState {
  name: string;
  crewSlug: string;
  kind: TriggerKind;
  expression: string;
  timezone: string;
  everyMinutes: string;
  afterId: string;
  prompt: string;
  session: "fresh" | "continue";
  enabled: boolean;
}

function toForm(w: WatchDto | null, crew: CrewDto[]): FormState {
  const t = w?.trigger;
  return {
    name: w?.name ?? "",
    crewSlug: w?.crewSlug ?? crew[0]?.slug ?? "",
    kind: t?.kind ?? "cron",
    expression: t?.kind === "cron" ? t.expression : "0 7 * * 1-5",
    timezone:
      t?.kind === "cron"
        ? (t.timezone ?? "")
        : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""),
    everyMinutes: t?.kind === "interval" ? String(t.everyMinutes) : "30",
    afterId: t?.kind === "after" ? t.routineId : "",
    prompt: w?.prompt ?? "",
    session: w?.session ?? "fresh",
    enabled: w?.enabled ?? true,
  };
}

function toTrigger(f: FormState): WatchTrigger | string {
  switch (f.kind) {
    case "cron": {
      const expression = f.expression.trim();
      if (!expression) return "Enter a cron expression.";
      const timezone = f.timezone.trim();
      return timezone ? { kind: "cron", expression, timezone } : { kind: "cron", expression };
    }
    case "interval": {
      const n = Number.parseInt(f.everyMinutes, 10);
      if (!Number.isFinite(n) || n < 1) return "The interval must be at least 1 minute.";
      return { kind: "interval", everyMinutes: n };
    }
    case "webhook":
      return { kind: "webhook" };
    case "after":
      if (!f.afterId) return "Pick the watch this one runs after.";
      return { kind: "after", routineId: f.afterId };
    default:
      return "Pick a trigger.";
  }
}

function WatchForm({
  watch,
  watches,
  crew,
  onSaved,
  onCancel,
}: {
  watch: WatchDto | null;
  watches: WatchDto[];
  crew: CrewDto[];
  onSaved: (w: WatchDto) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<FormState>(() => toForm(watch, crew));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const activeCrew = crew.filter((c) => c.status === "active");
  const crewSlug = f.crewSlug || activeCrew[0]?.slug || "";
  const candidates = afterCandidates(watches, watch?.id ?? null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trigger = toTrigger(f);
    if (typeof trigger === "string") {
      setError(trigger);
      return;
    }
    const body: CreateWatchRequest = {
      name: f.name.trim(),
      crewSlug,
      trigger,
      prompt: f.prompt,
      enabled: f.enabled,
      session: f.session,
    };
    setBusy(true);
    setError(null);
    try {
      const { watch: w } = watch
        ? await api.updateWatch(watch.id, body)
        : await api.createWatch(body);
      onSaved(w);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          placeholder="e.g. Morning brief"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
        />
        <SelectField
          label="Crew member"
          required
          value={crewSlug}
          onChange={(e) => set("crewSlug", e.target.value)}
        >
          {activeCrew.length === 0 && <option value="">No active crew</option>}
          {activeCrew.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name} ({c.role})
            </option>
          ))}
        </SelectField>
      </div>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <legend className="px-1 text-sm font-medium">Trigger</legend>
        <SelectField
          label="Runs"
          value={f.kind}
          onChange={(e) => set("kind", e.target.value as TriggerKind)}
        >
          <option value="cron">On a schedule (cron)</option>
          <option value="interval">Every few minutes</option>
          <option value="webhook">When a webhook is called</option>
          <option value="after">After another watch finishes</option>
        </SelectField>
        {f.kind === "cron" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Cron expression"
                required
                placeholder="0 7 * * 1-5"
                hint="minute hour day-of-month month day-of-week"
                value={f.expression}
                onChange={(e) => set("expression", e.target.value)}
              />
              <TextField
                label="Timezone (optional)"
                placeholder="Europe/Berlin"
                hint="IANA name; the server's timezone when empty."
                value={f.timezone}
                onChange={(e) => set("timezone", e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 dark:text-slate-400">Examples:</span>
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.expression}
                  type="button"
                  aria-pressed={f.expression.trim() === p.expression}
                  onClick={() => set("expression", p.expression)}
                  className={cx(
                    "rounded-full border px-2.5 py-0.5 text-xs",
                    f.expression.trim() === p.expression
                      ? "border-teal-600 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/50 dark:text-teal-200"
                      : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800",
                    focusRing,
                  )}
                >
                  <span className="font-mono">{p.expression}</span>{" "}
                  <span className="text-slate-500 dark:text-slate-400">{p.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {f.kind === "interval" && (
          <TextField
            label="Every (minutes)"
            type="number"
            min={1}
            required
            value={f.everyMinutes}
            onChange={(e) => set("everyMinutes", e.target.value)}
          />
        )}
        {f.kind === "webhook" && (
          <Muted>
            {watch?.webhookUrl
              ? "The webhook URL is shown below the form."
              : "The webhook URL appears after you save. Any text POSTed to it is added to the prompt."}
          </Muted>
        )}
        {f.kind === "after" && (
          <SelectField
            label="After"
            required
            value={f.afterId}
            onChange={(e) => set("afterId", e.target.value)}
          >
            <option value="">Pick a watch…</option>
            {candidates.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </SelectField>
        )}
      </fieldset>

      <TextAreaField
        label="Prompt"
        rows={6}
        required
        placeholder="What should the crew member do each time this runs?"
        value={f.prompt}
        onChange={(e) => set("prompt", e.target.value)}
      />

      <fieldset>
        <legend className="mb-1 text-sm font-medium">Session</legend>
        <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:gap-5">
          {(
            [
              ["fresh", "Start fresh each run"],
              ["continue", "Continue the previous run's session"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="session"
                value={v}
                checked={f.session === v}
                onChange={() => set("session", v)}
                className="size-4 accent-teal-700"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={f.enabled}
          onChange={(e) => set("enabled", e.target.checked)}
          className="size-4 accent-teal-700"
        />
        Enabled
      </label>

      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !crewSlug}>
          {busy ? "Saving…" : watch ? "Save" : "Create watch"}
        </Button>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}

function NewWatch() {
  const watches = useWatches();
  const crew = useCrew();
  return (
    <Page>
      <a
        href={href("/watches")}
        className="text-sm text-teal-700 hover:underline dark:text-teal-300"
      >
        ← Watches
      </a>
      <PageHeader title="New watch" />
      <Card>
        {crew.length === 0 ? (
          <Muted>Loading crew…</Muted>
        ) : (
          <WatchForm
            watch={null}
            watches={watches.data ?? []}
            crew={crew}
            onSaved={(w) => navigate(`/watches/${w.id}`)}
            onCancel={() => navigate("/watches")}
          />
        )}
      </Card>
    </Page>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{label}</p>
      <div className="flex gap-2">
        <input
          readOnly
          aria-label={label}
          value={value}
          onFocus={(e) => e.target.select()}
          className={cx(
            "min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs dark:border-slate-600 dark:bg-slate-800",
            focusRing,
          )}
        />
        <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Keep it private: anyone with this URL can start the watch. POST body text is appended to the
        prompt.
      </p>
    </div>
  );
}

function WatchDetail({ id }: { id: string }) {
  const user = useUser();
  const watches = useWatches();
  const crew = useCrew();
  const runs = useResource(() => api.watchRuns(id, 25).then((r) => r.runs), [id]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useServerEvents((ev) => {
    if (ev.type === "watch_run" && ev.run.watchId === id) void runs.reload();
  });

  const all = watches.data ?? [];
  const watch = all.find((w) => w.id === id) ?? null;
  const editable = watch ? canEdit(watch, user) : false;
  const crewName = (slug: string) => crew.find((c) => c.slug === slug)?.name ?? slug;

  async function remove() {
    if (!watch || !window.confirm(`Delete the watch "${watch.name}"? Its run history goes too.`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteWatch(id);
      navigate("/watches");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Page wide>
      <a
        href={href("/watches")}
        className="text-sm text-teal-700 hover:underline dark:text-teal-300"
      >
        ← Watches
      </a>
      {watches.error && !watch && <ErrorText>{watches.error}</ErrorText>}
      {!watch && watches.loading && <Muted>Loading…</Muted>}
      {!watch && watches.data && <Muted>This watch no longer exists.</Muted>}
      {watch && (
        <>
          <header className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">{watch.name}</h1>
                {!watch.enabled && <Badge>paused</Badge>}
              </div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {crewName(watch.crewSlug)} · {describeTrigger(watch.trigger, all)}
                {watch.enabled && watch.nextRunAt && <> · next {formatWhen(watch.nextRunAt)}</>}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Owner: {watch.owner.id === user.id ? "you" : watch.owner.name} · session{" "}
                {watch.session === "fresh" ? "starts fresh" : "continues"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <EnabledToggle
                watch={watch}
                disabled={!editable}
                onChange={(w) => watches.setData(all.map((x) => (x.id === w.id ? w : x)))}
              />
              {editable && <RunNow watch={watch} onRun={() => void runs.reload()} />}
              {editable && !editing && (
                <Button size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
              {editable && (
                <Button size="sm" variant="danger" onClick={() => void remove()}>
                  Delete
                </Button>
              )}
            </div>
          </header>
          <ErrorText>{error}</ErrorText>
          <RoutineApprovals watchId={id} />

          <div className="space-y-4">
            {editing ? (
              <Card>
                <WatchForm
                  watch={watch}
                  watches={all}
                  crew={crew}
                  onSaved={(w) => {
                    watches.setData(all.map((x) => (x.id === w.id ? w : x)));
                    setEditing(false);
                  }}
                  onCancel={() => setEditing(false)}
                />
              </Card>
            ) : (
              <Card>
                <h2 className="mb-2 font-semibold">Prompt</h2>
                <p className="text-sm whitespace-pre-wrap">{watch.prompt}</p>
              </Card>
            )}
            {watch.trigger.kind === "webhook" && watch.webhookUrl && (
              <Card>
                <CopyField label="Webhook URL" value={watch.webhookUrl} />
              </Card>
            )}
            <RunHistory watchId={id} runs={runs.data} error={runs.error} loading={runs.loading} />
          </div>
        </>
      )}
    </Page>
  );
}

function RunHistory({
  watchId,
  runs,
  error,
  loading,
}: {
  watchId: string;
  runs: WatchRunDto[] | null;
  error: string | null;
  loading: boolean;
}) {
  return (
    <Card>
      <h2 className="mb-3 font-semibold">Run history</h2>
      <ErrorText>{error}</ErrorText>
      {loading && !runs && <Muted>Loading…</Muted>}
      {runs?.length === 0 && <Muted>No runs yet.</Muted>}
      <ul className="divide-y divide-slate-200 dark:divide-slate-800">
        {runs?.map((r) => (
          <li key={r.id} className="py-3">
            <details open={r.status === "failed" && r === runs[0]}>
              <summary
                className={cx(
                  "flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded text-sm",
                  focusRing,
                )}
              >
                <Badge tone={runTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
                <span>{formatWhen(r.startedAt)}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {r.cause}
                  {r.finishedAt && <> · {formatDuration(r.startedAt, r.finishedAt)}</>} ·{" "}
                  {formatCost(r.costMicroUsd)}
                </span>
              </summary>
              <div className="mt-2 space-y-2 pl-1">
                {r.error && <ErrorText>{r.error}</ErrorText>}
                {r.output ? (
                  <div className="rounded-md border border-slate-200 p-3 text-sm dark:border-slate-700">
                    <Markdown text={r.output} />
                  </div>
                ) : (
                  !r.error && <Muted>No output.</Muted>
                )}
                {r.conversationId && (
                  <a
                    href={href(`/watches/${watchId}/runs/${r.id}`)}
                    className={cx(
                      "inline-block rounded text-sm font-medium text-teal-700 hover:underline dark:text-teal-300",
                      focusRing,
                    )}
                  >
                    View transcript
                  </a>
                )}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RunTranscript({ watchId, runId }: { watchId: string; runId: string }) {
  const user = useUser();
  const data = useResource(async () => {
    const [{ watches }, { runs }] = await Promise.all([
      api.listWatches(),
      api.watchRuns(watchId, 100),
    ]);
    const run = runs.find((r) => r.id === runId) ?? null;
    const messages: MessageDto[] = run?.conversationId
      ? (await api.listMessages(run.conversationId)).messages
      : [];
    return { watch: watches.find((w) => w.id === watchId) ?? null, run, messages };
  }, [watchId, runId]);
  const items: TimelineItem[] = (data.data?.messages ?? []).map((m) => ({
    kind: "message",
    key: `m:${m.id}`,
    message: m,
  }));
  const run = data.data?.run ?? null;

  return (
    <Page>
      <a
        href={href(`/watches/${watchId}`)}
        className="text-sm text-teal-700 hover:underline dark:text-teal-300"
      >
        ← {data.data?.watch?.name ?? "Watch"}
      </a>
      <PageHeader
        title="Run transcript"
        description={
          run ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <Badge tone={runTone(run.status)}>{RUN_STATUS_LABEL[run.status]}</Badge>
              {formatWhen(run.startedAt)} · {run.cause}
              {run.finishedAt && <> · {formatDuration(run.startedAt, run.finishedAt)}</>} ·{" "}
              {formatCost(run.costMicroUsd)}
            </span>
          ) : undefined
        }
      />
      <ErrorText>{data.error}</ErrorText>
      {data.loading && !data.data && <Muted>Loading…</Muted>}
      {data.data && !run && <Muted>This run is no longer in the history.</Muted>}
      {run && !run.conversationId && <Muted>This run has no transcript.</Muted>}
      {run?.error && (
        <div className="mb-4">
          <ErrorText>{run.error}</ErrorText>
        </div>
      )}
      {items.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 sm:p-5 dark:border-slate-800 dark:bg-slate-950">
          <TimelineView items={items} selfId={user.id} />
        </div>
      )}
    </Page>
  );
}
