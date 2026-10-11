# Shipmate on TrueNAS SCALE

Shipmate runs as a custom app: the Shipmate container plus PostgreSQL, from the
[docker-compose.yml](docker-compose.yml) in this folder. It targets TrueNAS SCALE 24.10
(Electric Eel) or newer, where apps are Docker Compose.

Shipmate is source-available under the PolyForm Noncommercial 1.0.0 license: free for
noncommercial use, not open source. Commercial use needs a separate license.

## Install

1. **Datasets.** In **Datasets**, create `apps/shipmate/data` and `apps/shipmate/db` on your
   pool (e.g. `tank`). Postgres runs as uid 999 and Shipmate as root inside its container;
   the defaults of a new dataset with the "Apps" preset work.
2. **Edit the YAML.** Copy `docker-compose.yml` and change:
   - `/mnt/tank/...` to your pool and dataset paths (three places, plus
     `SHIPMATE_HOST_DATA_DIR`),
   - both `CHANGE_ME` to the same long random password,
   - `SHIPMATE_URL` to the address people will open.
3. **Install.** **Apps → Discover Apps → ⋮ → Install via YAML**, name it `shipmate`, paste
   the YAML, **Save**. Open `http://<truenas-ip>:3000` and create the owner account.

If port 3000 is taken, change the left side of `"3000:3000"` and `SHIPMATE_URL` with it.
To use a Postgres you already run, delete the `db` service and `depends_on`, and point
`DATABASE_URL` at it.

**Docker socket:** mounting `/var/run/docker.sock` lets the Shipyard run code in per-project
sandbox containers. Whatever holds the socket controls Docker on the NAS; remove the line to
keep the Shipyard off.

**No socket?** If you would rather not hand Shipmate the NAS's Docker socket, run sandboxes on
another machine instead: a small Linux box or VM with Docker (TLS on port 2376) or Podman.
Share the `data/workspaces` folder of the data dataset with it over NFS, then in Shipmate open
**Settings → Shipyard sandbox**, choose **A remote Docker or Podman host**, paste the TLS
files, set the workspaces path as that machine mounts it, and press **Test connection**. Or
use the `DOCKER_HOST` lines in the YAML. Step by step: [docs/shipyard.md](../../docs/shipyard.md#sandboxes-without-the-docker-socket).

Updating: **Apps → shipmate → Update** (or edit the YAML to pin a version tag). Migrations run
on every start. The **Health** page in Shipmate shows when a newer release is out and checks the
database, providers, bridges, Docker socket, disk and backups; it leaves the update itself to
TrueNAS.

## Local models (optional)

To run models on the NAS with no API key, create one more dataset (e.g.
`apps/shipmate/ollama`; models take several GB each), uncomment the `ollama` service in the
YAML and point its volume at that dataset. After the app restarts, open **Providers → Local
model (Ollama)** as the owner, download a model (progress shows on the page) and press **Use
this model**. See [docs/local-models.md](../../docs/local-models.md) for which model to pick.

## Backups

Owners find **Settings → Backups** in the web app: back up now, download, delete, and a nightly
schedule (03:00 UTC by default, keeping the newest 7 nightly backups). Files land in
`<data dataset>/backups`, so ZFS snapshots and replication of the data dataset cover them; or
mount another dataset at `/backups` and set `SHIPMATE_BACKUP_DIR: /backups`.

Stored API keys stay encrypted in a backup. The key is `/data/.secret` (included in every
backup) or `SHIPMATE_SECRET` if you set one: keep a copy somewhere safe.

To restore, open a shell on the NAS (**System → Shell**), stop only the Shipmate container so
the database keeps running (`docker ps` shows the names; typically `ix-shipmate-shipmate-1`):

```bash
docker stop ix-shipmate-shipmate-1
```

then run the restore:

```bash
docker run --rm -it --network ix-shipmate_default \
  -v /mnt/tank/apps/shipmate/data:/data \
  -e DATABASE_URL='postgres://shipmate:<password>@db:5432/shipmate' \
  ghcr.io/addison16/shipmate:latest \
  shipmate restore /data/backups/<file>.tar.gz --yes
```

(`docker network ls` shows the app's network name.) Then restart the app
(**Apps → shipmate → Restart**).
`shipmate doctor` in place of `shipmate restore …` checks the database, migrations, data
folder, key, Docker socket and free space.
