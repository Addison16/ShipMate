import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttachmentService, detectFile } from "./files/service.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

/** A one-page PDF whose text layer says `text`. */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A real 1×1 PNG (pi decodes and resizes images before sending them). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("file detection", () => {
  it("trusts the bytes, not the claimed type", () => {
    expect(detectFile(PNG, "text/plain", "x.txt")).toEqual({
      kind: "image",
      mimeType: "image/png",
    });
    expect(detectFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "", "a")).toMatchObject({
      mimeType: "image/jpeg",
    });
    expect(detectFile(tinyPdf("x"), "image/png", "x.png")).toMatchObject({ kind: "pdf" });
    expect(detectFile(Buffer.from("<svg onload=alert(1)>"), "image/svg+xml", "x.svg")).toBeNull();
    expect(detectFile(Buffer.from("<html>"), "image/png", "x.png")).toBeNull();
    expect(detectFile(Buffer.from("a,b\n1,2"), "", "list.csv")).toEqual({
      kind: "text",
      mimeType: "text/plain",
    });
    expect(detectFile(Buffer.from([0x61, 0, 0x62]), "text/plain", "x.txt")).toBeNull();
    expect(detectFile(Buffer.from([0xc3, 0x28]), "text/plain", "x.txt")).toBeNull();
  });
});

