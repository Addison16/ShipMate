import type { CodexCliStatusDto, ProviderAuth, ProviderDto, ProviderKindDto } from "@shipmate/core";
import { type FormEvent, useCallback, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useUser } from "../auth.js";
import { ChatGptCard } from "../components/ChatGptCard.js";
import { ClaudeCliCard } from "../components/ClaudeCliCard.js";
import { CodexCliCard } from "../components/CodexCliCard.js";
import { LocalAiCard } from "../components/LocalAiCard.js";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Muted,
  Page,
  PageHeader,
  SelectField,
  Table,
  TextAreaField,
  TextField,
  td,
  th,
} from "../components/ui.js";
import { usableModels } from "../lib/claude-cli.js";
import { codexChoices } from "../lib/codex-cli.js";
import { groupByProvider, providerLabel } from "../lib/models.js";
import { useResource } from "../lib/useResource.js";

const OLLAMA_URL = "http://localhost:11434/v1";
const isSelfHosted = (auth: ProviderAuth | undefined) => auth === "none" || auth === "optional-key";

function parseModels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function ProvidersPage() {
  const user = useUser();
  const owner = user.role === "owner";
  const providers = useResource(() => api.listProviders());
  const models = useResource(() => api.listModels().then((r) => r.models));
  const kinds = providers.data?.kinds ?? [];
  const [cliSignedIn, setCliSignedIn] = useState(false);
  const onCliStatus = useCallback((s: { signedIn: boolean }) => setCliSignedIn(s.signedIn), []);
  const [codexModels, setCodexModels] = useState<Array<{ ref: string; name: string }>>([]);
  const onCodexStatus = useCallback((s: CodexCliStatusDto) => setCodexModels(codexChoices(s)), []);
  const usable = models.data ? usableModels(models.data, cliSignedIn, codexModels) : null;

  const reloadAll = async () => {
    await Promise.all([providers.reload(), models.reload()]);
  };

  return (
    <Page wide>
      <PageHeader
        icon="providers"
        title="Providers"
        description={
          owner
            ? "Model providers are shared by the whole instance. Keys are stored on the server and never shown again."
            : "Model providers are configured by the owner."
        }
      />
      <ErrorText>{providers.error}</ErrorText>
      <div className="space-y-4">
        {providers.data?.providers.length === 0 && (
          <Muted>No providers configured yet{owner ? ". Add one below." : "."}</Muted>
        )}
        {providers.data?.providers.map((p) => (
          <ProviderCard
            key={`${p.id}:${p.baseUrl ?? ""}:${p.models.join(",")}`}
            provider={p}
            kind={kinds.find((k) => k.kind === p.kind)}
            owner={owner}
            onChanged={reloadAll}
          />
        ))}
        {owner && providers.data && (
          <AddProvider
            kinds={kinds.filter((k) => k.kind !== "openai-chatgpt" && k.kind !== "claude-code-cli")}
            onAdded={reloadAll}
          />
        )}
      </div>

      <div className="mt-4">
        {owner && (
          <div className="mb-4">
            <LocalAiCard onUsed={() => void reloadAll()} />
          </div>
        )}
        <div className="mb-4">
          <ChatGptCard onChanged={reloadAll} />
        </div>
        <ClaudeCliCard onStatus={onCliStatus} />
        <div className="mt-4">
          <CodexCliCard onStatus={onCodexStatus} />
        </div>
      </div>

      <h2 className="mt-10 mb-1 text-lg font-semibold">Models</h2>
      <Muted>Models the crew can use with the providers and sign-ins above.</Muted>
      <ErrorText>{models.error}</ErrorText>
      {usable && usable.length === 0 && (
        <div className="mt-3">
          <Muted>No models yet. Add a provider or sign in above and its models show up here.</Muted>
        </div>
      )}
      {usable && usable.length > 0 && (
        <div className="mt-3">
          {[...groupByProvider(usable.map((m) => ({ ...m, provider: m.source })))].map(
            ([source, list]) => (
              <details
                key={source}
                className="mb-2 rounded-xl border border-slate-200 dark:border-slate-800"
              >
                <summary className="flex cursor-pointer items-center gap-2 px-4 py-3 text-sm">
                  <span className="font-medium">{providerLabel(source)}</span>
                  <Badge tone="ok">
                    {list.length} model{list.length === 1 ? "" : "s"}
                  </Badge>
                </summary>
                <div className="px-2 pb-2">
                  <Table>
                    <thead>
                      <tr>
                        <th className={th}>Model</th>
                        <th className={th}>Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((m) => (
                        <tr key={m.ref}>
                          <td className={td}>{m.name}</td>
                          <td className={`${td} font-mono text-xs`}>{m.ref}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </details>
            ),
          )}
        </div>
      )}
    </Page>
  );
}

function ProviderCard({
  provider,
  kind,
  owner,
  onChanged,
}: {
  provider: ProviderDto;
  kind: ProviderKindDto | undefined;
  owner: boolean;
  onChanged: () => Promise<void>;
}) {
  const selfHosted = isSelfHosted(kind?.auth) || provider.models.length > 0;
  const takesKey = kind?.auth === "api-key" || kind?.auth === "optional-key";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modelsText, setModelsText] = useState(provider.models.join("\n"));
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const modelsDirty = modelsText !== provider.models.join("\n");

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const probe = () =>
    run("probe", async () => {
      const { models } = await api.probeProvider(provider.id);
      setModelsText(models.join("\n"));
    });

  function saveConnection(e: FormEvent) {
    e.preventDefault();
    void run("conn", async () => {
      await api.updateProvider(provider.id, {
        ...(selfHosted ? { baseUrl: baseUrl.trim() || null } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setApiKey("");
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">{provider.label}</h2>
            <Badge>{kind?.label ?? provider.kind}</Badge>
            {provider.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>}
            {provider.hasSecret && <Badge tone="accent">key stored</Badge>}
          </div>
          {provider.baseUrl && (
            <p className="mt-1 font-mono text-xs text-slate-500 dark:text-slate-400">
              {provider.baseUrl}
            </p>
          )}
        </div>
        {owner && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run("toggle", () =>
                  api.updateProvider(provider.id, { enabled: !provider.enabled }),
                )
              }
            >
              {provider.enabled ? "Disable" : "Enable"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm(`Delete provider "${provider.label}"?`)) {
                  void run("delete", () => api.deleteProvider(provider.id));
                }
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </div>

      {owner && (selfHosted || takesKey) && (
        <form onSubmit={saveConnection} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
          {selfHosted && (
            <TextField
              label="Base URL"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          )}
          {takesKey && (
            <TextField
              label={provider.hasSecret ? "Replace API key" : "API key"}
              type="password"
              autoComplete="off"
              placeholder={provider.hasSecret ? "Leave blank to keep the stored key" : ""}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
          <div className="flex items-end gap-2">
            <Button type="submit" disabled={busy !== null}>
              Save
            </Button>
            {provider.hasSecret && kind?.auth === "optional-key" && (
              <Button
                variant="ghost"
                disabled={busy !== null}
                onClick={() =>
                  void run("clear", () => api.updateProvider(provider.id, { apiKey: "" }))
                }
              >
                Clear key
              </Button>
            )}
          </div>
        </form>
      )}

      {selfHosted && (
        <div className="mt-4 space-y-2">
          {owner ? (
            <>
              <TextAreaField
                label="Model ids"
                hint="One per line. Probe asks the server for its model list."
                mono
                rows={Math.min(10, Math.max(3, modelsText.split("\n").length + 1))}
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy !== null} onClick={() => void probe()}>
                  {busy === "probe" ? "Probing…" : "Probe models"}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!modelsDirty || busy !== null}
                  onClick={() =>
                    void run("models", () =>
                      api.updateProvider(provider.id, { models: parseModels(modelsText) }),
                    )
                  }
                >
                  Save models
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm">
              <span className="font-medium">Models: </span>
              {provider.models.length ? provider.models.join(", ") : "none"}
            </p>
          )}
        </div>
      )}
      <div className="mt-3">
        <ErrorText>{error}</ErrorText>
      </div>
    </Card>
  );
}

export function AddProvider({
  kinds,
  onAdded,
}: {
  kinds: ProviderKindDto[];
  onAdded: () => Promise<void>;
}) {
  const firstAvailable = kinds.find((k) => !k.comingSoon)?.kind ?? "";
  const [kindId, setKindId] = useState(firstAvailable);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(OLLAMA_URL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kind = kinds.find((k) => k.kind === kindId);
  const auth = kind?.auth;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!kind || kind.comingSoon) return;
    setBusy(true);
    setError(null);
    try {
      await api.createProvider({
        kind: kind.kind,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(isSelfHosted(auth) && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...((auth === "api-key" || auth === "optional-key") && apiKey ? { apiKey } : {}),
      });
      setLabel("");
      setApiKey("");
      await onAdded();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-semibold">Add a provider</h2>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Kind"
            value={kindId}
            onChange={(e) => {
              setKindId(e.target.value);
              const k = kinds.find((x) => x.kind === e.target.value);
              setBaseUrl(k?.auth === "none" ? OLLAMA_URL : "");
            }}
          >
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind} disabled={k.comingSoon}>
                {k.label}
                {k.comingSoon ? " (coming soon)" : ""}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Label (optional)"
            placeholder={kind?.label}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        {kinds.some((k) => k.comingSoon) && (
          <Muted>
            Coming soon:{" "}
            {kinds
              .filter((k) => k.comingSoon)
              .map((k) => k.label)
              .join(", ")}
            .
          </Muted>
        )}
        {auth === "api-key" && (
          <TextField
            label="API key"
            type="password"
            autoComplete="off"
            required
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        )}
        {isSelfHosted(auth) && (
          <TextField
            label="Base URL"
            type="url"
            required
            placeholder={auth === "none" ? OLLAMA_URL : "https://example.local/v1"}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        )}
        {auth === "optional-key" && (
          <TextField
            label="API key (optional)"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        )}
        {isSelfHosted(auth) && (
          <Muted>After adding it, use Probe models on the provider to fetch its model list.</Muted>
        )}
        {(auth === "oauth" || auth === "external") && (
          <Muted>This provider signs in outside Shipmate; no key is needed here.</Muted>
        )}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" disabled={busy || !kind || kind.comingSoon}>
          {busy ? "Adding…" : "Add provider"}
        </Button>
      </form>
    </Card>
  );
}
