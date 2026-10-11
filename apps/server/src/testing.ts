import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runMigrations } from "@shipmate/db";
import postgres from "postgres";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { DiscordClientPort } from "./discord/port.js";
import type { WeatherService } from "./services/weather.js";
import type { PushFetch } from "./push/webpush.js";
import type { SlackPort } from "./slack/port.js";
import type { TelegramPort } from "./telegram/port.js";

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
  } = {},
) {
  await resetDatabase(url);
  const dataDir = mkdtempSync(join(tmpdir(), "shipmate-test-"));
  const config = loadConfig({
    DATABASE_URL: url,
    SHIPMATE_DATA_DIR: dataDir,
    SHIPMATE_MCP: "off",
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dataDir, "auth.json"),
    modelsPath: join(dataDir, "models.json"),
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
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
  });
  await app.ready();
  return { app, faux, config };
}