describe.skipIf(!db)("files in chat", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const upload = (
    conversationId: string,
    data: Buffer,
    name: string,
    type = "",
    cookie = ownerCookie,
  ) =>
    t.app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/attachments`,
      payload: data,
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-file-type": type,
      },
    });
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  /** What the model was given on each call. */
  const seen: { model: string; text: string; images: number }[] = [];
  const reply =
    (text: string) =>
    (context: { messages: unknown[] }, _o: unknown, _s: unknown, model: Model<string>) => {
      const last = [...context.messages]
        .reverse()
        .find((m) => (m as { role: string }).role === "user") as {
        content: string | Array<{ type: string; text?: string }>;
      };
      const parts =
        typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
      seen.push({
        model: model.id,
        text: parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join(""),
        images: parts.filter((p) => p.type === "image").length,
      });
      return fauxAssistantMessage(text);
    };

  async function sendAndWait(conversationId: string, text: string, attachments: string[]) {
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString())));
    ws.send(JSON.stringify({ type: "send", conversationId, text, attachments }));
    await until(() => events.some((e) => (e.type === "status" && !e.busy) || e.type === "error"));
    ws.terminate();
    return events;
  }

  beforeAll(async () => {
    t = await testApp(db as string);
    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    await api("POST", "/api/users", {
      email: "kid@example.com",
      displayName: "Kid",
      password: "password1",
      role: "member",
    });
    memberCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("stores uploads for their owner only, and refuses what it cannot use", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const res = await upload(conv.id, PNG, "../../fridge.png", "image/png");
    expect(res.statusCode).toBe(200);
    const a = res.json().attachment;
    expect(a).toMatchObject({
      name: "fridge.png",
      kind: "image",
      mimeType: "image/png",
      size: PNG.length,
    });

    const got = await api("GET", `/api/attachments/${a.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.rawPayload.equals(PNG)).toBe(true);
    expect((await api("GET", `/api/attachments/${a.id}`, undefined, memberCookie)).statusCode).toBe(
      404,
    );
    expect((await api("GET", `/api/attachments/${a.id}`, undefined, "")).statusCode).toBe(401);

    // Someone else's conversation, a disguised file, an oversized text file.
    expect((await upload(conv.id, PNG, "x.png", "image/png", memberCookie)).statusCode).toBe(404);
    expect((await upload(conv.id, Buffer.from("<script>"), "x.png", "image/png")).statusCode).toBe(
      415,
    );
    expect(
      (await upload(conv.id, Buffer.alloc(1024 * 1024 + 1, 97), "big.txt", "text/plain"))
        .statusCode,
    ).toBe(413);

    // A JSON file stays a file (never parsed as a request body) and is served as plain text.
    const json = (
      await upload(conv.id, Buffer.from('{"a":1}'), "data.json", "application/json")
    ).json().attachment;
    expect(json).toMatchObject({ kind: "text", mimeType: "text/plain" });
    const served = await api("GET", `/api/attachments/${json.id}`);
    expect(served.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(served.headers["content-disposition"]).toMatch(/^attachment;/);

    // Unsent uploads can be discarded.
    expect((await api("DELETE", `/api/attachments/${json.id}`)).json()).toEqual({ ok: true });
    expect((await api("GET", `/api/attachments/${json.id}`)).statusCode).toBe(404);
  });

  it("passes photos as images and PDFs as text, and shows the files on the message", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const photo = (await upload(conv.id, PNG, "receipt.png", "image/png")).json().attachment;
    const pdf = (
      await upload(conv.id, tinyPdf("Total due 12.50 EUR"), "bill.pdf", "application/pdf")
    ).json().attachment;
    expect(pdf.kind).toBe("pdf");
    seen.length = 0;
    t.faux.setResponses([reply("That comes to 12.50.")]);
    const events = await sendAndWait(conv.id, "What do I owe?", [photo.id, pdf.id]);
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    expect(seen[0]).toMatchObject({ model: "m", images: 1 });
    expect(seen[0]?.text).toContain("What do I owe?");
    expect(seen[0]?.text).toContain('<attached-file name="bill.pdf" type="pdf">');
    expect(seen[0]?.text).toContain("Total due 12.50 EUR");

    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    expect(messages[0].meta.attachments.map((x: { name: string }) => x.name)).toEqual([
      "receipt.png",
      "bill.pdf",
    ]);
    // Sent files cannot be sent again or discarded.
    const again = await sendAndWait(conv.id, "again", [photo.id]);
    expect(again.find((e) => e.type === "error")).toMatchObject({
      message: expect.stringMatching(/already sent/),
    });
    expect((await api("DELETE", `/api/attachments/${photo.id}`)).statusCode).toBe(404);

    // Deleting the conversation removes the bytes.
    const file = join(t.config.dirs.files, photo.id);
    expect(existsSync(file)).toBe(true);
    await api("DELETE", `/api/conversations/${conv.id}`);
    expect(existsSync(file)).toBe(false);
  });

  it("hands a photo to a vision-capable model when the crew member's cannot see it", async () => {
    const yaml = (await api("GET", "/api/crew/captain")).json().crew.manifestYaml as string;
    const updated = await api("PUT", "/api/crew/captain", {
      manifestYaml: yaml.replace(/^model: .*$/m, "model: faux/text-only"),
    });
    expect(updated.json().crew.model).toBe("faux/text-only");

    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const photo = (await upload(conv.id, PNG, "fridge.png", "image/png")).json().attachment;
    seen.length = 0;
    t.faux.setResponses([reply("Eggs, milk, and a lonely lemon."), reply("Omelette it is.")]);
    await sendAndWait(conv.id, "", [photo.id]);
    expect(seen[0]).toMatchObject({ model: "m", images: 1 });
    expect(seen[0]?.text).toMatch(/sent a photo/);
    const messages = (await api("GET", `/api/conversations/${conv.id}/messages`)).json().messages;
    const note = messages.find((m: { role: string }) => m.role === "system");
    expect(note.content).toMatch(/can't see photos, so .* \(faux\/m\) answers this message/);
    expect(messages[0].content).toBe("");

    // The next message is back on the crew member's own model.
    await sendAndWait(conv.id, "What can I cook?", []);
    expect(seen[1]).toMatchObject({ model: "text-only", images: 0 });

    // Restore the Captain for other tests.
    await api("PUT", "/api/crew/captain", { manifestYaml: yaml });
  });
  it("keeps a PDF whose text layer has NUL characters (Postgres text cannot hold them)", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const me = (await api("GET", "/api/auth/me")).json().user;
    const files = new AttachmentService(
      t.app.db,
      mkdtempSync(join(tmpdir(), "shipmate-files-")),
      async () => "Total\u0000 due: 12",
    );
    const a = await files.upload(me.id, conv.id, {
      name: "bill.pdf",
      type: "application/pdf",
      data: tinyPdf("x"),
    });
    const [row] = await files.claim(me.id, conv.id, [a.id]);
    expect(row?.text).toBe("Total due: 12");
  });
});
