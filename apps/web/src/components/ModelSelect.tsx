import type { ModelOption } from "@shipmate/core";
import { SelectField } from "./ui.js";

export function ModelSelect({
  value,
  onChange,
  models,
  label = "Model",
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  models: ModelOption[] | null;
  label?: string;
  disabled?: boolean;
}) {
  // Only models something signed in or configured can run; a saved choice that no longer can
  // stays listed so the field still shows it.
  const usable = models?.filter((m) => m.available) ?? [];
  const current = models?.find((m) => m.ref === value);
  return (
    <SelectField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {!value && <option value="">Choose a model…</option>}
      {value && !usable.some((m) => m.ref === value) && (
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
