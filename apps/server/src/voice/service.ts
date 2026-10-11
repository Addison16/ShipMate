import type { VoiceSettingsDto, VoiceStatusDto } from "@shipmate/core";
import { type Db, providers, secrets } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError } from "../auth.js";
import type { SettingsService } from "../services/settings.js";

/** Provider kinds whose API has OpenAI's /audio endpoints, so their key can be reused. */
const AUDIO_KINDS = ["openai", "openai-compatible"];
const OPENAI_BASE = "https://api.openai.com/v1";
const SETTINGS_KEY = "voice";
const keyRef = (side: "stt" | "tts") => `voice:${side}`;

/** OpenAI's limit for /audio/transcriptions; local servers take the same. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
/** OpenAI's limit for one /audio/speech request. */
export const MAX_SPEECH_CHARS = 4096;

export const DEFAULT_VOICE: VoiceSettingsDto = {
  stt: { source: "off", providerId: null, baseUrl: null, model: "", language: "", hasKey: false },
  tts: { source: "browser", providerId: null, baseUrl: null, model: "", voice: "", hasKey: false },
};

/** Sensible models when none is typed in, by where requests go. */
function defaults(base: string) {
  const openai = base.startsWith(OPENAI_BASE);
  return {
    stt: openai ? "gpt-4o-mini-transcribe" : "Systran/faster-distil-whisper-small.en",
    tts: openai ? "gpt-4o-mini-tts" : "speaches-ai/Kokoro-82M-v1.0-ONNX",
    voice: openai ? "alloy" : "af_heart",
  };
}

export type VoiceFetch = typeof fetch;

/**
 * Voice: speech-to-text and text-to-speech through OpenAI-compatible /audio endpoints, either
 * a configured provider's (its key reused) or any server the owner points at (a local Whisper
 * or Kokoro, e.g. the optional `voice` compose service). The browser's own speech synthesis
 * (and, if chosen, recognition) needs nothing here.
 */
