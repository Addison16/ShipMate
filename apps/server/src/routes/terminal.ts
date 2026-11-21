import { existsSync } from "node:fs";
import type { TerminalStatusDto } from "@shipmate/core";
import { childEnv } from "@shipmate/crew";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import { type Pty, spawnPty } from "../pty.js";
import type { Services } from "../services.js";

/**
 * The owner's web terminal (Settings > Terminal): a shell on the Shipmate server in the browser,
 * for the jobs that used to need `docker exec`. It runs as Shipmate's own user (root in the
 * image), so it is off until the owner turns it on, only the owner can open it, every opening is
 * in the activity log, and SHIPMATE_TERMINAL=off keeps it off for good.
 */

const KEY = "terminal";
/** A terminal nobody types in for this long is closed. */
export const TERMINAL_IDLE_MS = 30 * 60_000;
/** At most this many open at once. */
const MAX_OPEN = 3;

const Toggle = z.object({ enabled: z.boolean() });
const Size = z.object({
  cols: z.coerce.number().int().min(10).max(1000).default(80),
  rows: z.coerce.number().int().min(2).max(500).default(24),
});
const ClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("i"), d: z.string().max(64_000) }),
  z.object({
    t: z.literal("r"),
    rows: z.number().int().min(2).max(500),
    cols: z.number().int().min(10).max(1000),
  }),
]);

function clientIp(req: FastifyRequest): string {
  try {
    return req.ip;
  } catch {
    return "an unknown address";
  }
}

export function terminalAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHIPMATE_TERMINAL?.trim().toLowerCase() !== "off";
}

/** The page that opens the socket must be Shipmate itself, not another site. */
export function sameOrigin(req: FastifyRequest, publicUrl?: string): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  // Default ports are left out of an Origin but may be in a Host header.
  const bare = (h: string) => h.toLowerCase().replace(/:(80|443)$/, "");
  let host: string;
  try {
    host = bare(new URL(origin).host);
  } catch {
    return false;
  }
  const hosts = [req.host, req.headers.host].filter(Boolean).map((h) => bare(String(h)));
  if (publicUrl) {
    try {
      hosts.push(bare(new URL(publicUrl).host));
    } catch {}
  }
  return hosts.includes(host);
}

export async function terminalRoutes(
  app: FastifyInstance,
  services: Services,
  options: { env?: NodeJS.ProcessEnv; shell?: string; python?: string; publicUrl?: string } = {},
) {
  const env = options.env ?? process.env;
  const open = new Set<Pty>();
  app.addHook("onClose", async () => {
    for (const p of open) p.kill();
  });

  const status = async (): Promise<TerminalStatusDto> => {
    const allowed = terminalAllowed(env);
    const saved = await services.settings.getJson<{ enabled?: boolean }>(KEY);
    return { allowed, enabled: allowed && saved?.enabled === true };
  };

  app.get("/api/terminal", async (req): Promise<{ terminal: TerminalStatusDto }> => {
    requireRole(req.user, "owner");
    return { terminal: await status() };
  });

  app.put("/api/terminal", async (req): Promise<{ terminal: TerminalStatusDto }> => {
    requireRole(req.user, "owner");
    const { enabled } = Toggle.parse(req.body);
    await services.settings.setJson(KEY, { enabled });
    await services.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "terminal.setting",
      summary: enabled ? "Turned the web terminal on" : "Turned the web terminal off",
      decision: null,
    });
    if (!enabled) for (const p of open) p.kill();
    return { terminal: await status() };
  });

  app.get("/api/terminal/ws", { websocket: true }, async (socket, req) => {
    // Listen before the first await, so keys typed while the shell starts are kept.
    const early: Buffer[] = [];
    let onMessage = (raw: Buffer) => {
      early.push(raw);
    };
    let closed = false;
    socket.on("message", (raw: Buffer) => onMessage(raw));
    socket.on("close", () => {
      closed = true;
    });
    const fail = (message: string) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ t: "x", message }));
      socket.close();
    };
    if (req.user.role !== "owner") return fail("Only the owner can open the terminal.");
    if (!sameOrigin(req, options.publicUrl ?? env.SHIPMATE_URL)) {
      return fail("Open the terminal from Shipmate's own page.");
    }
    if (!(await status()).enabled) return fail("The terminal is off. Turn it on first.");
    if (open.size >= MAX_OPEN) return fail("Too many terminals are open. Close one first.");
    const size = Size.parse(req.query ?? {});
    await services.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "terminal.open",
      summary: `Opened the web terminal from ${clientIp(req)}`,
      decision: null,
    });

    const shell = options.shell ?? (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
    const data = env.SHIPMATE_DATA_DIR?.trim() || "/data";
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    let idle: NodeJS.Timeout | undefined;
    const pty = spawnPty({
      command: shell,
      args: ["-l"],
      cwd: existsSync(data) ? data : undefined,
      env: { ...childEnv(env), TERM: "xterm-256color", COLORTERM: "truecolor" },
      rows: size.rows,
      cols: size.cols,
      ...(options.python ? { python: options.python } : {}),
      onData: (d) => send({ t: "o", d }),
      onExit: (code) => {
        open.delete(pty);
        clearTimeout(idle);
        send({ t: "e", code });
        socket.close();
      },
      onError: () => {
        open.delete(pty);
        fail("The terminal could not start (python3 is missing on the server).");
      },
    });
    open.add(pty);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        send({ t: "x", message: "Closed after 30 minutes with no typing." });
        pty.kill();
      }, TERMINAL_IDLE_MS);
      idle.unref?.();
    };
    bump();
    onMessage = (raw: Buffer) => {
      let msg: z.infer<typeof ClientMessage>;
      try {
        msg = ClientMessage.parse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (msg.t === "i") {
        bump();
        pty.write(msg.d);
      } else pty.resize(msg.rows, msg.cols);
    };
    for (const raw of early.splice(0)) onMessage(raw);
    const stop = () => {
      clearTimeout(idle);
      open.delete(pty);
      pty.kill();
    };
    if (closed) stop();
    socket.on("close", stop);
  });
}
