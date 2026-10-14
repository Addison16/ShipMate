import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { conversations, runMigrations } from "@shipmate/db";
import { desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { DiscordClientPort } from "./discord/port.js";
import type { PushFetch } from "./push/webpush.js";
import type { WeatherService } from "./services/weather.js";
import type { SlackPort } from "./slack/port.js";
import type { TelegramPort } from "./telegram/port.js";
import type { VoiceFetch } from "./voice/service.js";

/**
 * Database for integration tests; they are skipped when it is unset. The tests wipe it, so it is
 * deliberately separate from DATABASE_URL.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** Wipe the database and apply migrations from scratch. */
export async function resetDatabase(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(
      "drop schema if exists drizzle cascade; drop schema public cascade; create schema public;",
    );
  } finally {
    await sql.end();
  }
  await runMigrations(url);
}

/** A full app on a fresh database and data dir, with a scripted "faux/m" model. */
export async function testApp(
  url: string,
  options: {
    watches?: boolean;
    discordPort?: DiscordClientPort;
    telegramPort?: TelegramPort;
    slackPort?: SlackPort;
    weather?: WeatherService;
    pushFetch?: PushFetch;
    voiceFetch?: VoiceFetch;
    googleFetch?: typeof fetch;
    petFetch?: typeof fetch;
    /** Extra config variables (e.g. SHIPMATE_UPDATE_CHECK). */
    env?: Record<string, string>;
  } = {},
) {
  await resetDatabase(url);
  const dataDir = mkdtempSync(join(tmpdir(), "shipmate-test-"));
  const config = loadConfig({
    DATABASE_URL: url,
    SHIPMATE_DATA_DIR: dataDir,
    SHIPMATE_MCP: "off",
    // Never ask the real GitHub for releases from tests.
    SHIPMATE_UPDATE_CHECK: "off",
    ...options.env,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dataDir, "auth.json"),
    modelsPath: join(dataDir, "models.json"),
    allowModelNetwork: false,
  });
  // "m" sees images; "text-only" does not (photos in chat route to a vision model).
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "m" }, { id: "text-only", input: ["text"] }],
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const app = await buildApp(config, {
    modelRuntime,
    extraProviders: ["faux"],
    logger: false,
    watches: options.watches ?? false,
    ...(options.discordPort ? { discordPort: options.discordPort } : {}),
    ...(options.telegramPort ? { telegramPort: options.telegramPort } : {}),
    ...(options.slackPort ? { slackPort: options.slackPort } : {}),
    ...(options.weather ? { weather: options.weather } : {}),
    ...(options.pushFetch ? { pushFetch: options.pushFetch } : {}),
    ...(options.voiceFetch ? { voiceFetch: options.voiceFetch } : {}),
    ...(options.googleFetch ? { googleFetch: options.googleFetch } : {}),
    ...(options.petFetch ? { petFetch: options.petFetch } : {}),
  });
  await app.ready();
  return { app, faux, config };
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * A crew reply with a stored picture, in the newest conversation on `surface`, as the Bridge
 * sends it. It also lists a PDF (not a picture) and a picture whose file is gone; the relays
 * skip both.
 */
export async function emitCrewPicture(
  app: Awaited<ReturnType<typeof testApp>>["app"],
  surface: string,
  content: string,
) {
  const [conv] = await app.db
    .select()
    .from(conversations)
    .where(eq(conversations.surface, surface))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (!conv) throw new Error(`no ${surface} conversation`);
  const picture = await app.services.files.upload(conv.userId, conv.id, {
    name: "chart.png",
    type: "image/png",
    data: TINY_PNG,
  });
  const gone = { ...picture, id: randomUUID(), name: "gone.png" };
  const pdf = { ...picture, id: randomUUID(), name: "notes.pdf", kind: "pdf" as const };
  app.services.bridge.emit(conv.userId, {
    type: "message",
    conversationId: conv.id,
    message: {
      id: randomUUID(),
      conversationId: conv.id,
      role: "assistant",
      content,
      author: { kind: "crew", slug: "captain", name: "Captain" },
      meta: { attachments: [picture, pdf, gone] },
      createdAt: new Date().toISOString(),
    },
  });
  return picture;
}
