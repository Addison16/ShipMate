import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../auth.js";
import { MAX_UPLOAD_BYTES } from "../files/service.js";
import type { Services } from "../services.js";

const Id = z.string().uuid();

export async function fileRoutes(app: FastifyInstance, s: Services) {
  // Uploads are raw bytes, so a file's own type never reaches a parser (a .json stays a file).
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer", bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );

    scope.post<{ Params: { id: string } }>(
      "/api/conversations/:id/attachments",
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
        const attachment = await s.files.upload(req.user.id, parse(req.params.id), {
          name,
          type: header("x-file-type"),
          data: req.body,
        });
        return { attachment };
      },
    );
  });

  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (req, reply) => {
    const { row, stream } = await s.files.open(req.user.id, parse(req.params.id));
    // Only types Shipmate itself detected are served; text is always plain, never HTML.
    const inline = row.kind === "image" || row.kind === "pdf";
    // Browsers refuse to show a PDF in a sandboxed document; their PDF viewers sandbox it anyway.
    if (row.kind !== "pdf") reply.header("content-security-policy", "default-src 'none'; sandbox");
    return reply
      .header("content-type", row.kind === "text" ? "text/plain; charset=utf-8" : row.mimeType)
      .header("content-length", String(row.size))
      .header(
        "content-disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      )
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=86400")
      .send(stream());
  });

  app.delete<{ Params: { id: string } }>("/api/attachments/:id", async (req) => {
    await s.files.discard(req.user.id, parse(req.params.id));
    return { ok: true };
  });
}

function parse(id: string): string {
  if (!Id.safeParse(id).success) throw new HttpError(404, "not found");
  return id;
}
