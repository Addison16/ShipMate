/**
 * HTTP contract for the phone features: push notifications, files in chat and voice.
 * Types only, like api.ts.
 */

// ---------- push notifications ----------

/** Which notifications a device gets. */
export interface PushEvents {
  /** A crew member waits for this person's OK (with Approve and Deny buttons). */
  approvals: boolean;
  /** One of this person's watches finished or failed. */
  watches: boolean;
  /** A crew reply on the Bridge while no Shipmate tab is open. */
  messages: boolean;
}

export interface PushDeviceDto {
  id: string;
  /** The push service URL; the web app matches it to its own subscription. */
  endpoint: string;
  label: string;
  events: PushEvents;
  lastSentAt: string | null;
  createdAt: string;
}

/** GET /api/push → PushStatusDto (the caller's devices, and the key to subscribe with). */
export interface PushStatusDto {
  /** VAPID public key (base64url), PushManager.subscribe's applicationServerKey. */
  publicKey: string;
  devices: PushDeviceDto[];
}

/**
 * POST /api/push/devices → { device } (subscribe this browser; same endpoint updates it)
 * PATCH /api/push/devices/:id { events } → { device }
 * DELETE /api/push/devices/:id → { ok: true }
 * POST /api/push/test → { sent, failed, removed } (a test notification to every device)
 * POST /api/push/act/approvals/:id { token, decision: "allow" | "deny" } → { ok: true }
 *   Public: the token from an approval notification is the credential. One use, 30 minutes.
 */
export interface SubscribePushRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  events?: Partial<PushEvents>;
}

/** What the service worker receives, decrypted. */
export interface PushPayload {
  kind: "approval" | "watch" | "message" | "test";
  title: string;
  body: string;
  /** Where a tap on the notification goes (a hash route of the web app). */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
  /** For approvals: the one-time token behind the Approve and Deny buttons. */
  approval?: { id: string; token: string };
}

// ---------- files in chat ----------

export type AttachmentKind = "image" | "pdf" | "text";

/**
 * A file attached to a message. Sent messages list theirs in `meta.attachments`.
 * Images go to the model as images (a vision-capable model takes the turn when the crew
 * member's cannot see them); PDFs and text files go as their text.
 */
export interface AttachmentDto {
  id: string;
  name: string;
  /** The type Shipmate detected from the content: image/*, application/pdf or text/plain. */
  mimeType: string;
  kind: AttachmentKind;
  size: number;
}
/**
 * POST /api/conversations/:id/attachments (body: the raw bytes, content-type
 *   application/octet-stream; headers x-file-name (URI-encoded) and x-file-type) → { attachment }
 *   Photos up to 10 MB, PDFs up to 20 MB, text files up to 1 MB.
 * Then send it: { type: "send", conversationId, text, attachments: [id, …] } on the WebSocket.
 * GET /api/attachments/:id → the file (only for the person who uploaded it)
 * DELETE /api/attachments/:id → { ok: true } (only while not yet sent)
 */

// ---------- voice ----------

/**
 * Where speech goes. "provider" reuses a configured OpenAI or OpenAI-compatible provider (its
 * key and address); "custom" is any OpenAI-compatible server (a local Whisper or Kokoro, e.g.
 * speaches); "browser" is the browser's own speech recognition or synthesis.
 */
export type SpeechToTextSource = "off" | "browser" | "provider" | "custom";
export type TextToSpeechSource = "browser" | "provider" | "custom";

/** GET /api/voice/settings (owner) → VoiceSettingsDto. Keys are never returned. */
export interface VoiceSettingsDto {
  stt: {
    source: SpeechToTextSource;
    providerId: string | null;
    /** For "custom": e.g. http://voice:8000/v1 */
    baseUrl: string | null;
    /** "" uses a default for the service (gpt-4o-mini-transcribe, or a faster-whisper model). */
    model: string;
    /** ISO 639-1 hint such as "en"; "" lets the model detect it. */
    language: string;
    hasKey: boolean;
  };
  tts: {
    source: TextToSpeechSource;
    providerId: string | null;
    baseUrl: string | null;
    /** "" uses a default (gpt-4o-mini-tts, or Kokoro). */
    model: string;
    /** "" uses a default (alloy, or af_heart). */
    voice: string;
    hasKey: boolean;
  };
}
/**
 * PUT /api/voice/settings (owner) { stt?, tts? } partial, plus `apiKey` per side for "custom"
 * ("" clears it) → VoiceSettingsDto
 * GET /api/voice/providers (owner) → { providers: { id, label, kind }[] } usable for voice
 */
export type UpdateVoiceSettingsRequest = {
  stt?: Partial<Omit<VoiceSettingsDto["stt"], "hasKey">> & { apiKey?: string };
  tts?: Partial<Omit<VoiceSettingsDto["tts"], "hasKey">> & { apiKey?: string };
};

/** GET /api/voice (anyone signed in) → VoiceStatusDto: how this instance listens and speaks. */
export interface VoiceStatusDto {
  stt: "off" | "browser" | "server";
  tts: "browser" | "server";
}
/**
 * POST /api/voice/transcribe (body: the recording as application/octet-stream, its type in
 *   x-audio-type; up to 25 MB) → { text }
 * POST /api/voice/speak { text } → audio (audio/mpeg), at most 4096 characters
 */
