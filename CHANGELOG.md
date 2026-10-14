# Changelog

All notable changes to Shipmate. Versions follow [semver](https://semver.org); each release is
published as `ghcr.io/addison16/shipmate:<version>` (plus `:<major>.<minor>`, `:<major>` and
`:latest`). Database migrations run on boot, so upgrading is pulling the new image.

## Unreleased

- **Tidier Usage and cost page on phones**: Month and Show (Mine / Everyone) sit side by side
  and line up, money shows as cents ($0.00, not $0.0000), the subscription note is one line
  with "More details", and the chart buttons and table names no longer wrap.
- **Crew pets (optional)**: any crew member can have a little creature that hangs out on the
  message box, dances while that crew member works and hops when the reply lands. Off until you
  make one: tap "Make a pet" on a crew member's Settings tab (or just ask the Captain), answer a
  few tap questions, and keep or redo the result. Pictures come from the image model picked
  under Settings → Photos and voice (an OpenAI or OpenAI-compatible provider, a local image
  server); without one, the Captain draws the pet as an SVG, so it always works. See [docs/pets.md](docs/pets.md).
- **The crew keep working when you close the app**: a reply carries on on the server when you
  close the tab or the phone app, as it always did, and now a chat you open again mid-reply
  shows everything written so far and the Stop button, then keeps streaming. Coming back to
  the phone app after a while reconnects at once instead of waiting on a dead connection.
- **Custom themes, built by your AI**: Settings > Appearance > Make a custom theme opens a chat
  where the Captain follows a step-by-step build guide (`theme_build_guide`) to make a theme
  around any idea, a trainer adventure or a company with a CEO: accent color and grays (light
  and dark, kept readable automatically), font, corners, an original SVG logo, the app's words
  (Bridge, Crew, Captain, Watches, Shipyard, the app name) and the crew's voice. It posts a
  preview card with Try it; each person picks their own theme, can keep several, and goes back
  to the standard look by picking a color theme. Themes import and export as files, so other
  AIs can make them too. See docs/custom-themes.md.
- **Plain AI words by default**: the app now says Assistant, Agents, Chat, Routines and
  Projects. The ship words (Captain, Crew, Bridge, Watches, Shipyard) are one tap away in
  Settings > Appearance > Words. The setup guide has a new Style step that explains this and
  offers "Make my own", which opens the theme chat when setup ends. Existing crew names are
  unchanged; a coordinator still named "Captain" shows as "Assistant" in the plain style.
- **Theme building works with small local models**: the build guide is now nine short steps
  with exact questions and an example to copy, and `save_theme` fixes sloppy input instead of
  refusing it (color names, missing fields, a logo wrapped in code fences) and says what it
  changed.
- **Codex engine**: a third Engine choice, Codex (your ChatGPT plan). Shipmate runs the
  official, unmodified `codex` CLI (included in the image) for that crew member, signed in once
  with `docker exec -it shipmate codex login --device-auth`; Shipmate never sees the login. Pick
  a `codex/<model>` model and how much Codex may do (read only, edit its folder, or anything).
  Shipmate's own tools (memory, lists, the Captain's crew tools) reach it under the usual
  approvals; its own MCP servers and Shipyard projects stay on the other engines. Pictures it
  makes with Codex's built-in image tool show under its reply. In read only and edit modes Codex
  only sees its own folder (plus system folders), not the rest of `/data`. Signed in with an API
  key instead of ChatGPT, its use counts as API spend and towards caps.
- **Helper agents (sub agents)**: tick "Let it start helper agents" in a crew member's
  settings (`helpers: true` in crew.yaml). On Shipmate (pi) it gets a `helper` tool that runs
  short-lived copies of itself side by side, with its tools and approvals, up to 8 per message;
  on Claude Code it allows Claude Code's own sub agent tool. Helpers spend from the same caps,
  and the Captain can turn them on with `edit_crew_member`.
