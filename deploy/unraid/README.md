# Shipmate on Unraid

Shipmate is one container plus a PostgreSQL database. On Unraid that means two containers:
the official Postgres image and Shipmate (from the template in this folder).

Shipmate is source-available under the PolyForm Noncommercial 1.0.0 license: free for
noncommercial use, not open source. Commercial use needs a separate license.

## 1. Postgres

In **Docker → Add Container** (or from Community Applications, search "postgres"):

| Field | Value |
|---|---|
| Repository | `postgres:17` |
| Name | `shipmate-db` |
| Port | `5432` (host) → `5432` (container), or another free host port |
| Path | `/mnt/user/appdata/shipmate-db` → `/var/lib/postgresql/data` |
| `POSTGRES_USER` | `shipmate` |
| `POSTGRES_PASSWORD` | a long random password |
| `POSTGRES_DB` | `shipmate` |

Any Postgres 15 or newer works, including one you already run; create a `shipmate` database
and user in it.

## 2. Shipmate

Add the template, either from Community Applications once it is listed, or by hand:

```bash
# on the Unraid server
mkdir -p /boot/config/plugins/dockerMan/templates-user
curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-shipmate.xml \
  https://raw.githubusercontent.com/Addison16/ShipMate/main/deploy/unraid/shipmate.xml
```

Then **Docker → Add Container → Template: shipmate** and fill in:

- **DATABASE_URL**: `postgres://shipmate:<password>@<unraid-ip>:5432/shipmate`.
  If both containers are on a custom Docker network (e.g. `docker network create shipmate`
  and Network Type set to it on both), use the container name instead:
  `postgres://shipmate:<password>@shipmate-db:5432/shipmate`.
- **SHIPMATE_URL**: the address people will open, e.g. `http://192.168.1.10:3000`, or
  `https://shipmate.example.com` behind a reverse proxy (SWAG, Nginx Proxy Manager, Traefik).
- **Data**: `/mnt/user/appdata/shipmate` (default).
- **Docker socket**: keep it to use the Shipyard's sandboxes; remove it to turn the Shipyard
  off. Whatever holds the socket can control Docker on the server.
- **SHIPMATE_SECRET**: leave empty to have one generated into `/data/.secret`.

Start it, open the Web UI, and create the owner account. Migrations run on every start, so
updating is "Check for updates → Apply update".

## Backups

Owners find **Settings → Backups** in the web app: back up now, download, delete, and a nightly
schedule (03:00 UTC by default, keeping the newest 7 nightly backups). Files land in
`/mnt/user/appdata/shipmate/backups`; set `SHIPMATE_BACKUP_DIR` and map another share to keep
them elsewhere, and include that folder in your Unraid backup routine (e.g. the Appdata
Backup plugin).

Stored API keys stay encrypted in a backup. The key is `/data/.secret` (included in every
backup) or `SHIPMATE_SECRET` if you set one: keep a copy of that somewhere safe.

To restore, stop Shipmate (Postgres keeps running), then from the Unraid terminal:

```bash
docker run --rm -it --volumes-from Shipmate \
  -e DATABASE_URL='postgres://shipmate:<password>@<unraid-ip>:5432/shipmate' \
  ghcr.io/addison16/shipmate:latest \
  shipmate restore /data/backups/<file>.tar.gz --yes
```

Then start Shipmate again. `shipmate doctor` (same command, `doctor` instead of `restore …`)
checks the database, migrations, data folder, key, Docker socket and free space.
