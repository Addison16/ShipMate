import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import type { Services } from "../services.js";
import { MAX_AUDIO_BYTES, MAX_SPEECH_CHARS } from "../voice/service.js";

const Side = {
  providerId: z.string().uuid().nullable().optional(),
  baseUrl: z.string().max(500).nullable().optional(),
  model: z.string().trim().max(200).optional(),
  apiKey: z.string().max(500).optional(),
};

/** Drop keys zod left undefined (exactOptionalPropertyTypes). */
function defined<T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

export async function voiceRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/voice", async () => s.voice.status());

  app.get("/api/voice/settings", async (req) => {
    requireRole(req.user, "owner");
    return s.voice.config();
  });

  app.get("/api/voice/providers", async (req) => {
    requireRole(req.user, "owner");
    return { providers: await s.voice.audioProviders() };
  });

  app.put("/api/voice/settings", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        stt: z
          .object({
            source: z.enum(["off", "browser", "provider", "custom"]).optional(),
            language: z
              .string()
              .regex(/^([a-z]{2,3})?$/)
              .optional(),
            ...Side,
          })
          .strict()
          .optional(),
        tts: z
          .object({
            source: z.enum(["browser", "provider", "custom"]).optional(),
            voice: z.string().trim().max(100).optional(),
            ...Side,
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    return s.voice.update({
      ...(body.stt ? { stt: defined(body.stt) } : {}),
      ...(body.tts ? { tts: defined(body.tts) } : {}),
    });
  });

  await app.register(async (scope) => {
    const raw = (_req: unknown, body: Buffer, done: (err: null, body: Buffer) => void) =>
      done(null, body);
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_AUDIO_BYTES },
      raw,
    );
    scope.post("/api/voice/transcribe", { bodyLimit: MAX_AUDIO_BYTES }, async (req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new HttpError(400, "send the recording as the request body");
      }
      const declared = req.headers["x-audio-type"];
      const type = typeof declared === "string" && declared ? declared : "audio/webm";
      return { text: await s.voice.transcribe(req.body, type) };
    });
  });

  app.post("/api/voice/speak", async (req, reply) => {
    const { text } = z
      .object({ text: z.string().trim().min(1).max(MAX_SPEECH_CHARS) })
      .parse(req.body);
    const { audio, contentType } = await s.voice.speak(text);
    return reply
      .header("content-type", contentType)
      .header("cache-control", "no-store")
      .send(audio);
  });
}
