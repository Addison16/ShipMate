import { existsSync } from "node:fs";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { type ClientEvent, type ServerEvent, SHIPMATE_VERSION } from "@shipmate/core";
import { createDb } from "@shipmate/db";
import { coreServers } from "@shipmate/mcp-catalog";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { ZodError, z } from "zod";
import { HttpError, type UserRow } from "./auth.js";
import { CLI_MCP_PATH, cliMcpRoutes } from "./cli-mcp.js";
import type { Config } from "./config.js";
import { approvalRoutes, DecisionSchema } from "./routes/approvals.js";
import { authRoutes } from "./routes/auth.js";
import { backupRoutes } from "./routes/backups.js";
import { claudeCliRoutes } from "./routes/claude-cli.js";
import { conversationRoutes } from "./routes/conversations.js";
import { crewRoutes } from "./routes/crew.js";
import { discordRoutes } from "./routes/discord.js";
import { fileRoutes } from "./routes/files.js";
import { healthRoutes } from "./routes/health.js";
import { listRoutes } from "./routes/lists.js";
import { localAiRoutes } from "./routes/local-ai.js";
import { mcpRoutes } from "./routes/mcp.js";
import { oidcRoutes } from "./routes/oidc.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { petRoutes } from "./routes/pets.js";
import { profileRoutes } from "./routes/profiles.js";
import { providerRoutes } from "./routes/providers.js";
import { pushRoutes } from "./routes/push.js";
import { shipyardRoutes } from "./routes/shipyard.js";
import { skillRoutes } from "./routes/skills.js";
import { slackRoutes } from "./routes/slack.js";
import { telegramRoutes } from "./routes/telegram.js";
import { themeRoutes } from "./routes/themes.js";
import { settingsRoutes, usageRoutes } from "./routes/usage.js";
import { userRoutes } from "./routes/users.js";
import { voiceRoutes } from "./routes/voice.js";
import { watchRoutes } from "./routes/watches.js";
import { GOOGLE_CALLBACK_PATH } from "./services/google-oauth.js";
import { createServices } from "./services.js";

/** Routes reachable without signing in. */
const PUBLIC = new Set([
  "/api/auth/me",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/setup",
  "/api/meta",
  "/api/auth/oidc",
  "/api/auth/oidc/start",
  "/api/auth/oidc/callback",
  // Checked by its one-time state instead: Google may send the browser to another address.
  GOOGLE_CALLBACK_PATH,
]);
/** Prefixes reachable without signing in; each route checks its own credential (a token). */
const PUBLIC_PREFIXES = ["/api/hooks/", "/api/push/act/", CLI_MCP_PATH];

/** How often the Bridge's WebSocket is pinged, under common proxy idle timeouts (60 s). */
const WS_PING_MS = 25_000;

const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    conversationId: z.string().uuid(),
    text: z.string().max(100_000),
    attachments: z.array(z.string().uuid()).max(8).optional(),
  }),
  z.object({ type: z.literal("abort"), conversationId: z.string().uuid() }),
  z.object({
    type: z.literal("approve"),
    approvalId: z.string(),
    decision: DecisionSchema,
    answer: z.string().max(4000).optional(),
  }),
]);

