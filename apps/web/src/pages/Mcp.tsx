import type { CreateCustomMcpRequest, CrewDto, McpServerDto } from "@shipmate/core";
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
  TextAreaField,
  TextField,
} from "../components/ui.js";
import { useResource } from "../lib/useResource.js";
import { useServerEvents } from "../ws.js";

const GROUPS: Array<{
  id: string;
  title: string;
  blurb: string;
  pick: (s: McpServerDto) => boolean;
}> = [
  {
    id: "core",
    title: "Core (bundled)",
    blurb: "Shipped with Shipmate and always installed; some need a key.",
    pick: (s) => s.tier === "core",
  },
  {
    id: "installed",
    title: "Installed",
    blurb: "Catalog servers installed on this instance.",
    pick: (s) => s.tier === "catalog" && s.installed,
  },
  {
    id: "catalog",
    title: "Catalog",
    blurb: "One click to install.",
    pick: (s) => s.tier === "catalog" && !s.installed,
  },
  {
    id: "custom",
    title: "Custom",
    blurb: "Servers an owner added by command or URL.",
    pick: (s) => s.tier === "custom",
  },
];

export function McpPage() {
  const user = useUser();
  const owner = user.role === "owner";
  const admin = isAdmin(user);
  const servers = useResource(() => api.listMcp().then((r) => r.servers));
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  const [adding, setAdding] = useState(false);
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") {
      void crew.reload();
      void servers.reload();
    }
  });

  const replace = (s: McpServerDto) =>
    servers.setData((servers.data ?? []).map((x) => (x.id === s.id ? s : x)));

  return (
    <Page wide>
      <PageHeader
        title="MCP servers"
        description="Tools crew members can use. Each server runs only with the secrets it declares, and a crew member only sees the servers in its manifest."
        actions={
          owner &&
          !adding && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add custom server
            </Button>
          )
        }
      />
      <div className="space-y-6">
        {!owner && (
          <Muted>
            {admin
              ? "Only the owner can install servers and set their secrets. You can choose which crew members use each server."
              : "Only the owner can change MCP servers."}
          </Muted>
        )}
        {adding && (
          <CustomServerForm
            onCancel={() => setAdding(false)}
            onSaved={(s) => {
              servers.setData([...(servers.data ?? []), s]);
              setAdding(false);
            }}
          />
        )}
        <ErrorText>{servers.error}</ErrorText>
        {servers.loading && !servers.data && <Muted>Loading…</Muted>}
        {servers.data &&
          GROUPS.map((g) => {
            const list = servers.data?.filter(g.pick) ?? [];
            if (list.length === 0 && g.id !== "custom") return null;
            return (
              <section key={g.id} aria-labelledby={`mcp-${g.id}`}>
                <h2 id={`mcp-${g.id}`} className="font-semibold">
                  {g.title}
                </h2>
                <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{g.blurb}</p>
                {list.length === 0 ? (
                  <Muted>None yet.</Muted>
                ) : (
                  <ul className="grid gap-3 lg:grid-cols-2">
                    {list.map((s) => (
                      <li key={s.id}>
                        <ServerCard
                          server={s}
                          crew={crew.data ?? []}
                          owner={owner}
                          admin={admin}
                          onChange={replace}
                          onReload={() => void servers.reload()}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
      </div>
    </Page>
  );
}

function ServerCard({
  server: s,
  crew,
  owner,
  admin,
  onChange,
  onReload,
}: {
  server: McpServerDto;
  crew: CrewDto[];
  owner: boolean;
  admin: boolean;
  onChange: (s: McpServerDto) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<"secrets" | "crews" | null>(null);
  const crewName = (slug: string) => crew.find((c) => c.slug === slug)?.name ?? slug;
  const canUninstall = owner && s.tier !== "core" && s.installed;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const install = () =>
    act(async () => {
      const { server } = await api.installMcp(s.id);
      onChange(server);
    });
  const uninstall = () => {
    const msg =
      s.tier === "custom"
        ? `Remove the custom server "${s.name}"?`
        : `Uninstall "${s.name}"? Crew members lose access to it.`;
    if (!window.confirm(msg)) return;
    void act(async () => {
      await api.uninstallMcp(s.id);
      onReload();
    });
  };

  return (
    <Card className="h-full">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{s.name}</h3>
            {s.installed ? (
              s.ready ? (
                <Badge tone="ok">ready</Badge>
              ) : (
                <Badge tone="warn">needs secrets</Badge>
              )
            ) : (
              <Badge>not installed</Badge>
            )}
          </div>
          <p className="font-mono text-xs text-slate-500 dark:text-slate-400">{s.id}</p>
        </div>
        {s.homepage && (
          <a
            href={s.homepage}
            target="_blank"
            rel="noreferrer"
            className={cx(
              "rounded text-xs text-accent-700 hover:underline dark:text-accent-300",
              focusRing,
            )}
          >
            Homepage
          </a>
        )}
      </div>
      {s.description && (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{s.description}</p>
      )}
      {s.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      )}
      <p className="mt-2 font-mono text-xs break-all text-slate-600 dark:text-slate-300">
        <span className="text-slate-500 dark:text-slate-400">{s.transport}: </span>
        {s.transport === "http" ? s.url : [s.command, ...s.args].filter(Boolean).join(" ")}
      </p>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Used by: {s.crews.length ? s.crews.map(crewName).join(", ") : "no crew members"}
      </p>
      {s.secrets.length > 0 && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Secrets:{" "}
          {s.secrets.map((x, i) => (
            <span key={x.env}>
              {i > 0 && ", "}
              <span className="font-mono">{x.env}</span>{" "}
              {x.set ? "(set)" : x.required ? "(missing)" : "(optional)"}
            </span>
          ))}
        </p>
      )}

      {(owner || admin) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {owner && !s.installed && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void install()}>
              Install
            </Button>
          )}
          {owner && s.installed && s.secrets.length > 0 && (
            <Button
              size="sm"
              aria-expanded={panel === "secrets"}
              onClick={() => setPanel(panel === "secrets" ? null : "secrets")}
            >
              Secrets
            </Button>
          )}
          {admin && s.installed && (
            <Button
              size="sm"
              aria-expanded={panel === "crews"}
              onClick={() => setPanel(panel === "crews" ? null : "crews")}
            >
              Assign to crew
            </Button>
          )}
          {canUninstall && (
            <Button size="sm" variant="danger" disabled={busy} onClick={uninstall}>
              {s.tier === "custom" ? "Remove" : "Uninstall"}
            </Button>
          )}
        </div>
      )}
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {panel === "secrets" && (
        <SecretsForm server={s} onSaved={onChange} onClose={() => setPanel(null)} />
      )}
      {panel === "crews" && (
        <CrewAssign server={s} crew={crew} onSaved={onChange} onClose={() => setPanel(null)} />
      )}
    </Card>
  );
}

function SecretsForm({
  server,
  onSaved,
  onClose,
}: {
  server: McpServerDto;
  onSaved: (s: McpServerDto) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function send(v: Record<string, string>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const { server: s } = await api.setMcpSecrets(server.id, v);
      onSaved(s);
      setValues({});
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    // Empty inputs leave the stored value unchanged.
    const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    if (Object.keys(filled).length === 0) return;
    void send(filled);
  }

  function clear(env: string) {
    if (!window.confirm(`Clear the stored value for ${env}?`)) return;
    void send({ [env]: "" });
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700"
    >
      {server.secrets.map((x) => (
        <div key={x.env} className="flex items-end gap-2">
          <TextField
            className="flex-1"
            label={`${x.label || x.env}${x.required ? "" : " (optional)"}`}
            type="password"
            autoComplete="off"
            placeholder={x.set ? "•••••• stored; type to replace" : "Not set"}
            hint={
              <>
                <span className="font-mono">{x.env}</span> ·{" "}
                {x.set ? (
                  <span className="text-emerald-700 dark:text-emerald-300">set</span>
                ) : (
                  "not set"
                )}
              </>
            }
            value={values[x.env] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [x.env]: e.target.value }))}
          />
          {x.set && (
            <Button
              size="sm"
              variant="ghost"
              className="mb-6"
              disabled={busy}
              onClick={() => clear(x.env)}
            >
              Clear
            </Button>
          )}
        </div>
      ))}
      <ErrorText>{error}</ErrorText>
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={busy || !Object.values(values).some((v) => v !== "")}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
        {saved && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>}
      </div>
    </form>
  );
}

function CrewAssign({
  server,
  crew,
  onSaved,
  onClose,
}: {
  server: McpServerDto;
  crew: CrewDto[];
  onSaved: (s: McpServerDto) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>(server.crews);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidates = crew.filter((c) => c.status !== "retired");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { server: s } = await api.setMcpCrews(server.id, picked);
      onSaved(s);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-3 border-t border-slate-200 pt-3 dark:border-slate-700"
    >
      <fieldset>
        <legend className="mb-1 text-sm font-medium">
          Crew members that can use {server.name}
        </legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {candidates.map((c) => (
            <label key={c.slug} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(c.slug)}
                onChange={(e) =>
                  setPicked((p) =>
                    e.target.checked ? [...p, c.slug] : p.filter((x) => x !== c.slug),
                  )
                }
                className="size-4 accent-accent-700"
              />
              {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CustomServerForm({
  onSaved,
  onCancel,
}: {
  onSaved: (s: McpServerDto) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [secrets, setSecrets] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const lines = (t: string) =>
      t
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const body: CreateCustomMcpRequest = {
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      transport,
      ...(transport === "stdio"
        ? { command: command.trim(), args: lines(args) }
        : { url: url.trim() }),
      secrets: secrets
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((env) => ({ env })),
    };
    setBusy(true);
    setError(null);
    try {
      const { server } = await api.createCustomMcp(body);
      onSaved(server);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-semibold">Add custom server</h2>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Id"
            required
            pattern="[a-z0-9][a-z0-9\-]*"
            hint="Lowercase letters, digits and dashes."
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <TextField
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <SelectField
          label="Transport"
          value={transport}
          onChange={(e) => setTransport(e.target.value as "stdio" | "http")}
        >
          <option value="stdio">stdio (a local command)</option>
          <option value="http">http (a URL)</option>
        </SelectField>
        {transport === "stdio" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Command"
              required
              placeholder="npx"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            <TextAreaField
              label="Arguments"
              mono
              rows={3}
              hint="One per line."
              placeholder={"-y\n@example/mcp-server"}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </div>
        ) : (
          <TextField
            label="URL"
            type="url"
            required
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}
        <TextField
          label="Secret env names"
          placeholder="EXAMPLE_API_KEY, EXAMPLE_TOKEN"
          hint="Separated by commas or spaces. Set the values after adding the server."
          value={secrets}
          onChange={(e) => setSecrets(e.target.value)}
        />
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Adding…" : "Add server"}
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}
