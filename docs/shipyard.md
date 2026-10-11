# The Shipyard

The Shipyard is where crew members work on software projects: GitHub repositories or local
folders, each with a workspace under `/data/workspaces/<slug>` and a sandbox container that runs
every shell command. This page covers setting it up.

- [Sandboxes](#sandboxes)
- [Sandboxes without the Docker socket](#sandboxes-without-the-docker-socket)
  - [Rootless Podman on the same machine](#rootless-podman-on-the-same-machine)
  - [A remote Docker or Podman host](#a-remote-docker-or-podman-host)

## Sandboxes

Shipmate starts one container per project through a Docker-compatible API, mounts only the
project's workspace into it at `/workspace`, and runs commands there with none of Shipmate's
secrets. Git credentials never enter the sandbox: pushing and GitHub calls happen in Shipmate,
behind approval gates. If no sandbox engine is reachable, the Shipyard says "Code cannot run
right now" and nothing runs at all; code never runs outside a sandbox.

The default is the Docker socket mounted into the Shipmate container:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Whatever holds that socket controls Docker on the host. If that is not acceptable, or your NAS
does not let you share it, use one of the options below.

Where sandboxes run is set either in the environment or, by the owner, under **Settings →
Shipyard sandbox**, which overrides the environment and has a **Test connection** button.

| Variable | Meaning |
|---|---|
| `DOCKER_SOCKET` | Path of a socket inside the container (default `/var/run/docker.sock`). |
| `DOCKER_HOST` | Docker's own variable: `unix:///path/to.sock` or `tcp://host:port`. Wins over `DOCKER_SOCKET`. |
| `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` | For `tcp://`: `1`, and a folder with `ca.pem`, `cert.pem`, `key.pem`. |
| `SHIPMATE_HOST_DATA_DIR` | Host path of Shipmate's `/data` volume, for bind mounts (usually detected). |
| `SHIPMATE_SANDBOX_WORKSPACES` | Where the sandbox host sees Shipmate's `workspaces` folder (remote hosts). |

TLS files saved in Settings are stored encrypted like other secrets and are never shown again.

## Sandboxes without the Docker socket

### Rootless Podman on the same machine

Podman serves a Docker-compatible API on a socket, and rootless Podman runs entirely as an
ordinary user, so a container escape lands in that user's account rather than as root.

1. As the user that should own the sandboxes (here uid 1000), enable the socket and let it run
   without a login session:

   ```bash
   systemctl --user enable --now podman.socket
   sudo loginctl enable-linger "$USER"
   ls -l "$XDG_RUNTIME_DIR/podman/podman.sock"   # /run/user/1000/podman/podman.sock
   ```

2. Mount that socket into the Shipmate container. Mounting it at Docker's path needs no other
   setting:

   ```yaml
   volumes:
     - /run/user/1000/podman/podman.sock:/var/run/docker.sock
   ```

   Or mount it at its own path and pick it under **Settings → Shipyard sandbox → A socket
   mounted into Shipmate** (or set `DOCKER_HOST=unix:///run/user/1000/podman/podman.sock`).

3. Set `SHIPMATE_HOST_DATA_DIR` to the host path of Shipmate's data folder, so sandboxes bind
   the right folder (Shipmate tries to detect it, but Podman setups vary).

4. On SELinux hosts (Fedora, RHEL), give the workspaces a container label once, and run the
   Shipmate container with `--security-opt label=disable` so it can use the socket:

   ```bash
   chcon -R -t container_file_t /srv/shipmate/data/workspaces
   ```

5. Open **Settings → Shipyard sandbox**, press **Test connection**; it should say "Connected to
   Podman 5.x".

Run Shipmate itself under the same rootless user too, if you can: then files in the workspaces
belong to that user on both sides.

### A remote Docker or Podman host

For a NAS that cannot or should not share its socket, run sandboxes on another machine on your
network: a small Linux box, a VM, or a Raspberry Pi with enough memory for your builds.

**1. Share the workspaces.** The sandbox host mounts project folders into containers, so it must
see Shipmate's `workspaces` folder. Export `<data folder>/workspaces` from the NAS over NFS
(allow root access for that one client, or the sandbox cannot write) and mount it on the sandbox
host, e.g. at `/mnt/shipmate/workspaces`.

**2. Protect the API with TLS client certificates.** Whoever can reach an unprotected Docker
port controls that machine. Create a small certificate authority and certificates (on any
machine with OpenSSL; replace `sandbox-host.lan` and the IP):

```bash
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -subj "/CN=shipmate-sandbox-ca" \
  -keyout ca-key.pem -out ca.pem
# Server certificate for the sandbox host
openssl req -newkey rsa:4096 -nodes -subj "/CN=sandbox-host.lan" -keyout server-key.pem -out server.csr
echo "subjectAltName=DNS:sandbox-host.lan,IP:192.168.1.20" > server.ext
openssl x509 -req -days 3650 -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -extfile server.ext -out server-cert.pem
# Client certificate for Shipmate
openssl req -newkey rsa:4096 -nodes -subj "/CN=shipmate" -keyout key.pem -out client.csr
echo "extendedKeyUsage=clientAuth" > client.ext
openssl x509 -req -days 3650 -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -extfile client.ext -out cert.pem
```

Keep `ca-key.pem` offline. Shipmate needs `ca.pem`, `cert.pem` and `key.pem`.

**3a. Docker on the sandbox host.** Put `ca.pem`, `server-cert.pem` and `server-key.pem` in
`/etc/docker/tls/` and add to `/etc/docker/daemon.json`:

```json
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2376"],
  "tlsverify": true,
  "tlscacert": "/etc/docker/tls/ca.pem",
  "tlscert": "/etc/docker/tls/server-cert.pem",
  "tlskey": "/etc/docker/tls/server-key.pem"
}
```

On systemd distributions, remove `-H fd://` from the service's `ExecStart` (a drop-in with
`ExecStart=` then `ExecStart=/usr/bin/dockerd`) so the two settings do not clash, then
`systemctl daemon-reload && systemctl restart docker`.

**3b. Podman on the sandbox host.** `podman system service` has no TLS of its own. Serve it on
a local socket and put a TLS proxy that checks client certificates in front, for example
stunnel:

```ini
; /etc/stunnel/podman.conf
[podman]
accept = 2376
connect = /run/user/1000/podman/podman.sock
cert = /etc/stunnel/server-cert.pem
key = /etc/stunnel/server-key.pem
CAfile = /etc/stunnel/ca.pem
verifyChain = yes
requireCert = yes
```

**4. Point Shipmate at it.** Under **Settings → Shipyard sandbox** choose **A remote Docker or
Podman host**, enter `tcp://sandbox-host.lan:2376`, paste the three PEM files, set **Workspaces
path on the sandbox host** to `/mnt/shipmate/workspaces`, and press **Test connection**, then
**Save**. Or set it in the environment:

```yaml
environment:
  DOCKER_HOST: tcp://sandbox-host.lan:2376
  DOCKER_TLS_VERIFY: "1"
  DOCKER_CERT_PATH: /data/sandbox-certs   # ca.pem, cert.pem, key.pem
  SHIPMATE_SANDBOX_WORKSPACES: /mnt/shipmate/workspaces
```

A plain `tcp://` connection without certificates works too, and Settings warns about it: use
it only on a network that is yours alone.
