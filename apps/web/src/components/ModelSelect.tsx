import type { CrewDetailDto, ModelOption } from "@shipmate/core";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useThemeText } from "../appearance.js";
import { CLAUDE_CODE_MODELS, readBackend, withBackend } from "../lib/claude-cli.js";
import {
  CLAUDE_CODE_PROVIDER,
  CODEX_PROVIDER,
  CREW_DEFAULT,
  CURSOR_PROVIDER,
  GEMINI_PROVIDER,
  groupByProvider,
  type ModelChoice,
  providerLabel,
  providerOf,
  readModel,
  withModel,
} from "../lib/models.js";
import { ErrorText, SelectField } from "./ui.js";

/**
 * Two dropdowns: where the model comes from (a provider, the Claude subscription, or the crew
 * default), then which of its models. Only models something signed in or configured can run are
 * offered; a saved choice that no longer can stays listed so the field still shows it.
 */
export function ModelSelect({
  value,
  onChange,
  models,
  label = "Runs on",
  hint,
  disabled,
  crewDefault,
  claudeCode,
  codexModels,
  cursorModels,
  geminiModels,
}: {
  value: string;
  onChange: (v: string) => void;
  models: ModelOption[] | null;
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** Offer "Crew default" (`model: default`), showing the model it currently means. */
  crewDefault?: string;
  /** Offer the Claude subscription's models (`claude-code/<alias>`). */
  claudeCode?: boolean;
  /** Codex models to offer (`codex/<id>`), when Codex is signed in. */
  codexModels?: ReadonlyArray<ModelChoice>;
  /** Cursor models to offer (`cursor/<slug>`), when Cursor is signed in. */
  cursorModels?: ReadonlyArray<ModelChoice>;
  /** Gemini CLI models to offer (`gemini-cli/<id>`), when it has a key or login. */
  geminiModels?: ReadonlyArray<ModelChoice>;
}) {
  const t = useThemeText();
  const groups = groupByProvider(
    (models ?? [])
      .filter((m) => m.available)
      .map((m) => ({ ref: m.ref, name: m.name, provider: m.provider })),
  );
  if (claudeCode) groups.set(CLAUDE_CODE_PROVIDER, [...CLAUDE_CODE_MODELS]);
  if (codexModels?.length) groups.set(CODEX_PROVIDER, [...codexModels]);
  if (cursorModels?.length) groups.set(CURSOR_PROVIDER, [...cursorModels]);
  if (geminiModels?.length) groups.set(GEMINI_PROVIDER, [...geminiModels]);
  const offerDefault = crewDefault !== undefined;
  const valueProvider = value === CREW_DEFAULT ? CREW_DEFAULT : providerOf(value);
  // A saved model nothing can run any more still shows, marked.
  if (
    value &&
    value !== CREW_DEFAULT &&
    !value.endsWith("/") &&
    !groups.get(valueProvider)?.some((m) => m.ref === value)
  ) {
    const known = models?.find((m) => m.ref === value);
    const list = groups.get(valueProvider) ?? [];
    groups.set(valueProvider, [
      { ref: value, name: `${known?.name ?? value} (not configured)` },
      ...list,
    ]);
  }
  const [provider, setProvider] = useState(valueProvider);
  useEffect(() => setProvider(valueProvider), [valueProvider]);
  const choices: ModelChoice[] = groups.get(provider) ?? [];

  const pickProvider = (p: string) => {
    setProvider(p);
    if (p === CREW_DEFAULT) onChange(CREW_DEFAULT);
    else if (p !== valueProvider) {
      const first = groups.get(p)?.[0];
      if (first) onChange(first.ref);
    }
  };

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={label}
          value={provider}
          onChange={(e) => pickProvider(e.target.value)}
          disabled={disabled}
        >
          {!provider && <option value="">Choose where it runs…</option>}
          {offerDefault && (
            <option value={CREW_DEFAULT}>
              {t("Crew default")}
              {crewDefault ? ` (${crewDefault})` : ""}
            </option>
          )}
          {[...groups.keys()].map((p) => (
            <option key={p} value={p}>
              {providerLabel(p)}
            </option>
          ))}
        </SelectField>
        {provider && provider !== CREW_DEFAULT && (
          <SelectField
            label="Model"
            value={choices.some((m) => m.ref === value) ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
          >
            {!choices.some((m) => m.ref === value) && <option value="">Choose a model…</option>}
            {choices.map((m) => (
              <option key={m.ref} value={m.ref}>
                {m.name}
              </option>
            ))}
          </SelectField>
        )}
      </div>
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * A crew member's model, saved into its crew.yaml as soon as it is picked. Picking a Claude
 * subscription model also moves it to the Claude Code backend, and any other model moves it back.
 */
export function CrewModelSelect({
  crew,
  models,
  crewDefault,
  claudeCode,
  readOnly,
  onSaved,
}: {
  crew: CrewDetailDto;
  models: ModelOption[] | null;
  crewDefault: string;
  /** Whether Claude Code is signed in. */
  claudeCode: boolean;
  readOnly: boolean;
  onSaved: (crew: CrewDetailDto) => void;
}) {
  const t = useThemeText();
  const onCli = readBackend(crew.manifestYaml) === "claude-code-cli";
  const saved = readModel(crew.manifestYaml);
  // On Claude Code a non-Claude model in crew.yaml means "the CLI's own default": show the
  // Claude subscription with no model picked yet.
  const value =
    onCli && providerOf(saved) !== CLAUDE_CODE_PROVIDER ? `${CLAUDE_CODE_PROVIDER}/` : saved;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    if (!next || next === value || next.endsWith("/")) return;
    setBusy(true);
    setError(null);
    try {
      const cli = providerOf(next) === CLAUDE_CODE_PROVIDER;
      const res = await api.updateCrew(crew.slug, {
        manifestYaml: withBackend(
          withModel(crew.manifestYaml, next),
          cli ? "claude-code-cli" : "pi",
        ),
      });
      onSaved(res.crew);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 max-w-2xl">
      <ModelSelect
        value={value}
        onChange={(v) => void change(v)}
        models={models}
        crewDefault={crewDefault}
        claudeCode={claudeCode || onCli}
        disabled={readOnly || busy}
        hint={t(
          onCli
            ? "Runs on your Claude subscription through Claude Code. Not available in Shipyard projects."
            : "Crew default follows the model picked in Settings → General. Pick a provider and model to give this crew member its own.",
        )}
      />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