- **Pick the engine**: crew settings now have an Engine choice, Shipmate (pi) or Claude Code
  (your Claude subscription), instead of switching only by picking a Claude model.
- **Crew questions you answer with a tap**: when a crew member needs your decision, it asks
  with `ask_person` and you get a card with its choices as buttons (plus "Something else" and
  Skip), on the Bridge, in Discord, Telegram and Slack, like ChatGPT and Claude do. The crew
  member carries on with your answer, and the question and answer stay in the conversation.
- **The Captain equips the crew, asking first**: new `equip_crew_member` gives a crew member
  MCP servers (installing catalog ones), tools, skills and Claude Code tools. It, installing a
  server, and any `edit_crew_member` change to what a crew member may do always wait for an
  Approve or Decline card with a plain summary, whatever the approval setting.
- **Simpler crew permissions**: Claude Code's options are in plain words, with a new
  "Allow all tools" (with a warning); its allowed tools, the approval lists and skills are
  checkboxes with an "Other" field instead of typed names; and "Allow all built-in tools" and
  "All installed servers" toggles replace the old "leave every box unticked" rule.
- **Sign-in never just sits there**: the sign-in cookie is marked https-only only when the
  browser actually came in over https, so signing in at a plain http LAN address works even when
  `SHIPMATE_URL` names the https one (before, the browser dropped the cookie and the form did
  nothing). If a browser still refuses the cookie, the sign-in page says so, and a server that
  never answers gets a "took too long" message instead of an endless spinner.
- **The crew default can be your Claude subscription**: Settings → General now offers the
  Claude subscription when it is signed in, and crew on the crew default then run on it. When the
  saved default is something this instance is not signed in to, the page says so and names what
  the crew use instead. Setting up with only the Claude subscription makes it the default too.
- **Phone and desktop layout fixes**: the daily briefing's time field on Watches no longer runs
  past the card on iPhone, Crew cards no longer run off the right edge on a phone, and the Bridge
  no longer scrolls far past the chat into empty space.
- **One container, one command**: the image now has Postgres built in. With no `DATABASE_URL`
  it starts its own database before Shipmate, keeps it in `/data/postgres`, and listens only
  inside the container, so `docker run … ghcr.io/addison16/shipmate:latest` (or one Unraid
  container) is a whole install. Set `DATABASE_URL` to keep using your own Postgres; existing
  installs carry on unchanged. Backups skip the database's raw files and restores leave them in
  place, and `shipmate restore` in a stopped container's volumes starts the built-in database
  for the restore. The Unraid template no longer needs a separate Postgres container.
- **The Captain sets people up**: ask the Captain to set someone up and it fills in their
  profile (diet, budget, timezone, schedule, notes), theme and spending cap, the household facts,
  and any crew member setting (model, backend, tools, MCP servers, skills, approvals, cap,
  visibility). Members can change only their own settings this way; owners and admins can set up
  anyone, and caps and renaming others stay with the owner. Edits keep the comments in
  `crew.yaml`. Unedited Captain standing orders are upgraded to mention this.
  The Captain can also put a crew member it recruited (or one imported) to work with
  `approve_crew_member`, which always shows you an approval card in the conversation first,
  whatever the Captain's approval settings, so no crew member starts work without a person's yes.
- **Crew settings**: a crew member's Manifest tab is now **Settings**, a form for everything in
  its `crew.yaml` (name, role, who can use it, what it runs on and its model, Claude Code
  options, built-in tools, MCP servers, skills, approvals and the monthly cap). **Edit file**
  switches to the raw YAML; both edit the same draft, and the form only rewrites the lines you
  change, so comments and keys it doesn't know about are kept.
