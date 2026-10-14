# Shipmate build plan

*Draft 2, 2026-10-11. All nine design questions are answered; the decisions are recorded in §17 and marked **Q1**–**Q9** where they touch the design.*

Shipmate is a self-hosted, Docker-style alternative to Grok Bot for everyday life and for work.
Two containers (app and Postgres), one `docker compose up`, a web app on port 3000. A **Captain** bot (the coordinator) is set up
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
│  │ Captain      │ │ crew: chef   │ │ crew: dev    │  ← pi SDK        │
│  │ (pi session) │ │ (pi session) │ │ (pi session) │    sessions       │
│  └──────────────┘ └──────────────┘ └──────┬───────┘                  │
└───────────────────────────────────────────┼──────────────────────────┘
                                            │ docker socket (optional)
                       ┌────────────────────▼───────────────────┐
                       │ work sandboxes (one container per repo) │
                       └─────────────────────────────────────────┘
   volumes:  /data (sqlite db, crew files, skills, memory, sessions, workspaces)
```

Default deploy is two containers (Shipmate and Postgres) plus a named volume, with the Docker
socket mounted so work sandboxes run as sibling containers (**Q1**, **Q2**).

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
  db/            Drizzle schema + migrations (Postgres)                @shipmate/db
  bridges/       Discord bridge (one channel per crew member)          @shipmate/bridges
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
| **Conversation** | belongs to a user, has one or more crew participants; `bridge` conversations include the Captain |
| **Message** | stored by Shipmate for the UI; pi's own session file remains the model-context source of truth |
| **Skill** | slug, folder path, author (user or crew member), scope (crew, user, instance), approval state |
| **Routine** | crew member, cron or trigger spec, prompt, enabled, last run, run history |
| **Provider** | kind (anthropic, openai, xai, google, openrouter, ollama, openai-compatible, claude-code-cli), scope (instance or user), encrypted credentials |
| **McpServer** | catalog id or custom spec, transport (stdio, http, sse), env refs into the vault, which crews may use it |
| **Project** (work section) | repo URL, default branch, workspace path, assigned crew, GitHub installation / token ref |
| **AuditEvent** | who, which crew, which tool, args summary, approval decision |

Storage: Postgres (**Q1**). Files live under `/data`. Every message, tool call, routine run and
token count carries the acting user id so usage is attributable per user (**Q3**).

## 5. Crew members

A crew member is a folder. The Captain fills it out when it recruits someone; users can
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

**The Captain** (the coordinator; the name is editable, Captain is the default, **Q8**) is a
crew member with extra tools, provided by a Shipmate extension:

- `recruit_crew_member(spec)` scaffolds the folder from a template and the user's description,
  writes `CREW.md`, registers it, and opens it for the user to review before first use.
- `edit_crew_member`, `retire_crew_member`, `list_crew`, `list_models` (what crew can run on, cheapest first).
- `delegate(crew, task, context)` runs a task in another crew member's session and returns the
  result; the bridge shows this as a hand-off, like Grok Bot's group chat.
- `create_skill`, `create_routine`, `install_mcp_server` (each gated by approval policy).

Starter crew templates shipped in `templates/crew/`: Captain, Quartermaster (household,
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
- **Sandboxes** (**Q2**): coding tools (bash, git, test runners) execute inside a per-project
  sandbox container started through the Docker socket, with the workspace bind-mounted and no
  access to Shipmate's own secrets. The compose file mounts the socket by default; if it is
  missing, the Shipyard is disabled with a clear message rather than running code unsandboxed.
- **Flows**: "plan this feature", "fix this issue", "review this PR", "triage new issues",
  "keep CI green". Each produces branches, commits and PRs with a Shipmate attribution footer,
  and can watch the PR for CI and review events (via GitHub webhooks or polling).
- **Beyond GitHub**: GitLab and Gitea providers follow the same interface. Non-code projects
  (a writing project, a research folder) are a Project without a git remote.
- The Shipwright crew template is the default coder; the Captain can recruit more
  (a reviewer, a release manager) with narrower tool access.

## 9. MCP server catalog

Shipmate ships a curated catalog (`packages/mcp-catalog/catalog.json`) with install recipes
(`npx`, `uvx`, or docker image), required secrets, and a short description. One-click install
from the UI stores secrets in the vault and wires the server to selected crew members.

**Core, bundled in the image and enabled by default** (**Q7**): filesystem, git, github, fetch,
browser (Playwright), web search (SearXNG or Brave), memory, time, sequential-thinking.
These are the servers nearly every agent setup already uses; they need no install step, only a
key where one applies.

**Catalog, one click to install**: gitlab, postgres, sqlite, docker, google workspace (gmail,
calendar, drive), notion, obsidian, todoist, slack, discord, home-assistant, spotify, weather,
and more over time. Any custom MCP server can be added with a command or URL. Each server runs
with only the env vars it declares, and crews only see the servers they are granted.

## 10. Users, auth and multi-user

- Local accounts (email + argon2 password) with an owner created on first run, plus optional
  OIDC (Authentik, Authelia, Keycloak, Google, GitHub) for people who already run SSO at home.
- Sessions in secure cookies; passkeys as a later addition.
- Roles: `owner` (instance settings, providers, users), `admin` (crews, MCP, skills), `member`.
- Crew are shared across the instance and use the instance's models (**Q3**). Each user has
  their own conversations with the crew; crew memory keeps a shared section plus a per-user
  section so the Captain remembers who asked for what. Private crew remain possible as a
  per-crew flag but are not the default.
- Provider credentials are instance-wide and set by the owner (**Q4**). Usage is metered per
  user, per crew and per routine, and the owner can set monthly token or cost caps per user.
  Per-user keys are not in scope for 1.0; the data model leaves room for them.

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
Shipmate holds no Claude.ai session tokens at all.

**Will people have to log in again every few hours?** No (**Q6**). Both routes use short-lived
access tokens backed by long-lived refresh tokens that renew silently:

- Claude Code keeps its credentials in its own config directory, which Shipmate places on the
  `/data` volume, and refreshes them itself whenever it runs. For headless setups,
  `claude setup-token` issues a token good for a year. A user signs in once at setup.
- Sign in with ChatGPT returns a refresh token to Shipmate as a registered OAuth client, which is
  the sanctioned way to hold it. Shipmate renews the access token on demand, before each request
  that needs it, not on a timer. A user signs in once and again only if they revoke access.

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

Pages: **Bridge** (group chat with the Captain and whichever crew it pulls in),
**Crew** (list, editor for `CREW.md`/`crew.yaml`, memory viewer), **Skills**, **Routines**
(calendar view and run logs), **Shipyard** (projects, PRs, sandboxes), **Providers**,
**MCP servers**, **Users**, **Settings**, **Costs**. Mobile-friendly; installable as a PWA.

**Discord bridge** (**Q5**): web app first, Discord in phase 3. One Discord application for the
instance; Shipmate creates a channel per crew member (or binds to one you pick) and each crew
member posts through that channel's webhook with its own name and avatar, so messages are
visibly from "Captain" or "Galley", not from a generic bot. Owners who want fully separate bot
users can give a crew member its own bot token instead. Discord user ids map to Shipmate users
for attribution. Telegram and Slack follow the same bridge interface later.

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
| 1 | Core: users and roles from day one, providers (API keys + local models), the Captain, recruit/edit crew, Bridge chat, memory, core MCP servers, per-user usage metering | 3 weeks |
| 2 | Skills (user + bot-made with approval), Routines + scheduler, MCP catalog + installer, approval gates, audit | 3 weeks |
| 3 | Discord bridge (channel per crew member), Shipyard: GitHub connect, workspaces, sandboxes, PR flows, webhooks | 3 weeks |
| 4 | OIDC login, cost caps per user, cost page, backups, Unraid/TrueNAS templates | 2 weeks |
| 5 | Subscription routes (Sign in with ChatGPT, Claude Code CLI backend), Telegram/Slack bridges, PWA polish, 1.0 | 3 weeks |

Each phase ends with a tagged image that works end to end.

## 17. Decisions (answered by Addison, 2026-10-11)

- **Q1 Database:** Postgres only. Compose ships two services.
- **Q2 Sandboxes:** yes. Docker socket mounted by default; per-repo sandbox containers for the
  Shipyard; Shipyard disabled rather than unsandboxed when the socket is absent.
- **Q3 Multi-user shape:** one shared instance, shared crew, shared models, several user logins so
  everything is tracked per user.
- **Q4 Who pays:** owner sets instance-wide provider keys; usage metered per user with optional
  per-user caps. Per-user keys deferred.
- **Q5 Chat surfaces:** web app first; Discord in phase 3 with a channel per crew member and
  distinct names and avatars per crew member.
- **Q6 Subscriptions:** compliant routes only (official Claude Code CLI, Sign in with ChatGPT).
  Users sign in once; refresh tokens renew silently, no re-login every few hours.
- **Q7 MCP:** the most common servers are core and bundled; everything else is in the catalog.
- **Q8 Names:** Captain is the default coordinator name and can be changed. Bridge, Shipyard,
  Watches (routines) and crew manifest adopted.
- **Q9 License:** PolyForm Noncommercial 1.0.0. Not OSI open source; describe as
  "source-available, free for noncommercial use". A company self-hosting internally counts as
  commercial, so commercial licenses can be sold later. Contributors sign a CLA to keep that
  possible. Dependencies (pi is MIT, MCP servers vary) keep their own licenses.
