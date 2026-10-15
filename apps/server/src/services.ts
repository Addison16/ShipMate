import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  CODEX_PROVIDER,
  CURSOR_PROVIDER,
  DEFAULT_MODEL,
  GEMINI_PROVIDER,
  type ServerEvent,
  SHIPMATE_VERSION,
} from "@shipmate/core";
import { claudeCliStatus, codexCliStatus, cursorCliStatus, geminiCliStatus } from "@shipmate/crew";
import type { Db } from "@shipmate/db";
import { SecretVault } from "@shipmate/providers";
import { SessionStore } from "./auth.js";
import { Bridge } from "./bridge.js";
import type { Config } from "./config.js";
import { DiscordJsPort } from "./discord/discordjs.js";
import type { DiscordClientPort } from "./discord/port.js";
import { DiscordService } from "./discord/service.js";
import { EverydayTools } from "./everyday.js";
import { AttachmentService } from "./files/service.js";
import { ReleaseChecker } from "./health/releases.js";
import { HealthService } from "./health/service.js";
import { Updater } from "./health/updater.js";
import { type CodexPainter, codexPainter } from "./pets/codex.js";
import { type PetFetch, PetService } from "./pets/service.js";
import { PushService } from "./push/service.js";
import type { PushFetch } from "./push/webpush.js";
import { ApprovalService } from "./services/approvals.js";
import { AuditService } from "./services/audit.js";
import { BackupService } from "./services/backups.js";
import { CrewService } from "./services/crew.js";
import { CrewBundleService } from "./services/crew-bundles.js";
import { GeminiKeyService } from "./services/gemini-key.js";
import { type GoogleFetch, GoogleOAuthService } from "./services/google-oauth.js";
import { ListService } from "./services/lists.js";
import { LocalAiService } from "./services/local-ai.js";
import { McpService } from "./services/mcp.js";
import { type OidcDiscover, OidcService } from "./services/oidc.js";
import { ProfileService } from "./services/profiles.js";
import { ProviderService } from "./services/providers.js";
import { SettingsService } from "./services/settings.js";
import { SkillService } from "./services/skills.js";
import { StarterService } from "./services/starters.js";
import { ThemeService } from "./services/themes.js";
import { UsageService } from "./services/usage.js";
import { WatchService } from "./services/watches.js";
import { WeatherService } from "./services/weather.js";
import { DockerClient, endpointFromEnv } from "./shipyard/docker.js";
import { ShipyardService } from "./shipyard/service.js";
import type { SlackPort } from "./slack/port.js";
import { SlackService } from "./slack/service.js";
import { SlackWebApi } from "./slack/webapi.js";
import { TelegramBotApi } from "./telegram/botapi.js";
import type { TelegramPort } from "./telegram/port.js";
import { TelegramService } from "./telegram/service.js";
import { type VoiceFetch, VoiceService } from "./voice/service.js";

export interface Services {
  db: Db;
  sessions: SessionStore;
  settings: SettingsService;
  providers: ProviderService;
  crew: CrewService;
  mcp: McpService;
  google: GoogleOAuthService;
  usage: UsageService;
  approvals: ApprovalService;
  audit: AuditService;
  skills: SkillService;
  watches: WatchService;
  bridge: Bridge;
  discord: DiscordService;
  telegram: TelegramService;
  slack: SlackService;
  shipyard: ShipyardService;
  oidc: OidcService;
  backups: BackupService;
  starters: StarterService;
  lists: ListService;
  profiles: ProfileService;
  crewBundles: CrewBundleService;
  push: PushService;
  files: AttachmentService;
  /** The Gemini API key for the Gemini CLI engine. */
  geminiKey: GeminiKeyService;
  voice: VoiceService;
  localAi: LocalAiService;
  health: HealthService;
  pets: PetService;
  themes: ThemeService;
}

/**
 * Wire the services together and bring disk and pi in step with the database: seed the
 * Captain, mirror the crew, and load provider keys into pi's model runtime.
 */
