# Shipmate

A self-hosted crew of AI bots for everyday life and for work. One **Captain** coordinates,
recruits and delegates to **crew members** you can shape yourself. Built on the
[pi agent harness](https://pi.dev). Source-available and free for noncommercial use.

Version 1.0. See [CHANGELOG.md](CHANGELOG.md) for what is in it and
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the design.

## Features

- **Bridge**: chat with the Captain, who pulls in the right crew member or recruits a new one.
  Replies stream in; hand-offs and tool calls are visible. Search every conversation and pin the
  ones you come back to.
- **Crew**: every bot is a folder (`crew.yaml` + `CREW.md`) you can edit in the UI or on disk,
  with its own memory, tools, MCP servers and cost ceiling. Start from ready-made crew (Galley,
  Purser, Navigator, Tutor, Health Log) at first run or any time later, and share crew members
  as a single file that others import for review.
- **Lists**: groceries, to-dos, packing and bills with checkboxes, shared with the household or
  private, kept up to date by you and the crew alike.
- **Household profiles**: diets, budgets, timezones and schedules every crew member knows, so
  nobody repeats themselves to each bot.
- **Skills and Watches**: reusable skills made by you or by the crew (with approval), and
  watches that run on a schedule, a webhook, a GitHub event or after another watch. A one-click
  **daily briefing** brings the weather, today's calendar, bills due and what the crew did
  overnight.
- **Shipyard**: GitHub or local projects worked in sandboxed containers (Docker, rootless
  Podman or a remote host). Assign an issue and the Shipwright opens a draft PR, fixes failing
  CI and, with the Bosun reviewing first, hands you a PR ready for review. GitHub webhooks
  drive it all, with polling as a fallback. See [docs/shipyard.md](docs/shipyard.md).
- **Approvals and audit**: consequential actions wait for the person who asked; every tool call
  is logged.
- **MCP**: the common servers bundled, the rest one click away from the catalog.
- **Users**: several logins on one instance (password or OIDC), with roles, usage tracked per
  person and monthly caps.
- **Models**: API keys, self-hosted models (Ollama, vLLM, LM Studio, llama.cpp), your ChatGPT
  plan via Sign in with ChatGPT, and your Claude subscription via the official Claude Code CLI.
  An optional bundled Ollama runs everything locally with no API key.
- **Chat anywhere**: the web app (installable as a PWA on phone and desktop), Discord,
  Telegram and Slack.
- **On your phone**: push notifications for approvals (approve or deny from the notification),
  watch results and crew replies, and photos, PDFs and files in chat (a receipt for the Purser,
  a fridge photo for the Galley), and voice: talk to the Captain and hear the replies, hands-free
  if you like, with a provider's speech or a local Whisper and Kokoro. See
  [docs/phone.md](docs/phone.md).
- **Backups**: nightly or on demand, restorable from the UI or the CLI.
- **Health and updates**: a Health page with the running version, newer releases and checks
  for the database, providers, bridges, the Docker socket, disk and backups, plus a one-click
  update when the Docker socket is mounted.

## Quick start

```bash
curl -fsSLO https://raw.githubusercontent.com/Addison16/ShipMate/main/docker-compose.yml
docker compose up -d
open http://localhost:3000
```

The first visit creates the owner account. Then add a provider under **Providers** (an API key,
a local model server, or a subscription sign-in) and say hello to the Captain on the **Bridge**.

**No API key?** Start the bundled local model server too; it downloads a small model on first
start, and setup offers it right after you create the owner account:

```bash
docker compose --profile local-ai up -d
```

See [docs/local-models.md](docs/local-models.md) for picking a model and using a GPU.
Set `SHIPMATE_URL` to the address people use to reach the instance; it is needed for OIDC,
webhooks and links in chat bridges. Every variable and the `/data` layout are in
[docs/configuration.md](docs/configuration.md); behind Nginx Proxy Manager, SWAG, Traefik or
Caddy, see [docs/reverse-proxy.md](docs/reverse-proxy.md).

Images are tagged `ghcr.io/addison16/shipmate:0.2.3`, `:0.2` and `:latest` (from 1.0 on, also `:1`); pin a version
tag to control upgrades. Migrations run on boot. `:edge` follows `main`. **Health** (owners and
admins) says when a newer release is out and can update in one click; see
[docs/health-and-updates.md](docs/health-and-updates.md).

To install the web app, open it in a browser and use **Install app** (desktop) or **Add to Home
Screen** (iOS and Android). The service worker needs HTTPS (or `localhost`).

On a NAS: [Unraid template](deploy/unraid/README.md) or [TrueNAS SCALE custom app](deploy/truenas/README.md).
Back up from **Settings → Backups** or with `shipmate backup`; check an install with `shipmate doctor`.

### Discord (optional)

1. Create an application at <https://discord.com/developers/applications>, open **Bot**, copy
   its token, and turn on the **Message Content intent** (Privileged Gateway Intents). Without
   it the bot cannot read what people write.
2. In Shipmate, open **Discord** as the owner, paste the token, then use the invite link to add
   the bot to your server and press **Sync channels**. Each crew member gets a channel in a
   "Shipmate" category and posts there under its own name.
3. Each person presses **Link Discord** and types `/shipmate link` with the code in Discord.
   Messages from unlinked accounts are not run.

## Develop

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # Postgres on 5432
cp .env.example .env
pnpm db:migrate
pnpm dev                                          # server on 3000, web on 5173
```

`pnpm check` (build, lint, test) is what CI runs. Workspace packages resolve through their
`dist` folders, so run `pnpm build` once after pulling changes to `packages/*`.

## License

Shipmate is source-available, not open source: it is licensed under
[PolyForm Noncommercial 1.0.0](LICENSE). Use it, change it, self-host it and share it for any
noncommercial purpose. Commercial use needs a separate license; open an issue to ask. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contributor agreement.
