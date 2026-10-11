import type {
  SpeechToTextSource,
  TextToSpeechSource,
  UpdateVoiceSettingsRequest,
  VoiceSettingsDto,
} from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { useUser } from "../auth.js";
import { useResource } from "../lib/useResource.js";
import { voiceApi } from "../lib/voice.js";
import { Button, Card, ErrorText, Muted, SelectField, TextField } from "./ui.js";
import { refreshVoiceStatus, speaker, useVoiceStatus } from "./Voice.js";

type Side<T> = {
  source: T;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  extra: string;
};

const STT_SOURCES: Array<{ id: SpeechToTextSource; label: string }> = [
  { id: "off", label: "Off (no mic button)" },
  { id: "provider", label: "A provider (OpenAI or OpenAI-compatible)" },
  { id: "custom", label: "A speech server (local Whisper, speaches)" },
  { id: "browser", label: "The browser's own recognition" },
];
const TTS_SOURCES: Array<{ id: TextToSpeechSource; label: string }> = [
  { id: "browser", label: "The browser's own voice (no setup)" },
  { id: "provider", label: "A provider (OpenAI or OpenAI-compatible)" },
  { id: "custom", label: "A speech server (local Kokoro, speaches)" },
];

function fromDto<T>(s: VoiceSettingsDto["stt"] | VoiceSettingsDto["tts"], extra: string): Side<T> {
  return {
    source: s.source as T,
    providerId: s.providerId ?? "",
    baseUrl: s.baseUrl ?? "",
    model: s.model,
    apiKey: "",
    extra,
  };
}

/** Settings → Voice: where speech-to-text and text-to-speech run (owner), and a test. */
export function VoiceSettings() {
  const owner = useUser().role === "owner";
  const status = useVoiceStatus();
  if (!owner) {
    return (
      <Card>
        <h2 className="mb-1 font-semibold">Voice</h2>
        <Muted>
          {status?.stt === "off"
            ? "Talking to the crew is not set up on this instance yet; the owner can turn it on here."
            : "Tap the mic next to the message box to talk, and the speaker on a reply to hear it. Hands-free mode reads replies aloud as they arrive."}
        </Muted>
      </Card>
    );
  }
  return <VoiceSettingsForm />;
}

