# Shipmate

A self-hosted crew of AI bots for everyday life and for work. One **Captain** coordinates,
recruits and delegates to **crew members** you can shape yourself. Built on the
[pi agent harness](https://pi.dev). Source-available and free for noncommercial use.

> Status: phase 0 (scaffold). Nothing to run yet beyond a health check. See
> [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) for the full plan and phases.

## What it will do

- **Bridge**: chat with the Captain, who pulls in the right crew member or recruits a new one.
- **Crew**: every bot is a folder (`crew.yaml` + `CREW.md`) you can edit in the UI or on disk.
- **Skills and Watches**: reusable skills made by you or by the crew, and scheduled routines.
- **Shipyard**: GitHub projects worked in sandboxed containers, with PR flows.
- **MCP**: the common servers bundled, the rest one click away.
- **Users**: several logins on one instance, usage tracked per person.
- **Models**: API keys, self-hosted models (Ollama, vLLM, LM Studio, llama.cpp), your ChatGPT
  plan via Sign in with ChatGPT, and your Claude subscription via the official Claude Code CLI.

## Run it

```bash
curl -fsSLO https://raw.githubusercontent.com/Addison16/ShipMate/main/docker-compose.yml
docker compose up -d
open http://localhost:3000
```

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

[PolyForm Noncommercial 1.0.0](LICENSE). Use it, change it, self-host it and share it for any
noncommercial purpose. Commercial use needs a separate license; open an issue to ask. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the contributor agreement.
