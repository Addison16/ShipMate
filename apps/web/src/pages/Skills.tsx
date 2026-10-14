import type { CrewDto, SkillDto, SkillScope } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useCrewName, useThemeText } from "../appearance.js";
import { useUser } from "../auth.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Loading,
  Muted,
  Notice,
  Page,
  PageHeader,
  SelectField,
  TextAreaField,
} from "../components/ui.js";
import { formatTime } from "../lib/format.js";
import {
  canManageSkill,
  creatableScopes,
  groupSkills,
  SKILL_TEMPLATE,
  skillAuthor,
} from "../lib/skills.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { useServerEvents } from "../ws.js";

const SCOPE_LABEL: Record<SkillScope, string> = {
  instance: "Instance (everyone, every crew member)",
  crew: "Crew (one crew member)",
  user: "Mine (only my sessions)",
};

export function SkillsPage({ skillId }: { skillId: string | null }) {
  if (skillId === "new") return <NewSkill />;
  if (skillId) return <SkillDetail key={skillId} id={skillId} />;
  return <SkillList />;
}

function useCrewNames() {
  const crewName = useCrewName();
  const crew = useResource(() => api.listCrew(true).then((r) => r.crew));
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void crew.reload();
  });
  const names: Record<string, string> = {};
  for (const c of crew.data ?? []) names[c.slug] = crewName(c.name);
  return { crew: crew.data ?? [], names };
}

function SkillStatus({ skill }: { skill: SkillDto }) {
  return skill.status === "pending" ? (
    <Badge tone="warn">pending approval</Badge>
  ) : (
    <Badge tone="ok">active</Badge>
  );
}