export async function createServices(
  config: Config,
  db: Db,
  options: {
    modelRuntime?: ModelRuntime;
    extraProviders?: string[];
    /** Stand-in for discord.js (tests). */
    discordPort?: DiscordClientPort;
    /** Stand-ins for the Telegram Bot API and Slack (tests). */
    telegramPort?: TelegramPort;
    slackPort?: SlackPort;
    /** Stand-in for OIDC discovery (tests). */
    oidcDiscover?: OidcDiscover;
    /** Stand-in for Open-Meteo (tests). */
    weather?: WeatherService;
    /** Stand-in for the Web Push services (tests). */
    pushFetch?: PushFetch;
    /** Stand-in for speech services (tests). */
    voiceFetch?: VoiceFetch;
    /** Stand-in for Google's OAuth endpoints (tests). */
    googleFetch?: GoogleFetch;
    /** Stand-in for image models (tests). */
    petFetch?: PetFetch;
    /** Stand-in for pictures made through the Codex CLI (tests). */
    codexPainter?: CodexPainter;
  } = {},
): Promise<Services> {
  const vault = new SecretVault(config.SHIPMATE_SECRET);
  const runtime =
    options.modelRuntime ??
    (await ModelRuntime.create({
      authPath: `${config.dirs.pi}/auth.json`,
      modelsPath: `${config.dirs.pi}/models.json`,
    }));
  const settings = new SettingsService(db);
  const providers = new ProviderService(db, vault, runtime, options.extraProviders);
  const crew = new CrewService(db, config.dirs.crew, config.TEMPLATES_DIR);
  const google = new GoogleOAuthService({
    settings,
    vault,
    baseUrl: config.SHIPMATE_URL,
    port: config.PORT,
    credentialsDir: join(config.dirs.mcp, "google"),
    fetch: options.googleFetch,
  });
  const mcp = new McpService(db, vault, crew, config.SHIPMATE_MCP === "on", google);
  const usage = new UsageService(db);
  const audit = new AuditService(db);
  const skills = new SkillService(config.dirs.root, crew);
  // Approvals reach people through the Bridge's sockets, which exist once the Bridge does.
  let bridge: Bridge | undefined;
  const emit = (userId: string, event: ServerEvent) => bridge?.emit(userId, event);
  const approvals = new ApprovalService(emit);
  // Shared lists go to everyone's open web apps; private ones only to their owner.
  const lists = new ListService(db, (ownerId, event) =>
    ownerId ? bridge?.emit(ownerId, event) : bridge?.broadcast(event),
  );
  const files = new AttachmentService(db, config.dirs.files);
  const themes = new ThemeService(db);
  const geminiKey = new GeminiKeyService(db, vault);
  bridge = new Bridge({
    themes,
    db,
    crew,
    providers,
    mcp,
    settings,
    usage,
    approvals,
    audit,
    skills,
    files,
    agentDir: config.dirs.pi,
    geminiKey: () => geminiKey.get(),
  });
  const watches = new WatchService(db, db.$client, crew, bridge, audit, emit, config.SHIPMATE_URL);
  bridge.attachWatches(watches);
  const pets = new PetService(
    db,
    vault,
    settings,
    options.petFetch,
    options.codexPainter ?? codexPainter(config.dirs.root),
  );
  bridge.attachPets(pets);
  const profiles = new ProfileService(db, settings);
  bridge.attachEveryday(
    new EverydayTools({ db, lists, profiles, weather: options.weather ?? new WeatherService() }),
  );
  const shipyard = new ShipyardService({
    db,
    vault,
    bridge,
    crew,
    settings,
    workspacesDir: config.dirs.workspaces,
    hostDataDir: process.env.SHIPMATE_HOST_DATA_DIR || undefined,
    dockerEndpoint: endpointFromEnv(),
    sandboxWorkspaces: process.env.SHIPMATE_SANDBOX_WORKSPACES || undefined,
    sandboxImage: process.env.SHIPMATE_SANDBOX_IMAGE || undefined,
    publicUrl: config.SHIPMATE_URL,
    githubApi: process.env.SHIPMATE_GITHUB_API || undefined,
    githubWeb: process.env.SHIPMATE_GITHUB_URL || undefined,
    watches,
    isLeader: () => watches.isLeader,
  });
  bridge.attachWorkspaces(shipyard);
  const push = new PushService({
    db,
    vault,
    secret: config.SHIPMATE_SECRET,
    publicUrl: config.SHIPMATE_URL,
    extraHosts: (process.env.SHIPMATE_PUSH_HOSTS ?? "").split(","),
    wordsFor: (userId) => themes.wordsFor(userId),
    ...(options.pushFetch ? { fetch: options.pushFetch } : {}),
  });
  bridge.tap((userId, event) => push.handle(userId, event));

  const current = await settings.get();
  await crew.boot({ name: current.captainName });
  await providers.sync();
  // Asks local servers for their context sizes without holding up boot.
  void providers.refreshContexts();
  await shipyard.loadEndpoint();

  const discord = new DiscordService({
    db,
    vault,
    crew,
    bridge,
    approvals,
    port: options.discordPort ?? new DiscordJsPort(),
    readFile: (userId, id) => files.read(userId, id),
  });
  // Connects in the background when a bot token is stored; problems show on the Discord page.
  void discord.start();
  // Telegram and Slack start when the app is ready (app.ts), if their tokens are stored.
  const telegram = new TelegramService({
    db,
    vault,
    crew,
    bridge,
    approvals,
    port: options.telegramPort ?? new TelegramBotApi(),
    readFile: (userId, id) => files.read(userId, id),
  });
  const slack = new SlackService({
    db,
    vault,
    crew,
    bridge,
    approvals,
    port: options.slackPort ?? new SlackWebApi(),
    readFile: (userId, id) => files.read(userId, id),
  });
  // Each successful watch run's result also goes to the chat apps its owner has linked.
  for (const app of [discord, telegram, slack]) watches.onReport((r) => app.report(r));

  const backups = new BackupService(
    db,
    settings,
    audit,
    config.dirs.root,
    process.env.SHIPMATE_BACKUP_DIR || `${config.dirs.root}/backups`,
  );
  const health = new HealthService(
    {
      db,
      dataDir: config.dirs.root,
      publicUrl: config.SHIPMATE_URL,
      providers: () => providers.records(),
      chatgpt: () => providers.chatgpt.status(),
      claudeCli: async () => {
        const onDefault = (await settings.get()).defaultModel.startsWith("claude-code/");
        const used = crew.registry
          .list()
          .some(
            (f) =>
              f.manifest.backend === "claude-code-cli" ||
              (onDefault && f.manifest.model === DEFAULT_MODEL),
          );
        if (!used) return { used, installed: false, signedIn: false };
        const s = await claudeCliStatus();
        return { used, installed: s.installed, signedIn: s.signedIn };
      },
      codexCli: async () => {
        const onDefault = (await settings.get()).defaultModel.startsWith(`${CODEX_PROVIDER}/`);
        const used = crew.registry
          .list()
          .some(
            (f) =>
              f.manifest.backend === "codex-cli" ||
              (onDefault && f.manifest.model === DEFAULT_MODEL),
          );
        if (!used) return { used, installed: false, signedIn: false };
        const s = await codexCliStatus();
        return { used, installed: s.installed, signedIn: s.signedIn };
      },
      cursorCli: async () => {
        const onDefault = (await settings.get()).defaultModel.startsWith(`${CURSOR_PROVIDER}/`);
        const used = crew.registry
          .list()
          .some(
            (f) =>
              f.manifest.backend === "cursor-cli" ||
              (onDefault && f.manifest.model === DEFAULT_MODEL),
          );
        if (!used) return { used, installed: false, signedIn: false };
        const s = await cursorCliStatus();
        return { used, installed: s.installed, signedIn: s.signedIn };
      },
      geminiCli: async () => {
        const onDefault = (await settings.get()).defaultModel.startsWith(`${GEMINI_PROVIDER}/`);
        const used = crew.registry
          .list()
          .some(
            (f) =>
              f.manifest.backend === "gemini-cli" ||
              (onDefault && f.manifest.model === DEFAULT_MODEL),
          );
        if (!used) return { used, installed: false, signedIn: false };
        const s = await geminiCliStatus({ apiKey: await geminiKey.get() });
        return { used, installed: s.installed, signedIn: s.signedIn };
      },
      bridges: [
        { id: "discord", name: "Discord", status: () => discord.status() },
        { id: "telegram", name: "Telegram", status: () => telegram.status() },
        { id: "slack", name: "Slack", status: () => slack.status() },
      ],
      sandbox: () => shipyard.status(),
      backups: async () => ({ list: await backups.list(), settings: await backups.getSettings() }),
    },
    new ReleaseChecker({
      current: SHIPMATE_VERSION,
      enabled: config.SHIPMATE_UPDATE_CHECK === "on",
      apiBase: process.env.SHIPMATE_GITHUB_API || undefined,
    }),
    // The Docker that runs Shipmate itself (not a remote sandbox host).
    new Updater(new DockerClient(process.env.DOCKER_SOCKET || "/var/run/docker.sock"), {
      current: SHIPMATE_VERSION,
      container: config.SHIPMATE_CONTAINER,
      updaterImage: config.SHIPMATE_UPDATER_IMAGE,
    }),
    SHIPMATE_VERSION,
  );

  return {
    db,
    sessions: new SessionStore(db),
    settings,
    providers,
    crew,
    mcp,
    google,
    usage,
    approvals,
    audit,
    skills,
    watches,
    bridge,
    discord,
    telegram,
    slack,
    shipyard,
    lists,
    profiles,
    crewBundles: new CrewBundleService({ crew, settings, providers, mcp, skills }),
    starters: new StarterService(config.TEMPLATES_DIR, crew, mcp, watches),
    push,
    files,
    geminiKey,
    voice: new VoiceService(db, vault, settings, options.voiceFetch),
    backups,
    health,
    pets,
    themes,
    localAi: new LocalAiService(providers, settings, config.SHIPMATE_OLLAMA_URL),
    oidc: new OidcService({
      db,
      settings,
      vault,
      audit,
      baseUrl: config.SHIPMATE_URL,
      discover: options.oidcDiscover,
    }),
  };
}
