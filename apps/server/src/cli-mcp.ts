import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SHIPMATE_VERSION } from "@shipmate/core";
import type { FastifyInstance } from "fastify";

/** The MCP server name the CLI sees; its tools appear to it as `mcp__shipmate__<tool>`. */
export const CLI_MCP_SERVER = "shipmate";
/** Where the CLI reaches Shipmate's tools (over loopback, with a per-turn bearer token). */
export const CLI_MCP_PATH = "/api/cli-mcp";

/** What one CLI turn may call: its tools, behind the crew member's approval policy. */
export interface CliToolGrant {
  tools: ToolDefinition[];
  /** Approval policy check; a returned reason blocks the call. */
  gate: (call: {
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<{ block: true; reason: string } | undefined>;
}

interface Live extends CliToolGrant {
  controller: AbortController;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL = "2025-06-18";

/**
 * Shipmate's own tools for crew members on the `claude-code-cli` backend. The official `claude`
 * binary cannot load pi tools, so each CLI turn gets a short-lived token for a small MCP server
 * (streamable HTTP, JSON responses only) inside Shipmate that serves that turn's tools: memory,
 * lists, and for the Captain `delegate` and the other crew tools. The token is revoked when the
 * turn ends, and nothing here reads or forwards the CLI's own Claude login.
 */
export class CliToolServer {
  #grants = new Map<string, Live>();
  #baseUrl: string | undefined;

  /** Set once the HTTP server listens; until then CLI turns run without Shipmate's tools. */
  setBaseUrl(url: string) {
    this.#baseUrl = url.replace(/\/+$/, "");
  }

  get available(): boolean {
    return this.#baseUrl !== undefined;
  }

  /** Open a grant for one turn: the `--mcp-config` JSON to pass, and a revoke for the end. */
  open(grant: CliToolGrant): { mcpConfig: string; revoke: () => void } | undefined {
    if (!this.#baseUrl || !grant.tools.length) return undefined;
    const token = randomBytes(24).toString("base64url");
    this.#grants.set(token, { ...grant, controller: new AbortController() });
    const mcpConfig = JSON.stringify({
      mcpServers: {
        [CLI_MCP_SERVER]: {
          type: "http",
          url: `${this.#baseUrl}${CLI_MCP_PATH}`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    });
    return {
      mcpConfig,
      revoke: () => {
        this.#grants.get(token)?.controller.abort();
        this.#grants.delete(token);
      },
    };
  }

  /** Answer one JSON-RPC message (or batch); undefined means 202 with no body. */
  async handle(token: string, body: unknown): Promise<unknown> {
    const grant = this.#grants.get(token);
    if (!grant) return undefined;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => this.#one(grant, m as RpcRequest)))).filter(
        (r) => r !== undefined,
      );
      return out.length ? out : undefined;
    }
    return this.#one(grant, body as RpcRequest);
  }

  has(token: string): boolean {
    return this.#grants.has(token);
  }

  async #one(grant: Live, msg: RpcRequest): Promise<unknown> {
    // Notifications (no id) need no answer.
    if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null)
      return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code, message },
    });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion:
            typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: CLI_MCP_SERVER, version: SHIPMATE_VERSION },
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: grant.tools.map((t) => ({
            name: t.name,
            description: t.description,
            // TypeBox schemas are plain JSON Schema once serialized.
            inputSchema: JSON.parse(JSON.stringify(t.parameters)),
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const input = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = grant.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `unknown tool: ${name}`);
        const errorResult = (text: string) =>
          ok({ content: [{ type: "text", text }], isError: true });
        try {
          const blocked = await grant.gate({ toolName: name, input });
          if (blocked) return errorResult(blocked.reason);
          const execute = tool.execute as unknown as (
            id: string,
            params: unknown,
            signal: AbortSignal | undefined,
          ) => Promise<{ content: { type: string; text?: string }[] }>;
          const result = await execute(
            `cli-${randomBytes(6).toString("hex")}`,
            input,
            grant.controller.signal,
          );
          return ok({
            content: result.content
              .filter((c) => c.type === "text")
              .map((c) => ({ type: "text", text: c.text ?? "" })),
            isError: false,
          });
        } catch (err) {
          return errorResult((err as Error).message);
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }
}

/** The endpoint the CLI talks to. Public to cookie auth: the per-turn token is the credential. */
export async function cliMcpRoutes(app: FastifyInstance, server: CliToolServer) {
  const tokenOf = (header: string | undefined) => /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  app.post(CLI_MCP_PATH, async (req, reply) => {
    const token = tokenOf(req.headers.authorization);
    // 404 rather than 401, so the CLI does not start an OAuth discovery for an expired turn.
    if (!server.has(token)) return reply.code(404).send({ error: "unknown or expired token" });
    const out = await server.handle(token, req.body);
    if (out === undefined) return reply.code(202).send();
    return reply.header("content-type", "application/json").send(out);
  });
  // No server-initiated stream: the spec allows 405 here.
  app.get(CLI_MCP_PATH, async (_req, reply) => reply.code(405).send());
  app.delete(CLI_MCP_PATH, async (_req, reply) => reply.code(405).send());
}
