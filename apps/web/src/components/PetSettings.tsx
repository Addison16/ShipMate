import type { PetImageSource, PetSettingsDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { useThemeWords } from "../appearance.js";
import { useUser } from "../auth.js";
import { PET_SOURCES, petsApi } from "../lib/pets.js";
import { useResource } from "../lib/useResource.js";
import { href } from "../router.js";
import { Button, Card, cx, ErrorText, focusRing, Muted, SelectField, TextField } from "./ui.js";

const HINTS: Record<PetImageSource, string> = {
  draw: "Simple pet drawings. Works with any model. No other pictures.",
  provider: "Uses a provider's key. Costs a few cents a picture with OpenAI.",
  custom: "Any server with an OpenAI-style images API, such as LocalAI.",
};

/** Settings → Photos and voice: where pet pictures and `make_picture` pictures come from. */
export function PetSettings() {
  const owner = useUser().role === "owner";
  const words = useThemeWords();
  if (!owner) {
    return (
      <Card>
        <h2 className="mb-1 font-semibold">Pictures and pets</h2>
        <Muted>
          Ask {words.captain} for a pet, or ask anyone on the crew for a picture. The owner picks
          where pictures come from here.
        </Muted>
      </Card>
    );
  }
  return <PetSettingsForm captain={words.captain} />;
}

function PetSettingsForm({ captain }: { captain: string }) {
  const settings = useResource(() => petsApi.settings());
  const [source, setSource] = useState<PetImageSource>("draw");
  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setSource(d.source);
    setProviderId(d.providerId ?? d.providers[0]?.id ?? "");
    setBaseUrl(d.baseUrl ?? "");
    setModel(d.model);
  }, [settings.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next: PetSettingsDto = await petsApi.update({
        source,
        providerId: source === "provider" ? providerId || null : null,
        baseUrl: source === "custom" ? baseUrl.trim() : null,
        model: model.trim(),
        ...(apiKey ? { apiKey } : {}),
      });
      settings.setData(next);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const d = settings.data;
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Pictures and pets</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Makes pets and any picture you ask the crew for. If a pet picture fails, {captain} draws it
        instead.
      </p>
      <ErrorText>{settings.error}</ErrorText>
      {d && (
        <form onSubmit={save} className="space-y-4">
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Pictures come from</legend>
            {PET_SOURCES.map((s) => {
              const off = s.id === "provider" && d.providers.length === 0;
              return (
                <label
                  key={s.id}
                  className={cx(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent-600",
                    source === s.id
                      ? "border-accent-600 bg-accent-50 dark:border-accent-400 dark:bg-accent-950/40"
                      : "border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600",
                    off && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name="pet-source"
                    value={s.id}
                    checked={source === s.id}
                    disabled={off}
                    onChange={() => {
                      setSource(s.id);
                      setSaved(false);
                      if (s.id !== d.source) setModel("");
                    }}
                    className="mt-1 size-4 shrink-0 accent-accent-700"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {s.id === "draw" ? `${captain} draws them (no setup)` : s.label}
                    </span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      {off ? "Add an OpenAI or OpenAI-compatible provider first." : HINTS[s.id]}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {source === "provider" && (
            <SelectField
              label="Provider"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              {d.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </SelectField>
          )}
          {source === "custom" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Server address"
                type="url"
                required
                placeholder="http://localai:8080/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <TextField
                label="API key (optional)"
                type="password"
                autoComplete="off"
                placeholder={d.hasKey ? "Saved; type to replace" : ""}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          )}

          {source !== "draw" && (
            <details className="text-sm">
              <summary
                className={cx(
                  "cursor-pointer rounded font-medium text-slate-600 dark:text-slate-300",
                  focusRing,
                )}
              >
                More details
              </summary>
              <div className="mt-3 space-y-2">
                <TextField
                  label="Image model (optional)"
                  placeholder={
                    source === "provider" ? "gpt-image-1 for OpenAI" : "The server's default"
                  }
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Pet pictures are asked for as an original sticker-style character on a plain
                  background, which Shipmate clears. See{" "}
                  <a
                    className="text-accent-700 underline dark:text-accent-300"
                    href={href("/providers")}
                  >
                    Models and providers
                  </a>{" "}
                  to add keys. A ChatGPT plan can't be used here, since OpenAI only allows its
                  sign-in for chat. Crew on the Codex engine make pictures with the plan instead.
                </p>
              </div>
            </details>
          )}

          <ErrorText>{error}</ErrorText>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              Save
            </Button>
            {d.hasKey && source === "custom" && (
              <Button
                onClick={() =>
                  void petsApi
                    .update({ apiKey: "" })
                    .then(settings.setData)
                    .catch((err) => setError(errorMessage(err)))
                }
              >
                Remove key
              </Button>
            )}
            {saved && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>}
          </div>
        </form>
      )}
    </Card>
  );
}