export class VoiceService {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    private readonly settings: SettingsService,
    private readonly fetchImpl: VoiceFetch = fetch,
  ) {}

  async config(): Promise<VoiceSettingsDto> {
    const stored = (await this.settings.getJson<Partial<VoiceSettingsDto>>(SETTINGS_KEY)) ?? {};
    return {
      stt: {
        ...DEFAULT_VOICE.stt,
        ...stored.stt,
        hasKey: await this.#hasKey("stt"),
      },
      tts: {
        ...DEFAULT_VOICE.tts,
        ...stored.tts,
        hasKey: await this.#hasKey("tts"),
      },
    };
  }

  /** What the web app needs: whether to show the mic and how to speak replies. */
  async status(): Promise<VoiceStatusDto> {
    const c = await this.config();
    return {
      stt: c.stt.source === "off" ? "off" : c.stt.source === "browser" ? "browser" : "server",
      tts: c.tts.source === "browser" ? "browser" : "server",
    };
  }

  async update(input: {
    stt?: Partial<VoiceSettingsDto["stt"]> & { apiKey?: string };
    tts?: Partial<VoiceSettingsDto["tts"]> & { apiKey?: string };
  }): Promise<VoiceSettingsDto> {
    const current = await this.config();
    const next = { stt: { ...current.stt }, tts: { ...current.tts } };
    for (const side of ["stt", "tts"] as const) {
      const patch = input[side];
      if (!patch) continue;
      const { apiKey, hasKey: _ignored, ...rest } = patch;
      // Model and voice names belong to one service; moving to another starts from its defaults.
      const moved = (["source", "providerId", "baseUrl"] as const).some(
        (k) => k in rest && rest[k] !== current[side][k],
      );
      if (moved) {
        next[side].model = "";
        if (side === "tts") next.tts.voice = "";
      }
      Object.assign(next[side], rest);
      if (next[side].source === "provider") {
        if (!next[side].providerId) throw new HttpError(400, "pick a provider");
        await this.#provider(next[side].providerId as string);
      }
      if (next[side].source === "custom") {
        const url = next[side].baseUrl ?? "";
        if (!/^https?:\/\/[^\s/]+/.test(url)) {
          throw new HttpError(400, "the server address must start with http:// or https://");
        }
        next[side].baseUrl = url.replace(/\/+$/, "");
      }
      if (apiKey !== undefined) {
        if (apiKey === "") await this.db.delete(secrets).where(eq(secrets.ref, keyRef(side)));
        else await this.#setKey(side, apiKey.trim());
      }
    }
    const strip = <T extends { hasKey: boolean }>({ hasKey: _h, ...v }: T) => v;
    await this.settings.setJson(SETTINGS_KEY, { stt: strip(next.stt), tts: strip(next.tts) });
    return this.config();
  }

  /** Audio in, text out (OpenAI-compatible /audio/transcriptions). */
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const c = (await this.config()).stt;
    if (c.source !== "provider" && c.source !== "custom") {
      throw new HttpError(
        409,
        "Speech-to-text on the server is not set up. An owner can turn it on in Settings → Voice.",
      );
    }
    const { base, key } = await this.#endpoint("stt", c);
    const type = mimeType.split(";")[0]?.trim() || "audio/webm";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type }), `speech.${extensionOf(type)}`);
    form.append("model", c.model || defaults(base).stt);
    form.append("response_format", "json");
    if (c.language) form.append("language", c.language);
    const res = await this.#call(`${base}/audio/transcriptions`, key, {
      method: "POST",
      body: form,
    });
    const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
    if (typeof data?.text !== "string")
      throw new HttpError(502, "The speech service sent no text back.");
    return data.text.trim();
  }

  /** Text in, MP3 out (OpenAI-compatible /audio/speech). */
  async speak(text: string): Promise<{ audio: Buffer; contentType: string }> {
    const c = (await this.config()).tts;
    if (c.source !== "provider" && c.source !== "custom") {
      throw new HttpError(409, "Replies are spoken by the browser on this instance.");
    }
    const { base, key } = await this.#endpoint("tts", c);
    const d = defaults(base);
    const res = await this.#call(`${base}/audio/speech`, key, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: c.model || d.tts,
        voice: c.voice || d.voice,
        input: text.slice(0, MAX_SPEECH_CHARS),
        response_format: "mp3",
      }),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new HttpError(502, "The speech service sent no audio back.");
    return {
      audio,
      contentType: res.headers.get("content-type")?.startsWith("audio/")
        ? (res.headers.get("content-type") as string)
        : "audio/mpeg",
    };
  }

  /** Providers whose key can be reused for voice (the settings page offers these). */
  async audioProviders(): Promise<Array<{ id: string; label: string; kind: string }>> {
    const rows = await this.db.select().from(providers);
    return rows
      .filter((r) => AUDIO_KINDS.includes(r.kind))
      .map((r) => ({ id: r.id, label: r.label, kind: r.kind }));
  }

  async #endpoint(
    side: "stt" | "tts",
    c: { source: string; providerId: string | null; baseUrl: string | null },
  ): Promise<{ base: string; key: string | null }> {
    if (c.source === "provider") {
      const row = await this.#provider(c.providerId ?? "");
      const key = row.secretRef ? await this.#secret(row.secretRef) : null;
      const base = (row.kind === "openai" ? OPENAI_BASE : row.baseUrl || OPENAI_BASE).replace(
        /\/+$/,
        "",
      );
      return { base, key };
    }
    return { base: c.baseUrl ?? "", key: await this.#secret(keyRef(side)) };
  }

  async #call(url: string, key: string | null, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new HttpError(502, `Cannot reach the speech service at ${new URL(url).host}.`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = /"message"\s*:\s*"([^"]{1,200})"/.exec(body)?.[1] ?? body.slice(0, 200);
      throw new HttpError(
        502,
        `The speech service answered ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return res;
  }

  async #provider(id: string) {
    const [row] = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    if (!row || !AUDIO_KINDS.includes(row.kind)) {
      throw new HttpError(
        400,
        "that provider has no speech service (use OpenAI or an OpenAI-compatible server)",
      );
    }
    return row;
  }

  async #hasKey(side: "stt" | "tts"): Promise<boolean> {
    const [row] = await this.db
      .select({ ref: secrets.ref })
      .from(secrets)
      .where(eq(secrets.ref, keyRef(side)))
      .limit(1);
    return Boolean(row);
  }

  async #secret(ref: string): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.ref, ref)).limit(1);
    if (!row) return null;
    try {
      return this.vault.decrypt(row.ciphertext);
    } catch {
      return null;
    }
  }

  async #setKey(side: "stt" | "tts", key: string) {
    const ciphertext = this.vault.encrypt(key);
    await this.db
      .insert(secrets)
      .values({ ref: keyRef(side), ciphertext })
      .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
  }
}

/** A file name extension Whisper servers recognise for the recorder's type. */
export function extensionOf(type: string): string {
  if (type.includes("webm")) return "webm";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "mp4";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  return "webm";
}
