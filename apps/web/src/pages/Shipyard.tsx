import type {
  CrewDto,
  IssueDto,
  ProjectDto,
  PullRequestDto,
  ShipyardFlow,
  ShipyardJobDto,
  ShipyardStatusDto,
} from "@shipmate/core";
import { type FormEvent, type ReactNode, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import { CopyField } from "../components/CopyField.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  Notice,
  Page,
  PageHeader,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/ui.js";
import { formatTime } from "../lib/format.js";
import {
  activeJobsByIssue,
  checksBadge,
  emptyProjectForm,
  FLOW_LABELS,
  type JobSettingsForm,
  jobActions,
  jobBadge,
  jobSettingsChanges,
  jobSettingsForm,
  jobsApi,
  jobsForBoard,
  type ProjectForm,
  projectChanges,
  prStateBadge,
  repoUrl,
  sandboxBadge,
  validateProjectForm,
  workspaceSummary,
} from "../lib/shipyard.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { useServerEvents } from "../ws.js";

type Tab = "pulls" | "issues" | "activity" | "chats" | "settings";
const TABS: Array<{ id: Tab; label: string; github?: boolean; admin?: boolean }> = [
  { id: "pulls", label: "Pull requests", github: true },
  { id: "issues", label: "Issues", github: true },
  { id: "activity", label: "Activity" },
  { id: "chats", label: "Chats" },
  { id: "settings", label: "Settings", admin: true },
];

export function ShipyardPage({ projectId, tab }: { projectId: string | null; tab: string | null }) {
  if (projectId) return <ProjectDetail key={projectId} id={projectId} tab={tab} />;
  return <ProjectList />;
}

const linkClass = cx(
  "rounded font-medium text-accent-800 hover:underline dark:text-accent-300",
  focusRing,
);

function ExternalLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={to} target="_blank" rel="noreferrer noopener" className={linkClass}>
      {children}
    </a>
  );
}

function useCrew(): CrewDto[] {
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void crew.reload();
  });
  return crew.data ?? [];
}

/** Crew members who can own a project: active and not the coordinator. */
function workers(crew: CrewDto[]): CrewDto[] {
  return crew.filter((c) => c.status === "active" && !c.captain);
}

function defaultCrewSlug(crew: CrewDto[]): string {
  const list = workers(crew);
  return list.find((c) => c.slug === "shipwright")?.slug ?? list[0]?.slug ?? "shipwright";
}

function CrewSelect({
  crew,
  value,
  onChange,
  disabled,
}: {
  crew: CrewDto[];
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
}) {
  const list = workers(crew);
  const known = list.some((c) => c.slug === value);
  return (
    <SelectField
      label="Crew member"
      hint="Who works on this project. The Shipwright is the default coder."
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {!known && value && <option value={value}>{value}</option>}
      {list.map((c) => (
        <option key={c.slug} value={c.slug}>
          {c.name} ({c.role})
        </option>
      ))}
    </SelectField>
  );
}

function StatusBanner({ status }: { status: ShipyardStatusDto | null }) {
  const user = useUser();
  if (!status || status.available) return null;
  const code = (t: string) => <code className="font-mono text-xs">{t}</code>;
  return (
    <div
      role="status"
      className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100"
    >
      <p className="font-medium">Code cannot run right now.</p>
      {status.reason && <p className="mt-1">{status.reason}</p>}
      <p className="mt-1">
        Crew members run code in a sandbox container, started through a Docker-compatible API. Any
        one of these works:
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        <li>
          Mount the Docker socket into Shipmate ({code("/var/run/docker.sock:/var/run/docker.sock")}
          ) and restart it.
        </li>
        <li>
          Use rootless Podman: run {code("systemctl --user enable --now podman.socket")} and mount{" "}
          {code("$XDG_RUNTIME_DIR/podman/podman.sock")} instead. Nothing runs as root.
        </li>
        <li>
          Use a Docker or Podman host elsewhere on your network over TCP with TLS client
          certificates, for a NAS that cannot share its socket.
        </li>
      </ul>
      <p className="mt-1">
        {user.role === "owner" ? (
          <>
            Choose and test one under{" "}
            <a href={href("/settings")} className="underline underline-offset-2">
              Settings → Shipyard sandbox
            </a>
            .
          </>
        ) : (
          "The owner can set this up under Settings."
        )}{" "}
        You can still add projects in the meantime.
      </p>
    </div>
  );
}

