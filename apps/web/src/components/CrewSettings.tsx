import type { CrewDetailDto, McpServerDto, ModelOption, SkillDto } from "@shipmate/core";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { api, errorMessage } from "../api.js";
import {
  type ApprovalMode,
  applyManifestForm,
  approvalToolChoices,
  BUILTIN_TOOLS,
  type Choice,
  CLI_TOOL_GROUPS,
  cleanList,
  type Engine,
  hasToolGroup,
  type ManifestForm,
  otherCliTools,
  PERMISSION_MODES,
  type PermissionMode,
  readManifestForm,
  setToolGroup,
  switchEngine,
} from "../lib/crew-manifest.js";
import { CLAUDE_CODE_PROVIDER, providerOf } from "../lib/models.js";
import { useResource } from "../lib/useResource.js";
import { ModelSelect } from "./ModelSelect.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  SelectField,
  TextAreaField,
  TextField,
} from "./ui.js";

type Mode = "form" | "file";

/**
 * Crew → Settings: every crew.yaml field as a form, with "Edit file" to switch to the raw YAML.
 * Both views edit the same draft; switching back to the form re-reads the file, and the form
 * only rewrites the lines it changed, so comments and unknown keys survive.
 */
export function CrewSettings({
  crew,
  models,
  crewDefault,
  claudeCode,
  readOnly,
  onSaved,
}: {
  crew: CrewDetailDto;
  models: ModelOption[] | null;
  /** The crew default model from Settings, which `model: default` means. */
  crewDefault: string;
  /** Whether Claude Code is signed in, so its models can be offered. */
  claudeCode: boolean;
  readOnly: boolean;
  onSaved: (crew: CrewDetailDto) => void;
}) {
  const saved = crew.manifestYaml;
  const initial = readManifestForm(saved);
  const [mode, setMode] = useState<Mode>(initial.ok ? "form" : "file");
  // The YAML the form's values are applied on top of; always valid while in form mode.
  const [source, setSource] = useState(saved);
  const [form, setForm] = useState<ManifestForm | null>(initial.ok ? initial.form : null);
  const [text, setText] = useState(saved);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const current = mode === "form" && form ? applyManifestForm(source, form) : text;
  const dirty = current !== saved;
  const check = readManifestForm(current);

  // Pick up outside changes (e.g. the Captain edited the file) when nothing is pending.
  useEffect(() => {
    if (dirty) return;
    const next = readManifestForm(saved);
    setSource(saved);
    setText(saved);
    setForm(next.ok ? next.form : null);
    if (!next.ok) setMode("file");
  }, [saved, dirty]);

  function reset() {
    const next = readManifestForm(saved);
    setSource(saved);
    setText(saved);
    setForm(next.ok ? next.form : null);
    setMode(next.ok ? mode : "file");
    setSwitchError(null);
    setError(null);
  }

  function switchTo(next: Mode) {
    if (next === mode) return;
    setSwitchError(null);
    if (next === "file") {
      setText(current);
      setMode("file");
      return;
    }
    const parsed = readManifestForm(text);
    if (!parsed.ok) {
      setSwitchError(`Fix the file first: ${parsed.error}`);
      return;
    }
    setSource(text);
    setForm(parsed.form);
    setMode("form");
  }

  function patch(p: Partial<ManifestForm>) {
    setForm((f) => (f ? { ...f, ...p } : f));
    setJustSaved(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setJustSaved(false);
    try {
      const res = await api.updateCrew(crew.slug, { manifestYaml: current });
      setSource(current);
      setText(current);
      setJustSaved(true);
      onSaved(res.crew);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
          These settings live in this crew member's <code className="font-mono">crew.yaml</code>.
          Change them here, or edit the file directly; both stay in step.
        </p>
        <fieldset className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-600">
          <legend className="sr-only">How to edit</legend>
          {(
            [
              ["form", "Settings"],
              ["file", "Edit file"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              onClick={() => switchTo(id)}
              className={cx(
                "rounded px-3 py-1 text-sm font-medium",
                focusRing,
                mode === id
                  ? "bg-accent-700 text-white dark:bg-accent-600"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white",
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <ErrorText>{switchError}</ErrorText>

      {mode === "form" && form ? (
        <ManifestFields
          crew={crew}
          form={form}
          models={models}
          crewDefault={crewDefault}
          claudeCode={claudeCode}
          readOnly={readOnly}
          patch={patch}
        />
      ) : (
        <TextAreaField
          label="crew.yaml"
          mono
          rows={22}
          readOnly={readOnly}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSwitchError(null);
            setJustSaved(false);
          }}
        />
      )}

      {dirty && !check.ok && !switchError && <ErrorText>{check.error}</ErrorText>}
      <ErrorText>{error}</ErrorText>
      {readOnly ? (
        <Muted>Only owners and admins can change crew settings.</Muted>
      ) : (
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!dirty || !check.ok || busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button disabled={!dirty || busy} onClick={reset}>
            Revert
          </Button>
          {justSaved && !dirty && (
            <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
          )}
        </div>
      )}
    </form>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <h2 className="font-semibold">{title}</h2>
      {description && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{description}</p>
      )}
      <div className="mt-4 space-y-4">{children}</div>
    </Card>
  );
}

function ManifestFields({
  crew,
  form,
  models,
  crewDefault,
  claudeCode,
  readOnly,
  patch,
}: {
  crew: CrewDetailDto;
  form: ManifestForm;
  models: ModelOption[] | null;
  crewDefault: string;
  claudeCode: boolean;
  readOnly: boolean;
  patch: (p: Partial<ManifestForm>) => void;
}) {
  const servers = useResource<McpServerDto[]>(() => api.listMcp().then((r) => r.servers));
  const skills = useResource<SkillDto[]>(() => api.listSkills().then((r) => r.skills));
  const cli = form.backend === "claude-code-cli";

  const builtin = new Set(BUILTIN_TOOLS.map((t) => t.id));
  const otherTools = form.tools.filter((t) => !builtin.has(t));
  const installedIds = (servers.data ?? []).filter((s) => s.installed).map((s) => s.id);
  const toolChoices = approvalToolChoices(
    form.mcp.map((id) => ({ id, name: servers.data?.find((s) => s.id === id)?.name ?? id })),
  );
  const skillNames = cleanList(
    (skills.data ?? [])
      .filter((s) => s.scope !== "crew" || s.crewSlug === crew.slug)
      .map((s) => s.name),
  );

  return (
    <div className="space-y-4">
      <Section title="Identity">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            required
            maxLength={60}
            disabled={readOnly}
            value={form.name}
            onChange={(e) => patch({ name: e.target.value })}
          />
          <SelectField
            label="Who can use it"
            disabled={readOnly}
            value={form.visibility}
            onChange={(e) => patch({ visibility: e.target.value as ManifestForm["visibility"] })}
          >
            <option value="shared">Everyone aboard</option>
            <option value="private">Private (admins and whoever recruited it)</option>
          </SelectField>
        </div>
        <TextField
          label="Role"
          required
          maxLength={200}
          disabled={readOnly}
          hint="One line the Captain reads when deciding who to hand work to."
          value={form.role}
          onChange={(e) => patch({ role: e.target.value })}
        />
        <TextField
          label="Avatar"
          disabled={readOnly}
          placeholder="Optional image path or URL"
          value={form.avatar}
          onChange={(e) => patch({ avatar: e.target.value })}
        />
        {form.captain && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            <Badge tone="accent">captain</Badge> This is the coordinator. Use Edit file to move the
            role to someone else.
          </p>
        )}
      </Section>

      <Section title="Model" description="What runs this crew member's turns.">
        <SelectField
          label="Engine"
          disabled={readOnly}
          value={form.backend}
          onChange={(e) => patch(switchEngine(form, e.target.value as Engine))}
          hint={
            !claudeCode && !cli
              ? "To use Claude Code, sign in to Claude on the Providers page first."
              : undefined
          }
        >
          <option value="pi">Shipmate (pi)</option>
          <option value="claude-code-cli" disabled={!claudeCode && !cli}>
            Claude Code (your Claude subscription)
          </option>
        </SelectField>
        <ModelSelect
          // On Claude Code a non-Claude model means "the CLI's own default": show the Claude
          // subscription with no model picked yet.
          value={
            cli && providerOf(form.model) !== CLAUDE_CODE_PROVIDER
              ? `${CLAUDE_CODE_PROVIDER}/`
              : form.model
          }
          onChange={(model) => {
            if (!model || model.endsWith("/")) return;
            const onCli = providerOf(model) === CLAUDE_CODE_PROVIDER;
            patch({ model, backend: onCli ? "claude-code-cli" : "pi" });
          }}
          models={models}
          crewDefault={crewDefault}
          claudeCode={claudeCode || cli}
          disabled={readOnly}
          hint={
            cli
              ? "Runs on your Claude subscription through Claude Code. Shipmate's approval rules below do not apply; the Claude Code settings decide which tools it may use. Not available in Shipyard projects."
              : "Crew default follows the model picked in Settings. Pick a provider and model to give this crew member its own."
          }
        />
        {cli && (
          <div className="space-y-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <h3 className="text-sm font-semibold">Claude Code</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                label="What it may do"
                disabled={readOnly}
                value={form.cliPermissionMode}
                onChange={(e) => patch({ cliPermissionMode: e.target.value as PermissionMode })}
                hint={
                  <span
                    className={cx(
                      form.cliPermissionMode === "bypassPermissions" &&
                        "font-medium text-amber-800 dark:text-amber-200",
                    )}
                  >
                    {PERMISSION_MODES.find((m) => m.id === form.cliPermissionMode)?.hint}
                  </span>
                }
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </SelectField>
            </div>
            {form.cliPermissionMode !== "bypassPermissions" && (
              <>
                <fieldset disabled={readOnly} className="grid gap-2.5 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-medium">Tools it may use</legend>
                  {CLI_TOOL_GROUPS.map((g) => (
                    <Check
                      key={g.label}
                      checked={hasToolGroup(form.cliAllowedTools, g.rules)}
                      onChange={(on) =>
                        patch({ cliAllowedTools: setToolGroup(form.cliAllowedTools, g.rules, on) })
                      }
                    >
                      {g.label}
                    </Check>
                  ))}
                </fieldset>
                <ListInput
                  label="Other tools"
                  placeholder="e.g. Bash(npm test)"
                  disabled={readOnly}
                  values={otherCliTools(form.cliAllowedTools)}
                  onChange={(next) =>
                    patch({
                      cliAllowedTools: [
                        ...form.cliAllowedTools.filter(
                          (r) => !otherCliTools(form.cliAllowedTools).includes(r),
                        ),
                        ...next,
                      ],
                    })
                  }
                />
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="Helper agents">
        <Check disabled={readOnly} checked={form.helpers} onChange={(on) => patch({ helpers: on })}>
          <span className="font-medium">Let it start helper agents</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            Copies of itself that work on parts of a task at the same time. They use its tools and
            count toward its spending cap.
          </span>
        </Check>
      </Section>

      <Section
        title="Tools"
        description={
          cli
            ? "Used when this crew member runs on Shipmate (pi)."
            : "Shipmate's own tools and its MCP servers are always added."
        }
      >
        <Check
          disabled={readOnly}
          checked={form.tools.length === 0}
          onChange={(on) => patch({ tools: on ? [] : ["read", "grep", "find", "ls"] })}
        >
          <span className="font-medium">Allow all built-in tools</span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            Includes running shell commands. Approvals below still apply.
          </span>
        </Check>
        {form.tools.length > 0 && (
          <fieldset disabled={readOnly} className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <legend className="sr-only">Built-in tools</legend>
            {BUILTIN_TOOLS.map((t) => (
              <Check
                key={t.id}
                checked={form.tools.includes(t.id)}
                onChange={(on) =>
                  patch({
                    tools: on ? [...form.tools, t.id] : form.tools.filter((x) => x !== t.id),
                  })
                }
              >
                {t.label} <code className="font-mono text-xs text-slate-500">{t.id}</code>
              </Check>
            ))}
          </fieldset>
        )}
        {form.tools.length > 0 && (
          <ListInput
            label="Other tools"
            placeholder="Tool name"
            disabled={readOnly}
            values={otherTools}
            onChange={(next) =>
              patch({ tools: [...form.tools.filter((t) => builtin.has(t)), ...next] })
            }
          />
        )}
      </Section>

      <Section
        title="Connections (MCP servers)"
        description="Install and set up servers on the MCP servers page."
      >
        <ErrorText>{servers.error}</ErrorText>
        {installedIds.length > 1 && (
          <Check
            disabled={readOnly}
            checked={installedIds.every((id) => form.mcp.includes(id))}
            onChange={(on) =>
              patch({
                mcp: on
                  ? cleanList([...form.mcp, ...installedIds])
                  : form.mcp.filter((id) => !installedIds.includes(id)),
              })
            }
          >
            <span className="font-medium">All installed servers</span>
          </Check>
        )}
        <fieldset disabled={readOnly} className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">MCP servers</legend>
          {(servers.data ?? [])
            .filter((s) => s.installed || form.mcp.includes(s.id))
            .map((s) => (
              <Check
                key={s.id}
                checked={form.mcp.includes(s.id)}
                onChange={(on) =>
                  patch({ mcp: on ? [...form.mcp, s.id] : form.mcp.filter((x) => x !== s.id) })
                }
              >
                <span className="font-medium">{s.name}</span>{" "}
                {!s.installed ? (
                  <Badge tone="warn">not installed</Badge>
                ) : (
                  !s.ready && <Badge tone="warn">needs setup</Badge>
                )}
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {s.description}
                </span>
              </Check>
            ))}
          {form.mcp
            .filter((id) => servers.data && !servers.data.some((s) => s.id === id))
            .map((id) => (
              <Check
                key={id}
                checked
                onChange={() => patch({ mcp: form.mcp.filter((x) => x !== id) })}
              >
                <span className="font-mono">{id}</span> <Badge tone="warn">unknown</Badge>
              </Check>
            ))}
        </fieldset>
        {servers.data?.length === 0 && <Muted>No MCP servers installed.</Muted>}
      </Section>

      <Section title="Skills">
        <ChoiceList
          label="Skills it loads"
          choices={skillNames.map((n) => ({ value: n, label: n }))}
          empty="No skills yet. Add them on the Skills page."
          otherPlaceholder="Skill name"
          disabled={readOnly}
          values={form.skills}
          onChange={(next) => patch({ skills: next })}
        />
        <Check
          disabled={readOnly}
          checked={form.autoApproveSkills}
          onChange={(autoApproveSkills) => patch({ autoApproveSkills })}
        >
          Use skills it writes right away, without waiting for a person to approve them
        </Check>
      </Section>

      <Section
        title="Approvals"
        description="When this crew member has to ask before running a tool (Shipmate backend only)."
      >
        <SelectField
          label="Ask before running tools"
          disabled={readOnly}
          value={form.approval}
          onChange={(e) => patch({ approval: e.target.value as ApprovalMode })}
        >
          <option value="ask">Ask for anything that changes things</option>
          <option value="auto">Never ask</option>
          <option value="never-for">Never ask, and block some tools</option>
        </SelectField>
        {form.approval === "never-for" && (
          <ChoiceList
            label="Never allowed"
            choices={toolChoices}
            otherPlaceholder="Tool name, e.g. mcp__github__merge_pull_request"
            disabled={readOnly}
            values={form.neverFor}
            onChange={(neverFor) => patch({ neverFor })}
          />
        )}
        {form.approval === "ask" && (
          <ChoiceList
            label="Runs without asking"
            hint='"Always allow" on an approval card adds here too.'
            choices={toolChoices}
            otherPlaceholder="Tool name"
            disabled={readOnly}
            values={form.allow}
            onChange={(allow) => patch({ allow })}
          />
        )}
      </Section>

      <Section title="Spending">
        <TextField
          label="Monthly cap (USD)"
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          placeholder="No cap"
          className="max-w-xs"
          hint="For everyone together. Leave empty for no cap."
          disabled={readOnly}
          value={form.monthlyCapUsd ?? ""}
          onChange={(e) => {
            const n = Number.parseFloat(e.target.value);
            patch({ monthlyCapUsd: Number.isFinite(n) && n > 0 ? n : null });
          }}
        />
      </Section>
    </div>
  );
}

function Check({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-accent-700"
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/**
 * Checkboxes for the usual values, plus an "Other" field for anything else, editing one list.
 * Values keep their order; unticking removes just that value.
 */
function ChoiceList({
  label,
  hint,
  choices,
  values,
  onChange,
  otherPlaceholder,
  empty,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  choices: Choice[];
  values: string[];
  onChange: (values: string[]) => void;
  otherPlaceholder: string;
  empty?: string;
  disabled?: boolean;
}) {
  const known = new Set(choices.map((c) => c.value));
  const others = values.filter((v) => !known.has(v));
  return (
    <div className="space-y-2.5">
      <fieldset disabled={disabled} className="grid gap-2.5 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">{label}</legend>
        {choices.map((c) => (
          <Check
            key={c.value}
            checked={values.includes(c.value)}
            onChange={(on) =>
              onChange(on ? [...values, c.value] : values.filter((v) => v !== c.value))
            }
          >
            {c.label}
          </Check>
        ))}
        {!choices.length && empty && <Muted>{empty}</Muted>}
      </fieldset>
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
      <ListInput
        label="Other"
        placeholder={otherPlaceholder}
        disabled={disabled}
        values={others}
        onChange={(next) => onChange([...values.filter((v) => known.has(v)), ...next])}
      />
    </div>
  );
}

/** A list of short strings as removable chips plus an input that adds on Enter or comma. */
function ListInput({
  label,
  values,
  onChange,
  placeholder,
  hint,
  suggestions,
  disabled,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  hint?: ReactNode;
  suggestions?: string[];
  disabled?: boolean;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");

  function add() {
    if (!draft.trim()) return;
    onChange(cleanList([...values, draft]));
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-600 dark:bg-slate-900">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-mono text-xs dark:bg-slate-800"
          >
            {v}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className={cx("rounded text-slate-500 hover:text-red-600", focusRing)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && (
          <input
            id={id}
            list={suggestions?.length ? `${id}-list` : undefined}
            value={draft}
            placeholder={values.length ? "" : placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={add}
            className="min-w-32 flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-slate-400"
          />
        )}
        {disabled && values.length === 0 && <span className="text-sm text-slate-400">None</span>}
      </div>
      {suggestions?.length ? (
        <datalist id={`${id}-list`}>
          {suggestions
            .filter((s) => !values.includes(s))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
      ) : null}
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}
