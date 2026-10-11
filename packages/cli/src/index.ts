#!/usr/bin/env node
import { SHIPMATE_VERSION } from "@shipmate/core";
import { runMigrations } from "@shipmate/db";

const [cmd = "help"] = process.argv.slice(2);

const commands: Record<string, () => Promise<void>> = {
  async version() {
    console.log(`shipmate ${SHIPMATE_VERSION}`);
  },
  async doctor() {
    const checks: Array<[string, boolean, string]> = [
      ["node >= 22", Number(process.versions.node.split(".")[0]) >= 22, process.versions.node],
      [
        "DATABASE_URL set",
        Boolean(process.env.DATABASE_URL),
        process.env.DATABASE_URL ? "set" : "missing",
      ],
      [
        "SHIPMATE_SECRET set",
        Boolean(process.env.SHIPMATE_SECRET),
        process.env.SHIPMATE_SECRET ? "set" : "missing",
      ],
    ];
    let ok = true;
    for (const [name, pass, detail] of checks) {
      ok &&= pass;
      console.log(`${pass ? "ok  " : "FAIL"} ${name} (${detail})`);
    }
    process.exitCode = ok ? 0 : 1;
  },
  async migrate() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    await runMigrations(url);
    console.log("migrations applied");
  },
  async help() {
    console.log(
      `shipmate <command>\n\n  version   print the version\n  doctor    check the environment\n  migrate   apply database migrations\n`,
    );
  },
};

const run = commands[cmd];
if (!run) {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
