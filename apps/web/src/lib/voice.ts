import type { UpdateVoiceSettingsRequest, VoiceSettingsDto, VoiceStatusDto } from "@shipmate/core";
import { ApiError, request } from "../api.js";

export const voiceApi = {
  status: () => request<VoiceStatusDto>("GET", "/api/voice"),
  settings: () => request<VoiceSettingsDto>("GET", "/api/voice/settings"),
  providers: () =>
    request<{ providers: Array<{ id: string; label: string; kind: string }> }>(
      "GET",
      "/api/voice/providers",
    ),
  update: (body: UpdateVoiceSettingsRequest) =>
    request<VoiceSettingsDto>("PUT", "/api/voice/settings", body),

  async transcribe(audio: Blob): Promise<string> {
    const res = await send("/api/voice/transcribe", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-audio-type": audio.type },
      body: audio,
    });
    const data = (await res.json()) as { text?: string };
    return data.text ?? "";
  },

  async speak(text: string): Promise<Blob> {
    const res = await send("/api/voice/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.blob();
  },
};

async function send(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Cannot reach the Shipmate server.");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `${res.status} ${res.statusText}`);
  }
  return res;
}

/** Recording formats in order of preference; Whisper servers take all of them. */
const RECORDER_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/webm",
];

/** The first recording format this browser supports (Safari records mp4, others webm). */
export function recorderType(isSupported: (type: string) => boolean): string | undefined {
  return RECORDER_TYPES.find((t) => isSupported(t));
}

/**
 * What to say aloud for a crew reply written in Markdown: code is mentioned, not read out;
 * links and emphasis become plain words; tables and lists read as sentences.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/(?:www\.)?([^/\s]+)\S*/g, "a link to $1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
    .replace(/^\s*\|(.*)\|\s*$/gm, "$1")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/(?<![\w*])(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1(?![\w*])/g, "$2")
    .replace(/\n{2,}/g, ".\n")
    .replace(/([.!?:;,])\.(\n|$)/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+([.!?,:;])/g, "$1")
    .trim();
}

/**
 * Browsers cut off long utterances (Chrome after about 15 seconds), so speak sentence-sized
 * pieces one after another.
 */
export function speechChunks(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [];
  const out: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if ((current ? `${current} ${s}` : s).length <= max) {
      current = current ? `${current} ${s}` : s;
      continue;
    }
    if (current) out.push(current);
    if (s.length <= max) {
      current = s;
      continue;
    }
    // A very long sentence: break at commas or spaces.
    let rest = s;
    while (rest.length > max) {
      const cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf(" ", max));
      const at = cut > max / 3 ? cut + 1 : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    current = rest;
  }
  if (current) out.push(current);
  return out;
}