const TOKEN_HINT = (
  <>
    A fine-grained personal access token limited to this repository, with <strong>Contents</strong>,{" "}
    <strong>Pull requests</strong> and <strong>Issues</strong> set to read and write. Create one at{" "}
    <a
      href="https://github.com/settings/personal-access-tokens/new"
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2"
    >
      github.com/settings/personal-access-tokens
    </a>
    . Stored encrypted and never shown again.
  </>
);

// ---------- list ----------

function ProjectList() {
  const user = useUser();
  const admin = isAdmin(user);
  const shipyard = useResource(() => api.getShipyard());
  const crew = useCrew();
  const [adding, setAdding] = useState(false);
  const crewName = (slug: string) => crew.find((c) => c.slug === slug)?.name ?? slug;
  const projects = shipyard.data?.projects ?? [];

  return (
    <Page wide>
      <PageHeader
        title="Shipyard"
        description="Software projects your crew works on: pull requests, issues, and a sandbox to run code in."
        actions={
          admin && !adding ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              New project
            </Button>
          ) : undefined
        }
      />
      <StatusBanner status={shipyard.data?.status ?? null} />
      <ErrorText>{shipyard.error}</ErrorText>
      {adding && (
        <Card className="mb-6">
          <h2 className="mb-4 font-semibold">New project</h2>
          <NewProjectForm
            crew={crew}
            defaultImage={shipyard.data?.status.sandboxImage ?? ""}
            onCancel={() => setAdding(false)}
            onCreated={(p) => navigate(`/shipyard/${p.id}`)}
          />
        </Card>
      )}
      {shipyard.loading && !shipyard.data && <Muted>Loading…</Muted>}
      {shipyard.data && projects.length === 0 && !adding && (
        <Card>
          <Muted>
            No projects yet.{" "}
            {admin
              ? "Add a GitHub repository or a local folder and a crew member can plan features, fix issues and review pull requests."
              : "Ask an admin to add one."}
          </Muted>
        </Card>
      )}
      <ul className="grid gap-3 md:grid-cols-2">
        {projects.map((p) => {
          const sb = sandboxBadge(p.sandbox.status);
          const url = repoUrl(p.repo);
          return (
            <li key={p.id}>
              <Card className="h-full">
                <a href={href(`/shipyard/${p.id}`)} className={cx(linkClass, "font-semibold")}>
                  {p.name}
                </a>
                <p className="mt-0.5 truncate text-sm text-slate-600 dark:text-slate-300">
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={cx("rounded hover:underline", focusRing)}
                    >
                      github.com/{p.repo}
                    </a>
                  ) : (
                    "Local folder"
                  )}
                </p>
                <dl className="mt-2 space-y-1 text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex gap-1.5">
                    <dt>Crew:</dt>
                    <dd>{crewName(p.crewSlug)}</dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>Workspace:</dt>
                    <dd>{workspaceSummary(p.workspace)}</dd>
                  </div>
                </dl>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone={sb.tone}>{sb.label}</Badge>
                  {p.provider === "github" && !p.hasToken && <Badge tone="warn">no token</Badge>}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}

export function NewProjectForm({
  crew,
  defaultImage,
  onCreated,
  onCancel,
}: {
  crew: CrewDto[];
  defaultImage: string;
  onCreated: (p: ProjectDto) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ProjectForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof ProjectForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Default the crew member once the roster has loaded.
  const f = form ?? emptyProjectForm(defaultCrewSlug(crew));
  const set = <K extends keyof ProjectForm>(k: K, v: ProjectForm[K]) => setForm({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const result = validateProjectForm(f);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(result.request);
      onCreated(project);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const github = f.provider === "github";
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
          hint={
            errors.name && <span className="text-red-700 dark:text-red-300">{errors.name}</span>
          }
        />
        <SelectField
          label="Source"
          value={f.provider}
          onChange={(e) => set("provider", e.target.value as ProjectForm["provider"])}
        >
          <option value="github">GitHub repository</option>
          <option value="local">Local folder (no git remote)</option>
        </SelectField>
      </div>
      {github ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Repository"
            placeholder="owner/name"
            required
            autoComplete="off"
            spellCheck={false}
            value={f.repo}
            onChange={(e) => set("repo", e.target.value)}
            hint={
              errors.repo ? (
                <span className="text-red-700 dark:text-red-300">{errors.repo}</span>
              ) : (
                "e.g. octocat/hello-world, or paste the GitHub URL."
              )
            }
          />
          <TextField
            label="Access token"
            type="password"
            autoComplete="new-password"
            value={f.token}
            onChange={(e) => set("token", e.target.value)}
            hint={TOKEN_HINT}
          />
        </div>
      ) : (
        <Muted>
          A local project is a folder in the workspace with no git remote, for writing or research.
        </Muted>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <CrewSelect crew={crew} value={f.crewSlug} onChange={(v) => set("crewSlug", v)} />
        <TextField
          label="Default branch (optional)"
          placeholder={github ? "from GitHub" : "main"}
          value={f.defaultBranch}
          onChange={(e) => set("defaultBranch", e.target.value)}
          hint={
            errors.defaultBranch && (
              <span className="text-red-700 dark:text-red-300">{errors.defaultBranch}</span>
            )
          }
        />
        <TextField
          label="Sandbox image (optional)"
          placeholder={defaultImage || "default"}
          value={f.sandboxImage}
          onChange={(e) => set("sandboxImage", e.target.value)}
        />
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Adding…" : "Add project"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------- detail ----------

/** Starts a flow and opens its conversation; tracks which button is busy. */
function useFlows(projectId: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start(flow: ShipyardFlow, opts: { target?: number; notes?: string } = {}) {
    const key = `${flow}:${opts.target ?? ""}`;
    setBusy(key);
    setError(null);
    try {
      const { conversationId } = await api.startFlow(projectId, { flow, ...opts });
      navigate(`/bridge/${conversationId}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }
  const isBusy = (flow: ShipyardFlow, target?: number) => busy === `${flow}:${target ?? ""}`;
  return { start, isBusy, anyBusy: busy !== null, error };
}

/** A project's issue-to-PR jobs, kept fresh by the server's shipyard_job events. */
function useJobs(projectId: string, enabled: boolean) {
  const jobs = useResource(
    () => (enabled ? jobsApi.list(projectId).then((r) => r.jobs) : Promise.resolve([])),
    [projectId, enabled],
  );
  useServerEvents((ev) => {
    if (ev.type === "shipyard_job" && ev.projectId === projectId) void jobs.reload();
  });
  return jobs;
}

function ProjectDetail({ id, tab: tabParam }: { id: string; tab: string | null }) {
  const user = useUser();
  const admin = isAdmin(user);
  const detail = useResource(() => api.getProject(id).then((r) => r.project), [id]);
  const shipyard = useResource(() => api.getShipyard().then((r) => r.status));
  const crew = useCrew();
  const project = detail.data;
  const jobs = useJobs(id, project?.provider === "github");

  if (!project) {
    return (
      <Page wide>
        <a href={href("/shipyard")} className={cx(linkClass, "text-sm")}>
          ← Shipyard
        </a>
        <div className="mt-4">
          {detail.error ? <ErrorText>{detail.error}</ErrorText> : <Muted>Loading…</Muted>}
        </div>
      </Page>
    );
  }

  const github = project.provider === "github";
  const tabs = TABS.filter((t) => (!t.github || github) && (!t.admin || admin));
  const tab: Tab = tabs.find((t) => t.id === tabParam)?.id ?? tabs[0].id;
  const crewName = crew.find((c) => c.slug === project.crewSlug)?.name ?? project.crewSlug;
  const url = repoUrl(project.repo);

  return (
    <Page wide>
      <a href={href("/shipyard")} className={cx(linkClass, "text-sm")}>
        ← Shipyard
      </a>
      <header className="mt-2 mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {url ? <ExternalLink to={url}>github.com/{project.repo}</ExternalLink> : "Local folder"}
          {" · "}
          {crewName}
          {" · "}
          {workspaceSummary(project.workspace)}
        </p>
      </header>
      <StatusBanner status={shipyard.data} />
      {admin && <ProjectActions project={project} onChange={detail.setData} />}
      <PlanFeature projectId={project.id} />
      {github && (
        <JobsBoard
          jobs={jobs.data ?? []}
          error={jobs.error}
          crew={crew}
          project={project}
          onChange={() => void jobs.reload()}
        />
      )}

      <div
        role="tablist"
        aria-label="Project sections"
        className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      >
        {tabs.map((t) => (
          <a
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            href={href(`/shipyard/${project.id}/${t.id}`)}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              focusRing,
              tab === t.id
                ? "border-accent-700 text-accent-800 dark:border-accent-400 dark:text-accent-200"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            {t.label}
          </a>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "pulls" && <PullsTab project={project} />}
        {tab === "issues" && (
          <IssuesTab
            project={project}
            crewName={crewName}
            jobs={jobs.data ?? []}
            onAssigned={() => void jobs.reload()}
          />
        )}
        {tab === "activity" && <ActivityTab projectId={project.id} />}
        {tab === "chats" && <ChatsTab projectId={project.id} />}
        {tab === "settings" && admin && (
          <SettingsTab project={project} crew={crew} onChange={detail.setData} />
        )}
      </div>
    </Page>
  );
}

function ProjectActions({
  project,
  onChange,
}: {
  project: ProjectDto;
  onChange: (p: ProjectDto) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function run(key: string, fn: () => Promise<{ project: ProjectDto }>) {
    setBusy(key);
    setError(null);
    try {
      const { project: p } = await fn();
      onChange(p);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  const sb = sandboxBadge(project.sandbox.status);
  const running = project.sandbox.status === "running";
  const cloneLabel = project.workspace.cloned ? "Fetch" : "Clone";
  const sandboxOff = project.sandbox.status === "unavailable";
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {project.provider === "github" && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void run("clone", () => api.cloneProject(project.id))}
            >
              {busy === "clone"
                ? `${cloneLabel === "Clone" ? "Cloning" : "Fetching"}…`
                : cloneLabel}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={sb.tone}>{sb.label}</Badge>
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
            {project.sandbox.image}
          </span>
          {running ? (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void run("stop", () => api.sandboxAction(project.id, "stop"))}
            >
              {busy === "stop" ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy !== null || sandboxOff}
              onClick={() => void run("start", () => api.sandboxAction(project.id, "start"))}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== null || sandboxOff || project.sandbox.status === "none"}
            title="Throw away the sandbox container and start a fresh one"
            onClick={() => {
              if (window.confirm("Reset the sandbox? Anything installed in it is lost."))
                void run("reset", () => api.sandboxAction(project.id, "reset"));
            }}
          >
            {busy === "reset" ? "Resetting…" : "Reset"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  );
}

function PlanFeature({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const flows = useFlows(projectId);
  if (!open) {
    return (
      <div className="mb-4">
        <Button variant="primary" onClick={() => setOpen(true)}>
          {FLOW_LABELS.plan}
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void flows.start("plan", { notes: notes.trim() || undefined });
        }}
        className="space-y-3"
      >
        <TextAreaField
          label="What should the crew plan?"
          rows={4}
          placeholder="Describe the feature, constraints and anything the crew should know."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
        <ErrorText>{flows.error}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={flows.anyBusy || !notes.trim()}>
            {flows.isBusy("plan") ? "Starting…" : "Start planning"}
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

type StateFilter = "open" | "closed" | "all";

function StateSelect({
  value,
  onChange,
  label,
}: {
  value: StateFilter;
  onChange: (v: StateFilter) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as StateFilter)}
        className={cx(
          "rounded-md border border-control bg-white px-2 py-1 text-sm dark:bg-slate-900",
          focusRing,
        )}
      >
        <option value="open">Open</option>
        <option value="closed">Closed</option>
        <option value="all">All</option>
      </select>
    </label>
  );
}

function NoToken({ project }: { project: ProjectDto }) {
  if (project.hasToken) return null;
  return (
    <div className="mb-3">
      <Notice>
        No GitHub token is stored for this project, so private repositories cannot be read and
        nothing can be pushed. An admin can add one under Settings.
      </Notice>
    </div>
  );
}

function PullsTab({ project }: { project: ProjectDto }) {
  const [state, setState] = useState<StateFilter>("open");
  const pulls = useResource(() => api.listPulls(project.id, state).then((r) => r.pulls), [state]);
  const flows = useFlows(project.id);
  return (
    <div>
      <NoToken project={project} />
      <div className="mb-3 flex items-center justify-between gap-2">
        <StateSelect label="Pull request state" value={state} onChange={setState} />
        <Button size="sm" variant="ghost" onClick={() => void pulls.reload()}>
          Refresh
        </Button>
      </div>
      <ErrorText>{pulls.error ?? flows.error}</ErrorText>
      {pulls.loading && !pulls.data && <Muted>Loading…</Muted>}
      {pulls.data?.length === 0 && (
        <Muted>No {state === "all" ? "" : `${state} `}pull requests.</Muted>
      )}
      <ul className="space-y-2">
        {pulls.data?.map((pr) => (
          <PullRow key={pr.number} pr={pr} flows={flows} />
        ))}
      </ul>
    </div>
  );
}

function PullRow({ pr, flows }: { pr: PullRequestDto; flows: ReturnType<typeof useFlows> }) {
  const st = prStateBadge(pr);
  const ck = checksBadge(pr.checks);
  return (
    <li>
      <Card className="p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <ExternalLink to={pr.url}>
                #{pr.number} {pr.title}
              </ExternalLink>
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <Badge tone={st.tone}>{st.label}</Badge>
              <Badge tone={ck.tone}>{ck.label}</Badge>
              <code className="truncate font-mono">{pr.branch}</code>
              <span>
                by {pr.author} · {formatTime(pr.updatedAt)}
              </span>
            </div>
          </div>
          {pr.state === "open" && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={flows.anyBusy}
                onClick={() => void flows.start("review_pr", { target: pr.number })}
              >
                {flows.isBusy("review_pr", pr.number) ? "Starting…" : "Review"}
              </Button>
              {pr.checks === "failure" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={flows.anyBusy}
                  onClick={() => void flows.start("keep_ci_green", { target: pr.number })}
                >
                  {flows.isBusy("keep_ci_green", pr.number) ? "Starting…" : "Fix CI"}
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>
    </li>
  );
}

function IssuesTab({
  project,
  crewName,
  jobs,
  onAssigned,
}: {
  project: ProjectDto;
  crewName: string;
  jobs: ShipyardJobDto[];
  onAssigned: () => void;
}) {
  const [state, setState] = useState<StateFilter>("open");
  const issues = useResource(
    () => api.listIssues(project.id, state).then((r) => r.issues),
    [state],
  );
  const flows = useFlows(project.id);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const active = activeJobsByIssue(jobs);
  async function assign(n: number) {
    setAssigning(n);
    setAssignError(null);
    try {
      await jobsApi.assign(project.id, n);
      onAssigned();
    } catch (err) {
      setAssignError(errorMessage(err));
    } finally {
      setAssigning(null);
    }
  }
  return (
    <div>
      <NoToken project={project} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <StateSelect label="Issue state" value={state} onChange={setState} />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => void issues.reload()}>
            Refresh
          </Button>
          <Button size="sm" disabled={flows.anyBusy} onClick={() => void flows.start("triage")}>
            {flows.isBusy("triage") ? "Starting…" : FLOW_LABELS.triage}
          </Button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        <strong>Assign to {crewName}</strong> works the issue through to a draft pull request,
        follows CI and fixes failures, and marks it ready for review when it is green.{" "}
        <strong>Fix</strong> starts a conversation you steer yourself.
      </p>
      <ErrorText>{issues.error ?? flows.error ?? assignError}</ErrorText>
      {issues.loading && !issues.data && <Muted>Loading…</Muted>}
      {issues.data?.length === 0 && <Muted>No {state === "all" ? "" : `${state} `}issues.</Muted>}
      <ul className="space-y-2">
        {issues.data?.map((issue) => (
          <IssueRow
            key={issue.number}
            issue={issue}
            flows={flows}
            job={active.get(issue.number) ?? null}
            crewName={crewName}
            assigning={assigning}
            onAssign={() => void assign(issue.number)}
            canAssign={project.hasToken}
          />
        ))}
      </ul>
    </div>
  );
}

function IssueRow({
  issue,
  flows,
  job,
  crewName,
  assigning,
  onAssign,
  canAssign,
}: {
  issue: IssueDto;
  flows: ReturnType<typeof useFlows>;
  job: ShipyardJobDto | null;
  crewName: string;
  assigning: number | null;
  onAssign: () => void;
  canAssign: boolean;
}) {
  const badge = job ? jobBadge(job) : null;
  return (
    <li>
      <Card className="p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <ExternalLink to={issue.url}>
                #{issue.number} {issue.title}
              </ExternalLink>
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              {issue.state === "closed" && <Badge>closed</Badge>}
              {badge && <Badge tone={badge.tone}>job: {badge.label}</Badge>}
              {issue.labels.map((l) => (
                <Badge key={l} tone="accent">
                  {l}
                </Badge>
              ))}
              <span>
                by {issue.author} · {formatTime(issue.updatedAt)}
              </span>
            </div>
          </div>
          {issue.state === "open" && (
            <div className="flex flex-wrap gap-2">
              {!job && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={assigning !== null || !canAssign}
                  title={canAssign ? undefined : "Needs a GitHub token (Settings)"}
                  onClick={onAssign}
                >
                  {assigning === issue.number ? "Assigning…" : `Assign to ${crewName}`}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={flows.anyBusy}
                onClick={() => void flows.start("fix_issue", { target: issue.number })}
              >
                {flows.isBusy("fix_issue", issue.number) ? "Starting…" : "Fix"}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </li>
  );
}

// ---------- issue-to-PR jobs ----------

function JobsBoard({
  jobs,
  error,
  crew,
  project,
  onChange,
}: {
  jobs: ShipyardJobDto[];
  error: string | null;
  crew: CrewDto[];
  project: ProjectDto;
  onChange: () => void;
}) {
  const board = jobsForBoard(jobs);
  if (!board.length && !error) return null;
  const nameOf = (slug: string | null) =>
    (slug && crew.find((c) => c.slug === slug)?.name) || slug || "the reviewer";
  return (
    <section aria-labelledby="jobs-heading" className="mb-6">
      <h2 id="jobs-heading" className="mb-2 text-sm font-semibold">
        Jobs
      </h2>
      <ErrorText>{error}</ErrorText>
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {board.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            crewName={nameOf(job.crewSlug)}
            reviewerName={nameOf(project.reviewerSlug)}
            onChange={onChange}
          />
        ))}
      </ul>
    </section>
  );
}

function JobCard({
  job,
  crewName,
  reviewerName,
  onChange,
}: {
  job: ShipyardJobDto;
  crewName: string;
  reviewerName: string;
  onChange: () => void;
}) {
  const user = useUser();
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const badge = jobBadge(job, reviewerName);
  const actions = jobActions(job, user);
  async function act(kind: "cancel" | "retry") {
    if (kind === "cancel" && !window.confirm(`Stop the job on #${job.issue.number}?`)) return;
    setBusy(kind);
    setError(null);
    try {
      await (kind === "cancel" ? jobsApi.cancel(job.id) : jobsApi.retry(job.id));
      onChange();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <li>
      <Card className="h-full p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          {job.source !== "manual" && (
            <Badge>{job.source === "label" ? "by label" : "by assignee"}</Badge>
          )}
        </div>
        <p className="mt-2 text-sm font-medium">
          {job.issue.url ? (
            <ExternalLink to={job.issue.url}>
              #{job.issue.number} {job.issue.title}
            </ExternalLink>
          ) : (
            `#${job.issue.number} ${job.issue.title}`
          )}
        </p>
        <dl className="mt-1 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          {job.pr && (
            <div className="flex gap-1.5">
              <dt>Pull request:</dt>
              <dd>
                <ExternalLink to={job.pr.url}>#{job.pr.number}</ExternalLink>
                {job.branch && <code className="ml-1.5 font-mono">{job.branch}</code>}
              </dd>
            </div>
          )}
          <div className="flex gap-1.5">
            <dt>For:</dt>
            <dd>
              {job.user.name} · {crewName} · {formatTime(job.updatedAt)}
            </dd>
          </div>
        </dl>
        {job.detail && (
          <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{job.detail}</p>
        )}
        <ErrorText>{error}</ErrorText>
        {(job.conversationId || actions.cancel || actions.retry) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {job.conversationId && (
              <a href={href(`/bridge/${job.conversationId}`)} className={cx(linkClass, "text-sm")}>
                Open conversation
              </a>
            )}
            {actions.retry && (
              <Button size="sm" disabled={busy !== null} onClick={() => void act("retry")}>
                {busy === "retry" ? "Starting…" : "Try again"}
              </Button>
            )}
            {actions.cancel && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void act("cancel")}
              >
                {busy === "cancel" ? "Stopping…" : "Cancel"}
              </Button>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

function ActivityTab({ projectId }: { projectId: string }) {
  const events = useResource(() => api.listProjectEvents(projectId, 50).then((r) => r.events));
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => void events.reload()}>
          Refresh
        </Button>
      </div>
      <ErrorText>{events.error}</ErrorText>
      {events.loading && !events.data && <Muted>Loading…</Muted>}
      {events.data?.length === 0 && (
        <Muted>
          No activity yet. Events arrive from GitHub once the webhook is set up (see Settings).
        </Muted>
      )}
      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
        {events.data?.map((ev) => (
          <li key={ev.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
            <span className="w-20 shrink-0 text-xs text-slate-500 dark:text-slate-400">
              {formatTime(ev.createdAt)}
            </span>
            <Badge>{ev.kind.replace(/_/g, " ")}</Badge>
            <span className="min-w-0 flex-1 text-sm">{ev.summary}</span>
            {ev.conversationId && (
              <a href={href(`/bridge/${ev.conversationId}`)} className={cx(linkClass, "text-xs")}>
                Open conversation
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChatsTab({ projectId }: { projectId: string }) {
  const conversations = useResource(() =>
    api.listConversations().then((r) => r.conversations.filter((c) => c.projectId === projectId)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await api.createProjectConversation(projectId);
      navigate(`/bridge/${conversation.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void create()}>
          {busy ? "Starting…" : "New chat"}
        </Button>
      </div>
      <ErrorText>{conversations.error ?? error}</ErrorText>
      {conversations.loading && !conversations.data && <Muted>Loading…</Muted>}
      {conversations.data?.length === 0 && (
        <Muted>No chats about this project yet. Flows you start appear here too.</Muted>
      )}
      <ul className="space-y-1">
        {conversations.data?.map((c) => (
          <li key={c.id}>
            <a
              href={href(`/bridge/${c.id}`)}
              className={cx(
                "flex items-baseline justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800",
                focusRing,
              )}
            >
              <span className="truncate text-sm font-medium">{c.title ?? "Untitled chat"}</span>
              <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                {formatTime(c.updatedAt)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsTab({
  project,
  crew,
  onChange,
}: {
  project: ProjectDto;
  crew: CrewDto[];
  onChange: (p: ProjectDto) => void;
}) {
  const [name, setName] = useState(project.name);
  const [crewSlug, setCrewSlug] = useState(project.crewSlug);
  const [defaultBranch, setDefaultBranch] = useState(project.defaultBranch ?? "");
  const [sandboxImage, setSandboxImage] = useState(project.sandbox.image);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changes = projectChanges(project, { name, crewSlug, defaultBranch, sandboxImage });
  const dirty = Object.keys(changes).length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { project: p } = await api.updateProject(project.id, changes);
      onChange(p);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="mb-4 font-semibold">Project</h2>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <CrewSelect crew={crew} value={crewSlug} onChange={setCrewSlug} />
            <TextField
              label="Default branch"
              value={defaultBranch}
              placeholder="main"
              onChange={(e) => setDefaultBranch(e.target.value)}
            />
            <TextField
              label="Sandbox image"
              value={sandboxImage}
              onChange={(e) => setSandboxImage(e.target.value)}
              hint="Takes effect the next time the sandbox starts (or after Reset)."
            />
          </div>
          <ErrorText>{error}</ErrorText>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {saved && !dirty && (
              <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
            )}
          </div>
        </form>
      </Card>
      {project.provider === "github" && <TokenCard project={project} onChange={onChange} />}
      {project.provider === "github" && (
        <JobSettingsCard project={project} crew={crew} onChange={onChange} />
      )}
      {project.provider === "github" && <WebhookCard project={project} onChange={onChange} />}
      <DeleteCard project={project} />
    </div>
  );
}

function TokenCard({
  project,
  onChange,
}: {
  project: ProjectDto;
  onChange: (p: ProjectDto) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(value: string) {
    setBusy(true);
    setError(null);
    try {
      const { project: p } = await api.updateProject(project.id, { token: value });
      onChange(p);
      setToken("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="mb-1 font-semibold">GitHub token</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {project.hasToken ? "A token is stored." : "No token is stored."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) void save(token.trim());
        }}
        className="space-y-3"
      >
        <TextField
          label={project.hasToken ? "Replace token" : "Token"}
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          hint={TOKEN_HINT}
        />
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" disabled={busy || !token.trim()}>
            {busy ? "Saving…" : project.hasToken ? "Replace token" : "Save token"}
          </Button>
          {project.hasToken && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Clear the stored token? The crew loses GitHub access."))
                  void save("");
              }}
            >
              Clear token
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

function JobSettingsCard({
  project,
  crew,
  onChange,
}: {
  project: ProjectDto;
  crew: CrewDto[];
  onChange: (p: ProjectDto) => void;
}) {
  const [form, setForm] = useState<JobSettingsForm>(() => jobSettingsForm(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = <K extends keyof JobSettingsForm>(k: K, v: string) => {
    setForm({ ...form, [k]: v });
    setSaved(false);
  };
  const changes = jobSettingsChanges(project, form);
  const dirty = typeof changes === "string" || Object.keys(changes).length > 0;
  const reviewers = workers(crew).filter((c) => c.slug !== project.crewSlug);
  const ownerName = crew.find((c) => c.slug === project.crewSlug)?.name ?? project.crewSlug;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (typeof changes === "string") {
      setError(changes);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project: p } = await api.updateProject(project.id, changes);
      onChange(p);
      setForm(jobSettingsForm(p));
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Issue-to-PR jobs</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Assigned issues are worked by {ownerName} into a draft pull request. Shipmate follows CI,
        hands failures back to fix, and marks the pull request ready for review when it is green.
      </p>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Reviewer"
            value={form.reviewerSlug}
            onChange={(e) => set("reviewerSlug", e.target.value)}
            hint="Reviews each pull request once CI is green and posts the review on GitHub; blocking findings go back to be fixed before it is marked ready."
          >
            <option value="">No crew review</option>
            {reviewers.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name} ({c.role})
              </option>
            ))}
          </SelectField>
          <TextField
            label="Fix attempts for failing CI"
            type="number"
            min={0}
            max={10}
            value={form.maxFixAttempts}
            onChange={(e) => set("maxFixAttempts", e.target.value)}
            hint="After this many pushed fixes the job gives up and leaves it to you."
          />
          <TextField
            label="Start a job when an issue gets this label (optional)"
            placeholder="e.g. shipwright"
            value={form.triggerLabel}
            onChange={(e) => set("triggerLabel", e.target.value)}
          />
          <TextField
            label="…or is assigned to this GitHub user (optional)"
            placeholder="e.g. my-shipmate-bot"
            value={form.triggerAssignee}
            onChange={(e) => set("triggerAssignee", e.target.value)}
          />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {project.triggerUser && (project.triggerLabel || project.triggerAssignee)
            ? `Automatic jobs run as ${project.triggerUser.name}: their approvals, their usage. `
            : "Automatic jobs run as whoever saves a trigger here. "}
          Pushing and opening pull requests still ask for approval unless that person chose "Always
          allow".
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {saved && !dirty && (
            <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
          )}
        </div>
      </form>
    </Card>
  );
}

function WebhookCard({
  project,
  onChange,
}: {
  project: ProjectDto;
  onChange: (p: ProjectDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function rotate() {
    if (
      !window.confirm(
        "Make a new secret? GitHub's deliveries fail until you paste the new one into the webhook.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      onChange((await jobsApi.rotateWebhookSecret(project.id)).project);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">GitHub webhook</h2>
        {project.webhookLastDeliveryAt ? (
          <Badge tone="ok">last delivery {formatTime(project.webhookLastDeliveryAt)}</Badge>
        ) : (
          <Badge tone="warn">not set up: polling</Badge>
        )}
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Lets the crew react as things happen: new and labelled issues start jobs, failed CI goes
        back to be fixed, and comments and reviews reach the conversation that opened the pull
        request. Watches can run on these events too. Without a webhook, Shipmate checks GitHub
        every minute for jobs and their CI instead.
      </p>
      {project.webhookUrl ? (
        <div className="space-y-4">
          <CopyField label="Payload URL" value={project.webhookUrl} />
          {project.webhookSecret && (
            <CopyField
              label="Secret"
              value={project.webhookSecret}
              hint="Keep it private: every delivery is signed with it (X-Hub-Signature-256) and unsigned ones are refused."
            />
          )}
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
            <li>
              On GitHub, open the repository's{" "}
              {project.repo ? (
                <ExternalLink to={`https://github.com/${project.repo}/settings/hooks/new`}>
                  Settings → Webhooks → Add webhook
                </ExternalLink>
              ) : (
                "Settings → Webhooks → Add webhook"
              )}
              .
            </li>
            <li>Paste the payload URL and the secret above.</li>
            <li>
              Set <strong>Content type</strong> to{" "}
              <code className="font-mono">application/json</code>.
            </li>
            <li>
              Choose <strong>Let me select individual events</strong> and tick: Issues, Issue
              comments, Pull requests, Pull request reviews, Pull request review comments, Check
              suites, Check runs, Workflow runs, Statuses, and Pushes (for watches).
            </li>
            <li>Save. GitHub sends a ping; it shows up under Activity.</li>
          </ol>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            GitHub must be able to reach this URL, so Shipmate needs a public address (or a tunnel).
            Polling keeps jobs going without one.
          </p>
          <ErrorText>{error}</ErrorText>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void rotate()}>
            {busy ? "Making a new secret…" : "New secret"}
          </Button>
        </div>
      ) : (
        <Muted>The server did not report a webhook URL for this project.</Muted>
      )}
    </Card>
  );
}

function DeleteCard({ project }: { project: ProjectDto }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (
      !window.confirm(
        `Delete "${project.name}"? The sandbox is removed; the workspace folder stays on disk.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteProject(project.id);
      navigate("/shipyard");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Delete project</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Removes the project and its sandbox. The workspace folder on disk is kept.
      </p>
      <ErrorText>{error}</ErrorText>
      <Button variant="danger" disabled={busy} onClick={() => void remove()}>
        {busy ? "Deleting…" : "Delete project"}
      </Button>
    </Card>
  );
}
