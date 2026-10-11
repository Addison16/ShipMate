#!/usr/bin/env node
import { SHIPMATE_VERSION } from "@shipmate/core";
import { runMigrations } from "@shipmate/db";
import { backupCommand, restoreCommand } from "./backup.js";
import { doctorCommand } from "./doctor.js";
import { databaseUrl } from "./env.js";

const [cmd = "help", ...args] = process.argv.slice(2);

const HELP = `shipmate <command>

  version                                   print the version
  doctor                                    check the database, migrations, data folder,
                                            encryption key, Docker socket and disk space
  migrate                                   apply database migrations
  backup [--out file] [--include-workspaces]
                                            back up the database and the data folder to a
                                            .tar.gz (default: $SHIPMATE_BACKUP_DIR or
                                            <data>/backups); workspaces are left out unless asked
  restore <file> --yes                      replace the database and data folder with a backup
                                            (stop the server first)

Environment: DATABASE_URL, SHIPMATE_DATA_DIR (default /data), SHIPMATE_BACKUP_DIR,
SHIPMATE_SECRET, DOCKER_SOCKET.
`;

const commands: Record<string, () => Promise<void>> = {
  async version() {
    console.log(`shipmate ${SHIPMATE_VERSION}`);
  },
  doctor: doctorCommand,
  async migrate() {
    await runMigrations(databaseUrl());
    console.log("migrations applied");
  },
  backup: () => backupCommand(args),
  restore: () => restoreCommand(args),
  async help() {
    console.log(HELP);
  },
};
commands["--help"] = commands.help as () => Promise<void>;
commands["-h"] = commands.help as () => Promise<void>;

const run = commands[cmd];
if (!run) {
  console.error(`unknown command: ${cmd}\n\n${HELP}`);
  process.exit(2);
}
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
