# Health and updates

Owners and admins find **Health** under Manage. It shows:

- **The running version** and the latest release on GitHub, with a link to its release notes.
  The check is cached for six hours (sooner after a failure), and a failed check (offline,
  rate limited) only shows a note; the rest of the page works. Turn it off for offline
  installs with `SHIPMATE_UPDATE_CHECK=off`.
- **Checks**, each ok, warning or problem with a hint:
  - Postgres and whether all migrations are applied,
  - each model provider: self-hosted servers list their models; API keys are checked with a
    free request (the provider's model list or key info), never a model call; the ChatGPT
    sign-in; the Claude Code CLI when a crew member uses it,
  - each chat bridge that is set up (Discord, Telegram, Slack): connected or not,
  - the Docker socket the Shipyard (and one-click updates) need,
  - free disk space where `/data` lives,
  - how recent the newest backup is.

`GET /healthz` needs no sign-in and answers `{ "ok": true, "version": "..." }` once the
database responds; the image's `HEALTHCHECK` uses it.

## One-click update

When Shipmate can reach the Docker socket and its image tag can move to a newer build
(`:latest`, `:1`, `:1.2`, `:edge`), the owner gets an **Update now** button. After a confirm,
Shipmate starts a short-lived helper container, a one-shot
[Watchtower](https://containrrr.dev/watchtower/) (`--run-once --cleanup`), that:

1. pulls the newest image for the tag Shipmate runs,
2. stops Shipmate's container and starts a new one with the same settings (volumes, ports,
   environment, network, compose labels),
3. removes the old image and then itself.

Shipmate is offline for about a minute; open chats reconnect and replies that were running are
cut off. Migrations run when the new container starts. The page reloads itself once the new
version answers.

It is not offered, and the page shows the commands to run instead, when:

- there is no Docker socket,
- the image is pinned to an exact version (`:1.0.0`) or a digest: pulling it again brings
  nothing new, so change the tag first,
- Unraid or TrueNAS manages the container: update from their UI so they stay in step.

Settings:

| Variable | Default | |
|---|---|---|
| `SHIPMATE_UPDATE_CHECK` | `on` | `off` never contacts GitHub |
| `SHIPMATE_UPDATER_IMAGE` | `containrrr/watchtower:latest` | The helper image; any Watchtower build that takes `--run-once` |
| `SHIPMATE_CONTAINER` | the container's hostname | Shipmate's container name, if its hostname was changed |

The helper gets `DOCKER_API_VERSION` set to the version the engine reports, so an older
Watchtower build talks to a newer engine in that engine's API version instead of its own
older default.

## By hand

With the stock `docker-compose.yml`, from its folder:

```bash
docker compose pull shipmate
docker compose up -d shipmate
```