function VoiceSettingsForm() {
  const settings = useResource(() => voiceApi.settings());
  const providers = useResource(() => voiceApi.providers().then((r) => r.providers));
  const [stt, setStt] = useState<Side<SpeechToTextSource> | null>(null);
  const [tts, setTts] = useState<Side<TextToSpeechSource> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setStt(fromDto(settings.data.stt, settings.data.stt.language));
    setTts(fromDto(settings.data.tts, settings.data.tts.voice));
  }, [settings.data]);

  function body(): UpdateVoiceSettingsRequest {
    if (!stt || !tts) return {};
    const side = (s: Side<string>) => ({
      providerId: s.source === "provider" ? s.providerId || null : null,
      baseUrl: s.source === "custom" ? s.baseUrl.trim() : null,
      model: s.model.trim(),
      ...(s.apiKey ? { apiKey: s.apiKey } : {}),
    });
    return {
      stt: { source: stt.source, ...side(stt), language: stt.extra.trim().toLowerCase() },
      tts: { source: tts.source, ...side(tts), voice: tts.extra.trim() },
    };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      settings.setData(await voiceApi.update(body()));
      refreshVoiceStatus();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearKey(which: "stt" | "tts") {
    setError(null);
    try {
      settings.setData(await voiceApi.update({ [which]: { apiKey: "" } }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  function tryVoice() {
    speaker.unlock();
    const mode = settings.data?.tts.source === "browser" ? "browser" : "server";
    void speaker.speak("voice-test", "Ahoy! This is how the crew sounds on this device.", mode);
  }

  const options = providers.data ?? [];

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Voice</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Talk to the crew with the mic next to the message box and hear replies read aloud. Use a
        provider you already set up, or a speech server of your own (see the optional{" "}
        <code>voice</code> service in docker-compose). Save, then try it.
      </p>
      <ErrorText>{settings.error ?? providers.error}</ErrorText>
      {stt && tts && (
        <form onSubmit={save} className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-semibold">Speech to text (your voice)</legend>
            <SelectField
              label="Listen with"
              value={stt.source}
              onChange={(e) => setStt({ ...stt, source: e.target.value as SpeechToTextSource })}
              hint={
                stt.source === "browser"
                  ? "Works in Chrome, Edge and Safari. The browser may send the audio to its maker (Google or Apple) to recognise it."
                  : undefined
              }
            >
              {STT_SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </SelectField>
            <Endpoint
              side={stt}
              set={(p) => setStt({ ...stt, ...p })}
              providers={options}
              hasKey={settings.data?.stt.hasKey ?? false}
              onClearKey={() => void clearKey("stt")}
              modelHint="Empty uses gpt-4o-mini-transcribe on OpenAI, or Systran/faster-distil-whisper-small.en on a speech server."
            />
            {(stt.source === "provider" || stt.source === "custom") && (
              <TextField
                label="Language (optional)"
                placeholder="en"
                value={stt.extra}
                maxLength={3}
                onChange={(e) => setStt({ ...stt, extra: e.target.value })}
                hint="A two-letter code makes recognition faster and more accurate; empty detects it."
              />
            )}
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-semibold">
              Text to speech (the crew's voice)
            </legend>
            <SelectField
              label="Speak with"
              value={tts.source}
              onChange={(e) => setTts({ ...tts, source: e.target.value as TextToSpeechSource })}
            >
              {TTS_SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </SelectField>
            <Endpoint
              side={tts}
              set={(p) => setTts({ ...tts, ...p })}
              providers={options}
              hasKey={settings.data?.tts.hasKey ?? false}
              onClearKey={() => void clearKey("tts")}
              modelHint="Empty uses gpt-4o-mini-tts on OpenAI, or speaches-ai/Kokoro-82M-v1.0-ONNX on a speech server."
            />
            {(tts.source === "provider" || tts.source === "custom") && (
              <TextField
                label="Voice (optional)"
                placeholder="alloy, coral, af_heart…"
                value={tts.extra}
                onChange={(e) => setTts({ ...tts, extra: e.target.value })}
              />
            )}
          </fieldset>

          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button onClick={tryVoice}>Try the voice</Button>
            {saved && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>}
          </div>
        </form>
      )}
    </Card>
  );
}

function Endpoint({
  side,
  set,
  providers,
  hasKey,
  onClearKey,
  modelHint,
}: {
  side: Side<string>;
  set: (p: Partial<Omit<Side<string>, "source">>) => void;
  providers: Array<{ id: string; label: string; kind: string }>;
  hasKey: boolean;
  onClearKey: () => void;
  modelHint: string;
}) {
  if (side.source !== "provider" && side.source !== "custom") return null;
  return (
    <>
      {side.source === "provider" ? (
        <SelectField
          label="Provider"
          value={side.providerId}
          onChange={(e) => set({ providerId: e.target.value })}
          hint={
            providers.length
              ? "Its key and address are reused."
              : "No OpenAI or OpenAI-compatible provider yet. Add one on the Providers page, or use a speech server."
          }
        >
          <option value="">Choose…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.kind})
            </option>
          ))}
        </SelectField>
      ) : (
        <>
          <TextField
            label="Server address"
            placeholder="http://voice:8000/v1"
            value={side.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            hint="The OpenAI-compatible base URL, ending in /v1."
          />
          <div className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label="API key (optional)"
              type="password"
              autoComplete="off"
              placeholder={hasKey ? "Stored; type to replace" : "Not needed for most local servers"}
              value={side.apiKey}
              onChange={(e) => set({ apiKey: e.target.value })}
            />
            {hasKey && (
              <Button variant="ghost" onClick={onClearKey}>
                Remove key
              </Button>
            )}
          </div>
        </>
      )}
      <TextField
        label="Model (optional)"
        value={side.model}
        onChange={(e) => set({ model: e.target.value })}
        hint={modelHint}
      />
    </>
  );
}
