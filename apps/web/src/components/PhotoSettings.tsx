import type { SettingsDto } from "@shipmate/core";
import { useEffect, useState } from "react";
import { api, errorMessage, request } from "../api.js";
import { useThemeText } from "../appearance.js";
import { useUser } from "../auth.js";
import { useResource } from "../lib/useResource.js";
import { Button, Card, ErrorText, SelectField } from "./ui.js";

/** Settings → Photos: which model looks at photos when a crew member's own cannot. */
export function PhotoSettings() {
  const owner = useUser().role === "owner";
  const t = useThemeText();
  const settings = useResource(() => api.getSettings());
  const models = useResource(() => api.listModels().then((r) => r.models));
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settings.data) setValue(settings.data.visionModel);
  }, [settings.data]);

  const vision = (models.data ?? []).filter((m) => m.images && m.available);

  async function save() {
    setError(null);
    setSaved(false);
    try {
      const next = await request<SettingsDto>("PUT", "/api/settings", { visionModel: value });
      settings.setData(next);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Photos</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t(
          "Photos sent in chat go to the crew member's own model when it can see images. When it can't, this model takes that one message, and the chat says so.",
        )}
      </p>
      <ErrorText>{settings.error ?? models.error}</ErrorText>
      {settings.data && models.data && (
        <div className="space-y-3">
          <SelectField
            label="Model for photos"
            value={value}
            disabled={!owner}
            onChange={(e) => setValue(e.target.value)}
            hint={
              vision.length
                ? "Automatic prefers a model from the same provider, then the default model."
                : "None of the configured models can see images. Add a provider such as Anthropic, OpenAI or Google."
            }
          >
            <option value="">Automatic</option>
            {value && !vision.some((m) => m.ref === value) && (
              <option value={value}>{value} (not available)</option>
            )}
            {vision.map((m) => (
              <option key={m.ref} value={m.ref}>
                {m.name} ({m.ref})
              </option>
            ))}
          </SelectField>
          <ErrorText>{error}</ErrorText>
          {owner && (
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                disabled={value === settings.data.visionModel}
                onClick={() => void save()}
              >
                Save
              </Button>
              {saved && (
                <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
