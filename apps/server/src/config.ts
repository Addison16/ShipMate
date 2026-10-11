import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  SHIPMATE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  SHIPMATE_DATA_DIR: z.string().default("/data"),
  SHIPMATE_SECRET: z.string().optional(),
  WEB_DIST: z.string().optional(),
  /** Where the starter crew templates live; the image sets /app/templates. */
  TEMPLATES_DIR: z.string().optional(),
  /** "off" skips starting MCP servers for crew sessions (tests, air-gapped installs). */
  SHIPMATE_MCP: z.enum(["on", "off"]).default("on"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.parse(env);
  mkdirSync(parsed.SHIPMATE_DATA_DIR, { recursive: true });
  const secret = parsed.SHIPMATE_SECRET || loadOrCreateSecret(parsed.SHIPMATE_DATA_DIR);
  return {
    ...parsed,
    SHIPMATE_SECRET: secret,
    TEMPLATES_DIR: parsed.TEMPLATES_DIR ?? defaultTemplatesDir(),
    dirs: dataDirs(parsed.SHIPMATE_DATA_DIR),
    /** Cookies get the Secure flag when the instance is served over https. */
    secureCookies: parsed.SHIPMATE_URL.startsWith("https://"),
  };
}

/** templates/ at the repo root, found relative to this file in both src/ and dist/. */
function defaultTemplatesDir(): string {
  return fileURLToPath(new URL("../../../templates", import.meta.url));
}

/** Generated once and kept on the volume so stored secrets stay readable across restarts. */
function loadOrCreateSecret(dataDir: string): string {
  const file = join(dataDir, ".secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function dataDirs(root: string) {
  const dirs = {
    root,
    crew: join(root, "crew"),
    skills: join(root, "skills"),
    workspaces: join(root, "workspaces"),
    /** Files people attach in chat, one per attachment id. */
    files: join(root, "files"),
    claudeConfig: join(root, "claude"),
    /** pi's agent directory: auth.json, models.json, mcp logs. */
    pi: join(root, "pi"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}
