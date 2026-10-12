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

**No socket?** Remove the Docker socket path and run sandboxes elsewhere: rootless Podman on
another machine, or a Docker host with TLS. Share `/mnt/user/appdata/shipmate/workspaces` with
it (NFS), then set it up under **Settings → Shipyard sandbox** in Shipmate (or the advanced
`DOCKER_HOST` variables) and press **Test connection**. Step by step:
[docs/shipyard.md](../../docs/shipyard.md#sandboxes-without-the-docker-socket).

Start it, open the Web UI, and create the owner account. Migrations run on every start, so
updating is "Check for updates → Apply update". The **Health** page in Shipmate shows when a
newer release is out; it leaves the update itself to Unraid so the template stays in step.

## What goes where

| On the Unraid server | In the container | What it holds |
|---|---|---|
| `/mnt/user/appdata/shipmate-db` | `/var/lib/postgresql/data` (Postgres) | The database: accounts, conversations, settings, encrypted keys |
| `/mnt/user/appdata/shipmate` | `/data` (Shipmate) | Crew folders, skills, Shipyard workspaces, chat files, sign-ins, the generated key (`.secret`) and `backups/` |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Optional: Shipyard sandboxes and one-click updates |
| port `3000` | `3000/tcp` | Web app, API and WebSocket |

Keep appdata on a pool (cache) disk with the share set to stay there (e.g. **Primary storage:
cache, Secondary: none**, or "Prefer" on older Unraid): Postgres and the Shipyard's workspaces
write often, and the mover must not move a running database. Shipmate runs as root inside its
container and its files are owned by root, so there is no `PUID`/`PGID` setting; don't run
**New Permissions** or a "Docker Safe New Perms" pass on these folders.

Every variable, with its default, is in [docs/configuration.md](../../docs/configuration.md).
The template shows the common ones; press **Show more settings** for the rest.

**A custom Docker network** makes the wiring simpler: from the Unraid terminal run
`docker network create shipmate`, then set **Network Type** to `shipmate` on Postgres, Shipmate
(and Ollama and your reverse proxy, if you use them). Containers then reach each other by name
(`shipmate-db`, `Shipmate`, `ollama`), and Postgres no longer needs a host port at all.

## Reverse proxy

Give Shipmate its own subdomain (e.g. `shipmate.example.com`; a sub-path is not supported), set
**SHIPMATE_URL** to `https://shipmate.example.com`, and restart. Then:

- **Nginx Proxy Manager**: a proxy host to `http://<unraid-ip>:3000` (or `Shipmate:3000` on a
  shared custom network), **Websockets Support** on, a Let's Encrypt certificate with **Force
  SSL**, and `client_max_body_size 30m;` under **Advanced**.
- **SWAG**: a `shipmate.subdomain.conf` in `/mnt/user/appdata/swag/nginx/proxy-confs/`.
- **Traefik**, **Caddy** and **Cloudflare Tunnel** work too.

Configs for each are in [docs/reverse-proxy.md](../../docs/reverse-proxy.md). The default
**SHIPMATE_TRUST_PROXY** already trusts a proxy on the server, on a Docker network or on the
LAN. Afterwards, open **Health** in Shipmate: the **Web address** check confirms the address
and https got through. With an https `SHIPMATE_URL`, sign in at that address rather than at
`http://<unraid-ip>:3000`, since the sign-in cookie is https-only.

## Local models (optional)

To run models on the server with no API key, add Ollama as a third container (Community
Applications: search "ollama", or Repository `ollama/ollama`, with a path such as
`/mnt/user/appdata/ollama` → `/root/.ollama` and port `11434`). Then set Shipmate's
**SHIPMATE_OLLAMA_URL** (advanced view) to `http://<unraid-ip>:11434`, or to
`http://ollama:11434` when both are on the same custom Docker network. As the owner, open
**Providers → Local model (Ollama)**, download a model (progress shows on the page) and press
**Use this model**. See [docs/local-models.md](../../docs/local-models.md) for which to pick.

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
