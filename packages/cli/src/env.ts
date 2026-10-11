import { join } from "node:path";

/** Where the server keeps its data, matching apps/server's config (SHIPMATE_DATA_DIR). */
export function dataDir(): string {
  return process.env.SHIPMATE_DATA_DIR || "/data";
}

/** Where backups go, matching the server (SHIPMATE_BACKUP_DIR, else <data>/backups). */
export function backupDir(): string {
  return process.env.SHIPMATE_BACKUP_DIR || join(dataDir(), "backups");
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return url;
}

/** Split argv into positionals and --flags (`--out file` and `--out=file` both work). */
export function parseArgs(argv: string[], valued: string[] = []) {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) flags[name] = arg.slice(eq + 1);
    else if (valued.includes(name)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      flags[name] = value;
    } else flags[name] = true;
  }
  return { flags, positional };
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
