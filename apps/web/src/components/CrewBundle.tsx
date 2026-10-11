import type { CrewImportPreviewDto } from "@shipmate/core";
import { type ChangeEvent, type FormEvent, useState } from "react";
import { ApiError, api, errorMessage } from "../api.js";
import { checkCrewFile, redactedNotice } from "../lib/crew-bundle.js";
import { href, navigate } from "../router.js";
import { Avatar } from "./Avatar.js";
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
  TextField,
} from "./ui.js";

/** Download one crew member as a .shipmate-crew.json file to share. */
export function ExportCrewButton({ slug }: { slug: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/crew/${encodeURIComponent(slug)}/export`, {
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new ApiError(res.status, body?.error ?? `${res.status} export failed`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}.shipmate-crew.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNote(redactedNotice(res.headers.get("x-shipmate-redacted")));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button
        disabled={busy}
        onClick={() => void download()}
        title="Download crew.yaml, CREW.md and skills as one file to share. Memory is never included."
      >
        {busy ? "Exporting…" : "Export"}
      </Button>
      {note && (
        <span className="max-w-64 text-right text-xs text-amber-700 dark:text-amber-300">
          {note}
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-red-700 dark:text-red-300">
          {error}
        </span>
      )}
    </span>
  );
}

/** Import a shared crew member from a file or an https link; it lands awaiting review. */
export function ImportCrewPage() {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<CrewImportPreviewDto | null>(null);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(body: { text: string } | { url: string }) {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const { preview: p } = await api.previewCrewImport(body);
      setPreview(p);
      setSlug(p.slug);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const problem = checkCrewFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    await load({ text: await file.text() });
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const { crew } = await api.importCrew({ bundle: preview.bundle, slug: slug.trim() });
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
      <PageHeader
        title="Import a crew member"
        description="From a .shipmate-crew.json file someone shared, or a link to one. You see everything before it comes aboard, and it waits for review before first use."
      />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="mb-1 block text-sm font-medium">From a file</span>
            <label
              className={cx(
                "flex cursor-pointer items-center justify-center rounded-md border border-dashed border-slate-300 px-3 py-6 text-sm text-slate-600 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-600 hover:border-accent-600 hover:text-accent-800 dark:border-slate-600 dark:text-slate-300 dark:hover:border-accent-400",
              )}
            >
              <input
                type="file"
                accept=".json,application/json"
                className="sr-only"
                onChange={(e) => void onFile(e)}
              />
              Choose a .shipmate-crew.json file
            </label>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) void load({ url: url.trim() });
            }}
            className="space-y-2"
          >
            <TextField
              label="From a link"
              type="url"
              placeholder="https://…/galley.shipmate-crew.json"
              hint="https only, on a public host."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? "Reading…" : "Preview"}
            </Button>
          </form>
        </div>
        <div className="mt-4">
          <ErrorText>{error}</ErrorText>
        </div>
      </Card>

      {preview && (
        <Card className="mt-6">
          <form onSubmit={confirm} className="space-y-4">
            <div className="flex items-start gap-3">
              <Avatar name={preview.name} size="lg" />
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{preview.name}</h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">{preview.role}</p>
                <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {preview.model}
                  {preview.backend === "claude-code-cli" && " · Claude Code CLI"}
                </p>
                {preview.modelReplaced && (
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    It asked for {preview.modelReplaced}, which is not set up here, so it gets the
                    default model.
                  </p>
                )}
              </div>
            </div>
            {preview.warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-medium">Tools</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {preview.tools.length ? (
                    preview.tools.map((t) => (
                      <Badge key={t} tone={t === "bash" ? "warn" : "neutral"}>
                        {t}
                      </Badge>
                    ))
                  ) : (
                    <Muted>All built-in tools</Muted>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium">MCP servers</dt>
                <dd className="mt-1 flex flex-wrap gap-1">
                  {preview.mcp.length ? (
                    preview.mcp.map((m) => (
                      <Badge key={m.id} tone={m.known ? (m.installed ? "ok" : "neutral") : "warn"}>
                        {m.id}
                        {!m.known ? " (unknown)" : !m.installed ? " (not installed)" : ""}
                      </Badge>
                    ))
                  ) : (
                    <Muted>None</Muted>
                  )}
                </dd>
              </div>
              <div>
                <dt className="font-medium">Skills</dt>
                <dd className="mt-1">
                  {preview.skills.length ? (
                    <ul className="space-y-0.5">
                      {preview.skills.map((s) => (
                        <li key={s.name}>
                          <span className="font-mono text-xs">{s.name}</span>{" "}
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {s.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Muted>None</Muted>
                  )}
                </dd>
              </div>
            </dl>
            <details>
              <summary className={cx("cursor-pointer rounded text-sm font-medium", focusRing)}>
                Persona (CREW.md)
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-slate-800/60">
                {preview.persona || "(empty)"}
              </pre>
            </details>
            <details>
              <summary className={cx("cursor-pointer rounded text-sm font-medium", focusRing)}>
                Manifest (crew.yaml)
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-slate-800/60">
                {preview.bundle.manifest}
              </pre>
            </details>
            <TextField
              label="Slug"
              required
              pattern="[a-z0-9][a-z0-9\-]{0,39}"
              hint="The folder name here. Change it if you want both versions aboard."
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <Notice>
              It arrives awaiting review: approve it on its Crew page before first use. Its skills
              wait on the Skills page.
            </Notice>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={busy || !slug.trim()}>
                {busy ? "Importing…" : "Import for review"}
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </Page>
  );
}
