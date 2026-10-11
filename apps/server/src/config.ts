import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  SHIPMATE_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  SHIPMATE_DATA_DIR: z.string().default("/data"),
  SHIPMATE_SECRET: z.string().optional(),
  WEB_DIST: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Env.parse(env);
  mkdirSync(parsed.SHIPMATE_DATA_DIR, { recursive: true });
  const secret = parsed.SHIPMATE_SECRET || loadOrCreateSecret(parsed.SHIPMATE_DATA_DIR);
  return { ...parsed, SHIPMATE_SECRET: secret, dirs: dataDirs(parsed.SHIPMATE_DATA_DIR) };
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
    claudeConfig: join(root, "claude"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}