function SkillList() {
  const user = useUser();
  const t = useThemeText();
  const skills = useResource(() => api.listSkills().then((r) => r.skills));
  const { names } = useCrewNames();
  const [error, setError] = useState<string | null>(null);
  useServerEvents((ev) => {
    if (ev.type === "skills_changed") void skills.reload();
  });

  async function approve(s: SkillDto) {
    setError(null);
    try {
      await api.approveSkill(s.id);
      await skills.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const groups = groupSkills(skills.data ?? []);
  const pendingCount = (skills.data ?? []).filter((s) => s.status === "pending").length;

  const list = (items: SkillDto[]) => (
    <ul className="divide-y divide-slate-200 dark:divide-slate-800">
      {items.map((s) => (
        <li
          key={s.id}
          className={cx(
            "flex flex-wrap items-start justify-between gap-3 py-3",
            s.status === "pending" && "-mx-2 rounded-md bg-amber-50 px-2 dark:bg-amber-950/30",
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={href(`/skills/${encodeURIComponent(s.id)}`)}
                className={cx(
                  "rounded font-mono text-sm font-medium text-accent-800 hover:underline dark:text-accent-300",
                  focusRing,
                )}
              >
                {s.name}
              </a>
              <SkillStatus skill={s} />
            </div>
            {s.description && (
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">{s.description}</p>
            )}
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Written by {skillAuthor(s, user.id, names)} · updated {formatTime(s.updatedAt)}
            </p>
          </div>
          {s.status === "pending" && canManageSkill(s, user) && (
            <Button size="sm" variant="primary" onClick={() => void approve(s)}>
              Approve
            </Button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Page wide>
      <PageHeader
        icon="skills"
        title="Skills"
        description={t(
          "Reusable instructions crew members load when a task calls for them. Skills a crew member writes itself wait for approval before they are used.",
        )}
        actions={
          <Button variant="primary" onClick={() => navigate("/skills/new")}>
            New skill
          </Button>
        }
      />
      <div className="space-y-4">
        {pendingCount > 0 && (
          <Notice>
            {pendingCount} {pendingCount === 1 ? "skill is" : "skills are"} waiting for approval.
            Read {pendingCount === 1 ? "it" : "them"} before approving.
          </Notice>
        )}
        <ErrorText>{skills.error ?? error}</ErrorText>
        {skills.loading && !skills.data && <Loading />}
        {skills.data && (
          <>
            <Card>
              <h2 className="mb-1 font-semibold">Instance</h2>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                {t("Available to every crew member for everyone.")}
              </p>
              {groups.instance.length ? list(groups.instance) : <Muted>None yet.</Muted>}
            </Card>
            <Card>
              <h2 className="mb-1 font-semibold">{t("Crew")}</h2>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                {t("Private to one crew member.")}
              </p>
              {groups.crew.length === 0 && <Muted>None yet.</Muted>}
              <div className="space-y-4">
                {groups.crew.map((g) => (
                  <div key={g.slug}>
                    <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200">
                      <a
                        href={href(`/crew/${g.slug}`)}
                        className={cx("rounded hover:underline", focusRing)}
                      >
                        {names[g.slug] ?? g.slug}
                      </a>
                    </h3>
                    {list(g.skills)}
                  </div>
                ))}
              </div>
            </Card>
            <Card>
              <h2 className="mb-1 font-semibold">Mine</h2>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Loaded only in your own sessions.
              </p>
              {groups.mine.length ? list(groups.mine) : <Muted>None yet.</Muted>}
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}

function NewSkill() {
  const user = useUser();
  const t = useThemeText();
  const crewName = useCrewName();
  const scopes = creatableScopes(user);
  const { crew } = useCrewNames();
  const [scope, setScope] = useState<SkillScope>("user");
  const [crewSlug, setCrewSlug] = useState("");
  const [content, setContent] = useState(SKILL_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeCrew = crew.filter((c: CrewDto) => c.status !== "retired");

  useEffect(() => {
    if (!crewSlug && activeCrew[0]) setCrewSlug(activeCrew[0].slug);
  }, [crewSlug, activeCrew]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { skill } = await api.createSkill({
        scope,
        crewSlug: scope === "crew" ? crewSlug : undefined,
        content,
      });
      navigate(`/skills/${encodeURIComponent(skill.id)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <a
        href={href("/skills")}
        className="text-sm text-accent-700 hover:underline dark:text-accent-300"
      >
        ← Skills
      </a>
      <PageHeader title="New skill" />
      <Card>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as SkillScope)}
              hint={
                scopes.length === 1
                  ? t("Only owners and admins can add skills for a crew member or the instance.")
                  : undefined
              }
            >
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {t(SCOPE_LABEL[s])}
                </option>
              ))}
            </SelectField>
            {scope === "crew" && (
              <SelectField
                label={t("Crew member")}
                required
                value={crewSlug}
                onChange={(e) => setCrewSlug(e.target.value)}
              >
                {activeCrew.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {crewName(c.name)}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
          <TextAreaField
            label="SKILL.md"
            mono
            rows={18}
            required
            hint={t(
              "The name and description in the frontmatter are required. The description tells crew members when to use it.",
            )}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Creating…" : "Create skill"}
            </Button>
            <Button onClick={() => navigate("/skills")}>Cancel</Button>
          </div>
        </form>
      </Card>
    </Page>
  );
}

function SkillDetail({ id }: { id: string }) {
  const user = useUser();
  const t = useThemeText();
  const detail = useResource(() => api.getSkill(id).then((r) => r.skill), [id]);
  const { names } = useCrewNames();
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useServerEvents((ev) => {
    if (ev.type === "skills_changed" && value === null) void detail.reload();
  });

  const skill = detail.data;
  const canManage = skill ? canManageSkill(skill, user) : false;
  const text = value ?? skill?.content ?? "";
  const dirty = value !== null && value !== skill?.content;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { skill: s } = await api.updateSkill(id, text);
      detail.setData(s);
      setValue(null);
      setSaved(true);
      // Renaming in the frontmatter can change the id.
      if (s.id !== id) navigate(`/skills/${encodeURIComponent(s.id)}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    setError(null);
    try {
      const { skill: s } = await api.approveSkill(id);
      detail.setData(s);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove() {
    if (!skill || !window.confirm(`Delete the skill "${skill.name}"? This cannot be undone.`))
      return;
    setError(null);
    try {
      await api.deleteSkill(id);
      navigate("/skills");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const scopeLine = skill
    ? skill.scope === "instance"
      ? "Instance"
      : skill.scope === "user"
        ? "Mine"
        : `${t("Crew")}: ${names[skill.crewSlug ?? ""] ?? skill.crewSlug}`
    : "";

  return (
    <Page wide>
      <a
        href={href("/skills")}
        className="text-sm text-accent-700 hover:underline dark:text-accent-300"
      >
        ← Skills
      </a>
      {detail.error && !skill && <ErrorText>{detail.error}</ErrorText>}
      {!skill && !detail.error && <Loading />}
      {skill && (
        <>
          <header className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-mono text-2xl font-semibold tracking-tight">{skill.name}</h1>
                <SkillStatus skill={skill} />
              </div>
              {skill.description && (
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  {skill.description}
                </p>
              )}
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {scopeLine} · written by {skillAuthor(skill, user.id, names)} · updated{" "}
                {formatTime(skill.updatedAt)}
              </p>
            </div>
            {canManage && (
              <div className="flex flex-wrap gap-2">
                {skill.status === "pending" && (
                  <Button variant="primary" onClick={() => void approve()}>
                    Approve
                  </Button>
                )}
                <Button variant="danger" onClick={() => void remove()}>
                  Delete
                </Button>
              </div>
            )}
          </header>
          {skill.status === "pending" && (
            <div className="mb-4">
              <Notice>
                {t(
                  "A crew member wrote this skill. It is not loaded until it is approved; read it first.",
                )}
              </Notice>
            </div>
          )}
          <form onSubmit={save} className="space-y-3">
            <TextAreaField
              label="SKILL.md"
              mono
              rows={24}
              readOnly={!canManage}
              value={text}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
            />
            <ErrorText>{error}</ErrorText>
            {canManage ? (
              <div className="flex items-center gap-3">
                <Button type="submit" variant="primary" disabled={!dirty || busy}>
                  {busy ? "Saving…" : "Save"}
                </Button>
                <Button disabled={!dirty || busy} onClick={() => setValue(null)}>
                  Revert
                </Button>
                {saved && (
                  <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
                )}
              </div>
            ) : (
              <Muted>
                {skill.scope === "user"
                  ? "Only the person who owns this skill can change it."
                  : t("Only owners and admins can change skills for crew members or the instance.")}
              </Muted>
            )}
          </form>
        </>
      )}
    </Page>
  );
}
