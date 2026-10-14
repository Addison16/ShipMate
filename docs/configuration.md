# Configuration

Everything Shipmate reads from its environment, and what it keeps in `/data`. Most installs set
one variable (`SHIPMATE_URL`) and leave the rest alone. Everything else (providers, chat bridges, OIDC, backups, the Shipyard sandbox)
is set up in the web app by the owner and stored in the database.

On a NAS, see also [the Unraid guide](../deploy/unraid/README.md) and
[the TrueNAS guide](../deploy/truenas/README.md). Behind a reverse proxy, see
[reverse-proxy.md](reverse-proxy.md).

## The essentials

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | built-in database | Leave unset to use the Postgres built into the image (see [The database](#the-database)). Or an external Postgres 15 or newer: `postgres://user:password@host:5432/database`. URL-encode special characters in the password (`@` → `%40`, `:` → `%3A`, `/` → `%2F`). |
| `SHIPMATE_URL` | `http://localhost:3000` | The address people open Shipmate at, exactly as they type it, with no path: `http://192.168.1.10:3000`, or `https://shipmate.example.com` behind a reverse proxy. Used for links in notifications and chat bridges, GitHub webhooks, OIDC redirects, and push notifications. Sign-in cookies are marked Secure whenever the browser reached Shipmate over https, so signing in also works at a plain http LAN address. |
| `SHIPMATE_SECRET` | generated | The key that encrypts stored API keys and tokens. Leave it empty and Shipmate generates one into `/data/.secret` on first start. If you set it, keep it forever: without it, stored secrets cannot be read, even from a backup. |

The **Health** page (owners and admins) checks that `SHIPMATE_URL` matches the address you
opened the page at, and says what to change when it does not.

## The database

With no `DATABASE_URL`, the container starts the Postgres 17 built into the image before
Shipmate and keeps its files in `/data/postgres`, so one container and one folder are a whole
install. It listens only on a socket inside the container: nothing else on your network (not
even other containers) can reach it, so it needs no password or port. It stops cleanly with
the container.

Set `DATABASE_URL` to use your own Postgres 15 or newer instead (a `postgres` container beside
Shipmate, as `docker-compose.yml` does, or one you already run). Shipmate then never starts the
built-in one. Installs set up before the built-in database existed have `DATABASE_URL` set and
carry on unchanged.

**Switching between them** goes through a backup, since each keeps its own data: back up in
**Settings → Backups**, stop Shipmate, change (or clear) `DATABASE_URL`, then restore with the
container stopped:

```bash
docker run --rm -it --volumes-from shipmate ghcr.io/addison16/shipmate:latest \
  shipmate restore /data/backups/<file>.tar.gz --yes
```

Start Shipmate again afterwards. (`--volumes-from` takes your container's name; with an
external database, add `-e DATABASE_URL=…` too.) Backups hold the database as tables, never
`/data/postgres`'s raw files, and a restore leaves that folder in place.

While Shipmate is running, run the command line inside it instead, e.g.
`docker exec -it shipmate shipmate doctor` or `shipmate backup`. A `docker run` of the image
refuses to start the built-in database while another container is using it.

## Server

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the web app and API listen on inside the container. Change the host side of the port mapping instead, unless you use host networking. |
| `HOST` | `0.0.0.0` | Address to listen on. |
| `SHIPMATE_TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which reverse proxies to believe about the browser's address and https (`X-Forwarded-For`, `-Proto`, `-Host`). The default trusts proxies on the same machine and on private networks (10.x, 172.16-31.x, 192.168.x, Docker networks). A comma list of IPs or CIDR ranges narrows it (e.g. `172.18.0.0/16`); `off` trusts none; `all` trusts any, only when nothing but the proxy can reach Shipmate's port. See [reverse-proxy.md](reverse-proxy.md#trusting-the-proxy). |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs go to the container's output (`docker logs shipmate`). |
| `SHIPMATE_DATA_DIR` | `/data` | Where Shipmate keeps its files (see the layout below). Leave it as is in Docker and map a host folder to `/data`. |

## Shipyard sandboxes

The Shipyard runs code in a sandbox container per project. With nothing set it uses the
Docker socket mounted at `/var/run/docker.sock`; without one, the Shipyard is off. The owner
can also pick a sandbox host in **Settings → Shipyard sandbox**, which overrides these. See
[shipyard.md](shipyard.md#sandboxes-without-the-docker-socket).

| Variable | Default | What it does |
|---|---|---|
| `SHIPMATE_HOST_DATA_DIR` | detected | The host path of the folder mapped to `/data` (e.g. `/mnt/user/appdata/shipmate`), so sandbox containers bind the right folder. Shipmate finds it by inspecting its own container; set it if sandboxes start with an empty project folder. |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Path of the Docker socket inside the container. |
| `DOCKER_HOST` | unset | Instead of the socket: `unix:///run/podman/podman.sock` (rootless Podman) or `tcp://sandbox-host.lan:2376` (a Docker or Podman host elsewhere). |
| `DOCKER_TLS_VERIFY` | unset | `1` to use TLS client certificates for a `tcp://` host. |
| `DOCKER_CERT_PATH` | unset | Folder with `ca.pem`, `cert.pem` and `key.pem`, e.g. `/data/sandbox-certs`. |
| `SHIPMATE_SANDBOX_WORKSPACES` | unset | Where a remote sandbox host sees Shipmate's `workspaces` folder (shared over NFS), e.g. `/mnt/shipmate/workspaces`. |
| `SHIPMATE_SANDBOX_IMAGE` | `node:22-bookworm` | Default sandbox image; each project can pick its own. |

## Models, voice and notifications

| Variable | Default | What it does |
|---|---|---|
| `SHIPMATE_OLLAMA_URL` | `http://ollama:11434` | Ollama server for local models, checked in first-run setup and on Providers. See [local-models.md](local-models.md). |
| `SHIPMATE_LOCAL_MODEL` | `qwen3:4b` | docker-compose only: the model the `local-ai` profile downloads on first start. |
| `SHIPMATE_PUSH_HOSTS` | unset | Extra Web Push service hosts to accept, comma-separated, besides the browser makers' own. |
| `SHIPMATE_CLAUDE_BIN` | `claude` | Path of the Claude Code CLI, for the Claude subscription backend. The image ships it. |
| `CLAUDE_CONFIG_DIR` | `/data/claude` | Where the Claude Code CLI keeps its sign-in. Set by the image so it survives updates. |
| `SHIPMATE_BROWSER_PATH` | `/usr/bin/chromium` | The Chromium the browser MCP server drives. The image ships it; outside Docker, leave it unset and Playwright uses its own download. |
| `SHIPMATE_CODEX_BIN` | `codex` | Path of the Codex CLI, for the Codex engine (ChatGPT plan). The image ships it. |
| `CODEX_HOME` | `/data/codex` | Where the Codex CLI keeps its sign-in. Set by the image so it survives updates. |

## Updates, backups and offline installs

| Variable | Default | What it does |
|---|---|---|
| `SHIPMATE_BACKUP_DIR` | `/data/backups` | Where backups are written. Map another host folder to it to keep backups off the appdata disk. |
| `SHIPMATE_UPDATE_CHECK` | `on` | `off` never asks GitHub for new releases. |
| `SHIPMATE_MCP` | `on` | `off` skips starting MCP servers for crew sessions (air-gapped installs). |
| `SHIPMATE_UPDATER_IMAGE` | `containrrr/watchtower:latest` | The helper image for one-click updates. See [health-and-updates.md](health-and-updates.md). |
| `SHIPMATE_CONTAINER` | the container's hostname | Shipmate's container name, if its hostname is not the container id. |

## docker-compose only

These are read by `docker-compose.yml`, not by Shipmate, so put them in a `.env` file next to it:

| Variable | Default | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | `shipmate` | Password of the compose file's `db` container; change it before the first start. |
| `SHIPMATE_URL`, `SHIPMATE_SECRET`, `SHIPMATE_TRUST_PROXY`, `SHIPMATE_OLLAMA_URL`, `SHIPMATE_LOCAL_MODEL` | as above | Passed through to the containers. |

## Volumes and the `/data` layout

Shipmate needs one writable folder, `/data`. Map it to a host folder you back up (on Unraid,
`/mnt/user/appdata/shipmate`).

| Path in the container | What is there |
|---|---|
| `/data/.secret` | The generated encryption key (when `SHIPMATE_SECRET` is not set). Keep a copy somewhere safe. |
| `/data/crew/` | One folder per crew member: `crew.yaml`, `CREW.md` and its memory. Editable on disk. |
| `/data/skills/` | Skills made by you or the crew. |
| `/data/workspaces/` | Shipyard project checkouts, bind-mounted into sandbox containers. Can grow large. |
| `/data/files/` | Photos and files people attach in chat. |
| `/data/pi/` | The agent harness's own files: model sign-ins, model lists, MCP logs. |
| `/data/claude/` | The Claude Code CLI's sign-in. |
| `/data/codex/` | The Codex CLI's sign-in and threads. |
| `/data/mcp/` | Sign-ins MCP servers read, such as Google Workspace's credentials file. |
| `/data/backups/` | Backups (unless `SHIPMATE_BACKUP_DIR` points elsewhere). |
| `/data/postgres/` | The built-in database's files (accounts, conversations, settings, encrypted keys), when `DATABASE_URL` is not set. Owned by the container's `postgres` user. Back it up with Shipmate's backups rather than by copying it while Shipmate runs. |
| `/var/run/docker.sock` | Optional: the Docker socket, for Shipyard sandboxes and one-click updates. Whatever holds it controls Docker on the host. |

With an external database, Postgres keeps those in its own data folder instead (mapped to
`/var/lib/postgresql/data` in the `postgres` image).

**Ownership.** Shipmate runs as root inside its container and its files are owned by root
(except `/data/postgres`, which the built-in database owns).
That is on purpose: the Shipyard drives Docker and its sandbox containers write into
`/data/workspaces` as root, so a non-root Shipmate could not clean up after them. There is no
`PUID`/`PGID` setting for that reason. Back up the folder as root (Unraid's Appdata Backup
plugin does), and don't run a permissions fixer on it.

Ports: `3000/tcp` for the web app, the API and the WebSocket. Nothing else needs to be
exposed; behind a reverse proxy, don't publish it outside your LAN at all.
