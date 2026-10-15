import type { PetImageSource, PetSettingsDto } from "@shipmate/core";
import { type Db, providers, secrets } from "@shipmate/db";
import type { SecretVault } from "@shipmate/providers";
import { eq } from "drizzle-orm";
import { HttpError } from "../auth.js";
import type { SettingsService } from "../services/settings.js";
import type { CodexPainter } from "./codex.js";
import type { PetExt } from "./files.js";
import { isPng, tidyPetPicture } from "./png.js";

/** Provider kinds whose API has OpenAI's /images endpoints, so their key can be reused. */
const IMAGE_KINDS = ["openai", "openai-compatible"];
const OPENAI_BASE = "https://api.openai.com/v1";
const SETTINGS_KEY = "pets";
const KEY_REF = "pets:custom";
/** Pictures take a while, more so on a home server. */
const PAINT_TIMEOUT_MS = 180_000;
/** Codex's image tool says it can take a few minutes. */
const CODEX_PAINT_TIMEOUT_MS = 300_000;
const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
/** OpenAI's image model; any other server gets the model typed in, or its own default. */
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1";
/** What OpenAI charges for one medium-quality 1024x1024 gpt-image-1 picture. */
export const OPENAI_PICTURE_USD = 0.042;
/** How pictures made on a ChatGPT plan through Codex show on the cost page. */
export const CODEX_PICTURE_MODEL = "chatgpt-plan";

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
    private readonly fetchImpl: PetFetch = fetch,
    private readonly codex?: CodexPainter,
  ) {}

  async config(): Promise<PetSettingsDto> {
    const stored = { ...DEFAULTS, ...(await this.settings.getJson<Partial<Stored>>(SETTINGS_KEY)) };
    const rows = await this.db.select().from(providers);
    return {
      ...stored,
      hasKey: Boolean(await this.#secret(KEY_REF)),
      codexSignedIn: (await this.codex?.signedIn()) ?? false,
      providers: rows
        .filter((r) => IMAGE_KINDS.includes(r.kind))
        .map((r) => ({ id: r.id, label: r.label, kind: r.kind })),
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
      const url = (next.baseUrl ?? "").trim();
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {}
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
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
      case "provider": {
        const p = c.providers.find((x) => x.id === c.providerId);
        return p
          ? { paints: true, painter: `made by the ${p.label} provider.` }
          : { paints: false, painter: draw };
      }
      case "codex":
        return this.codex
          ? { paints: true, painter: "made on the owner's ChatGPT plan, through Codex." }
          : { paints: false, painter: draw };
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
    const bytes = await this.#generate(picturePrompt(look), true, signal);
    if (isPng(bytes)) return { bytes: tidyPetPicture(bytes), ext: "png" };
    const ext = sniff(bytes);
    if (!ext) throw new Error("the image model sent something that is not a picture");
    return { bytes, ext };
  }

  /**
   * Make any picture a crew member asks for (`make_picture`), with the same image model as
   * pets. Throws a readable error.
   */
  async picture(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{
    bytes: Uint8Array;
    ext: PetExt;
    model: string;
    costUsd: number;
    billing: "api" | "subscription";
  }> {
    const c = await this.config();
    const bytes = await this.#generate(prompt, false, signal);
    const ext = isPng(bytes) ? "png" : sniff(bytes);
    if (!ext) throw new Error("the image model sent something that is not a picture");
    if (c.source === "codex") {
      return { bytes, ext, model: CODEX_PICTURE_MODEL, costUsd: 0, billing: "subscription" };
    }
    const { base } = await this.#endpoint(c);
    const openai = base.startsWith(OPENAI_BASE);
    return {
      bytes,
      ext,
      model: c.model || (openai ? DEFAULT_OPENAI_IMAGE_MODEL : "default"),
      // OpenAI's price for one medium 1024px picture; other servers (often local) are not priced.
      costUsd: openai ? OPENAI_PICTURE_USD : 0,
      billing: "api",
    };
  }

  async #generate(prompt: string, sticker: boolean, signal?: AbortSignal): Promise<Uint8Array> {
    const c = await this.config();
    const timeout = AbortSignal.timeout(
      c.source === "codex" ? CODEX_PAINT_TIMEOUT_MS : PAINT_TIMEOUT_MS,
    );
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (c.source === "codex" && this.codex) {
      const bytes = await this.codex.paint(prompt, sticker, abort);
      if (bytes.length > MAX_PICTURE_BYTES) throw new Error("the picture is too large");
      return bytes;
    }
    if (c.source !== "provider" && c.source !== "custom") {
      throw new Error("no image model is set up");
    }
    const { base, key } = await this.#endpoint(c);
    return this.#paintWithImagesApi(base, key, c.model, prompt, sticker, abort);
  }

  /** OpenAI-compatible POST /images/generations. A sticker has a see-through background. */
  async #paintWithImagesApi(
    base: string,
    key: string | null,
    model: string,
    prompt: string,
    sticker: boolean,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const openai = base.startsWith(OPENAI_BASE);
    const body = openai
      ? {
          model: model || DEFAULT_OPENAI_IMAGE_MODEL,
          prompt,
          n: 1,
          size: "1024x1024",
          ...(sticker ? { background: "transparent" } : {}),
          output_format: "png",
          quality: "medium",
        }
      : {
          ...(model ? { model } : {}),
          prompt,
          n: 1,
          size: sticker ? "512x512" : "1024x1024",
          response_format: "b64_json",
        };
    const res = await this.#call(`${base}/images/generations`, key, signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      data?: Array<{ b64_json?: unknown; url?: unknown }>;
    } | null;
    const first = data?.data?.[0];
    if (typeof first?.b64_json === "string") {
      // base64 is 4 characters per 3 bytes; check before decoding.
      if (first.b64_json.length > (MAX_PICTURE_BYTES / 3) * 4 + 4) {
        throw new Error("the picture is too large");
      }
      return Buffer.from(first.b64_json, "base64");
    }
    if (typeof first?.url === "string" && /^https?:\/\//.test(first.url)) {
      const pic = await this.#call(first.url, null, signal, { method: "GET" });
      return readCapped(pic);
    }
    throw new Error("the image model answered without a picture");
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
