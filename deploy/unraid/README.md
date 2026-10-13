# Shipmate on Unraid

Shipmate is one container on Unraid. Its database is built in, so there is nothing else to
install first: no Postgres container, no database password, no compose file.

Shipmate is source-available under the PolyForm Noncommercial 1.0.0 license: free for
noncommercial use, not open source. Commercial use needs a separate license.

## Install (about 5 minutes)

**You need:** Unraid 6.12 or newer with Docker enabled (**Settings → Docker → Enable Docker:
Yes**), and your server's IP address (shown at the top of the Unraid web UI, e.g.
`192.168.1.10`). Below, replace `192.168.1.10` with yours.

### Step 1. Add the Shipmate template

Open the Unraid terminal (the **>_** icon at the top right of the Unraid web UI), paste this
whole block and press Enter:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user && curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-shipmate.xml https://raw.githubusercontent.com/Addison16/ShipMate/main/deploy/unraid/shipmate.xml && echo "Template added"
```

It prints `Template added`. Close the terminal. (Once Shipmate is listed in Community
Applications, searching "Shipmate" in the **Apps** tab does the same thing.)

### Step 2. Create the container

Go to the **Docker** tab, press **Add Container** at the bottom, and in the **Template**
dropdown pick **Shipmate** (under "User templates"). The form fills itself in.

### Step 3. Check these fields

Most are already right. Change only what the table says:

| Field | What to put | Notes |
|---|---|---|
| **Name** | `Shipmate` | Leave as is. |
| **Repository** | `ghcr.io/addison16/shipmate:latest` | Leave as is. |
| **Network Type** | `bridge` | Leave as is. |
| **Web UI port** | `3000` | Change it only if something else already uses 3000, e.g. to `3080`. |
| **Data** | `/mnt/user/appdata/shipmate` | Leave as is. Everything Shipmate keeps lives here, the database included. |
| **Docker socket** | `/var/run/docker.sock` | Keep it to let the Shipyard work on code in sandboxes. Delete this entry if you don't want that. |
| **DATABASE_URL** | *(leave empty)* | Empty means "use the built-in database". |
| **SHIPMATE_URL** | `http://192.168.1.10:3000` | Your server's IP and the Web UI port. Later, behind a reverse proxy, your https address. |
| **SHIPMATE_SECRET** | *(leave empty)* | Shipmate makes one on first start and keeps it in the Data folder. |

The other settings (under **Show more settings**) are optional; leave them alone.

### Step 4. Start it

Press **Apply**. Unraid downloads the image (a few minutes the first time) and starts the container.
When it shows **started** on the Docker tab, the first start takes a few more seconds to set
up the database.

### Step 5. Open Shipmate

On the Docker tab, click the Shipmate icon and choose **WebUI**, or browse to
`http://192.168.1.10:3000`. The first visit walks you through creating the owner account,
choosing a model and meeting the Captain. That is the whole install.

