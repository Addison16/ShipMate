import type { VoiceStatusDto } from "@shipmate/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { errorMessage } from "../api.js";
import { recorderType, speakableText, speechChunks, voiceApi } from "../lib/voice.js";
import { cx, focusRing } from "./ui.js";

// ---------- status ----------

let statusPromise: Promise<VoiceStatusDto> | null = null;

/** How this instance listens and speaks; fetched once per page load. */
export function useVoiceStatus(): VoiceStatusDto | null {
  const [status, setStatus] = useState<VoiceStatusDto | null>(null);
  useEffect(() => {
    let live = true;
    statusPromise ??= voiceApi.status().catch(() => {
      statusPromise = null;
      return { stt: "off", tts: "browser" } as VoiceStatusDto;
    });
    void statusPromise.then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, []);
  return status;
}

/** Forget the cached status (after the owner changes the voice settings). */
export function refreshVoiceStatus() {
  statusPromise = null;
}

// ---------- speaking ----------

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function recognitionClass(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as
    | (new () => SpeechRecognitionLike)
    | null;
}

/** A tiny silent clip, played inside a tap so iOS lets the page play audio later on its own. */
const SILENCE = `data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0Ya${"A".repeat(218)}`;

/**
 * One voice for the whole app: speaks a crew reply with the server's voice (falling back to
 * the browser's) and stops whatever was playing first.
 */
class Speaker {
  #audio: HTMLAudioElement | null = null;
  #url: string | null = null;
  #listeners = new Set<() => void>();
  #token = 0;
  /** The id of what is being spoken, or null. */
  current: string | null = null;

  subscribe = (l: () => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };

  /** Call from a tap: lets iOS play replies that arrive later without another tap. */
  unlock() {
    const a = this.#element();
    a.src = SILENCE;
    void a.play().catch(() => {});
    if ("speechSynthesis" in window) window.speechSynthesis.resume();
  }

  async speak(id: string, markdown: string, mode: VoiceStatusDto["tts"]): Promise<void> {
    this.stop();
    const text = speakableText(markdown);
    if (!text) return;
    const token = ++this.#token;
    this.#set(id);
    try {
      if (mode === "server") {
        try {
          const blob = await voiceApi.speak(text.slice(0, 4096));
          if (token !== this.#token) return;
          await this.#play(blob, token);
          return;
        } catch {
          if (token !== this.#token) return;
          // The speech service is down: the browser's voice is better than silence.
        }
      }
      await this.#browser(text, token);
    } finally {
      if (token === this.#token) this.#set(null);
    }
  }

  stop() {
    this.#token++;
    if (this.#audio) this.#audio.pause();
    if (this.#url) URL.revokeObjectURL(this.#url);
    this.#url = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.#set(null);
  }

  #element(): HTMLAudioElement {
    this.#audio ??= new Audio();
    return this.#audio;
  }

  #play(blob: Blob, token: number): Promise<void> {
    const a = this.#element();
    this.#url = URL.createObjectURL(blob);
    a.src = this.#url;
    return new Promise((resolve) => {
      // Ends when the clip does, fails, or something else starts or stops speech.
      const check = setInterval(() => token !== this.#token && done(), 250);
      const done = () => {
        clearInterval(check);
        a.onended = null;
        a.onerror = null;
        resolve();
      };
      a.onended = done;
      a.onerror = done;
      a.play().catch(done);
    });
  }

  async #browser(text: string, token: number): Promise<void> {
    if (!("speechSynthesis" in window)) return;
    for (const chunk of speechChunks(text)) {
      if (token !== this.#token) return;
      await new Promise<void>((resolve) => {
        const u = new SpeechSynthesisUtterance(chunk);
        u.onend = () => resolve();
        u.onerror = () => resolve();
        window.speechSynthesis.speak(u);
      });
    }
  }

  #set(id: string | null) {
    this.current = id;
    for (const l of this.#listeners) l();
  }
}

export const speaker = new Speaker();

function useSpeaking(): string | null {
  return useSyncExternalStore(speaker.subscribe, () => speaker.current);
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {on ? (
        <path d="M16 9l5 6M21 9l-5 6" />
      ) : (
        <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
      )}
    </svg>
  );
}

/** "Listen" on a crew reply. */
export function ListenButton({ id, text }: { id: string; text: string }) {
  const status = useVoiceStatus();
  const speaking = useSpeaking() === id;
  if (!status || (status.tts === "browser" && !("speechSynthesis" in window))) return null;
  return (
    <button
      type="button"
      onClick={() => {
        if (speaking) speaker.stop();
        else {
          speaker.unlock();
          void speaker.speak(id, text, status.tts);
        }
      }}
      title={speaking ? "Stop" : "Listen"}
      className={cx(
        "rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200",
        speaking && "text-accent-700 dark:text-accent-300",
        focusRing,
      )}
    >
      <SpeakerIcon on={speaking} />
      <span className="sr-only">{speaking ? "Stop reading aloud" : "Read aloud"}</span>
    </button>
  );
}

// ---------- listening ----------

/** Longest recording, so a forgotten mic does not run forever. */
const MAX_RECORDING_MS = 120_000;

type MicState = "idle" | "recording" | "transcribing";

/**
 * Tap to talk, tap again to stop. The recording goes to the server's speech-to-text (or the
 * browser's own recognition when that is what the owner chose) and the text comes back.
 */
export function MicButton({
  mode,
  onText,
  onError,
  disabled,
}: {
  mode: VoiceStatusDto["stt"];
  onText: (text: string) => void;
  onError: (message: string | null) => void;
  disabled?: boolean;
}) {
  const [state, setState] = useState<MicState>("idle");
  const stopRef = useRef<(() => void) | null>(null);
  // A recording outlives the render that started it: hand the text to the current callbacks,
  // which see the composer as it is now (files attached or finished uploading meanwhile).
  const onTextRef = useRef(onText);
  const onErrorRef = useRef(onError);
  onTextRef.current = onText;
  onErrorRef.current = onError;

  useEffect(() => () => stopRef.current?.(), []);

  const supported =
    mode === "server"
      ? typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)
      : mode === "browser"
        ? recognitionClass() !== null
        : false;
  if (!supported) return null;

  async function startServer() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onErrorRef.current(
        "Shipmate needs microphone access. Allow it in the browser's site settings.",
      );
      return;
    }
    const type = recorderType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const timer = setTimeout(
      () => recorder.state === "recording" && recorder.stop(),
      MAX_RECORDING_MS,
    );
    recorder.onstop = async () => {
      clearTimeout(timer);
      for (const track of stream.getTracks()) track.stop();
      stopRef.current = null;
      const audio = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      if (!audio.size) {
        setState("idle");
        return;
      }
      setState("transcribing");
      try {
        const text = await voiceApi.transcribe(audio);
        if (text) onTextRef.current(text);
        else onErrorRef.current("Didn't catch that. Try again a little closer to the mic.");
      } catch (err) {
        onErrorRef.current(errorMessage(err));
      } finally {
        setState("idle");
      }
    };
    stopRef.current = () => recorder.state === "recording" && recorder.stop();
    recorder.start();
    setState("recording");
  }

  function startBrowser() {
    const Recognition = recognitionClass();
    if (!Recognition) return;
    const r = new Recognition();
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.maxAlternatives = 1;
    let heard = "";
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((res) => res[0]?.transcript ?? "")
        .join(" ")
        .trim();
    };
    r.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") {
        onErrorRef.current(
          e.error === "not-allowed"
            ? "Shipmate needs microphone access. Allow it in the browser's site settings."
            : `Speech recognition failed (${e.error}).`,
        );
      }
    };
    r.onend = () => {
      stopRef.current = null;
      setState("idle");
      if (heard) onTextRef.current(heard);
    };
    stopRef.current = () => r.stop();
    r.start();
    setState("recording");
  }

  function toggle() {
    onError(null);
    if (state === "recording") {
      stopRef.current?.();
      return;
    }
    if (state !== "idle") return;
    speaker.stop();
    speaker.unlock();
    if (mode === "server") void startServer();
    else startBrowser();
  }

  const label =
    state === "recording" ? "Stop and send" : state === "transcribing" ? "Listening…" : "Talk";
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || state === "transcribing"}
      title={label}
      aria-pressed={state === "recording"}
      className={cx(
        "relative inline-flex size-[42px] shrink-0 items-center justify-center rounded-lg border disabled:opacity-50",
        state === "recording"
          ? "border-red-400 bg-red-600 text-white"
          : "border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800",
        focusRing,
      )}
    >
      {state === "recording" && (
        <span
          className="absolute inset-0 animate-ping rounded-lg bg-red-500/40"
          aria-hidden="true"
        />
      )}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={cx("relative", state === "transcribing" && "animate-pulse")}
      >
        {state === "recording" ? (
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
        ) : (
          <>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
          </>
        )}
      </svg>
      <span className="sr-only">{label}</span>
    </button>
  );
}

// ---------- hands-free ----------

const HANDS_FREE_KEY = "shipmate.handsFree";

/** Hands-free: replies are read aloud as they arrive, and what you say is sent right away. */
export function useHandsFree(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(HANDS_FREE_KEY) === "1";
    } catch {
      return false;
    }
  });
  function set(next: boolean) {
    setOn(next);
    if (next) speaker.unlock();
    else speaker.stop();
    try {
      window.localStorage.setItem(HANDS_FREE_KEY, next ? "1" : "0");
    } catch {
      // Private mode: it just will not be remembered.
    }
  }
  return [on, set];
}
