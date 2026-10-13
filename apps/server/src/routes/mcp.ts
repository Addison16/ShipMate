import type { CreateCustomMcpRequest } from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireRole } from "../auth.js";
import { GOOGLE_CALLBACK_PATH, GoogleOAuthError } from "../services/google-oauth.js";
import type { Services } from "../services.js";

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes");
const EnvName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an env var name like API_KEY");

export async function mcpRoutes(app: FastifyInstance, s: Services) {
  const audit = (userId: string, action: string, summary: string) =>
    s.audit.record({ userId, crewMemberId: null, action, summary, decision: null });

  app.get("/api/mcp", async (req) => {
    const servers = await s.mcp.list();
    // Only the owner sees which Google account is signed in.
    if (req.user.role === "owner") return { servers };
    return {
      servers: servers.map((x) => (x.google ? { ...x, google: { ...x.google, email: null } } : x)),
    };
  });

  // Sign in with Google, for the Google Workspace server and the owner's own OAuth client.
  const googleServer = async () => {
    const server = (await s.mcp.list()).find((x) => x.google);
    if (!server) throw new HttpError(404, "no Google server in the catalog");
    return server;
  };
  const signedIn = async (userId: string, email: string) => {
    await audit(userId, "mcp.google_signin", `Signed in to Google as ${email}`);
  };

  app.post("/api/mcp/google/start", async (req) => {
    requireRole(req.user, "owner");
    try {
      return { url: s.google.start(await s.mcp.googleClient(), req.user.id) };
    } catch (err) {
      if (err instanceof GoogleOAuthError) throw new HttpError(400, err.message);
      throw err;
    }
  });

  app.get(GOOGLE_CALLBACK_PATH, async (req, reply) => {
    const query = req.url.split("?")[1] ?? "";
    try {
      const { email, userId } = await s.google.finish(query, await s.mcp.googleClient());
      await signedIn(userId, email);
      return reply.redirect(s.google.doneUrl("ok"));
    } catch (err) {
      if (!(err instanceof GoogleOAuthError)) req.log.error(err);
      else if (err.code === "failed")
        req.log.warn({ reason: err.message }, "Google sign-in failed");
      return reply.redirect(
        s.google.doneUrl(err instanceof GoogleOAuthError ? err.code : "failed"),
      );
    }
  });

  app.post("/api/mcp/google/finish", async (req) => {
    requireRole(req.user, "owner");
    const { url } = z.object({ url: z.string().trim().min(1).max(4000) }).parse(req.body);
    const query = url.includes("?") ? url.slice(url.indexOf("?") + 1).split("#")[0] : url;
    try {
      const { email } = await s.google.finish(query ?? "", await s.mcp.googleClient());
      await signedIn(req.user.id, email);
    } catch (err) {
      if (err instanceof GoogleOAuthError) throw new HttpError(400, googleErrorText(err));
      throw err;
    }
    return { server: await googleServer() };
  });

  app.delete("/api/mcp/google", async (req) => {
    requireRole(req.user, "owner");
    await s.google.signOut();
    await audit(req.user.id, "mcp.google_signout", "Signed out of Google");
    return { server: await googleServer() };
  });

  app.post<{ Params: { id: string } }>("/api/mcp/:id/install", async (req) => {
    requireRole(req.user, "owner");
    const server = await s.mcp.install(req.params.id);
    await audit(req.user.id, "mcp.install", `Installed ${server.name}`);
    return { server };
  });

  app.delete<{ Params: { id: string } }>("/api/mcp/:id", async (req) => {
    requireRole(req.user, "owner");
    await s.mcp.uninstall(req.params.id);
    await audit(req.user.id, "mcp.uninstall", `Uninstalled ${req.params.id}`);
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/mcp/:id/secrets", async (req) => {
    requireRole(req.user, "owner");
    const { values } = z
      .object({ values: z.record(EnvName, z.string().max(8000)) })
      .parse(req.body);
    return { server: await s.mcp.setSecrets(req.params.id, values) };
  });

  app.put<{ Params: { id: string } }>("/api/mcp/:id/crews", async (req) => {
    requireRole(req.user, "admin");
    const { crews } = z.object({ crews: z.array(z.string()).max(200) }).parse(req.body);
    return { server: await s.mcp.assign(req.params.id, crews) };
  });

  app.post("/api/mcp/custom", async (req) => {
    requireRole(req.user, "owner");
    const body = z
      .object({
        id: Id,
        name: z.string().trim().min(1).max(80),
        description: z.string().max(500).optional(),
        transport: z.enum(["stdio", "http"]),
        command: z.string().max(200).optional(),
        args: z.array(z.string().max(500)).max(50).optional(),
        url: z.string().url().optional(),
        secrets: z
          .array(
            z.object({
              env: EnvName,
              label: z.string().max(80).optional(),
              required: z.boolean().optional(),
            }),
          )
          .max(20)
          .optional(),
      })
      .parse(req.body);
    const server = await s.mcp.addCustom(
      Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      ) as unknown as CreateCustomMcpRequest,
    );
    await audit(req.user.id, "mcp.custom", `Added custom server ${server.name}`);
    return { server };
  });
}

/** Readable reason for a pasted-address sign-in that failed. */
function googleErrorText(err: GoogleOAuthError): string {
  switch (err.code) {
    case "state":
      return "That sign-in expired or came from another attempt. Start again.";
    case "denied":
      return "Sign-in was cancelled at Google.";
    case "no_client":
      return "Save a client ID and secret first.";
    case "no_refresh":
      return "Google did not send a refresh token. Start again.";
    case "partial":
      return "Some access was left unticked. Sign in again and allow everything Shipmate asks for.";
    default:
      return `Google could not finish the sign-in: ${err.message}`;
  }
}
