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
  const known = models?.some((m) => m.ref === value);
  return (
    <SelectField
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {!value && <option value="">Choose a model…</option>}
      {value && !known && <option value={value}>{value}</option>}
      {models?.map((m) => (
        <option key={m.ref} value={m.ref}>
          {m.name} ({m.ref}){m.available ? "" : " (not configured)"}
        </option>
      ))}
    </SelectField>
  );
}