- **Subscription use is not spend**: calls through the Claude Code CLI (on a Claude
  subscription) or a ChatGPT plan no longer count as cost or towards monthly caps. The Cost page
  shows real API spend apart from a "Saved by subscriptions" estimate of what that use would have
  cost at API prices, with a column per person, crew member and model, a daily chart and two new
  CSV columns (`billing`, `api_equivalent_usd`). A CLI signed in with an API key still counts as
  spend. Existing Claude Code and ChatGPT usage is moved over on upgrade.
- **Direct chats, reworked**: the Bridge opens on "Who would you like to talk to?", with the
  Captain and every crew member one tap away. "Chat with…" opens a searchable crew picker
  (arrow keys and Enter work). Each crew member keeps one chat with you: talking to them again
  continues it instead of starting another. The conversation list shows who each chat is with
  and the latest message, and a chat's header shows its crew member, what they do and a link to
  their settings. **Start fresh** (or typing `/new`) makes the crew forget the chat so far while
  the messages stay on screen below a divider. Unsent text is kept per chat when you switch.
  Crew member pages get a **Chat** button. On phones the crew sit in a row of avatars above the
  chat list, the picker opens as a bottom sheet, and Start fresh is an icon in the chat header.
- **Motion and polish**: pages fade in as you arrive, cards and lists rise in one after another,
  chat messages slide in from their side, and a crew member who is working shows bouncing dots
  instead of "typing…". Loading spots show shimmering placeholders, empty pages show an icon, a
  line of help and the next step, each page has its icon beside its title, and buttons, fields,
  dialogs and failure notices respond with small transitions. People whose device asks for
  reduced motion get none of it. On phones, buttons and cards show a pressed state, fields no
  longer zoom the page when tapped, the chat's Pin, Rename and Delete become icons so its title
  fits, and an installed app keeps the top bar, menu, message box, approvals, notices and the end of
  every page clear of the notch and the home indicator.
