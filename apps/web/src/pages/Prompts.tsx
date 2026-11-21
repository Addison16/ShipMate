import type { SavedPromptDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { errorMessage } from "../api.js";
import { NavIcon } from "../components/icons.js";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  PageHeader,
  TextAreaField,
  TextField,
} from "../components/ui.js";
import { promptsApi } from "../lib/prompts.js";
import { useResource } from "../lib/useResource.js";

/** Settings → Saved prompts: messages you send often, picked by typing "/" in a chat. */
export function PromptsPage() {
  const res = useResource(() => promptsApi.list().then((r) => r.prompts));
  const [editing, setEditing] = useState<SavedPromptDto | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prompts = res.data ?? [];

  async function remove(p: SavedPromptDto) {
    if (!window.confirm(`Delete "${p.title}"?`)) return;
    setError(null);
    try {
      await promptsApi.remove(p.id);
    } catch (err) {
      setError(errorMessage(err));
    }
    res.reload();
  }

  return (
    <Page>
      <PageHeader
        title="Saved prompts"
        description="Messages you send often. In a chat, type / and pick one."
        actions={editing === null && <Button onClick={() => setEditing("new")}>New prompt</Button>}
      />
      <div className="space-y-6">
        <ErrorText>{error ?? res.error}</ErrorText>
        {editing !== null && (
          <PromptForm
            key={editing === "new" ? "new" : editing.id}
            prompt={editing === "new" ? null : editing}
            onClose={(changed) => {
              setEditing(null);
              if (changed) res.reload();
            }}
          />
        )}
        {!res.data && !res.error && <Loading />}
        {res.data && prompts.length === 0 && editing === null && (
          <EmptyState icon={<NavIcon name="sparkle" size={22} />} title="No saved prompts yet">
            Save a message like "Plan dinners for next week and add what we need to Groceries".
          </EmptyState>
        )}
        {prompts.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-900">
            {prompts.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 flex-1 basis-48">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="break-words">{p.title}</span>
                    <Badge tone={p.shared ? "accent" : "neutral"}>
                      {p.shared ? "Everyone" : "Only me"}
                    </Badge>
                  </div>
                  <p className="line-clamp-2 text-sm break-words text-slate-500 dark:text-slate-400">
                    {p.body}
                  </p>
                </div>
                {p.mine && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void remove(p)}>
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}

function PromptForm({
  prompt,
  onClose,
}: {
  prompt: SavedPromptDto | null;
  onClose: (changed: boolean) => void;
}) {
  const [title, setTitle] = useState(prompt?.title ?? "");
  const [body, setBody] = useState(prompt?.body ?? "");
  const [shared, setShared] = useState(prompt?.shared ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (prompt) await promptsApi.update(prompt.id, { title, body, shared });
      else await promptsApi.create({ title, body, shared });
      onClose(true);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save} className="space-y-4">
        <TextField
          label="Name"
          placeholder="Meal plan"
          maxLength={80}
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextAreaField
          label="Message"
          rows={5}
          maxLength={8000}
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-accent-600"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
          />
          Share with everyone here
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !title.trim() || !body.trim()}>
            Save
          </Button>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
