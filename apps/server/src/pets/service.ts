import type { PetImageSource, PetSettingsDto } from "@shipmate/core";
import { type Db, providers, secrets } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError } from "../auth.js";
import type { ChatGptService } from "../services/chatgpt.js";
import type { SettingsService } from "../services/settings.js";
import type { PetExt } from "./files.js";
import { isPng, tidyPetPicture } from "./png.js";

/** Provider kinds whose API has OpenAI's /images endpoints, so their key can be reused. */
const IMAGE_KINDS = ["openai", "openai-compatible"];
const OPENAI_BASE = "https://api.openai.com/v1";
const SETTINGS_KEY = "pets";
const KEY_REF = "pets:custom";
/** Pictures take a while, more so on a home server. */
const PAINT_TIMEOUT_MS = 180_000;
const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
/** OpenAI's image model; any other server gets the model typed in, or its own default. */
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";

interface Stored {
  source: PetImageSource;
  providerId: string | null;
  baseUrl: string | null;
  model: string;
}

const DEFAULTS: Stored = { source: "draw", providerId: null, baseUrl: null, model: "" };

export type PetFetch = typeof fetch;

/** What every image model is asked for, around the look the person and the Captain picked. */
export function picturePrompt(look: string): string {
  return [
    `A single original cartoon pet character: ${look.trim().replace(/\.$/, "")}.`,
    "Full body, centered, facing the viewer, cheerful and friendly, simple shapes, clean outlines, soft shading, sticker style.",
    "Plain flat white background with nothing else in the picture.",
    "No text, no letters, no logos, no frame, no ground shadow.",
    "An original design, not based on any existing character or brand.",
  ].join(" ");
}

/**
 * Pet pictures: where they come from (Settings → Photos and voice) and making one. With no image
 * model set up ("draw"), the Captain draws pets itself as SVGs, so pets always work.
 */
export class PetService {
  constructor(
    private readonly db: Db,
    private readonly vault: SecretVault,
    private readonly settings: SettingsService,
    private readonly chatgpt: Pick<ChatGptService, "status" | "accessToken">,
    private readonly fetchImpl: PetFetch = fetch,
  ) {}

  async config(): Promise<PetSettingsDto> {
    const stored = { ...DEFAULTS, ...(await this.settings.getJson<Partial<Stored>>(SETTINGS_KEY)) };
    const rows = await this.db.select().from(providers);
    return {
      ...stored,
      hasKey: Boolean(await this.#secret(KEY_REF)),
      providers: rows
        .filter((r) => IMAGE_KINDS.includes(r.kind))
        .map((r) => ({ id: r.id, label: r.label, kind: r.kind })),
      chatgptSignedIn: (await this.chatgpt.status()).signedIn,
    };
  }

  async update(input: Partial<Stored> & { apiKey?: string }): Promise<PetSettingsDto> {
    const current = await this.config();
    const { apiKey, ...rest } = input;
    const next: Stored = {
      source: current.source,
      providerId: current.providerId,
      baseUrl: current.baseUrl,
      model: current.model,
    };
    // A model name belongs to one service; moving to another starts from its default.
    if (
      (["source", "providerId", "baseUrl"] as const).some((k) => k in rest && rest[k] !== next[k])
    ) {
      next.model = "";
    }
    Object.assign(next, rest);
    if (next.source === "provider") {
      if (!next.providerId) throw new HttpError(400, "pick a provider");
      await this.#provider(next.providerId);
    }
    if (next.source === "custom") {
      const url = next.baseUrl ?? "";
      if (!/^https?:\/\/[^\s/]+/.test(url)) {
        throw new HttpError(400, "the server address must start with http:// or https://");
      }
      next.baseUrl = url.replace(/\/+$/, "");
    }
    if (apiKey !== undefined) {
      if (apiKey === "") await this.db.delete(secrets).where(eq(secrets.ref, KEY_REF));
      else {
        const ciphertext = this.vault.encrypt(apiKey.trim());
        await this.db
          .insert(secrets)
          .values({ ref: KEY_REF, ciphertext })
          .onConflictDoUpdate({ target: secrets.ref, set: { ciphertext, updatedAt: new Date() } });
      }
    }
    await this.settings.setJson(SETTINGS_KEY, next);
    return this.config();
  }

  /** Whether pictures come from an image model, and a line saying from where. */
  async painter(): Promise<{ paints: boolean; painter: string }> {
    const c = await this.config();
    const draw = "none set up, so you draw the pet yourself as an SVG (step 6).";
    switch (c.source) {
      case "chatgpt":
        return c.chatgptSignedIn
          ? { paints: true, painter: "made with the ChatGPT plan." }
          : { paints: false, painter: `ChatGPT is not signed in; ${draw}` };
      case "provider": {
        const p = c.providers.find((x) => x.id === c.providerId);
        return p
          ? { paints: true, painter: `made by the ${p.label} provider.` }
          : { paints: false, painter: draw };
      }
      case "custom":
        return c.baseUrl
          ? { paints: true, painter: `made by the image server at ${new URL(c.baseUrl).host}.` }
          : { paints: false, painter: draw };
      default:
        return { paints: false, painter: draw };
    }
  }

  /** Make a picture of `look` with the configured image model. Throws a readable error. */
  async paint(look: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; ext: PetExt }> {
    const c = await this.config();
    const prompt = picturePrompt(look);
    const timeout = AbortSignal.timeout(PAINT_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let bytes: Uint8Array;
    if (c.source === "chatgpt") {
      bytes = await this.#paintWithChatGpt(prompt, c.model, abort);
    } else if (c.source === "provider" || c.source === "custom") {
      const { base, key } = await this.#endpoint(c);
      bytes = await this.#paintWithImagesApi(base, key, c.model, prompt, abort);
    } else {
      throw new Error("no image model is set up");
    }
    if (isPng(bytes)) return { bytes: tidyPetPicture(bytes), ext: "png" };
    const ext = sniff(bytes);
    if (!ext) throw new Error("the image model sent something that is not a picture");
    return { bytes, ext };
  }

  /** OpenAI-compatible POST /images/generations. */
  async #paintWithImagesApi(
    base: string,
    key: string | null,
    model: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const openai = base.startsWith(OPENAI_BASE);
    const body = openai
      ? {
          model: model || DEFAULT_OPENAI_IMAGE_MODEL,
          prompt,
          n: 1,
          size: "1024x1024",
          background: "transparent",
          output_format: "png",
          quality: "medium",
        }
      : { ...(model ? { model } : {}), prompt, n: 1, size: "512x512", response_format: "b64_json" };
    const res = await this.#call(`${base}/images/generations`, key, signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      data?: Array<{ b64_json?: unknown; url?: unknown }>;
    } | null;
    const first = data?.data?.[0];
    if (typeof first?.b64_json === "string") return Buffer.from(first.b64_json, "base64");
    if (typeof first?.url === "string" && /^https?:\/\//.test(first.url)) {
      const pic = await this.#call(first.url, null, signal, { method: "GET" });
      return readCapped(pic);
    }
    throw new Error("the image model answered without a picture");
  }

