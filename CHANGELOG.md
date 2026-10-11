# Changelog

All notable changes to Shipmate. Versions follow [semver](https://semver.org); each release is
published as `ghcr.io/addison16/shipmate:<version>` (plus `:<major>.<minor>`, `:<major>` and
`:latest`). Database migrations run on boot, so upgrading is pulling the new image.

## Unreleased

- **Light, Dark and Auto** appearance per user, saved to the account so it follows you to every
  device. Auto follows the device and switches live. Pick it in Settings or from the sidebar.
- **Color themes** with a nautical feel: Harbor (teal, the default), Open Sea, Coral Reef,
  Lighthouse, Kelp Forest and Admiral.
- Navigation icons, a filled highlight for the current page, and colored avatars for crew
  members on the Crew page and in chat.
- **The Captain's standing orders**: a fuller CREW.md on when and how to recruit crew (one
  specialty each, the smallest model and tool set that works, a clear CREW.md with a "when you
  are unsure" section), how to brief a delegate, and how to answer crew questions. Edit it on
  the Crew page. Installs whose Captain CREW.md was never edited are upgraded on boot.
- **`ask_captain`**: every crew member except the Captain can check with the Captain mid-task
  instead of guessing, so crew can run on cheaper models with the Captain's judgment on call.
  The question and answer show in the conversation like a hand-off.
- **Starter crew**: first-run setup (and **Crew → Add starter crew** later) offers ready-made
  crew members: Galley (meals and groceries), Purser (bills), Navigator (calendar, travel and
  weather), Tutor and Health Log. Each comes with its persona, the catalog MCP servers it needs
  and a starter watch that is created paused, and uses the default model from Settings.
- **Lists**: grocery, to-do, packing and bill lists as real objects with their own page and
  checkboxes, shared with the household or private. Crew read and update them with list tools
  (`show_lists`, `read_list`, `add_to_list`, `check_list_items`, `remove_from_list`,
  `create_list`) instead of keeping them in memory, and changes show up live in every open app.
- **Household profiles**: each person keeps their diet, budget, timezone, schedule and notes in
  Settings, and owners and admins keep household facts (home location, who lives here, kids'
  schedules). Every crew member gets them in a compact context section with the person's local
  time, plus `read_profiles` for the full text. A profile can be shared with the household so
  crew planning for everyone (meals, say) can read it; it is private by default.
- **Daily briefing**: a one-click watch on the Watches page that sends a morning summary: the
  weather, today's calendar (when the Navigator's calendar is connected; skipped otherwise),
  bills and to-dos due soon, and what the crew did overnight. Every crew member now has
  `get_weather` (Open-Meteo, no key needed; defaults to the household's home location),
  `due_soon` and `recent_activity`.

## 1.0.0 — 2026-10-11

The first stable release. Phases 0 to 5 of [the build plan](docs/BUILD_PLAN.md) are done.

### Phase 5: subscription routes, Telegram and Slack, PWA

- **Sign in with ChatGPT**: use a ChatGPT plan as a model provider. The owner signs in once;
  tokens stay on the server, encrypted in the vault, and are renewed only right before a model
  call that needs one.
- **Claude subscription** through the official Claude Code CLI, which ships unmodified in the
  image; each person signs in themselves.
- **Telegram bridge** (long polling, no public URL needed): chats map to crew members, private
  chats go to the Captain, people link their account with a one-time code.
- **Slack bridge** (Socket Mode): each crew member posts in its channel under its own name and
  icon; direct messages go to the Captain.
- **Installable web app**: web app manifest, icons, and a small service worker that caches the
  app shell so the installed app opens offline. It never caches the API or the WebSocket.
- **Mobile**: slide-over navigation on narrow screens, a Bridge that fits a 375px phone, and
  tables that scroll inside their card instead of the page.
- Release images are tagged with semver on `v*` tags; `main` publishes `:edge`.

### Phase 4: OIDC, backups, cost ceilings, NAS templates

- OIDC sign-in (PKCE, state and nonce) with owner settings and an SSO button on the login page.
- Backup and restore from the server, on a nightly schedule, or with `shipmate backup` /
  `shipmate restore`; a fuller `shipmate doctor`.
- Monthly cost ceilings for crew members and watches, alongside the per-person caps; a cost
  page with a daily chart and CSV export.
- Unraid and TrueNAS SCALE templates; the `shipmate` CLI ships in the image.

### Phase 3: Discord and the Shipyard

- **Shipyard**: GitHub or local projects in `/data/workspaces/<slug>`. Commands run in a
  per-project sandbox container through the Docker socket, with none of Shipmate's secrets.
  Git tokens are passed per command and never stored. Approval-gated tools to push, open pull
  requests and comment; flows to plan, fix an issue, review a PR, triage and keep CI green.
  Signed GitHub webhooks route CI and review events back to the conversation that opened the PR.
- **Discord**: one bot per instance, a channel per crew member, each posting through a webhook
  under its own name. Accounts link with a one-time code; approval buttons work only for the
  person who asked.

### Phase 2: skills, watches, MCP, approvals, audit

- **Approval gates**: shell commands, acting MCP tools, new watches and MCP installs pause for
  the person who started the turn (allow once, always allow, deny). Every tool call is audited.
- **Skills** in Agent Skills format, per instance, person or crew member. Skills a crew member
  writes wait for approval.
- **Watches**: cron, interval, webhook and "after another watch" triggers, each run its own
  conversation with transcript, cost and status.
- **MCP**: install from the catalog, custom servers, encrypted secrets, per-crew assignment.
- Review fixes: watch turns respect caps, webhook URLs are shown only to their owner, trigger
  loops are rejected, concurrent runs of one watch are impossible.

### Phase 1: the Captain and the Bridge

- Accounts with owner, admin and member roles, cookie sessions, per-person monthly caps.
- Providers: API keys encrypted in the vault, Ollama and OpenAI-compatible servers with probed
  model lists.
- The Captain, seeded on first boot, recruits, edits, retires and delegates to crew members;
  every crew member is a folder (`crew.yaml` + `CREW.md`) mirrored to the database.
- The Bridge: streamed chat over a WebSocket with tool chips and visible hand-offs.
- Per-crew memory (shared and per person) and usage metered per person, crew member and model.
- Review fixes: private crew visibility, sockets re-check the account on every message,
  cap checks cannot race.

### Phase 0: scaffold

- pnpm monorepo (`@shipmate/core`, `db`, `providers`, `mcp-catalog`, `crew`, `cli`, server and
  web app), the Captain template, Dockerfile, compose files, CI, and the PolyForm Noncommercial
  1.0.0 license with a contributor agreement.
