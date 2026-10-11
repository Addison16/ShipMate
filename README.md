# Shipmate

A self-hosted crew of AI bots for everyday life and for work. One **Captain** coordinates,
recruits and delegates to **crew members** you can shape yourself. Built on the
[pi agent harness](https://pi.dev). Source-available and free for noncommercial use.

Version 1.0. See [CHANGELOG.md](CHANGELOG.md) for what is in it and
[docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the design.

## Features

- **Bridge**: chat with the Captain, who pulls in the right crew member or recruits a new one.
  Replies stream in; hand-offs and tool calls are visible.
- **Crew**: every bot is a folder (`crew.yaml` + `CREW.md`) you can edit in the UI or on disk,
  with its own memory, tools, MCP servers and cost ceiling.
- **Lists**: groceries, to-dos, packing and bills with checkboxes, shared with the household or
  private, kept up to date by you and the crew alike.
- **Household profiles**: diets, budgets, timezones and schedules every crew member knows, so
  nobody repeats themselves to each bot.
- **Skills and Watches**: reusable skills made by you or by the crew (with approval), and
  watches that run on a schedule, a webhook or after another watch.
- **Shipyard**: GitHub or local projects worked in sandboxed containers, with PR flows and
  CI and review events routed back to the conversation.
- **Approvals and audit**: consequential actions wait for the person who asked; every tool call
  is logged.
- **MCP**: the common servers bundled, the rest one click away from the catalog.
- **Users**: several logins on one instance (password or OIDC), with roles, usage tracked per
  person and monthly caps.
- **Models**: API keys, self-hosted models (Ollama, vLLM, LM Studio, llama.cpp), your ChatGPT
  plan via Sign in with ChatGPT, and your Claude subscription via the official Claude Code CLI.
- **Chat anywhere**: the web app (installable as a PWA on phone and desktop), Discord,
  Telegram and Slack.
- **Backups**: nightly or on demand, restorable from the UI or the CLI.

## Quick start

```bash
curl -fsSLO https://raw.githubusercontent.com/Addison16/ShipMate/main/docker-compose.yml
docker compose up -d
open http://localhost:3000
```

The first visit creates the owner account. Then add a provider under **Providers** (an API key,
a local model server, or a subscription sign-in) and say hello to the Captain on the **Bridge**.
Set `SHIPMATE_URL` to the address people use to reach the instance; it is needed for OIDC,
webhooks and links in chat bridges.

Images are tagged `ghcr.io/addison16/shipmate:1.0.0`, `:1.0`, `:1` and `:latest`; pin a version
tag to control upgrades. Migrations run on boot. `:edge` follows `main`.

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