export async function buildApp(
  config: Config,
  options: {
    modelRuntime?: ModelRuntime;
    extraProviders?: string[];
    logger?: boolean;
    /** Schedule watches (default on); tests run them by hand. */
    watches?: boolean;
    /** Stand-in for discord.js (tests). */
    discordPort?: import("./discord/port.js").DiscordClientPort;
    /** Stand-ins for the Telegram Bot API and Slack (tests). */
    telegramPort?: import("./telegram/port.js").TelegramPort;
    slackPort?: import("./slack/port.js").SlackPort;
    /** Stand-in for Open-Meteo (tests). */
    weather?: import("./services/weather.js").WeatherService;
    /** Stand-in for the Web Push services (tests). */
    pushFetch?: import("./push/webpush.js").PushFetch;
    /** Stand-in for speech services (tests). */
    voiceFetch?: import("./voice/service.js").VoiceFetch;
    googleFetch?: import("./services/google-oauth.js").GoogleFetch;
    /** Stand-in for image models (tests). */
    petFetch?: import("./pets/service.js").PetFetch;
  } = {},
) {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
    // Behind a reverse proxy: the browser's address and https come from X-Forwarded-*.
    trustProxy: config.trustProxy,
  });
  const { db, close } = createDb(config.DATABASE_URL);
  const services = await createServices(config, db, options);
  app.decorate("db", db);
  app.decorate("services", services);
  app.decorateRequest("user", null as unknown as UserRow);
  let fileSweep: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    if (options.watches !== false) {
      await services.watches.start();
      // Issue-to-PR jobs poll GitHub where no webhook is set up (tests drive them by hand).
      await services.shipyard.jobs.start();
    }
    await services.backups.start();
    // Files of conversations or people deleted while the server was down (or by a restore), and
    // uploads nobody sent; then hourly, so abandoned uploads don't pile up.
    void services.files.sweep().catch(() => {});
    fileSweep = setInterval(() => void services.files.sweep().catch(() => {}), 3600_000);
    fileSweep.unref();
    // Chat bridges connect in the background when configured; problems show on their pages.
    void services.telegram.start();
    void services.slack.start();
  });
  // Crew on the Claude Code CLI reach Shipmate's tools over loopback (see cli-mcp.ts).
  app.addHook("onListen", async () => {
    const address = app.server.address();
    if (address && typeof address === "object") {
      services.bridge.cliTools.setBaseUrl(
        `http://${loopbackHost(address.address)}:${address.port}`,
      );
    }
  });
  app.addHook("onClose", async () => {
    clearInterval(fileSweep);
    await services.backups.stop();
    services.localAi.close();
    await services.watches.stop();
    services.shipyard.jobs.stop();
    services.approvals.close();
    await services.discord.stop();
    await services.telegram.stop();
    await services.slack.stop();
    await services.bridge.close();
    await close();
  });

  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return reply.code(400).send({ error: `${where}${issue?.message ?? "invalid request"}` });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: "something went wrong on the server" });
  });

  app.addHook("onRequest", async (req) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/") || PUBLIC.has(path)) return;
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;
    const user = await services.sessions.user(req);
    if (!user) throw new HttpError(401, "sign in first");
    req.user = user;
  });

  app.get("/healthz", async () => {
    await db.execute(sql`select 1`);
    return { ok: true, version: SHIPMATE_VERSION };
  });

  app.get("/api/meta", async () => ({
    version: SHIPMATE_VERSION,
    url: config.SHIPMATE_URL,
    coreMcpServers: coreServers().map((s) => s.id),
  }));

  await authRoutes(app, services);
  await userRoutes(app, services);
  await providerRoutes(app, services);
  await crewRoutes(app, services);
  await conversationRoutes(app, services);
  await usageRoutes(app, services);
  await settingsRoutes(app, services);
  await onboardingRoutes(app, services);
  await skillRoutes(app, services);
  await approvalRoutes(app, services);
  await watchRoutes(app, services);
  await listRoutes(app, services);
  await mcpRoutes(app, services);
  await profileRoutes(app, services);
  await shipyardRoutes(app, services);
  await discordRoutes(app, services);
  await telegramRoutes(app, services);
  await slackRoutes(app, services);
  await backupRoutes(app, services);
  await claudeCliRoutes(app, services);
  await cliMcpRoutes(app, services.bridge.cliTools);
  await pushRoutes(app, services);
  await fileRoutes(app, services);
  await voiceRoutes(app, services);
  await petRoutes(app, services);
  await localAiRoutes(app, services);
  await healthRoutes(app, services);
  await oidcRoutes(app, services);
  await themeRoutes(app, services);

  // The Bridge's live channel: streams crew replies and takes messages from the person.
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const user = req.user;
    const send = (event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    const disconnect = services.bridge.connect(user.id, send);
    // While a tab is open, crew replies show there instead of as push notifications.
    const present = services.push.opened(user.id);
    // Reverse proxies close quiet connections (nginx after 60 s by default); a ping every
    // 25 s keeps the Bridge's socket open while nobody is talking.
    const keepalive = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, WS_PING_MS);
    socket.on("close", () => {
      clearInterval(keepalive);
      disconnect();
      present();
    });
    send({ type: "hello", version: SHIPMATE_VERSION, userId: user.id });
    socket.on("message", (raw: Buffer) => {
      let event: ClientEvent;
      try {
        event = ClientEventSchema.parse(JSON.parse(raw.toString()));
      } catch {
        send({ type: "error", message: "unrecognized message" });
        return;
      }
      void handle(event).catch((err: Error) =>
        send({
          type: "error",
          ...("conversationId" in event ? { conversationId: event.conversationId } : {}),
          message: err.message,
        }),
      );
    });

    // Reload the account for every message, so a changed role or cap (or a signed-out
    // session) applies to sockets that are already open.
    const handle = async (event: ClientEvent) => {
      const current = await services.sessions.user(req);
      if (!current || current.id !== user.id) {
        send({ type: "error", message: "sign in again" });
        socket.close();
        return;
      }
      if (event.type === "approve") {
        services.approvals.decide(current.id, event.approvalId, event.decision, event.answer);
      } else if (event.type === "send") {
        await services.bridge.send(
          current,
          event.conversationId,
          event.text,
          event.attachments ?? [],
        );
      } else {
        await services.bridge.abort(current, event.conversationId);
      }
    };
  });

  if (config.WEB_DIST && existsSync(config.WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: config.WEB_DIST,
      wildcard: false,
      // PWA: the service worker and the shell must revalidate every load; hashed assets never change.
      cacheControl: false,
      setHeaders(res, filePath) {
        const name = filePath.replaceAll("\\", "/");
        if (name.endsWith("/sw.js") || name.endsWith("/index.html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else if (name.includes("/assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "public, max-age=0");
        }
        if (name.endsWith(".webmanifest")) {
          res.setHeader("Content-Type", "application/manifest+json");
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    db: import("@shipmate/db").Db;
    services: import("./services.js").Services;
  }
  interface FastifyRequest {
    /** Set for every /api route except the public ones. */
    user: UserRow;
  }
}

/** The address a process in this container uses to reach the server's own port. */
export function loopbackHost(address: string): string {
  if (address === "0.0.0.0" || address === "::" || address === "" || address === "::1") {
    return address === "::1" ? "[::1]" : "127.0.0.1";
  }
  return address.includes(":") ? `[${address}]` : address;
}
