import { existsSync } from "node:fs";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { SHIPMATE_VERSION } from "@shipmate/core";
import { createDb, type Db } from "@shipmate/db";
import { coreServers } from "@shipmate/mcp-catalog";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import type { Config } from "./config.js";

export async function buildApp(config: Config) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const { db, close } = createDb(config.DATABASE_URL);
  app.decorate("db", db);
  app.addHook("onClose", async () => {
    await close();
  });

  await app.register(websocket);

  app.get("/healthz", async () => {
    await db.execute(sql`select 1`);
    return { ok: true, version: SHIPMATE_VERSION };
  });

  app.get("/api/meta", async () => ({
    version: SHIPMATE_VERSION,
    url: config.SHIPMATE_URL,
    coreMcpServers: coreServers().map((s) => s.id),
    dataDir: config.dirs.root,
  }));

  // Live events for the Bridge; the real protocol lands in phase 1.
  app.get("/api/ws", { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: "hello", version: SHIPMATE_VERSION }));
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
    db: Db;
  }
}
