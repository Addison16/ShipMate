import type { CrewDetailDto, ModelOption } from "@shipmate/core";
import { useState } from "react";
import { api, errorMessage } from "../api.js";
import { CREW_DEFAULT, readModel, withModel } from "../lib/models.js";
import { ErrorText, SelectField } from "./ui.js";

export function ModelSelect({
  value,
  onChange,
  models,
  label = "Model",
  hint,
  disabled,
  crewDefault,
}: {
  value: string;
  onChange: (v: string) => void;
  models: ModelOption[] | null;
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** Offer "Crew default" (`model: default`), showing the model it currently means. */
  crewDefault?: string;
}) {
  // Only models something signed in or configured can run; a saved choice that no longer can
  // stays listed so the field still shows it.
  const usable = models?.filter((m) => m.available) ?? [];
  const current = models?.find((m) => m.ref === value);
  const offerDefault = crewDefault !== undefined;
  const listed = usable.some((m) => m.ref === value) || (offerDefault && value === CREW_DEFAULT);
  return (
    <SelectField
      label={label}
      hint={hint}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {!value && <option value="">Choose a model…</option>}
      {offerDefault && (
        <option value={CREW_DEFAULT}>Crew default{crewDefault ? ` (${crewDefault})` : ""}</option>
      )}
      {value && !listed && (
        <option value={value}>
          {current ? `${current.name} (${value})` : value} (not configured)
        </option>
      )}
      {usable.map((m) => (
        <option key={m.ref} value={m.ref}>
          {m.name} ({m.ref})
        </option>
      ))}
    </SelectField>
  );
}

/** A crew member's model, saved into its crew.yaml as soon as it is picked. */
export function CrewModelSelect({
  crew,
  models,
  crewDefault,
  readOnly,
  onSaved,
}: {
  crew: CrewDetailDto;
  models: ModelOption[] | null;
  crewDefault: string;
  readOnly: boolean;
  onSaved: (crew: CrewDetailDto) => void;
}) {
  const value = readModel(crew.manifestYaml);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    if (next === value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.updateCrew(crew.slug, {
        manifestYaml: withModel(crew.manifestYaml, next),
      });
      onSaved(res.crew);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 max-w-xl">
      <ModelSelect
        value={value}
        onChange={(v) => void change(v)}
        models={models}
        crewDefault={crewDefault}
        disabled={readOnly || busy}
        hint="Crew default follows the model picked in Settings. Pick another to give this crew member its own."
      />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
