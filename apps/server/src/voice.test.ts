import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";
import { extensionOf } from "./voice/service.js";

const db = TEST_DATABASE_URL;

describe("voice helpers", () => {
  it("names recordings so Whisper servers recognise them", () => {
    expect(extensionOf("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionOf("audio/mp4")).toBe("mp4");
    expect(extensionOf("audio/ogg")).toBe("ogg");
    expect(extensionOf("")).toBe("webm");
  });
});

describe.skipIf(!db)("voice", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let memberCookie = "";
  /** Requests the speech services received. */
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  let failNext = false;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let body: unknown = init?.body;
    if (body instanceof FormData) {
      const file = body.get("file") as File;
      body = {
        model: body.get("model"),
        language: body.get("language"),
        file: file.name,
        type: file.type,
        size: file.size,
      };
    } else if (typeof body === "string") {
      body = JSON.parse(body);
    }
    calls.push({ url, auth: headers.authorization ?? null, body });
    if (failNext) {
      failNext = false;
      return new Response('{"error":{"message":"model not found"}}', { status: 404 });
    }
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: " Ahoy Captain " });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), {
      headers: { "content-type": "audio/mpeg" },
    });
  }) as typeof fetch;

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
  const transcribe = (cookie = ownerCookie) =>
    t.app.inject({
      method: "POST",
      url: "/api/voice/transcribe",
      payload: Buffer.from("fake opus audio"),
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-audio-type": "audio/webm;codecs=opus",
      },
    });

  beforeAll(async () => {
    t = await testApp(db as string, { voiceFetch: fakeFetch });
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
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("starts with the browser speaking and no server transcription", async () => {
    expect((await api("GET", "/api/voice", undefined, memberCookie)).json()).toEqual({
      stt: "off",
      tts: "browser",
    });
    expect((await transcribe()).statusCode).toBe(409);
    expect((await api("POST", "/api/voice/speak", { text: "hi" })).statusCode).toBe(409);
    // Only the owner sees and changes the setup.
    expect((await api("GET", "/api/voice/settings", undefined, memberCookie)).statusCode).toBe(403);
    expect(
      (await api("PUT", "/api/voice/settings", { tts: { source: "browser" } }, memberCookie))
        .statusCode,
    ).toBe(403);
  });

  it("reuses an OpenAI provider's key for both directions", async () => {
    const provider = (
      await api("POST", "/api/providers", { kind: "openai", apiKey: "sk-test-openai" })
    ).json().provider;
    const anthropic = (
      await api("POST", "/api/providers", { kind: "anthropic", apiKey: "sk-ant" })
    ).json().provider;
    const listed = (await api("GET", "/api/voice/providers")).json().providers;
    expect(listed.map((p: { id: string }) => p.id)).toEqual([provider.id]);
    expect(
      (
        await api("PUT", "/api/voice/settings", {
          stt: { source: "provider", providerId: anthropic.id },
        })
      ).statusCode,
    ).toBe(400);

    const saved = await api("PUT", "/api/voice/settings", {
      stt: { source: "provider", providerId: provider.id, language: "en" },
      tts: { source: "provider", providerId: provider.id, voice: "coral" },
    });
    expect(saved.statusCode).toBe(200);
    expect((await api("GET", "/api/voice", undefined, memberCookie)).json()).toEqual({
      stt: "server",
      tts: "server",
    });

    calls.length = 0;
    const heard = await transcribe(memberCookie);
    expect(heard.json()).toEqual({ text: "Ahoy Captain" });
    expect(calls[0]).toEqual({
      url: "https://api.openai.com/v1/audio/transcriptions",
      auth: "Bearer sk-test-openai",
      body: {
        model: "gpt-4o-mini-transcribe",
        language: "en",
        file: "speech.webm",
        type: "audio/webm",
        size: 15,
      },
    });

    const spoken = await api("POST", "/api/voice/speak", { text: "Fair winds." }, memberCookie);
    expect(spoken.statusCode).toBe(200);
    expect(spoken.headers["content-type"]).toBe("audio/mpeg");
    expect(spoken.rawPayload.subarray(0, 3).toString()).toBe("ID3");
    expect(calls[1]).toMatchObject({
      url: "https://api.openai.com/v1/audio/speech",
      body: {
        model: "gpt-4o-mini-tts",
        voice: "coral",
        input: "Fair winds.",
        response_format: "mp3",
      },
    });
  });

  it("talks to a local server with its own optional key, and reports its errors", async () => {
    expect(
      (await api("PUT", "/api/voice/settings", { tts: { source: "custom", baseUrl: "ftp://x" } }))
        .statusCode,
    ).toBe(400);
    const saved = await api("PUT", "/api/voice/settings", {
      stt: { source: "custom", baseUrl: "http://voice:8000/v1/", apiKey: "local-key" },
      tts: { source: "custom", baseUrl: "http://voice:8000/v1" },
    });
    expect(saved.json()).toMatchObject({
      stt: { source: "custom", baseUrl: "http://voice:8000/v1", hasKey: true },
      tts: { source: "custom", hasKey: false },
    });
    expect(JSON.stringify(saved.json())).not.toContain("local-key");

    calls.length = 0;
    await transcribe();
    await api("POST", "/api/voice/speak", { text: "Hello" });
    expect(calls.map((c) => [c.url, c.auth])).toEqual([
      ["http://voice:8000/v1/audio/transcriptions", "Bearer local-key"],
      ["http://voice:8000/v1/audio/speech", null],
    ]);
    expect(calls[0]?.body).toMatchObject({ model: "Systran/faster-distil-whisper-small.en" });
    expect(calls[1]?.body).toMatchObject({
      model: "speaches-ai/Kokoro-82M-v1.0-ONNX",
      voice: "af_heart",
    });

    failNext = true;
    const failed = await transcribe();
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe("The speech service answered 404: model not found");

    // Clearing the key.
    const cleared = await api("PUT", "/api/voice/settings", { stt: { apiKey: "" } });
    expect(cleared.json().stt.hasKey).toBe(false);
  });
});
