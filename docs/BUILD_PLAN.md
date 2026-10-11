# Shipmate build plan

*Draft 1, 2026-10-11. Open questions are at the end and marked **Q1**–**Q9** where they touch the design.*

Shipmate is a self-hosted, Docker-style alternative to Grok Bot for everyday life and for work.
One container, one `docker compose up`, a web app on port 3000. A **Coordinator** bot is set up
first and recruits **crew members** (specialist bots) as needed. Everything runs on the
[pi agent harness](https://pi.dev).

---

## 1. What we are building, in one picture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser (web app)   ·   later: Telegram / Discord / Slack bridges   │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTPS + WebSocket
┌───────────────▼──────────────────────────────────────────────────────┐
│  shipmate server (Node 22, one container)                            │
│                                                                      │
│  Auth & users · Bridge (chat) · Crew registry · Skills · Routines    │
│  Provider registry (keys, OAuth, local models) · MCP catalog         │
│  Secrets vault · Audit log · Scheduler                                │
│                                                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                  │
│  │ Coordinator  │ │ crew: chef   │ │ crew: dev    │  ← pi SDK        │
│  │ (pi session) │ │ (pi session) │ │ (pi session) │    sessions       │
│  └──────────────┘ └──────────────┘ └──────┬───────┘                  │
└───────────────────────────────────────────┼──────────────────────────┘
                                            │ docker socket (optional)
                       ┌────────────────────▼───────────────────┐
                       │ work sandboxes (one container per repo) │
                       └─────────────────────────────────────────┘
   volumes:  /data (sqlite db, crew files, skills, memory, sessions, workspaces)
```

Default deploy is a single container plus a named volume. Postgres and sandbox containers
are opt-in (see **Q1**, **Q2**).

## 2. Why pi, and how we use it

pi (`@earendil-works/pi-coding-agent`, MIT) gives us the agent loop, tool calling, session
trees, compaction, skills, prompt templates, extensions, and provider support (Anthropic,
OpenAI, Google, xAI, Mistral, Groq, OpenRouter, Ollama, Bedrock, Azure, plus custom
OpenAI-compatible endpoints via `models.json`). MCP is built in. It ships an SDK:
`createAgentSession()` returns an `AgentSession` that owns one conversation, its model, tools
and extension runtime, with `cwd`, `customTools`, `extensionFactories`, a pluggable
`SessionManager`, and a `subscribe()` event stream.

Shipmate's rule: **every crew member is one pi `AgentSession`**, created from that crew
member's folder as `cwd`. pi then discovers that folder's instructions, skills and prompt
templates on its own, so the on-disk layout *is* the configuration. Shipmate adds a thin layer
of extensions (permission gates, delegation tools, memory, audit) and never forks pi.

What pi does not give us and Shipmate must build: the server, multi-user auth, the web UI,
the persistent scheduler, the crew/skill/MCP management tools, the provider credential store,
and the GitHub work section.

## 3. Repository layout (pnpm monorepo, TypeScript, `@shipmate/*`)

```
apps/
  server/        Fastify + WebSocket API, scheduler, crew runtime     @shipmate/server
  web/           React + Vite SPA (served by the server in prod)       @shipmate/web
packages/
  core/          domain types, crew/skill/routine schemas (zod)        @shipmate/core
  crew/          pi session factory, Shipmate extensions, delegation   @shipmate/crew
  providers/     provider registry, key vault, OAuth flows             @shipmate/providers
  mcp-catalog/   curated MCP server catalog + installer                @shipmate/mcp-catalog
  db/            Drizzle schema + migrations (SQLite, Postgres)        @shipmate/db
  cli/           `shipmate` CLI: init, doctor, backup, crew ls          @shipmate/cli
templates/
  crew/          starter crew members (see §5)
  skills/        starter skills
docker/
  Dockerfile, docker-compose.yml, compose.postgres.yml, compose.sandbox.yml
docs/
```

Stack choices: Node 22, TypeScript, pnpm, Fastify, Drizzle ORM, zod, React 19 + Vite +
Tailwind, Vitest, Playwright for e2e. Everything a contributor needs is `pnpm i && pnpm dev`.

## 4. Data model

| Entity | Notes |
|---|---|
| **User** | email, password hash (argon2) or OIDC subject, role (`owner`, `admin`, `member`), per-user settings |
| **CrewMember** | slug, display name, owner user, visibility (`private`, `shared`), model ref, folder path, status |
| **Conversation** | belongs to a user, has one or more crew participants; `bridge` conversations include the Coordinator |
| **Message** | stored by Shipmate for the UI; pi's own session file remains the model-context source of truth |
| **Skill** | slug, folder path, author (user or crew member), scope (crew, user, instance), approval state |
| **Routine** | crew member, cron or trigger spec, prompt, enabled, last run, run history |
| **Provider** | kind (anthropic, openai, xai, google, openrouter, ollama, openai-compatible, claude-code-cli), scope (instance or user), encrypted credentials |
| **McpServer** | catalog id or custom spec, transport (stdio, http, sse), env refs into the vault, which crews may use it |
| **Project** (work section) | repo URL, default branch, workspace path, assigned crew, GitHub installation / token ref |
| **AuditEvent** | who, which crew, which tool, args summary, approval decision |

Storage: SQLite (libsql) by default, Postgres via one env var. Files live under `/data`.

## 5. Crew members

A crew member is a folder. The Coordinator fills it out when it recruits someone; users can
edit every file from the web UI (Monaco editor) or on disk.

```
/data/crew/<slug>/
  crew.yaml        name, role, model, tools allowed, MCP servers, skills, approval policy
  CREW.md          persona and instructions (pi loads this as the agent's context file)
  skills/          crew-private skills (SKILL.md folders)
  memory/          MEMORY.md index + one file per fact (same shape Claude uses)
  prompts/         pi prompt templates (/slash commands) specific to this crew member
  sessions/        pi session trees (managed by pi's SessionManager)
```

`crew.yaml` example:

```yaml
name: Galley
role: meal planning and groceries
model: anthropic/claude-sonnet-5-5       # or ollama/qwen3:32b, openai/gpt-5.5, ...
tools: [read, write, bash, web_fetch]
mcp: [google-calendar, todoist]
skills: [weekly-meal-plan, pantry-inventory]
approval: ask                           # ask | auto | never-for: [send_email, purchase]
visibility: shared                      # private | shared  (Q3)
```

**The Coordinator** is a crew member with extra tools, provided by a Shipmate extension:

- `recruit_crew_member(spec)` scaffolds the folder from a template and the user's description,
  writes `CREW.md`, registers it, and opens it for the user to review before first use.
- `edit_crew_member`, `retire_crew_member`, `list_crew`.
- `delegate(crew, task, context)` runs a task in another crew member's session and returns the
  result; the bridge shows this as a hand-off, like Grok Bot's group chat.
- `create_skill`, `create_routine`, `install_mcp_server` (each gated by approval policy).

Starter crew templates shipped in `templates/crew/`: Coordinator, Quartermaster (household,
lists, errands), Navigator (calendar and travel), Purser (budget and bills), Lookout (research
and news digests), Shipwright (software work, see §8). Users can rename or delete all of them.

## 6. Skills

Skills follow the open Agent Skills format (a folder with `SKILL.md` frontmatter, optional
scripts and references). pi already loads this format on demand, so a Shipmate skill is a pi
skill with Shipmate metadata (author, scope, approval).

- **User-made**: created in the UI editor or dropped into `/data/skills/`.
- **Bot-made**: any crew member can call `create_skill` after completing a task it expects to
  repeat. New bot-made skills land as *pending* and are not loaded until a user approves them in
  the Skills page (configurable per crew to auto-approve).
- **Scopes**: crew-private, user-wide, instance-wide.
- **Sharing**: `shipmate skill export` produces a pi package so skills can be published to npm or
  git and installed with `pi install`.

## 7. Routines (run-time schedules and triggers)

A built-in scheduler (croner, persisted in the database, one leader per instance) runs
routines as fresh or continuing pi sessions for a crew member.

- Triggers: cron (`every weekday at 07:00`), interval, webhook URL, GitHub events (push, PR
  opened, CI failed), and "when another routine finishes".
- Each run is logged with transcript, tool calls, cost, and result; failures notify the owner.
- Routines can be created by users in the UI or by bots via `create_routine` (approval-gated).
- Examples shipped: morning brief, weekly meal plan, nightly repo triage, dependency update PRs.

## 8. The work section (GitHub and other projects)

A separate area of the app, themed as the **Shipyard**, where crew members manage software
projects the way Claude and ChatGPT's coding products do.

- **Projects**: connect a GitHub repo (OAuth with GitHub, or a fine-grained PAT, or a GitHub
  App installation for orgs). Shipmate clones it into `/data/workspaces/<project>`.
- **Sandboxes**: coding tools (bash, git, test runners) execute inside a per-project sandbox
  container started through the Docker socket, with the workspace bind-mounted. Without the
  socket, tools run inside the main container in a restricted workspace (**Q2**).
- **Flows**: "plan this feature", "fix this issue", "review this PR", "triage new issues",
  "keep CI green". Each produces branches, commits and PRs with a Shipmate attribution footer,
  and can watch the PR for CI and review events (via GitHub webhooks or polling).
- **Beyond GitHub**: GitLab and Gitea providers follow the same interface. Non-code projects
  (a writing project, a research folder) are a Project without a git remote.
- The Shipwright crew template is the default coder; the Coordinator can recruit more
  (a reviewer, a release manager) with narrower tool access.

## 9. MCP server catalog

Shipmate ships a curated catalog (`packages/mcp-catalog/catalog.json`) with install recipes
(`npx`, `uvx`, or docker image), required secrets, and a short description. One-click install
from the UI stores secrets in the vault and wires the server to selected crew members.

Launch set (about 20): filesystem, git, github, gitlab, fetch, playwright (browser), memory,
time, sequential-thinking, sqlite, postgres, docker, brave-search / searxng, google workspace
(gmail, calendar, drive), notion, obsidian, todoist, slack, discord, home-assistant, spotify,
weather. Any custom MCP server can be added with a command or URL. Each server runs with only
the env vars it declares, and crews only see the servers they are granted.

## 10. Users, auth and multi-user

- Local accounts (email + argon2 password) with an owner created on first run, plus optional
  OIDC (Authentik, Authelia, Keycloak, Google, GitHub) for people who already run SSO at home.
- Sessions in secure cookies; passkeys as a later addition.
- Roles: `owner` (instance settings, providers, users), `admin` (crews, MCP, skills), `member`.
- Each user has private conversations and private crew; crew marked `shared` are visible to the
  household/team and keep one memory folder with per-user sections (**Q3**).
- Per-user provider credentials are allowed alongside instance-wide ones (**Q4**).

## 11. Model providers

Through pi-ai, with Shipmate holding the credentials:

- **API keys**: Anthropic, OpenAI, xAI, Google, Mistral, Groq, OpenRouter, and others pi supports.
- **Self-hosted**: Ollama, vLLM, LM Studio, llama.cpp server, LocalAI, or any OpenAI-compatible
  URL. Added in the UI with base URL + optional key; Shipmate probes `/v1/models` and lists them.
- **Subscription routes** (see §12 for the terms check):
  - **ChatGPT plan**: implement OpenAI's "Sign in with ChatGPT" with plan usage, which OpenAI
    documents for open-source and locally hosted apps. The user signs in through OpenAI's own
    flow; Shipmate calls the Responses API with the resulting token.
  - **Claude subscription**: a `claude-code-cli` crew backend that runs the unmodified official
    `claude` binary (installed in the image or on the host) which the user has signed into with
    their own account. Shipmate talks to it in print/JSON mode and never touches its tokens.
- Routing: each crew member picks a model; per-user defaults; a cost page shows token usage per
  crew, per user and per routine.

## 12. The subscription keep-alive ping: what the terms allow

The request was to keep Claude and ChatGPT subscriptions "logged in" by pinging them every
hour. I checked the current wording of both companies' terms.

**Anthropic.** The Claude Code legal page (read 2026-10-11) says OAuth sign-in is "intended
exclusively for purchasers of Claude ... subscription plans and is designed to support
ordinary use of Claude Code and other native Anthropic applications", that third-party
developers may not "offer Claude.ai login into their own applications, or ... route requests
through Free, Pro, or Max plan credentials on behalf of their users", and that developers
"may not collect, store, or intermediate Claude.ai credentials or session tokens". The
Consumer Terms separately forbid accessing the service "through automated or non-human
means, whether through a bot, script, or otherwise" except via an API key or where Anthropic
explicitly permits it. A Shipmate feature that stores a Claude.ai token and pings on a
schedule would break all three. **Not building it.**

What is allowed, and what Shipmate will do instead: the same page says nothing prevents "an
end user from signing in to the unmodified Claude Code binary with their own Claude
subscription, including where a platform hosts Claude Code". Claude Code refreshes its own
login and `claude setup-token` issues a long-lived token for headless use, so no keep-alive is
needed. Shipmate's `claude-code-cli` backend (§11) is therefore the compliant path, and API
keys are the path for everything else.

**OpenAI.** OpenAI now officially supports spending a ChatGPT plan allowance in third-party
tools through "Sign in with ChatGPT", and its docs cover "open-source and locally hosted
apps", which is exactly what Shipmate is (paid or remotely hosted apps must file an interest
form). Tokens refresh through OpenAI's flow, so again a keep-alive ping is unnecessary.
Driving the ChatGPT *website* with a stored browser session would fall under OpenAI's
prohibitions on automated extraction and bypassing protective measures, so Shipmate will not
do that either. **We implement Sign in with ChatGPT properly instead.**

Net effect for the user: both subscriptions can be used, neither needs an hourly ping, and
Shipmate holds no consumer session tokens at all.

## 13. Security model

- Secrets vault: AES-GCM with a key derived from `SHIPMATE_SECRET` (generated on first run),
  secrets referenced by name from `crew.yaml` and MCP configs, never written to session files.
- Approval gates: a pi extension intercepts tool calls; consequential actions (send, publish,
  purchase, delete, `git push`, shell in a shared workspace) pause for the user, with an
  "always allow for this crew" option, matching the Grok Bot behaviour users will expect.
- Per-crew allow-lists for tools, MCP servers, filesystem roots, and network egress (sandbox
  mode).
- Audit log of every tool call and approval, viewable per crew and per user.
- Rate and cost ceilings per crew and per routine.

## 14. Web app

Pages: **Bridge** (group chat with the Coordinator and whichever crew it pulls in),
**Crew** (list, editor for `CREW.md`/`crew.yaml`, memory viewer), **Skills**, **Routines**
(calendar view and run logs), **Shipyard** (projects, PRs, sandboxes), **Providers**,
**MCP servers**, **Users**, **Settings**, **Costs**. Mobile-friendly; installable as a PWA.
Messaging bridges (Telegram, Discord, Slack) are a later phase (**Q5**).

## 15. Deployment

```yaml
services:
  shipmate:
    image: ghcr.io/addison16/shipmate:latest
    ports: ["3000:3000"]
    volumes:
      - shipmate-data:/data
      # - /var/run/docker.sock:/var/run/docker.sock   # optional: sandboxes
    environment:
      - SHIPMATE_URL=https://shipmate.home
      # - DATABASE_URL=postgres://...                  # optional
```

Also: Unraid and TrueNAS app templates, a Helm chart later, `shipmate backup` and
`shipmate doctor` in the CLI, semver images with migrations run on boot.

## 16. Phases

| Phase | Deliverable | Rough size |
|---|---|---|
| 0 | Monorepo scaffold, Dockerfile, CI, docs site skeleton | 1 week |
| 1 | Single-user core: auth (owner), providers (API keys + Ollama), Coordinator, recruit/edit crew, Bridge chat, memory | 3 weeks |
| 2 | Skills (user + bot-made with approval), Routines + scheduler, MCP catalog + installer, approval gates, audit | 3 weeks |
| 3 | Shipyard: GitHub connect, workspaces, sandboxes, PR flows, GitHub webhooks | 3 weeks |
| 4 | Multi-user: roles, OIDC, shared vs private crew, per-user credentials, cost page | 2 weeks |
| 5 | Subscription routes (Sign in with ChatGPT, Claude Code CLI backend), Telegram/Discord bridges, PWA polish, 1.0 | 3 weeks |

Each phase ends with a tagged image that works end to end.

## 17. Open questions

Answers to these change the design. Defaults in bold are what I will build if unanswered.

- **Q1 Database.** **SQLite in the single container by default**, Postgres as an opt-in for
  larger households or teams. Or Postgres only, which means two containers from day one.
- **Q2 Sandboxes for the work section.** **Optional Docker socket mount, with a per-repo
  sandbox container when present and in-container execution when absent.** Alternatives: require
  the socket (safer, harder to install) or never spawn containers (simplest, least isolated).
- **Q3 Multi-user shape.** **One shared household/team instance: shared crew plus private crew
  and private chats per user.** Or fully isolated users who never see each other's crew.
- **Q4 Who pays for models.** **Both instance-wide keys set by the owner and per-user keys**,
  with per-user overriding. Or owner-only keys with per-user spend limits.
- **Q5 Chat surfaces.** **Web app first; Telegram and Discord in phase 5.** Or a messaging
  bridge in phase 1 because that is where everyday use really happens.
- **Q6 Subscriptions.** Confirm you are fine with the compliant approach in §12 (official
  `claude` CLI backend and Sign in with ChatGPT) instead of hourly pings and stored tokens.
- **Q7 Browser use.** Should crew members be able to drive a real browser (Playwright MCP, with
  the user entering logins and 2FA) for sites with no MCP server, as Grok Bot does? **Yes, as an
  opt-in MCP server in the catalog, not a core feature.**
- **Q8 Names.** The first bot is "the Coordinator" in your message. Suggestions to fit the theme:
  Coordinator = **Captain**, bot files = **crew manifest**, group chat = **Bridge**, work section
  = **Shipyard**, routines = **Watches**. Keep, change, or drop any of these.
- **Q9 License.** The repo is GPL-3.0 today. pi and most of the MCP ecosystem are MIT or
  Apache-2.0. GPL is fine for a self-hosted app, but it will deter some contributors and any
  company that wants to embed Shipmate. **Keep GPL-3.0 unless you want wider adoption, in which
  case AGPL-3.0 (protects against hosted forks) or Apache-2.0 (most permissive).**
