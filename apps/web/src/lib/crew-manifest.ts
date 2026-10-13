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
export type PermissionMode = "dontAsk" | "acceptEdits" | "plan";

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

  optional(["cli", "model"], form.cliModel, old.cliModel);
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
  scalar("monthlyCapUsd", form.monthlyCapUsd, old.monthlyCapUsd);
  scalar("visibility", form.visibility, old.visibility);
  scalar("captain", form.captain, old.captain);
  optional(["avatar"], form.avatar, old.avatar);

  return doc.toString({ flowCollectionPadding: false });
}

/** Trim, drop blanks and duplicates. */
export function cleanList(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}
