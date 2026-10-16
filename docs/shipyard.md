# The Shipyard

The Shipyard is where crew members work on software projects: GitHub repositories or local
folders, each with a workspace under `/data/workspaces/<slug>` and a sandbox container that runs
every shell command. This page covers setting it up.

- [Issue-to-PR jobs](#issue-to-pr-jobs)
- [A reviewer before you: the Bosun](#a-reviewer-before-you-the-bosun)
- [GitHub webhooks](#github-webhooks)
- [Sandboxes](#sandboxes)
- [Sandboxes without the Docker socket](#sandboxes-without-the-docker-socket)
  - [Rootless Podman on the same machine](#rootless-podman-on-the-same-machine)
  - [A remote Docker or Podman host](#a-remote-docker-or-podman-host)

## Issue-to-PR jobs

On a GitHub project's **Issues** tab, **Assign to Shipwright** (or whoever owns the project)
starts a job:

1. The crew member works the issue on a branch in the sandbox and opens a **draft** pull request
   with its usual tools. Pushing and opening pull requests ask the person who assigned the job
   for approval, unless they chose "Always allow".
2. Shipmate follows the pull request's CI. When it fails, the crew member gets the failing checks
   and pushes a fix, up to the project's **fix attempts** (3 by default); after that the job
   gives up and leaves it to you.
3. When CI is green, the project's reviewer (if any) reviews it; blocking findings go back to be
   fixed and CI runs again.
4. Then the pull request is marked **ready for review** for people to merge.

Each job has a status card on the project page: *Working*, *PR open*, *CI running*, *CI red
(attempt n of m)*, *Review by Bosun*, *Addressing review*, *Needs you*, *Ready for review*, *Gave
up*, *Merged*, *Closed* or *Cancelled*, with the pull request, the branch and a line on what is
happening. *Needs you* means the crew member stopped (it asked a question, or did not push a
fix): answer in its conversation, or press **Try again**. Only the person who assigned a job
sees its conversation; anyone can see the card. A job runs in the
assigner's name like any conversation, and its usage counts toward their cap.

Jobs can also start on their own, under the project's **Settings → Issue-to-PR jobs**: when an
issue gets a label (for example `shipwright`) or is assigned to a GitHub user. Automatic jobs run
as the admin who saved the trigger. With a webhook they start as soon as GitHub tells
Shipmate; without one, Shipmate polls every minute and picks each matching issue up once.

Issue text is treated as data, never as instructions, but anyone who can label or assign issues
can start a job: keep triggers to repositories where that is people you trust.
Use a label of its own for the trigger, not one your issue templates add by themselves (such as
`bug`): template labels are applied for anyone who opens an issue, including strangers on a public
repository.

## A reviewer before you: the Bosun

The Bosun is a starter crew member whose only job is reviewing diffs. Pick it (or any other
crew member) as a project's **Reviewer** under **Settings → Issue-to-PR jobs**. When a job's CI is
green, the reviewer reads the pull request and posts one review on GitHub with a verdict;
findings are marked `[blocking]` or `[nit]`. Blocking findings go back to the Shipwright, who
fixes them (or explains why not) before the pull request is marked ready. After two rounds the
pull request goes to people anyway, with a note on the card to read the last review.

The reviewer gets read-only tools in the workspace and GitHub's read and review tools; it cannot
push or open pull requests. Its reviews are posted as comments (GitHub does not let an account
approve its own pull request) and start with "Bosun's review: looks good to merge" or "changes
requested". Turn review off by choosing "No crew review".

## GitHub webhooks

Every GitHub project has a payload URL and a secret under **Settings → GitHub webhook**. Add them
to the repository (**Settings → Webhooks → Add webhook**, content type `application/json`) and
tick Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments,
Check suites, Check runs, Workflow runs, Statuses and Pushes.

Each delivery is checked against the project's secret (`X-Hub-Signature-256`, constant-time) and
refused without it; redeliveries are ignored. **New secret** replaces the secret at once. Then:

- **Issues** labelled or assigned to the project's trigger start jobs.
- **CI results** (check suites and runs, workflow runs, statuses) move jobs along: a failure goes
  back to be fixed, green goes to review or ready.
- **Comments and reviews** on a pull request the crew opened reach the conversation that opened
  it, so the crew member can answer or make the change. Shipmate's own comments are ignored.
- **Watches** with a "When something happens on GitHub" trigger run on the events they name
  (an issue is opened or labelled, a comment, a pull request opened or merged, a review, CI
  fails, a push), in the project's workspace, with what happened added to the prompt.

GitHub has to reach Shipmate's address. Without a webhook (no public address, or not set up
yet), Shipmate polls GitHub every minute for jobs and their CI instead; the card shows "not set
up: polling" until the first delivery arrives. Watches need the webhook.

## Sandboxes

Shipmate starts one container per project through a Docker-compatible API, mounts only the
project's workspace into it at `/workspace`, and runs commands there with none of Shipmate's
secrets. Git credentials never enter the sandbox: pushing and GitHub calls happen in Shipmate,
behind approval gates. If no sandbox engine is reachable, the Shipyard says "Code cannot run
right now" and nothing runs at all; code never runs outside a sandbox.

Agents on the Claude Code engine (your Claude subscription) can work on projects too. Claude Code
reads and edits the project's files itself, but its own shell is turned off there: every command
goes through Shipmate's sandboxed `bash` tool, behind the same approvals. It also ignores the
repo's own Claude Code settings and MCP servers, which could otherwise run things on the Shipmate
host. Codex, Cursor and Gemini CLI agents can't work on projects yet.

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