- **Simpler navigation**: the sidebar is down to six places (Bridge, Lists, Watches, Shipyard,
  Crew, Settings), each with a one-line hint of what it is for. Settings opens on an overview of
  every screen in four groups (You, Crew and tools, AI and cost, This Shipmate) with a filter box,
  and each screen keeps that list beside it. Press **Ctrl K** (**⌘K** on a Mac), **/**, or the
  Search button to jump to any page, setting or crew member by typing a few letters, such as
  "discord" or "password". Old links like `#/providers` still work. On phones, the five
  everyday places sit in a tab bar at the bottom, in thumb reach (hidden inside an open chat so
  the message box keeps the room).
- **Actions where you look for them**: every chat in the Bridge list has pin, rename and delete
  buttons on its row (rename happens in place), list cards have rename and delete, and each
  watch has edit and delete next to **Run now**, so nothing needs opening first to find them.
- **The Captain coordinates on Claude Code too**: a Captain running on a Claude subscription now
  hands your messages to the right crew member with `delegate`, like one on a provider. Crew on
  Claude Code also get Shipmate's own tools (memory, lists, `ask_captain`), served to the CLI by
  a small per-turn MCP endpoint over loopback and gated by the same approval rules. A Captain on
  Claude Code also answers crew members' `ask_captain` questions instead of declining.
- **One crew default model**: crew.yaml can say `model: default`, which means the crew default
  picked in Settings, and follows it when it changes. New crew, starters and recruits start on
  it. Settings has "Put everyone on the crew default" for existing crew, and each crew member's
  page has a model picker for giving one its own model.
- **Pick where a model runs, then which one**: model pickers are two dropdowns, a provider (or
  the Claude subscription, or the crew default) and then its models. Choosing a Claude
  subscription model for a crew member also moves it onto Claude Code, and the setup guide asks
  which Claude model the Captain should use.
- **Claude Code crew can read their own files**: crew on the Claude subscription were refused
  every tool in the default `dontAsk` mode ("Permission to use Read has been denied"). They may
  now read inside their working folder (not other people's private memory) and search or fetch the web out of the box, on top of their
  `cli.allowedTools`.
- **Only usable models**: the Providers page lists the models you can run with what is signed in
  or configured (including the Claude Code models when it is signed in), not every model pi
  knows. Model pickers leave out models nothing is configured for.
- **"What will you use Shipmate for?"**: the setup guide now opens by asking whether Shipmate is
  for home life, work or both, and tailors what follows. Work gets a short "basics" step (where
  you're based, working hours) with no family questions, and home keeps the household details
  behind an "Add more" button. The starter crew step suggests crew that match, with the rest
  listed underneath, and the Captain preview asks a work question for work. Two new starter
  crew for work: **Yeoman** (to-do list, email drafts, meeting prep) and **Lookout** (web
  research with sources). The answer is part of the household facts every crew member reads
  and can be changed in Settings.
- **Claude subscription in the setup guide**: when Claude Code is signed in, the model step can
  run the Captain (and the starter crew brought aboard next) on it and continue, instead of only
  offering "Next without a model". The Bridge no longer warns about a missing provider when the
  Captain runs on Claude Code. Copy buttons now work when Shipmate is opened over plain http
  (a LAN address), where browsers hide the clipboard API.
- **First-launch guide**: a new install walks the owner through a step-by-step, skippable setup
  after creating the account: connect a model (Ollama, ChatGPT plan, Claude subscription or an API
  key) and pick the crew's default, name the Captain and choose its personality (five presets or
  your own words, written into its CREW.md), home facts and theme, adding household members, a
  starter crew, notifications and chat apps, an optional Shipyard project, and a closing tour.
  It saves as it goes and resumes on the same step after a reload or sign-in; owners can run it
  again from Settings. Existing instances are not affected. People the owner adds later get a
  short welcome (profile, theme and notifications, tour) on their first sign-in.
- **Reverse proxies**: Shipmate believes `X-Forwarded-*` from proxies on the same machine,
  Docker networks and the LAN by default (`SHIPMATE_TRUST_PROXY` to change it), keeps the
  Bridge's WebSocket alive through proxy idle timeouts, and the Health page gains a **Web
  address** check that spots a `SHIPMATE_URL` that doesn't match the address in use or https
  that didn't reach Shipmate. Configs for Nginx Proxy Manager, SWAG, Traefik, Caddy, nginx and
  Cloudflare Tunnel in [docs/reverse-proxy.md](docs/reverse-proxy.md).
- **Configuration reference**: every environment variable and the `/data` folder layout in
  [docs/configuration.md](docs/configuration.md); the Unraid guide gains a "what goes where"
  table, custom network and reverse proxy steps, and the template an icon.

- **Push notifications** on phones and desktops (Web Push, no third-party account): approval
  requests, watch results, and crew replies while no tab is open. Turn them on per device in
  Settings → Notifications and choose what each device gets; **Send a test** checks them all.
  On iPhone and iPad, add Shipmate to the Home Screen first. See [docs/phone.md](docs/phone.md).
- **Approve or deny from the notification**: approval notifications have Approve and Deny
  buttons backed by a one-time token for that request and person, so they work without opening
  the app. Where buttons are not supported, a tap opens the request.
- **Typed approvals in chat bridges**: besides the buttons, answer an approval card in Discord,
  Telegram or Slack by typing `approve`, `deny` or `always` (or `yes` / `no`). Only the person
  who was asked can answer.
- **Photos and files in chat**: attach photos (or take one with the phone's camera), PDFs and
  text files on the Bridge. Photos go to the model as images; when a crew member's model cannot
  see images, a vision-capable model takes that message (pick it in Settings → Photos) and the
  chat says so. PDFs and text files are passed as text. Files show as thumbnails and chips in
  the conversation and only their uploader can open them.
- **Voice**: talk to the crew with the mic button and hear replies with the speaker button, or
  turn on **Hands-free** to have replies read aloud and your words sent as you speak. Speech
  runs through a provider you already have (OpenAI or OpenAI-compatible), your own speech
  server (local Whisper and Kokoro; an optional `voice` service ships in docker-compose behind
  the `voice` profile), or the browser's built-in voice. Set it up in Settings → Voice.
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
- **Conversation search and pinning**: a search box on the Bridge finds words and phrases across
  all of your own conversations (web, chat bridges and watch runs) with highlighted excerpts,
  using Postgres full-text search. Pin conversations to keep them at the top.
- **Share crew members**: **Export** on a crew member's page downloads one
  `.shipmate-crew.json` file with its crew.yaml, CREW.md and skills. Memory, sessions, granted
  approvals, spend caps and anything that looks like a key are left out. **Crew → Import** reads
  such a file or an https link (public hosts only, 512 KB at most), shows a preview with
  warnings, and brings the crew member aboard awaiting review, with its skills pending approval.
- **Issue-to-PR jobs**: assign an issue to the Shipwright from a project's Issues tab (or let a
  label or GitHub assignee start one). It works the issue on a branch, opens a draft pull
  request, follows CI and pushes fixes for failures up to a limit, then marks the pull request
  ready for review. Each job has a status card on the project page: working, PR open, CI
  running, CI red (attempt n), review, needs you, ready for review, gave up.
- **The Bosun**, a starter reviewer crew member. Turn it on per project and it reviews each job's
  pull request once CI is green, posting its review on GitHub; the Shipwright addresses blocking
  findings before the pull request goes to people.
- **GitHub webhooks drive the Shipyard**: signed deliveries start jobs from labelled or assigned
  issues, move jobs on CI results, route comments to the conversation, and run watches with the
  new "When something happens on GitHub" trigger. Projects without a webhook are polled. Project
  settings show the last delivery and can make a new secret.
- **Shipyard sandboxes without the Docker socket**: point the Shipyard at rootless Podman's
  socket, or at a Docker or Podman host elsewhere over TCP with TLS client certificates, from
  **Settings → Shipyard sandbox** (owner) or with `DOCKER_HOST`, `DOCKER_TLS_VERIFY` and
  `DOCKER_CERT_PATH`. **Test connection** says which engine answered or why it did not. The
  "Code cannot run right now" notice explains the options; see
  [docs/shipyard.md](docs/shipyard.md).
- **Bundled local models**: an optional Ollama service in `docker-compose.yml`, off by default.
  `docker compose --profile local-ai up -d` starts it and downloads a small starter model, so
  Shipmate runs with no API key at all. First-run setup and **Providers → Local model** find
  the Ollama server (address configurable, `SHIPMATE_OLLAMA_URL`), suggest a few small models
  that handle tools, download one with live progress, and set it up as the Ollama provider and
  the default model in one click. NAS templates and [docs/local-models.md](docs/local-models.md)
  cover running it on Unraid and TrueNAS and with a GPU.
- **Health page** for owners and admins: the running version, the latest GitHub release with
  its notes (cached, failure-tolerant, off with `SHIPMATE_UPDATE_CHECK=off`), and checks with
  a hint each for Postgres and migrations, every model provider (free requests only, never a
  model call), connected chat bridges, the Docker socket, free disk space and backup recency.
- **One-click update**: with the Docker socket mounted and a moving image tag, the owner can
  update after a confirm. A short-lived helper container (a one-shot Watchtower) pulls the
  image and recreates Shipmate's container with the same settings; the page reloads when the
  new version answers. Otherwise, and on Unraid and TrueNAS, it shows the commands to run.
- **Cost page for local models**: every model call now records how long the model took to
  answer. The Cost page shows average and p95 response time per person, crew member, watch and
  model, and the daily chart switches between cost, tokens and response time. When a month ran
  only on free (local) models it opens on tokens instead of a flat $0 line. The CSV export gains
  a `response_ms` column. Per-person metering and caps are unchanged.

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