  /**
   * The ChatGPT plan through OpenAI's public Responses API (the documented Sign in with ChatGPT
   * endpoint), asking for its image generation tool. OpenAI decides whether a plan's sign-in may
   * make pictures; when it refuses, the error says so and the Captain draws instead.
   */
  async #paintWithChatGpt(prompt: string, model: string, signal: AbortSignal) {
    const status = await this.chatgpt.status();
    if (!status.signedIn) throw new Error("ChatGPT is not signed in");
    const chosen =
      model ||
      status.models
        .map((ref) => ref.slice(ref.indexOf("/") + 1))
        .find((id) => /^gpt-/.test(id) && !/nano|mini/.test(id)) ||
      status.models[0]?.slice(status.models[0].indexOf("/") + 1);
    if (!chosen) throw new Error("the ChatGPT sign-in lists no models");
    const res = await this.#call(
      `${OPENAI_BASE}/responses`,
      await this.chatgpt.accessToken(),
      signal,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          model: chosen,
          input: `Draw this picture with the image generation tool: ${prompt}`,
          tools: [
            {
              type: "image_generation",
              size: "1024x1024",
              background: "transparent",
              output_format: "png",
              quality: "medium",
            },
          ],
          tool_choice: { type: "image_generation" },
          store: false,
          stream: true,
        }),
      },
    );
    return imageFromResponsesStream(await res.text());
  }

  async #call(
    url: string,
    key: string | null,
    signal: AbortSignal,
    init: RequestInit,
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw new Error("the image model took too long or was stopped");
      throw new Error(
        `cannot reach the image model at ${new URL(url).host} (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const detail = /"message"\s*:\s*"([^"]{1,300})"/.exec(body)?.[1] ?? body.slice(0, 300);
      throw new Error(`the image model answered ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res;
  }

  async #endpoint(c: Stored): Promise<{ base: string; key: string | null }> {
    if (c.source === "provider") {
      const row = await this.#provider(c.providerId ?? "");
      const key = row.secretRef ? await this.#secret(row.secretRef) : null;
      const base = (row.kind === "openai" ? OPENAI_BASE : row.baseUrl || OPENAI_BASE).replace(
        /\/+$/,
        "",
      );
      return { base, key };
    }
    return { base: c.baseUrl ?? "", key: await this.#secret(KEY_REF) };
  }

  async #provider(id: string) {
    const [row] = await this.db.select().from(providers).where(eq(providers.id, id)).limit(1);
    if (!row || !IMAGE_KINDS.includes(row.kind)) {
      throw new HttpError(
        400,
        "that provider cannot make pictures (use OpenAI or an OpenAI-compatible server)",
      );
    }
    return row;
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
}

/** The picture in a streamed Responses API answer (server-sent events), or a readable error. */
export function imageFromResponsesStream(text: string): Uint8Array {
  let failure: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const items: unknown[] = [];
    if (event.type === "response.output_item.done") items.push(event.item);
    if (event.type === "response.completed") {
      const output = (event.response as { output?: unknown[] } | undefined)?.output;
      if (Array.isArray(output)) items.push(...output);
    }
    for (const item of items) {
      const o = item as { type?: unknown; result?: unknown } | null;
      if (o?.type === "image_generation_call" && typeof o.result === "string" && o.result) {
        return Buffer.from(o.result, "base64");
      }
    }
    if (event.type === "error" || event.type === "response.failed") {
      const e =
        (event.error as { message?: unknown } | undefined) ??
        (event.response as { error?: { message?: unknown } } | undefined)?.error;
      failure = typeof e?.message === "string" ? e.message : "the request failed";
    }
  }
  throw new Error(
    failure
      ? `ChatGPT did not make the picture: ${failure}`
      : "ChatGPT answered without a picture (OpenAI may not allow pictures for this sign-in)",
  );
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_PICTURE_BYTES) throw new Error("the picture is too large");
  return bytes;
}

function sniff(bytes: Uint8Array): PetExt | null {
  const b = Buffer.from(bytes.subarray(0, 12));
  if (b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
    return "webp";
  return null;
}
