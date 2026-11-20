import type { DocumentDto, DocumentHitDto } from "@shipmate/core";
import { type FormEvent, useRef, useState } from "react";
import { errorMessage } from "../api.js";
import { NavIcon } from "../components/icons.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Muted,
  Notice,
  Page,
  PageHeader,
  TextField,
} from "../components/ui.js";
import { formatBytes } from "../lib/backups.js";
import {
  DOCUMENT_ACCEPT,
  documentProblem,
  documentsApi,
  documentUrl,
  roughLength,
} from "../lib/documents.js";
import { useResource } from "../lib/useResource.js";

/** Manuals, policies and letters saved once so any agent can look things up in them. */
export function DocumentsPage() {
  const res = useResource(() => documentsApi.list().then((r) => r.documents));
  const picker = useRef<HTMLInputElement>(null);
  const [onlyMe, setOnlyMe] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const docs = res.data ?? [];

  async function add(files: File[]) {
    const failed: string[] = [];
    for (const file of files) {
      const problem = documentProblem(file);
      if (problem) {
        failed.push(problem);
        continue;
      }
      setAdding(file.name);
      try {
        await documentsApi.add(file, onlyMe);
      } catch (err) {
        failed.push(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setAdding(null);
    setProblems(failed);
    res.reload();
  }

  async function act(run: () => Promise<unknown>) {
    setProblems([]);
    try {
      await run();
    } catch (err) {
      setProblems([errorMessage(err)]);
    }
    res.reload();
  }

  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Add manuals, policies and letters once. Your agents look things up in them when you ask."
        actions={
          <Button disabled={adding !== null} onClick={() => picker.current?.click()}>
            {adding ? "Adding…" : "Add documents"}
          </Button>
        }
      />
      <input
        ref={picker}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void add(files);
        }}
      />
      <div className="space-y-6">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-accent-600"
            checked={onlyMe}
            onChange={(e) => setOnlyMe(e.target.checked)}
          />
          Only for me (other people cannot see what I add)
        </label>
        {adding && <Notice>Reading {adding}…</Notice>}
        {problems.map((p) => (
          <ErrorText key={p}>{p}</ErrorText>
        ))}
        {res.error && <ErrorText>{res.error}</ErrorText>}
        {!res.data && !res.error && <Loading />}
        {res.data && docs.length === 0 && (
          <EmptyState icon={<NavIcon name="document" size={22} />} title="No documents yet">
            PDFs and text files work. Scanned PDFs need a version with text in them.
          </EmptyState>
        )}
        {docs.length > 0 && <SearchCard />}
        {docs.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-900">
            {docs.map((d) => (
              <DocumentRow key={d.id} doc={d} act={act} />
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}

function DocumentRow({
  doc,
  act,
}: {
  doc: DocumentDto;
  act: (run: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="break-all">{doc.name}</span>
          <Badge tone={doc.shared ? "accent" : "neutral"}>
            {doc.shared ? "Everyone" : "Only me"}
          </Badge>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {roughLength(doc.chars)} · {formatBytes(doc.size)} ·{" "}
          {new Date(doc.createdAt).toLocaleDateString()}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={documentUrl(doc.id)}
          download={doc.name}
          className="mr-1 text-sm font-medium text-accent-700 hover:underline dark:text-accent-300"
        >
          Download
        </a>
        {doc.mine && (
          <>
            <Button
              size="sm"
              onClick={() => void act(() => documentsApi.update(doc.id, { shared: !doc.shared }))}
            >
              {doc.shared ? "Make private" : "Share"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (window.confirm(`Delete ${doc.name}?`)) {
                  void act(() => documentsApi.remove(doc.id));
                }
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** Try the same search the agents use, to check a document is being found. */
function SearchCard() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocumentHitDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setHits((await documentsApi.search(query)).hits);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={search} className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <TextField
            label="Search inside your documents"
            placeholder="dishwasher error E24"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy || !query.trim()}>
          Search
        </Button>
      </form>
      {error && <ErrorText>{error}</ErrorText>}
      {hits && hits.length === 0 && (
        <div className="mt-3">
          <Muted>Nothing matches. Try other words from the document.</Muted>
        </div>
      )}
      {hits && hits.length > 0 && (
        <ul className="mt-3 space-y-3">
          {hits.map((h) => (
            <li key={`${h.documentId}-${h.part}`} className="text-sm">
              <div className="font-medium break-all">
                {h.name}{" "}
                <span className="font-normal text-slate-500 dark:text-slate-400">
                  part {h.part} of {h.parts}
                </span>
              </div>
              <p className="mt-1 line-clamp-4 whitespace-pre-line text-slate-600 dark:text-slate-300">
                {h.text}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
