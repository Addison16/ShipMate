import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalAiStatusDto } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyLine, MODEL_NAME_RE, ollamaRoot, withTag } from "./services/local-ai.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

describe("local AI helpers", () => {
  it("normalizes names and URLs", () => {
    expect(withTag("llama3.2")).toBe("llama3.2:latest");
    expect(withTag("qwen3:4b")).toBe("qwen3:4b");
    expect(ollamaRoot("http://ollama:11434/v1/")).toBe("http://ollama:11434");
    expect(ollamaRoot("http://host:11434")).toBe("http://host:11434");
    expect(MODEL_NAME_RE.test("qwen3:4b")).toBe(true);
    expect(MODEL_NAME_RE.test("library/gpt-oss:20b")).toBe(true);
    expect(MODEL_NAME_RE.test("../etc")).toBe(false);
    expect(MODEL_NAME_RE.test("a b")).toBe(false);
  });

  it("sums progress across layers", () => {
    const pull = { detail: "", completedBytes: 0, totalBytes: 0, error: null, layers: new Map() };
    applyLine(pull, '{"status":"pulling manifest"}');
    applyLine(pull, '{"status":"pulling a","digest":"a","total":100,"completed":50}');
    applyLine(pull, '{"status":"pulling b","digest":"b","total":300,"completed":0}');
    expect(pull).toMatchObject({ detail: "pulling b", completedBytes: 50, totalBytes: 400 });
    applyLine(pull, '{"status":"pulling a","digest":"a","total":100,"completed":100}');
    expect(pull.completedBytes).toBe(100);
    expect(applyLine(pull, "not json")).toBe(false);
    expect(applyLine(pull, '{"status":"success"}')).toBe(true);
    applyLine(pull, '{"error":"pull model manifest: file does not exist"}');
    expect(pull.error).toMatch(/does not exist/);
  });
});

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("local models through Ollama", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ollama: Server;
  let ollamaUrl = "";
  let ownerCookie = "";
  let memberCookie = "";
  const installed = new Set(["llama3.2:latest"]);
  const requests: string[] = [];

  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST", url: string, body?: unknown, cookie = ownerCookie) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const status = async (url = ollamaUrl) =>
    (await api("GET", `/api/local-ai?url=${encodeURIComponent(url)}`)).json()
      .localAi as LocalAiStatusDto;
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    // A fake Ollama: version, installed models, a streamed pull, and the OpenAI-style list.
    ollama = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        requests.push(`${req.method} ${req.url}`);
        const json = (body: unknown, code = 200) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.url === "/api/version") return json({ version: "0.12.0" });
        if (req.url === "/api/tags") {
          return json({ models: [...installed].map((name) => ({ name, size: 2_000_000_000 })) });
        }
        if (req.url === "/v1/models") {
          return json({ data: [...installed].map((id) => ({ id })) });
        }
        if (req.url === "/api/pull" && req.method === "POST") {
          const { model } = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          if (model === "nope:1b") {
            res.end('{"status":"pulling manifest"}\n{"error":"file does not exist"}\n');
            return;
          }
          const lines = [
            { status: "pulling manifest" },
            { status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 0 },
            { status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 600 },
            { status: "pulling aaa", digest: "sha256:aaa", total: 1000, completed: 1000 },
            { status: "verifying sha256 digest" },
            { status: "writing manifest" },
            { status: "success" },
          ];
          for (const line of lines) {
            res.write(`${JSON.stringify(line)}\n`);
            await new Promise((r) => setTimeout(r, 15));
          }
          installed.add(model.includes(":") ? model : `${model}:latest`);
          res.end();
          return;
        }
        json({ error: "not found" }, 404);
      });
    });
    await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
    ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;

    t = await testApp(db as string);
    ownerCookie = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Owner", password: "correct horse" },
        "",
      ),
    );
    await api("POST", "/api/users", {
      email: "deck@example.com",
      displayName: "Deckhand",
      password: "password1",
      role: "admin",
    });
    memberCookie = cookieOf(
      await api(
        "POST",
        "/api/auth/login",
        { email: "deck@example.com", password: "password1" },
        "",
      ),
    );
  });
  afterAll(async () => {
    await t?.app.close();
    await new Promise((r) => ollama?.close(r));
  });

  it("is for the owner only", async () => {
    const res = await api("GET", "/api/local-ai", undefined, memberCookie);
    expect(res.statusCode).toBe(403);
    expect(
      (await api("POST", "/api/local-ai/pull", { model: "qwen3:4b" }, memberCookie)).statusCode,
    ).toBe(403);
  });

  it("explains when no Ollama answers", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const s = await status(`http://127.0.0.1:${port}`);
    expect(s.reachable).toBe(false);
    expect(s.error).toBe(`Nothing is listening at http://127.0.0.1:${port}. Is Ollama running?`);
    expect(s.recommended.map((m) => m.name)).toContain("qwen3:4b");
    // Without a url or an Ollama provider, the configured default is checked.
    const fallback = (await api("GET", "/api/local-ai")).json().localAi as LocalAiStatusDto;
    expect(fallback.url).toBe("http://ollama:11434");
  });

  it("finds the server and lists installed models", async () => {
    const s = await status();
    expect(s).toMatchObject({
      url: ollamaUrl,
      reachable: true,
      version: "0.12.0",
      providerId: null,
      installed: [{ name: "llama3.2:latest", sizeBytes: 2_000_000_000 }],
    });
  });

  it("pulls a model with progress and reports failures", async () => {
    const bad = await api("POST", "/api/local-ai/pull", { url: ollamaUrl, model: "rm -rf" });
    expect(bad.statusCode).toBe(400);

    const started = await api("POST", "/api/local-ai/pull", { url: ollamaUrl, model: "qwen3:4b" });
    expect(started.statusCode).toBe(200);
    expect(started.json().pull).toMatchObject({ model: "qwen3:4b", status: "pulling" });
    await until(async () => (await status()).pulls.some((p) => p.status !== "pulling"));
    const s = await status();
    expect(s.pulls.find((p) => p.model === "qwen3:4b")).toMatchObject({
      status: "done",
      completedBytes: 1000,
      totalBytes: 1000,
      error: null,
    });
    expect(s.installed.map((m) => m.name)).toContain("qwen3:4b");
    // Pulls belong to their server: another server lists none of them.
    expect((await status("http://127.0.0.1:9")).pulls).toEqual([]);

    await api("POST", "/api/local-ai/pull", { url: ollamaUrl, model: "nope:1b" });
    await until(async () =>
      (await status()).pulls.some((p) => p.model === "nope:1b" && p.status === "failed"),
    );
    expect((await status()).pulls.find((p) => p.model === "nope:1b")?.error).toBe(
      "file does not exist",
    );
  });

  it("sets Ollama up as a provider and the default model", async () => {
    const missing = await api("POST", "/api/local-ai/use", { url: ollamaUrl, model: "phi4:14b" });
    expect(missing.statusCode).toBe(409);

    const res = await api("POST", "/api/local-ai/use", {
      url: ollamaUrl,
      model: "qwen3:4b",
      makeDefault: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider).toMatchObject({
      kind: "ollama",
      baseUrl: `${ollamaUrl}/v1`,
      models: ["qwen3:4b"],
      enabled: true,
    });
    expect(res.json().settings.defaultModel).toBe("ollama/qwen3:4b");

    // A second model joins the same provider; the default stays unless asked.
    const again = await api("POST", "/api/local-ai/use", { url: ollamaUrl, model: "llama3.2" });
    expect(again.json().provider.models).toEqual(["qwen3:4b", "llama3.2:latest"]);
    expect(again.json().settings.defaultModel).toBe("ollama/qwen3:4b");
    expect((await api("GET", "/api/providers")).json().providers).toHaveLength(1);

    // Crew can use it now, and the status remembers the server without a url.
    const models = (await api("GET", "/api/models")).json().models as Array<{
      ref: string;
      available: boolean;
    }>;
    expect(models.find((m) => m.ref === "ollama/qwen3:4b")?.available).toBe(true);
    const s = (await api("GET", "/api/local-ai")).json().localAi as LocalAiStatusDto;
    expect(s.url).toBe(ollamaUrl);
    expect(s.providerId).toBe(res.json().provider.id);

    // A server without qwen3 (as after switching servers) drops it from the provider.
    installed.delete("qwen3:4b");
    const moved = await api("POST", "/api/local-ai/use", { url: ollamaUrl, model: "llama3.2" });
    expect(moved.json().provider.models).toEqual(["llama3.2:latest"]);
  });
});
