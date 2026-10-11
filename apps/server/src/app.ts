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
import type { Config } from "./config.js";
import { approvalRoutes, DecisionSchema } from "./routes/approvals.js";
import { authRoutes } from "./routes/auth.js";
import { conversationRoutes } from "./routes/conversations.js";
import { crewRoutes } from "./routes/crew.js";
import { mcpRoutes } from "./routes/mcp.js";
import { providerRoutes } from "./routes/providers.js";
import { skillRoutes } from "./routes/skills.js";
import { settingsRoutes, usageRoutes } from "./routes/usage.js";
import { userRoutes } from "./routes/users.js";
import { watchRoutes } from "./routes/watches.js";
import { createServices } from "./services.js";

/** Routes reachable without signing in. */
const PUBLIC = new Set([
  "/api/auth/me",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/setup",
  "/api/meta",
]);
/** Prefixes reachable without signing in; each route checks its own credential (a token). */
const PUBLIC_PREFIXES = ["/api/hooks/"];

const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    conversationId: z.string().uuid(),
    text: z.string().max(100_000),
  }),
  z.object({ type: z.literal("abort"), conversationId: z.string().uuid() }),
  z.object({ type: z.literal("approve"), approvalId: z.string(), decision: DecisionSchema }),
]);

export async function buildApp(
  config: Config,
  options: {
    modelRuntime?: ModelRuntime;
    extraProviders?: string[];
    logger?: boolean;
    /** Schedule watches (default on); tests run them by hand. */
    watches?: boolean;
  } = {},
) {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? "info" },
  });
  const { db, close } = createDb(config.DATABASE_URL);
  const services = await createServices(config, db, options);
  app.decorate("db", db);
  app.decorate("services", services);
  app.decorateRequest("user", null as unknown as UserRow);
  app.addHook("onReady", async () => {
    if (options.watches !== false) await services.watches.start();
  });
  app.addHook("onClose", async () => {
    await services.watches.stop();
    services.approvals.close();
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
  await skillRoutes(app, services);
  await approvalRoutes(app, services);
  await watchRoutes(app, services);
  await mcpRoutes(app, services);

  // The Bridge's live channel: streams crew replies and takes messages from the person.
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const user = req.user;
    const send = (event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };
    const disconnect = services.bridge.connect(user.id, send);
    socket.on("close", disconnect);
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
        services.approvals.decide(current.id, event.approvalId, event.decision);
      } else if (event.type === "send") {
        await services.bridge.send(current, event.conversationId, event.text);
      } else {
        await services.bridge.abort(current, event.conversationId);
      }
    };
  });

  if (config.WEB_DIST && existsSync(config.WEB_DIST)) {
    await app.register(fastifyStatic, { root: config.WEB_DIST, wildcard: false });
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
