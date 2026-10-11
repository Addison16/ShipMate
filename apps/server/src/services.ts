import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerEvent } from "@shipmate/core";
import type { Db } from "@shipmate/db";
import { SecretVault } from "@shipmate/providers";
import { SessionStore } from "./auth.js";
import { Bridge } from "./bridge.js";
import type { Config } from "./config.js";
import { ApprovalService } from "./services/approvals.js";
import { AuditService } from "./services/audit.js";
import { CrewService } from "./services/crew.js";
import { McpService } from "./services/mcp.js";
import { ProviderService } from "./services/providers.js";
import { SettingsService } from "./services/settings.js";
import { SkillService } from "./services/skills.js";
import { UsageService } from "./services/usage.js";
import { WatchService } from "./services/watches.js";

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
}

/**
 * Wire the services together and bring disk and pi in step with the database: seed the
 * Captain, mirror the crew, and load provider keys into pi's model runtime.
 */
export async function createServices(
  config: Config,
  db: Db,
  options: { modelRuntime?: ModelRuntime; extraProviders?: string[] } = {},
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
  const skills = new SkillService(config.dirs.root, config.dirs.crew);
  // Approvals reach people through the Bridge's sockets, which exist once the Bridge does.
  let bridge: Bridge | undefined;
  const emit = (userId: string, event: ServerEvent) => bridge?.emit(userId, event);
  const approvals = new ApprovalService(emit);
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

  const current = await settings.get();
  await crew.boot({ name: current.captainName });
  await providers.sync();

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
  };
}
