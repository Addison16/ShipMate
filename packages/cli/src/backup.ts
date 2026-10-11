import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { SHIPMATE_VERSION } from "@shipmate/core";
import { backupFileName, createBackup, readBackupManifest, restoreBackup } from "@shipmate/db";
import { backupDir, databaseUrl, dataDir, formatBytes, parseArgs } from "./env.js";

/** shipmate backup [--out file] [--include-workspaces] */
export async function backupCommand(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv, ["out"]);
  const url = databaseUrl();
  const out =
    typeof flags.out === "string" ? resolve(flags.out) : join(backupDir(), backupFileName("cli"));
  if (existsSync(out)) throw new Error(`${out} already exists`);
  const started = Date.now();
  const result = await createBackup({
    url,
    dataDir: dataDir(),
    outFile: out,
    includeWorkspaces: flags["include-workspaces"] === true,
    trigger: "cli",
    version: SHIPMATE_VERSION,
    exclude: [backupDir()],
  });
  const rows = result.manifest.tables.reduce((n, t) => n + t.rows, 0);
  console.log(
    `backup written: ${result.file} (${formatBytes(result.sizeBytes)}, ${result.manifest.tables.length} tables, ${rows} rows, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );
}

/** shipmate restore <file> --yes */
export async function restoreCommand(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  const [file] = positional;
  if (!file) throw new Error("usage: shipmate restore <file> --yes");
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`${path} not found`);
  const manifest = await readBackupManifest(path);
  console.log(
    `backup: ${path}\n  made ${manifest.createdAt} by Shipmate ${manifest.shipmateVersion} (${manifest.trigger}), schema ${manifest.migrations.last ?? manifest.migrations.count}\n  workspaces ${manifest.includeWorkspaces ? "included" : "not included"}`,
  );
  if (flags.yes !== true) {
    console.error(
      "\nThis REPLACES every row in the database and the contents of the data folder" +
        ` (${dataDir()}).\nStop the Shipmate server first, then run again with --yes.`,
    );
    process.exitCode = 2;
    return;
  }
  console.warn("warning: the Shipmate server should be stopped while restoring.");
  const result = await restoreBackup({
    url: databaseUrl(),
    dataDir: dataDir(),
    file: path,
    keep: [backupDir()],
  });
  const rows = Object.values(result.rows).reduce((n, r) => n + r, 0);
  console.log(
    `restored ${Object.keys(result.rows).length} tables (${rows} rows) and the data folder`,
  );
  if (result.skippedTables.length) {
    console.warn(`skipped tables this version no longer has: ${result.skippedTables.join(", ")}`);
  }
  if (!process.env.SHIPMATE_SECRET && !existsSync(join(dataDir(), ".secret"))) {
    console.warn("warning: no SHIPMATE_SECRET and no .secret file; stored keys cannot be read");
  } else {
    console.log("start the server again; stored keys need the same SHIPMATE_SECRET as before");
  }
}
