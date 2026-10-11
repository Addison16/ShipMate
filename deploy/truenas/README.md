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

Updating: **Apps → shipmate → Update** (or edit the YAML to pin a version tag). Migrations run
on every start.

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
