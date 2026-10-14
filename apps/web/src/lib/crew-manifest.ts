import { CrewManifest } from "@shipmate/core";
import { parse, parseDocument } from "yaml";

/** pi's built-in tools; an empty `tools` list means all of them. */
export const BUILTIN_TOOLS: Array<{ id: string; label: string }> = [
  { id: "read", label: "Read files" },
  { id: "write", label: "Write files" },
  { id: "edit", label: "Edit files" },
  { id: "bash", label: "Run shell commands" },
  { id: "grep", label: "Search file contents" },
  { id: "find", label: "Find files" },
  { id: "ls", label: "List folders" },
];

export type ApprovalMode = "ask" | "auto" | "never-for";
export type PermissionMode = "dontAsk" | "acceptEdits" | "plan" | "bypassPermissions";

/** The Claude Code permission modes, in plain words. */
export const PERMISSION_MODES: Array<{ id: PermissionMode; label: string; hint: string }> = [
  {
    id: "dontAsk",
    label: "Only the tools ticked below",
    hint: "Anything else is refused. It can always read its workspace and look things up online.",
  },
  {
    id: "acceptEdits",
    label: "Ticked tools, and edit its files",
    hint: "Also lets it create and change files in its own workspace.",
  },
  { id: "plan", label: "Look only, change nothing", hint: "It can read and plan, never change." },
  {
    id: "bypassPermissions",
    label: "Allow all tools",
    hint: "It can run any command and change any file Shipmate can reach, without asking. Only for crew you trust.",
  },
];

/**
 * Claude Code tools in groups people can tick, as permission rules for `cli.allowedTools`.
 * Paths starting `./` are inside its workspace (the CLI's working folder).
 */
export const CLI_TOOL_GROUPS: Array<{ label: string; rules: string[] }> = [
  { label: "Edit files in its workspace", rules: ["Edit(./**)"] },
  { label: "Run git commands", rules: ["Bash(git *)"] },
  { label: "Run any shell command", rules: ["Bash"] },
  { label: "Read any file Shipmate can reach", rules: ["Read"] },
];

const GROUPED = new Set(CLI_TOOL_GROUPS.flatMap((g) => g.rules));

/** Whether every rule of a group is allowed. */
export function hasToolGroup(allowed: readonly string[], rules: readonly string[]): boolean {
  return rules.every((r) => allowed.includes(r));
}

/** Tick or untick a group, keeping every other rule in its place. */
export function setToolGroup(allowed: string[], rules: readonly string[], on: boolean): string[] {
  const rest = allowed.filter((r) => !rules.includes(r));
  return on ? [...rest, ...rules] : rest;
}

/** Rules that no group covers, for the "Other" field. */
export function otherCliTools(allowed: readonly string[]): string[] {
  return allowed.filter((r) => !GROUPED.has(r));
}

/** Every crew.yaml field as a plain form value. */
export interface ManifestForm {
  name: string;
  role: string;
  model: string;
  backend: "pi" | "claude-code-cli";
  cliModel: string;
  cliAllowedTools: string[];
  cliPermissionMode: PermissionMode;
  tools: string[];
  mcp: string[];
  skills: string[];
  approval: ApprovalMode;
  /** Tools that always need a person's OK when approval is `never-for`. */
  neverFor: string[];
  allow: string[];
  autoApproveSkills: boolean;
  /** Let it start helper agents (sub agents) on either engine. */
  helpers: boolean;
  monthlyCapUsd: number | null;
  visibility: "shared" | "private";
  captain: boolean;
  avatar: string;
}

export type ReadResult = { ok: true; form: ManifestForm } | { ok: false; error: string };

function describeIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}

