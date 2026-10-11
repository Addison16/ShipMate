import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerEvent } from "@shipmate/core";
import type { Db } from "@shipmate/db";
import { SecretVault } from "@shipmate/providers";
import { SessionStore } from "./auth.js";
import { Bridge } from "./bridge.js";
import type { Config } from "./config.js";
import { DiscordJsPort } from "./discord/discordjs.js";
import type { DiscordClientPort } from "./discord/port.js";
import { DiscordService } from "./discord/service.js";
import { EverydayTools } from "./everyday.js";
import { ApprovalService } from "./services/approvals.js";
import { AuditService } from "./services/audit.js";
import { BackupService } from "./services/backups.js";
import { CrewService } from "./services/crew.js";
import { ListService } from "./services/lists.js";
import { McpService } from "./services/mcp.js";
import { type OidcDiscover, OidcService } from "./services/oidc.js";
import { ProviderService } from "./services/providers.js";
import { SettingsService } from "./services/settings.js";
import { SkillService } from "./services/skills.js";
import { StarterService } from "./services/starters.js";
import { UsageService } from "./services/usage.js";
import { WatchService } from "./services/watches.js";
import { ShipyardService } from "./shipyard/service.js";
import type { SlackPort } from "./slack/port.js";
import { SlackService } from "./slack/service.js";
import { SlackWebApi } from "./slack/webapi.js";
import { TelegramBotApi } from "./telegram/botapi.js";
import type { TelegramPort } from "./telegram/port.js";
import { TelegramService } from "./telegram/service.js";

export interface Services {
  db: Db;
  sessions: SessionStore;
  settings: SettingsService;
  providers: ProviderService;
  crew: CrewService;
  mcp: McpService;
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
  const mcp = new McpService(db, vault, crew, config.SHIPMATE_MCP === "on");
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
  bridge = new Bridge({
    db,
    crew,
    providers,
    mcp,
    settings,
    usage,
    approvals,
    audit,
    skills,
    agentDir: config.dirs.pi,
  });
  const watches = new WatchService(db, db.$client, crew, bridge, audit, emit, config.SHIPMATE_URL);
  bridge.attachWatches(watches);
  bridge.attachEveryday(new EverydayTools({ lists }));
  const shipyard = new ShipyardService({
    db,
    vault,
    bridge,
    crew,
    workspacesDir: config.dirs.workspaces,
    hostDataDir: process.env.SHIPMATE_HOST_DATA_DIR || undefined,
    dockerSocket: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
    sandboxImage: process.env.SHIPMATE_SANDBOX_IMAGE || undefined,
    publicUrl: config.SHIPMATE_URL,
    githubApi: process.env.SHIPMATE_GITHUB_API || undefined,
    githubWeb: process.env.SHIPMATE_GITHUB_URL || undefined,
  });
  bridge.attachWorkspaces(shipyard);

  const current = await settings.get();
  await crew.boot({ name: current.captainName });
  await providers.sync();

  const discord = new DiscordService({
    db,
    vault,
    crew,
    bridge,
    approvals,
    port: options.discordPort ?? new DiscordJsPort(),
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
  });
  const slack = new SlackService({
    db,
    vault,
    crew,
    bridge,
    approvals,
    port: options.slackPort ?? new SlackWebApi(),
  });

  return {
    db,
    sessions: new SessionStore(db, config.secureCookies),
    settings,
    providers,
    crew,
    mcp,
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
    starters: new StarterService(config.TEMPLATES_DIR, crew, settings, mcp, watches),
    backups: new BackupService(
      db,
      settings,
      audit,
      config.dirs.root,
      process.env.SHIPMATE_BACKUP_DIR || `${config.dirs.root}/backups`,
    ),
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
