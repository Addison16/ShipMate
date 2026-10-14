#!/bin/sh
# Starts Shipmate. With no DATABASE_URL, it first starts the Postgres bundled in this image,
# keeping its files in <data>/postgres and listening only on a Unix socket inside the
# container, so one `docker run` (or one Unraid container) is a whole install.
#
# `shipmate <command>` as the container's command (e.g. a restore while Shipmate is stopped)
# gets the bundled database the same way; any other command runs as is.
set -e

DATA_DIR="${SHIPMATE_DATA_DIR:-/data}"
PGDATA="$DATA_DIR/postgres"
PGBIN="/usr/lib/postgresql/$PG_MAJOR/bin"
SOCKET_DIR=/run/postgresql

# The Codex CLI refuses to start when CODEX_HOME does not exist yet.
if [ -n "$CODEX_HOME" ]; then mkdir -p "$CODEX_HOME"; fi

if [ "$#" -eq 0 ] || [ "$*" = "node dist/main.js" ]; then
  set -- node dist/main.js
  server=1
elif [ "$1" = "shipmate" ]; then
  server=
else
  exec "$@"
fi

if [ -n "$DATABASE_URL" ]; then
  exec "$@"
fi

as_postgres() { runuser -u postgres -- "$@"; }

mkdir -p "$PGDATA" "$SOCKET_DIR"
chown postgres:postgres "$PGDATA" "$SOCKET_DIR"
chmod 700 "$PGDATA"
# An image whose postgres account had other IDs (0.3.0 used 100:102) leaves files Postgres can't
# open. Nothing is running on them yet, so hand the whole folder over once.
if [ -n "$(find "$PGDATA" \( ! -user postgres -o ! -group postgres \) -print -quit)" ]; then
  echo "shipmate: giving the bundled database files in $PGDATA to this image's postgres user"
  chown -R postgres:postgres "$PGDATA"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "shipmate: setting up the bundled database in $PGDATA"
  # Socket only, so trust is safe: nothing outside this container can connect.
  as_postgres "$PGBIN/initdb" -D "$PGDATA" -U shipmate --auth=trust \
    --encoding=UTF8 --locale=C.UTF-8 >/dev/null
elif [ "$(cat "$PGDATA/PG_VERSION")" != "$PG_MAJOR" ]; then
  echo "shipmate: $PGDATA holds a Postgres $(cat "$PGDATA/PG_VERSION") database, but this image bundles Postgres $PG_MAJOR." >&2
  echo "shipmate: restore a Shipmate backup into a fresh data folder, or set DATABASE_URL to an external Postgres." >&2
  exit 1
fi

# Two servers on one data folder would corrupt it, and a running Shipmate in another container
# can't be seen from here; a clean stop removes postmaster.pid.
if [ -z "$server" ] && [ -e "$PGDATA/postmaster.pid" ]; then
  echo "shipmate: the database in $PGDATA looks in use. Stop the Shipmate container first," >&2
  echo "shipmate: or run this inside it: docker exec -it <container> $*" >&2
  exit 1
fi

# Started fresh each time, so the log only holds this run (warnings and errors).
as_postgres sh -c ': > "$1"' sh "$PGDATA/server.log"
if ! as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" -w -t 120 -l "$PGDATA/server.log" start \
  -o "-c listen_addresses='' -c unix_socket_directories=$SOCKET_DIR -c log_min_messages=warning" \
  >/dev/null; then
  echo "shipmate: the bundled database did not start:" >&2
  cat "$PGDATA/server.log" >&2
  exit 1
fi

if ! as_postgres "$PGBIN/psql" -h "$SOCKET_DIR" -U shipmate -d postgres -tAc \
  "select 1 from pg_database where datname = 'shipmate'" | grep -q 1; then
  as_postgres "$PGBIN/createdb" -h "$SOCKET_DIR" -U shipmate shipmate
fi

export DATABASE_URL="postgres://shipmate@%2Frun%2Fpostgresql/shipmate"

stop_db() { as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null || true; }

# Run it in the background so a stop or Ctrl-C reaches it and the database still shuts down
# cleanly afterwards. fd 3 hands it the real stdin: a background job's would be /dev/null,
# and a one-off command (e.g. `shipmate restore` without --yes) may ask a question.
exec 3<&0
"$@" <&3 3<&- &
app=$!
exec 3<&-
trap 'kill -TERM "$app" 2>/dev/null' TERM INT
# A trapped signal ends the first wait early; the second waits for the command to finish.
status=0
wait "$app" || status=$?
if kill -0 "$app" 2>/dev/null; then
  wait "$app" || status=$?
fi
stop_db
exit "$status"