/** Parse and validate crew.yaml into form values, or say what is wrong with it. */
export function readManifestForm(yaml: string): ReadResult {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = CrewManifest.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, error: describeIssues(parsed.error.issues) };
  const m = parsed.data;
  const approval: ApprovalMode = typeof m.approval === "string" ? m.approval : "never-for";
  return {
    ok: true,
    form: {
      name: m.name,
      role: m.role,
      model: m.model,
      backend: m.backend,
      cliModel: m.cli?.model ?? "",
      cliAllowedTools: m.cli?.allowedTools ?? [],
      cliPermissionMode: m.cli?.permissionMode ?? "dontAsk",
      tools: m.tools,
      mcp: m.mcp,
      skills: m.skills,
      approval,
      neverFor: typeof m.approval === "object" ? m.approval["never-for"] : [],
      allow: m.allow,
      autoApproveSkills: m.autoApproveSkills,
      helpers: m.helpers,
      monthlyCapUsd: m.monthlyCapUsd,
      visibility: m.visibility,
      captain: m.captain,
      avatar: m.avatar ?? "",
    },
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * crew.yaml with the form's values written in. Only fields that changed are touched, so
 * comments, key order and anything the form does not know about are kept. `yaml` must be valid
 * (see readManifestForm).
 */
export function applyManifestForm(yaml: string, form: ManifestForm): string {
  const before = readManifestForm(yaml);
  if (!before.ok) throw new Error(before.error);
  const old = before.form;
  if (same(form, old)) return yaml;
  const doc = parseDocument(yaml);

  const scalar = (key: string, next: unknown, prev: unknown) => {
    if (!same(next, prev)) doc.set(key, next);
  };
  const list = (key: string, next: string[], prev: string[]) => {
    if (!same(next, prev)) doc.set(key, doc.createNode(next, { flow: true }));
  };
  const optional = (path: string[], next: string, prev: string) => {
    if (next === prev) return;
    if (next) doc.setIn(path, next);
    else doc.deleteIn(path);
  };

  scalar("name", form.name, old.name);
  scalar("role", form.role, old.role);
  scalar("model", form.model, old.model);
  scalar("backend", form.backend, old.backend);

  // `model` is the one model setting: picking a new one drops an old cli.model that would
  // otherwise override it on Claude Code.
  const cliModel = form.model !== old.model && form.cliModel === old.cliModel ? "" : form.cliModel;
  optional(["cli", "model"], cliModel, old.cliModel);
  if (!same(form.cliAllowedTools, old.cliAllowedTools))
    doc.setIn(["cli", "allowedTools"], doc.createNode(form.cliAllowedTools, { flow: true }));
  if (form.cliPermissionMode !== old.cliPermissionMode)
    doc.setIn(["cli", "permissionMode"], form.cliPermissionMode);

  list("tools", form.tools, old.tools);
  list("mcp", form.mcp, old.mcp);
  list("skills", form.skills, old.skills);

  if (form.approval !== old.approval || !same(form.neverFor, old.neverFor)) {
    doc.set(
      "approval",
      form.approval === "never-for"
        ? doc.createNode({ "never-for": doc.createNode(form.neverFor, { flow: true }) })
        : form.approval,
    );
  }
  list("allow", form.allow, old.allow);
  scalar("autoApproveSkills", form.autoApproveSkills, old.autoApproveSkills);
  scalar("helpers", form.helpers, old.helpers);
  scalar("monthlyCapUsd", form.monthlyCapUsd, old.monthlyCapUsd);
  scalar("visibility", form.visibility, old.visibility);
  scalar("captain", form.captain, old.captain);
  optional(["avatar"], form.avatar, old.avatar);

  return doc.toString({ flowCollectionPadding: false });
}

export type Engine = ManifestForm["backend"];

/**
 * Move a crew member to the other engine. Claude Code runs on the Claude subscription, so a
 * model from another provider is left for the CLI's own default; back on pi, a Claude
 * subscription model makes way for the crew default.
 */
export function switchEngine(form: ManifestForm, engine: Engine): Partial<ManifestForm> {
  if (engine === form.backend) return {};
  const claude = form.model.startsWith("claude-code/");
  return engine === "pi"
    ? { backend: "pi", ...(claude ? { model: "default" } : {}) }
    : { backend: "claude-code-cli" };
}

/** Trim, drop blanks and duplicates. */
export function cleanList(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export interface Choice {
  value: string;
  label: string;
}

/**
 * Tools to tick on the approval lists: built-ins and Shipmate actions that ask first, and every
 * tool of each MCP server the crew member has (`mcp__<id>__*`).
 */
export function approvalToolChoices(servers: Array<{ id: string; name: string }>): Choice[] {
  return [
    { value: "bash", label: "Run shell commands" },
    { value: "write", label: "Write files" },
    { value: "edit", label: "Edit files" },
    { value: "create_watch", label: "Schedule watches" },
    { value: "git_push", label: "Push code (Shipyard)" },
    { value: "open_pull_request", label: "Open pull requests (Shipyard)" },
    { value: "comment_on_github", label: "Comment on GitHub (Shipyard)" },
    ...servers.map((s) => ({ value: `mcp__${s.id}__*`, label: `All ${s.name} tools` })),
  ];
}
