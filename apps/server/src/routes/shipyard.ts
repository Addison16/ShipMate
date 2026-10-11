import type {
  CreateProjectRequest,
  UpdateProjectRequest,
  UpdateSandboxEndpointRequest,
} from "@shipmate/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole } from "../auth.js";
import type { Services } from "../services.js";

const Create = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().optional(),
  provider: z.enum(["github", "local"]),
  repo: z.string().trim().optional(),
  token: z.string().trim().max(500).optional(),
  crewSlug: z.string().optional(),
  defaultBranch: z.string().trim().optional(),
  sandboxImage: z.string().trim().optional(),
});
const Update = Create.omit({ provider: true }).partial();
const StateQuery = z.object({ state: z.enum(["open", "closed", "all"]).default("open") });
const Flow = z.object({
  flow: z.enum(["plan", "fix_issue", "review_pr", "triage", "keep_ci_green"]),
  target: z.number().int().positive().optional(),
  notes: z.string().max(20_000).optional(),
});

const SandboxEndpoint = z.object({
  mode: z.enum(["env", "socket", "tcp"]),
  socketPath: z.string().max(300).optional(),
  host: z.string().max(300).optional(),
  tlsCa: z.string().max(32_000).optional(),
  tlsCert: z.string().max(32_000).optional(),
  tlsKey: z.string().max(32_000).optional(),
  workspacesPath: z.string().max(500).optional(),
});

type Id = { Params: { id: string } };

export async function shipyardRoutes(app: FastifyInstance, s: Services) {
  const y = s.shipyard;

  app.get("/api/shipyard", async (req) => {
    const [status, projects] = await Promise.all([y.status(), y.list(req.user)]);
    return { status, projects };
  });

  // Where sandboxes run: owner only, since it decides which machine runs the crew's code.
  app.get("/api/shipyard/sandbox", async (req) => {
    requireRole(req.user, "owner");
    return { sandbox: await y.getEndpoint() };
  });

  app.put("/api/shipyard/sandbox", async (req) => {
    requireRole(req.user, "owner");
    const body = strip(SandboxEndpoint.parse(req.body)) as UpdateSandboxEndpointRequest;
    const sandbox = await y.setEndpoint(body);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "shipyard.sandbox",
      summary: `Set the Shipyard sandbox endpoint to ${sandbox.effective}`,
      decision: null,
      detail: { mode: body.mode },
    });
    return { sandbox };
  });

  app.post("/api/shipyard/sandbox/test", async (req) => {
    requireRole(req.user, "owner");
    const body = strip(SandboxEndpoint.parse(req.body)) as UpdateSandboxEndpointRequest;
    return { check: await y.endpoints.test(body) };
  });

  app.post("/api/shipyard/projects", async (req) => {
    requireRole(req.user, "admin");
    const body = strip(Create.parse(req.body)) as CreateProjectRequest;
    return { project: await y.create(req.user, body) };
  });

  app.get<Id>("/api/shipyard/projects/:id", async (req) => ({
    project: await y.get(req.user, req.params.id),
  }));

  app.patch<Id>("/api/shipyard/projects/:id", async (req) => {
    requireRole(req.user, "admin");
    const body = strip(Update.parse(req.body ?? {})) as UpdateProjectRequest;
    return { project: await y.update(req.user, req.params.id, body) };
  });

  app.delete<Id>("/api/shipyard/projects/:id", async (req) => {
    requireRole(req.user, "admin");
    await y.remove(req.params.id);
    return { ok: true };
  });

  app.post<Id>("/api/shipyard/projects/:id/clone", async (req) => {
    requireRole(req.user, "admin");
    return { project: await y.clone(req.user, req.params.id) };
  });

  app.post<Id>("/api/shipyard/projects/:id/sandbox", async (req) => {
    requireRole(req.user, "admin");
    const { action } = z.object({ action: z.enum(["start", "stop", "reset"]) }).parse(req.body);
    return { project: await y.sandbox(req.user, req.params.id, action) };
  });

  app.get<Id>("/api/shipyard/projects/:id/pulls", async (req) => {
    const { state } = StateQuery.parse(req.query);
    return { pulls: await y.pulls(req.params.id, state) };
  });

  app.get<Id>("/api/shipyard/projects/:id/issues", async (req) => {
    const { state } = StateQuery.parse(req.query);
    return { issues: await y.issues(req.params.id, state) };
  });

  app.get<Id>("/api/shipyard/projects/:id/events", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return { events: await y.events(req.params.id, limit) };
  });

  app.post<Id>("/api/shipyard/projects/:id/flows", async (req) => {
    const body = strip(Flow.parse(req.body)) as z.infer<typeof Flow>;
    return y.startFlow(req.user, req.params.id, {
      flow: body.flow,
      ...(body.target !== undefined ? { target: body.target } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    });
  });

  app.post<Id>("/api/shipyard/projects/:id/conversations", async (req) => ({
    conversation: await y.createConversation(req.user, req.params.id),
  }));

  // Public (see PUBLIC_PREFIXES): the HMAC signature over the raw body is the credential, so
  // this scope keeps bodies as raw bytes instead of parsing JSON.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post<{ Params: { projectId: string } }>("/api/hooks/github/:projectId", async (req) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return y.webhook(req.params.projectId, req.headers, raw);
    });
  });
}

/** Drop undefined keys (exactOptionalPropertyTypes). */
function strip(o: object): unknown {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
