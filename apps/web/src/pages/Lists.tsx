import type { ListDetailDto, ListItemDto, ListKind } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
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
  TextField,
} from "../components/ui.js";
import { dueLabel, itemPlaceholder, kindLabel, LIST_KINDS, localToday } from "../lib/lists.js";
import { useResource } from "../lib/useResource.js";
import { href, navigate } from "../router.js";
import { useServerEvents } from "../ws.js";

export function ListsPage({ listId }: { listId: string | null }) {
  if (listId) return <ListDetail key={listId} id={listId} />;
  return <ListIndex />;
}

function ListIndex() {
  const lists = useResource(() => api.listLists().then((r) => r.lists));
  useServerEvents((ev) => {
    if (ev.type === "list_changed") void lists.reload();
  });
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ListKind>("grocery");
  const [shared, setShared] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { list } = await api.createList({ name: name.trim(), kind, shared });
      navigate(`/lists/${list.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const all = lists.data ?? [];
  return (
    <Page wide>
      <PageHeader
        title="Lists"
        description="Groceries, to-dos, packing and bills. Shared lists are for the whole household; the crew read and update them too."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div>
          <ErrorText>{lists.error}</ErrorText>
          {lists.loading && !lists.data && <Muted>Loading…</Muted>}
          {lists.data && all.length === 0 && (
            <Card>
              <Muted>
                No lists yet. Start one here, or ask the crew: "add milk to the grocery list".
              </Muted>
            </Card>
          )}
          <ul className="grid gap-3 sm:grid-cols-2">
            {all.map((l) => (
              <li key={l.id}>
                <a
                  href={href(`/lists/${l.id}`)}
                  className={cx(
                    "block h-full rounded-xl border border-slate-200 bg-white p-4 transition hover:-translate-y-0.5 hover:border-accent-600/50 hover:shadow-md dark:border-slate-700 dark:bg-slate-900 dark:hover:border-accent-400/50",
                    focusRing,
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{l.name}</span>
                    <Badge tone="accent">{kindLabel(l.kind)}</Badge>
                    {!l.shared && <Badge>private</Badge>}
                  </div>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    {l.itemCount === 0
                      ? "Empty"
                      : l.openCount === 0
                        ? `All ${l.itemCount} done`
                        : `${l.openCount} open of ${l.itemCount}`}
                  </p>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">New list</h2>
          <form onSubmit={create} className="space-y-3">
            <TextField
              label="Name"
              required
              maxLength={100}
              placeholder="e.g. Groceries"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <SelectField
              label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as ListKind)}
            >
              {LIST_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </SelectField>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={!shared}
                onChange={(e) => setShared(!e.target.checked)}
                className="mt-0.5 size-4 accent-accent-700"
              />
              <span>Private: only you (and crew working for you) can see it</span>
            </label>
            <ErrorText>{error}</ErrorText>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create list"}
            </Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}

function ListDetail({ id }: { id: string }) {
  const user = useUser();
  const list = useResource(() => api.getList(id).then((r) => r.list), [id]);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [kind, setKind] = useState<ListKind>("other");
  useServerEvents((ev) => {
    if (ev.type !== "list_changed" || ev.listId !== id) return;
    if (ev.deleted) navigate("/lists");
    else void list.reload();
  });

  const l = list.data;
  /** Apply a change that returns the updated list; errors show above the items. */
  async function apply(fn: () => Promise<{ list: ListDetailDto }>) {
    setError(null);
    try {
      list.setData((await fn()).list);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove() {
    if (!l || !window.confirm(`Delete the list "${l.name}" and everything on it?`)) return;
    setError(null);
    try {
      await api.deleteList(id);
      navigate("/lists");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    if (renaming === null) return;
    await apply(() => api.updateList(id, { name: renaming.trim(), kind }));
    setRenaming(null);
  }

  const open = l?.items.filter((i) => !i.checked) ?? [];
  const done = l?.items.filter((i) => i.checked) ?? [];
  const canDelete = l && (!l.shared || isAdmin(user) || l.createdById === user.id);
  const today = localToday();

  return (
    <Page>
      <a
        href={href("/lists")}
        className="text-sm text-accent-700 hover:underline dark:text-accent-300"
      >
        ← Lists
      </a>
      {list.error && !l && <ErrorText>{list.error}</ErrorText>}
      {!l && !list.error && <Muted>Loading…</Muted>}
      {l && (
        <>
          <header className="mt-2 mb-4 flex flex-wrap items-start justify-between gap-3">
            {renaming !== null ? (
              <form onSubmit={saveName} className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
                <TextField
                  label="List name"
                  className="min-w-0 flex-1"
                  required
                  maxLength={100}
                  value={renaming}
                  onChange={(e) => setRenaming(e.target.value)}
                />
                <SelectField
                  label="Kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as ListKind)}
                >
                  {LIST_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                </SelectField>
                <Button type="submit" variant="primary">
                  Save
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold tracking-tight">{l.name}</h1>
                  <Badge tone="accent">{kindLabel(l.kind)}</Badge>
                  {l.shared ? <Badge>shared</Badge> : <Badge>private</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  {l.openCount} open of {l.itemCount}
                </p>
              </div>
            )}
            {renaming === null && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenaming(l.name);
                    setKind(l.kind);
                  }}
                >
                  Edit
                </Button>
                {canDelete && (
                  <Button size="sm" variant="danger" onClick={() => void remove()}>
                    Delete list
                  </Button>
                )}
              </div>
            )}
          </header>
          <ErrorText>{error}</ErrorText>
          <Card>
            <AddItem list={l} onAdded={list.setData} />
            {l.items.length === 0 && (
              <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">Nothing on it yet.</p>
            )}
            <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
              {open.map((item) => (
                <ItemRow key={item.id} listId={id} item={item} today={today} apply={apply} />
              ))}
            </ul>
            {done.length > 0 && (
              <details className="mt-3" open={open.length === 0}>
                <summary className={cx("cursor-pointer rounded text-sm font-medium", focusRing)}>
                  Checked off ({done.length})
                </summary>
                <ul className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                  {done.map((item) => (
                    <ItemRow key={item.id} listId={id} item={item} today={today} apply={apply} />
                  ))}
                </ul>
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={() => void apply(() => api.clearListChecked(id))}
                >
                  Clear checked items
                </Button>
              </details>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}

function AddItem({ list, onAdded }: { list: ListDetailDto; onAdded: (l: ListDetailDto) => void }) {
  const [text, setText] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [note, setNote] = useState("");
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const datesFirst = list.kind === "bills";

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { list: next } = await api.addListItem(list.id, {
        text: text.trim(),
        ...(dueOn ? { dueOn } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onAdded(next);
      setText("");
      setDueOn("");
      setNote("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={add} className="space-y-2">
      <div className="flex gap-2">
        <label htmlFor="new-item" className="sr-only">
          New item
        </label>
        <input
          id="new-item"
          value={text}
          maxLength={500}
          placeholder={itemPlaceholder(list.kind)}
          onChange={(e) => setText(e.target.value)}
          className={cx(
            "min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900",
            focusRing,
          )}
        />
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          Add
        </Button>
      </div>
      {more || datesFirst ? (
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <TextField
            label="Due (optional)"
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
          />
          <TextField
            label="Note (optional)"
            maxLength={2000}
            placeholder={datesFirst ? "Amount, how it is paid" : ""}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setMore(true)}
          className={cx(
            "rounded text-xs text-accent-700 hover:underline dark:text-accent-300",
            focusRing,
          )}
        >
          Add a due date or note
        </button>
      )}
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function ItemRow({
  listId,
  item,
  today,
  apply,
}: {
  listId: string;
  item: ListItemDto;
  today: string;
  apply: (fn: () => Promise<{ list: ListDetailDto }>) => Promise<void>;
}) {
  const id = `item-${item.id}`;
  const due = item.dueOn && !item.checked ? dueLabel(item.dueOn, today) : null;
  return (
    <li className="flex items-start gap-3 py-2">
      <input
        id={id}
        type="checkbox"
        checked={item.checked}
        onChange={(e) =>
          void apply(() => api.updateListItem(listId, item.id, { checked: e.target.checked }))
        }
        className="mt-0.5 size-5 shrink-0 accent-accent-700"
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={id}
          className={cx(
            "block cursor-pointer text-[15px] break-words",
            item.checked && "text-slate-400 line-through dark:text-slate-500",
          )}
        >
          {item.text}
        </label>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          {due && <Badge tone={due.tone}>{due.text}</Badge>}
          {item.note && <span className="break-words">{item.note}</span>}
          {item.addedBy && <span>added by {item.addedBy}</span>}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Remove ${item.text}`}
        title="Remove"
        onClick={() => void apply(() => api.deleteListItem(listId, item.id))}
        className={cx(
          "rounded px-1.5 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-red-700 dark:hover:bg-slate-800 dark:hover:text-red-300",
          focusRing,
        )}
      >
        ×
      </button>
    </li>
  );
}
