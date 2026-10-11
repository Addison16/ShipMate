import type { CrewDetailDto, CrewDto, MemoryEntryDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import { Avatar } from "../components/Avatar.js";
import { CrewBackendSelect } from "../components/ClaudeCliCard.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { StarterCrewPicker } from "../components/StarterCrewPicker.js";
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
  TextAreaField,
  TextField,
} from "../components/ui.js";
import { formatTime } from "../lib/format.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { useServerEvents } from "../ws.js";

export function CrewPage({ slug }: { slug: string | null }) {
  if (slug === "new") return <NewCrew />;
  if (slug === "starters") return <StarterCrew />;
  if (slug) return <CrewDetail key={slug} slug={slug} />;
  return <CrewList />;
}

function StatusBadges({ crew }: { crew: CrewDto }) {
  return (
    <>
      {crew.captain && <Badge tone="accent">captain</Badge>}
      {crew.status === "pending_review" && <Badge tone="warn">pending review</Badge>}
      {crew.status === "retired" && <Badge>retired</Badge>}
      {crew.visibility === "private" && <Badge>private</Badge>}
    </>
  );
}

function CrewList() {
  const user = useUser();
  const [showRetired, setShowRetired] = useState(false);
  const crew = useResource(() => api.listCrew(showRetired).then((r) => r.crew), [showRetired]);
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void crew.reload();
  });

  return (
    <Page wide>
      <PageHeader
        title="Crew"
        description="Each crew member is a folder with a persona, a manifest and its own memory."
        actions={
          isAdmin(user) && (
            <>
              <Button onClick={() => navigate("/crew/starters")}>Add starter crew</Button>
              <Button variant="primary" onClick={() => navigate("/crew/new")}>
                New crew member
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 flex items-center gap-2 text-sm">
        <input
          id="show-retired"
          type="checkbox"
          checked={showRetired}
          onChange={(e) => setShowRetired(e.target.checked)}
          className="size-4 accent-accent-700"
        />
        <label htmlFor="show-retired">Show retired</label>
      </div>
      <ErrorText>{crew.error}</ErrorText>
      {crew.data?.length === 0 && <Muted>No crew yet.</Muted>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {crew.data?.map((c) => (
          <li key={c.slug}>
            <a
              href={href(`/crew/${c.slug}`)}
              className={cx(
                "block h-full rounded-xl border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-accent-600/50 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-accent-400/50",
                focusRing,
              )}
            >
              <div className="flex items-start gap-3">
                <Avatar name={c.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{c.name}</span>
                    <StatusBadges crew={c} />
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{c.role}</p>
                  <p className="mt-3 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                    {c.model}
                  </p>
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Page>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function NewCrew() {
  const user = useUser();
  const models = useResource(() => api.listModels().then((r) => r.models));
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [persona, setPersona] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!model && models.data) {
      const first = models.data.find((m) => m.available);
      if (first) setModel(first.ref);
    }
  }, [models.data, model]);

  if (!isAdmin(user)) {
    return (
      <Page>
        <Muted>Only owners and admins can recruit crew members.</Muted>
      </Page>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { crew } = await api.createCrew({
        slug: slug.trim(),
        name: name.trim(),
        role: role.trim(),
        model: model || undefined,
        persona,
      });
      navigate(`/crew/${crew.slug}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <a
        href={href("/crew")}
        className="text-sm text-accent-700 hover:underline dark:text-accent-300"
      >
        ← Crew
      </a>
      <PageHeader title="New crew member" />
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Name"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugEdited) setSlug(slugify(e.target.value));
              }}
            />
            <TextField
              label="Slug"
              required
              pattern="[a-z0-9][a-z0-9\-]{0,39}"
              hint="Lowercase letters, digits and dashes. Used as the folder name."
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
            />
          </div>
          <TextField
            label="Role"
            required
            placeholder="e.g. meal planning and groceries"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
          <ModelSelect value={model} onChange={setModel} models={models.data} />
          <TextAreaField
            label="Persona (CREW.md)"
            mono
            rows={12}
            required
            placeholder="Who this crew member is and how it should work."
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
          />
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Recruiting…" : "Recruit"}
            </Button>
            <Button onClick={() => navigate("/crew")}>Cancel</Button>
          </div>
        </form>
      </Card>
    </Page>
  );
}

function StarterCrew() {
  const user = useUser();
  const [notes, setNotes] = useState<string[] | null>(null);
  if (!isAdmin(user)) {
    return (
      <Page>
        <Muted>Only owners and admins can bring crew aboard.</Muted>
      </Page>
    );
  }
  return (
    <Page>
      <a
        href={href("/crew")}
        className="text-sm text-accent-700 hover:underline dark:text-accent-300"
      >
        ← Crew
      </a>
      <PageHeader
        title="Starter crew"
        description="Ready-made crew members with a persona, the MCP servers they need and a starter watch. They use the default model from Settings."
      />
      <Card>
        {notes ? (
          <div className="space-y-3">
            <p className="text-sm">The new crew members are aboard.</p>
            {notes.map((n) => (
              <Notice key={n}>{n}</Notice>
            ))}
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => navigate("/crew")}>
                See the crew
              </Button>
              <Button onClick={() => navigate("/watches")}>Watches</Button>
            </div>
          </div>
        ) : (
          <StarterCrewPicker onDone={(r) => setNotes(r.notes)} />
        )}
      </Card>
    </Page>
  );
}

type Tab = "persona" | "manifest" | "memory";

function CrewDetail({ slug }: { slug: string }) {
  const user = useUser();
  const admin = isAdmin(user);
  const detail = useResource(() => api.getCrew(slug).then((r) => r.crew), [slug]);
  const [tab, setTab] = useState<Tab>("persona");
  const [actionError, setActionError] = useState<string | null>(null);
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void detail.reload();
  });

  const crew = detail.data;

  async function approve() {
    setActionError(null);
    try {
      const { crew: c } = await api.approveCrew(slug);
      detail.setData(c);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  async function retire() {
    if (!crew || !window.confirm(`Retire ${crew.name}? Their folder is kept on disk.`)) return;
    setActionError(null);
    try {
      await api.retireCrew(slug);
      navigate("/crew");
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "persona", label: "Persona" },
    { id: "manifest", label: "Manifest" },
    { id: "memory", label: "Memory" },
  ];

  return (
    <Page wide>
      <a
        href={href("/crew")}
        className="text-sm text-accent-700 hover:underline dark:text-accent-300"
      >
        ← Crew
      </a>
      {detail.error && !crew && <ErrorText>{detail.error}</ErrorText>}
      {!crew && !detail.error && <Muted>Loading…</Muted>}
      {crew && (
        <>
          <header className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-4">
              <Avatar name={crew.name} size="lg" />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{crew.name}</h1>
                  <StatusBadges crew={crew} />
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{crew.role}</p>
                <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {crew.slug} · {crew.model}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {admin && crew.status === "pending_review" && (
                <Button variant="primary" onClick={() => void approve()}>
                  Approve
                </Button>
              )}
              {admin && !crew.captain && crew.status !== "retired" && (
                <Button variant="danger" onClick={() => void retire()}>
                  Retire
                </Button>
              )}
            </div>
          </header>
          {crew.status === "pending_review" && (
            <div className="mb-4">
              <Notice>
                This crew member was recruited by the coordinator and is waiting for review. Read
                the persona and manifest, then approve it to put it to work.
              </Notice>
            </div>
          )}
          <ErrorText>{actionError}</ErrorText>
          <div
            role="tablist"
            aria-label="Crew member sections"
            className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800"
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cx(
                  "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                  focusRing,
                  tab === t.id
                    ? "border-accent-700 text-accent-800 dark:border-accent-400 dark:text-accent-200"
                    : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "persona" && (
              <FileEditor
                key="persona"
                label="CREW.md"
                initial={crew.persona}
                readOnly={!admin}
                onSave={(v) => api.updateCrew(slug, { persona: v })}
                onSaved={detail.setData}
              />
            )}
            {tab === "manifest" && (
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                Tool approvals are set here: <code className="font-mono">approval</code> (ask, auto,
                or <code className="font-mono">never-for</code> a list of tools) and{" "}
                <code className="font-mono">allow</code>, the tools this crew member may run without
                asking. "Always allow" on an approval card adds to that list.
              </p>
            )}
            {tab === "persona" && (
              <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
                The approval policy and allow list are edited in the Manifest tab.
              </p>
            )}
            {tab === "manifest" && (
              <CrewBackendSelect crew={crew} readOnly={!admin} onSaved={detail.setData} />
            )}
            {tab === "manifest" && (
              <FileEditor
                key="manifest"
                label="crew.yaml"
                initial={crew.manifestYaml}
                readOnly={!admin}
                onSave={(v) => api.updateCrew(slug, { manifestYaml: v })}
                onSaved={detail.setData}
              />
            )}
            {tab === "memory" && <MemoryPanel slug={slug} admin={admin} />}
          </div>
        </>
      )}
    </Page>
  );
}

function FileEditor({
  label,
  initial,
  readOnly,
  onSave,
  onSaved,
}: {
  label: string;
  initial: string;
  readOnly: boolean;
  onSave: (value: string) => Promise<{ crew: CrewDetailDto }>;
  onSaved: (crew: CrewDetailDto) => void;
}) {
  const [value, setValue] = useState(initial);
  const [base, setBase] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = value !== base;

  // Pick up outside changes (e.g. the coordinator edited the file) when nothing is pending.
  useEffect(() => {
    if (!dirty) {
      setValue(initial);
      setBase(initial);
    }
  }, [initial, dirty]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { crew } = await onSave(value);
      setBase(value);
      setSaved(true);
      onSaved(crew);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <TextAreaField
        label={label}
        mono
        rows={22}
        readOnly={readOnly}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
      />
      <ErrorText>{error}</ErrorText>
      {readOnly ? (
        <Muted>Only owners and admins can edit crew files.</Muted>
      ) : (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button disabled={!dirty || busy} onClick={() => setValue(base)}>
            Revert
          </Button>
          {saved && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>}
        </div>
      )}
    </form>
  );
}

function MemoryPanel({ slug, admin }: { slug: string; admin: boolean }) {
  const memory = useResource(() => api.crewMemory(slug), [slug]);
  const [error, setError] = useState<string | null>(null);

  async function remove(entry: MemoryEntryDto) {
    if (!window.confirm(`Forget "${entry.name}"?`)) return;
    setError(null);
    try {
      await api.deleteMemory(slug, entry.scope, entry.name);
      await memory.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const section = (title: string, entries: MemoryEntryDto[], canDelete: boolean, empty: string) => (
    <Card>
      <h2 className="mb-3 font-semibold">{title}</h2>
      {entries.length === 0 ? (
        <Muted>{empty}</Muted>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {entries.map((m) => (
            <li key={`${m.scope}:${m.name}`} className="py-2">
              <div className="flex items-start justify-between gap-3">
                <details className="min-w-0 flex-1">
                  <summary className={cx("cursor-pointer rounded", focusRing)}>
                    <span className="font-mono text-sm">{m.name}</span>
                    {m.description && (
                      <span className="ml-2 text-sm text-slate-500 dark:text-slate-400">
                        {m.description}
                      </span>
                    )}
                  </summary>
                  <pre className="mt-2 rounded bg-slate-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-slate-800/60">
                    {m.body}
                  </pre>
                  <p className="mt-1 text-xs text-slate-500">Updated {formatTime(m.updatedAt)}</p>
                </details>
                {canDelete && (
                  <Button size="sm" variant="danger" onClick={() => void remove(m)}>
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );

  return (
    <div className="space-y-4">
      <ErrorText>{memory.error ?? error}</ErrorText>
      {memory.loading && !memory.data && <Muted>Loading…</Muted>}
      {memory.data && (
        <>
          {section(
            "Shared memory",
            memory.data.shared,
            admin,
            "Nothing remembered for everyone yet.",
          )}
          {section("About you", memory.data.mine, true, "Nothing remembered about you yet.")}
        </>
      )}
    </div>
  );
}