**On your phone:** open the same address and use **Add to Home Screen**. For notifications
and voice on a phone, Shipmate needs https; see [Reverse proxy](#reverse-proxy) below.

### Updating

When **Health** in Shipmate says a newer release is out, go to the Docker tab and press
**Check for Updates**, then **apply update** next to Shipmate. Your data stays in the Data
folder, and the database is upgraded automatically on start.

### If something goes wrong

- **The page doesn't load:** on the Docker tab, click the Shipmate icon → **Logs**. A line
  ending `Server listening at http://...:3000` means it is running; check the address and
  port you typed. Anything else in red there says what is wrong.
- **"Port already in use" on Apply:** set **Web UI port** to another number (e.g. `3080`),
  and use that port in **SHIPMATE_URL** and the address you open.
- **"the bundled database did not start":** the lines after it in the log say why. The usual
  cause is the Data folder on the array with the mover moving it; see the note on cache
  disks under [What goes where](#what-goes-where).
- **Check everything at once:** in the Unraid terminal run
  `docker exec -it Shipmate shipmate doctor`. It checks the database, data folder, key,
  Docker socket and free space, and says what to fix.

**No socket?** If you removed the Docker socket, you can still run Shipyard sandboxes on
another machine (rootless Podman, or a Docker host with TLS). Share
`/mnt/user/appdata/shipmate/workspaces` with it (NFS), then set it up under
**Settings → Shipyard sandbox** in Shipmate and press **Test connection**. Step by step:
[docs/shipyard.md](../../docs/shipyard.md#sandboxes-without-the-docker-socket).

## What goes where

| On the Unraid server | In the container | What it holds |
|---|---|---|
| `/mnt/user/appdata/shipmate` | `/data` | Crew folders, skills, Shipyard workspaces, chat files, sign-ins, the generated key (`.secret`), `backups/`, and the built-in database in `postgres/` (accounts, conversations, settings, encrypted keys) |
| `/var/run/docker.sock` | `/var/run/docker.sock` | Optional: Shipyard sandboxes and one-click updates |
| port `3000` | `3000/tcp` | Web app, API and WebSocket |

Keep appdata on a pool (cache) disk with the share set to stay there (e.g. **Primary storage:
cache, Secondary: none**, or "Prefer" on older Unraid): Postgres and the Shipyard's workspaces
write often, and the mover must not move a running database. Shipmate runs as root inside its
container and its files are owned by root (the `postgres/` folder by the container's database
user), so there is no `PUID`/`PGID` setting; don't run **New Permissions** or a "Docker Safe
New Perms" pass on these folders.

Every variable, with its default, is in [docs/configuration.md](../../docs/configuration.md).
The template shows the common ones; press **Show more settings** for the rest.

**A custom Docker network** makes the wiring simpler: from the Unraid terminal run
`docker network create shipmate`, then set **Network Type** to `shipmate` on Shipmate (and
Ollama, your reverse proxy or your own Postgres, if you use them). Containers then reach each
other by name (`Shipmate`, `ollama`, `shipmate-db`).

## Your own Postgres (optional)

To keep the database in a container of its own (or in a Postgres you already run), add one,
for example from Community Applications (search "postgres") or **Add Container**:

| Field | Value |
|---|---|
| Repository | `postgres:17` |
| Name | `shipmate-db` |
| Port | `5432` (host) → `5432` (container), or another free host port |
| Path | `/mnt/user/appdata/shipmate-db` → `/var/lib/postgresql/data` |
| `POSTGRES_USER` | `shipmate` |
| `POSTGRES_PASSWORD` | a long random password |
| `POSTGRES_DB` | `shipmate` |

and set Shipmate's **DATABASE_URL** to `postgres://shipmate:<password>@<unraid-ip>:5432/shipmate`
(or `@shipmate-db:5432` on a shared custom network). Any Postgres 15 or newer works.

**Already running Shipmate with a separate Postgres?** Nothing changes: with DATABASE_URL set,
the built-in database stays off. To move to the built-in one and retire the Postgres container:

1. In Shipmate, open **Settings → Backups** and press **Back up now**.
2. On the Docker tab, stop Shipmate.
3. Click Shipmate → **Edit**, clear **DATABASE_URL**, and press **Apply** (this starts it on a
   new, empty built-in database). Stop Shipmate again.
4. Restore your backup from the Unraid terminal, as under [Backups](#backups) below (no
   `DATABASE_URL` needed).
5. Start Shipmate and sign in as before. Once everything looks right, stop and remove the old
   Postgres container and delete `/mnt/user/appdata/shipmate-db`.

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

To restore, stop Shipmate, then from the Unraid terminal:

```bash
docker run --rm -it --volumes-from Shipmate ghcr.io/addison16/shipmate:latest \
  shipmate restore /data/backups/<file>.tar.gz --yes
```

This starts the built-in database just for the restore. With your own Postgres (left
running), add `-e DATABASE_URL='postgres://shipmate:<password>@<unraid-ip>:5432/shipmate'`
before the image name. Then start Shipmate again.

`docker exec -it Shipmate shipmate doctor`, while Shipmate runs, checks the database,
migrations, data folder, key, Docker socket and free space.
