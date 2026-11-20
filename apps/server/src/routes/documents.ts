import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../auth.js";
import { MAX_UPLOAD_BYTES } from "../files/service.js";
import type { Services } from "../services.js";

export async function documentRoutes(app: FastifyInstance, s: Services) {
  app.get("/api/documents", async (req) => ({ documents: await s.documents.list(req.user) }));

  app.get<{ Querystring: { q?: string } }>("/api/documents/search", async (req) => ({
    hits: await s.documents.search(req.user, String(req.query.q ?? "").slice(0, 300), 8),
  }));

  // Raw bytes, like chat attachments, so a file's own type never reaches a parser.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.post<{ Querystring: { private?: string } }>(
      "/api/documents",
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (req) => {
        if (!Buffer.isBuffer(req.body)) {
          throw new HttpError(415, "send the file as application/octet-stream");
        }
        const header = (name: string) => {
          const v = req.headers[name];
          return typeof v === "string" ? v : "";
        };
        let name = "file";
        try {
          name = decodeURIComponent(header("x-file-name")) || "file";
        } catch {
          // A badly encoded name is not worth refusing the upload over.
        }
        const document = await s.documents.add(req.user, {
          name,
          type: header("x-file-type"),
          data: req.body,
          shared: req.query.private !== "1",
        });
        await s.audit.record({
          userId: req.user.id,
          crewMemberId: null,
          action: "document.add",
          summary: `Added ${document.name} to the documents (${document.shared ? "shared" : "private"})`,
          decision: null,
          detail: { id: document.id },
        });
        return { document };
      },
    );
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req, reply) => {
    const { row, stream } = await s.documents.open(req.user, req.params.id);
    return reply
      .header("content-type", row.kind === "pdf" ? "application/pdf" : "text/plain; charset=utf-8")
      .header("content-length", String(row.size))
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .send(stream());
  });

  app.patch<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        shared: z.boolean().optional(),
      })
      .parse(req.body);
    return { document: await s.documents.update(req.user, req.params.id, body) };
  });

  app.delete<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const { row } = await s.documents.open(req.user, req.params.id);
    await s.documents.remove(req.user, req.params.id);
    await s.audit.record({
      userId: req.user.id,
      crewMemberId: null,
      action: "document.delete",
      summary: `Deleted ${row.name} from the documents`,
      decision: null,
      detail: { id: row.id },
    });
    return { ok: true };
  });
}
