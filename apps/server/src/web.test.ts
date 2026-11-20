import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlToText, isPrivateAddress, parseDuckDuckGo, pinnedFetch } from "./services/web.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe("web helpers", () => {
  it("knows which addresses are not the public web", () => {
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.9",
      "172.31.255.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:192.168.1.1",
      "::ffff:c0a8:101",
      "not-an-address",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it("turns a page into readable text", () => {
    const { title, text } = htmlToText(
      `<html><head><title> Fish &amp; Chips </title><style>p{color:red}</style></head>
       <body><nav><a href="/">Home</a></nav><main><h1>Fish &amp; chips</h1>
       <p>Fry at 180&#176;C.</p><ul><li>Cod</li><li>Potatoes</li></ul>
       <script>alert("x")</script></main><footer>Contact us</footer></body></html>`,
    );
    expect(title).toBe("Fish & Chips");
    expect(text).toContain("Fish & chips");
    expect(text).toContain("Fry at 180°C.");
    expect(text).toContain("- Cod");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Home");
    expect(text).not.toContain("Contact us");
  });

  it("reads a page of unclosed tags in one pass", () => {
    // Each of these once cost a scan to the end of the page per opening tag.
    for (const piece of ["<article>", "<nav class=x>", "<!-- ", "<title>", "< ", "<script>"]) {
      const started = performance.now();
      const { text } = htmlToText(`<html><body>${piece.repeat(40_000)}<p>Still read</p></body>`);
      expect(text, piece).toContain("Still read");
      expect(performance.now() - started, piece).toBeLessThan(500);
    }
  });

  it("drops closed blocks even when another kind is left open", () => {
    const { text } = htmlToText(
      "<body><nav>Menu<p>Kept, the menu never closes</p><script>hidden()</script><!-- note --><p>End</p></body>",
    );
    expect(text).toContain("Kept, the menu never closes");
    expect(text).toContain("End");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("note");
  });
});

describe("pinnedFetch", () => {
  it("connects to the checked address, whatever the name would resolve to", async () => {
    let seenHost = "";
    const server = createServer((req, res) => {
      seenHost = req.headers.host ?? "";
      res.writeHead(200, { "content-type": "text/plain" }).end("from the pinned address");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      // This name does not exist; only the pinned address can answer.
      const res = await pinnedFetch(new URL(`http://pinned.invalid:${port}/page`), ["127.0.0.1"], {
        headers: {},
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("from the pinned address");
      expect(seenHost).toBe(`pinned.invalid:${port}`);
    } finally {
      server.close();
    }
  });
});

const DDG_PAGE = `<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a"
    href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftown.example%2Fbins%3Fa%3D1&amp;rut=abc">Bin <b>days</b> &amp; times</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Bins go out on <b>Tuesday</b>.</a>
</div>
<div class="result result--ad"><a rel="nofollow" class="result__a"
    href="https://duckduckgo.com/y.js?ad_domain=shop.example">Buy bins</a>
  <a class="result__snippet">An ad.</a></div>
<div class="result"><a class="result__a" rel="nofollow" href="https://council.example/waste">Waste</a></div>`;

describe("DuckDuckGo results", () => {
  it("reads results, their real addresses and summaries, and skips ads", () => {
    expect(parseDuckDuckGo(DDG_PAGE)).toEqual([
      {
        title: "Bin days & times",
        url: "https://town.example/bins?a=1",
        snippet: "Bins go out on Tuesday.",
      },
      { title: "Waste", url: "https://council.example/waste", snippet: "" },
    ]);
    expect(parseDuckDuckGo("<html>nothing</html>")).toEqual([]);
  });
});

describe.skipIf(!db)("Built-in web search", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let kidCookie = "";
  const asked: string[] = [];
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (method: "GET" | "POST" | "PUT", url: string, body?: unknown, cookie = ownerCookie) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  };
  const turn = async (message: string) => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(JSON.stringify({ type: "send", conversationId: conv.id, text: message }));
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    return events.filter((e) => e.type === "tool" && e.phase === "end");
  };

  const page = (body: string, init: ResponseInit = {}) =>
    new Response(body, { headers: { "content-type": "text/html; charset=utf-8" }, ...init });
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("http://searx.lan:8080/search")) {
      return Response.json({
        results: [
          { title: "Bin days", url: "https://town.example/bins", content: "Bins  go out Tuesday." },
          { title: "Bad", url: "javascript:alert(1)", content: "x" },
        ],
      });
    }
    if (url.startsWith("https://html.duckduckgo.com/html/")) {
      return url.includes("blocked")
        ? page('<form id="challenge-form">anomaly</form>', { status: 202 })
        : page(DDG_PAGE);
    }
    if (url.startsWith("http://locked.lan/search")) return new Response("no", { status: 403 });
    if (url === "https://town.example/bins") {
      return page(
        `<html><title>Bin days</title><body><p>Bins go out on Tuesday.</p>${"<p>More text here.</p>".repeat(1500)}</body></html>`,
      );
    }
    if (url === "https://hop.example/") {
      return new Response(null, { status: 302, headers: { location: "http://router.lan/admin" } });
    }
    if (url === "https://img.example/a.png") {
      return new Response("x", { headers: { "content-type": "image/png" } });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  /** Each page load, with the addresses it was allowed to connect to. */
  const pinned: string[] = [];
  const lookup = async (host: string) =>
    host.endsWith(".lan") ? ["192.168.1.1"] : ["93.184.216.34"];

  beforeAll(async () => {
    t = await testApp(db as string, {
      web: {
        fetch: fakeFetch,
        lookup,
        fetchPage: (url, addresses, init) => {
          pinned.push(`${url.hostname} ${addresses.join(",")}`);
          return fakeFetch(url, { redirect: "manual", ...init });
        },
      },
    });
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
    kidCookie = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("starts on DuckDuckGo with page reading on, and only admins change it", async () => {
    expect((await api("GET", "/api/settings/web", undefined, kidCookie)).json().web).toEqual({
      source: "duckduckgo",
      searxngUrl: "",
      readPages: true,
    });
    expect((await api("PUT", "/api/settings/web", { source: "off" }, kidCookie)).statusCode).toBe(
      403,
    );
    expect((await api("PUT", "/api/settings/web", { searxngUrl: "nonsense" })).statusCode).toBe(
      400,
    );
    expect((await api("PUT", "/api/settings/web", { source: "searxng" })).statusCode).toBe(400);
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("search_web", { query: "bin day" })]),
      fauxAssistantMessage([fauxToolCall("search_web", { query: "blocked" })]),
      fauxAssistantMessage("Tuesday."),
    ]);
    const out = (await turn("when do the bins go out?")).map((e) =>
      e.type === "tool" ? e.summary : "",
    );
    expect(out[0]).toContain("1. Bin days & times");
    expect(out[0]).toContain("https://town.example/bins?a=1");
    expect(out[1]).toContain("DuckDuckGo is limiting searches");
  });

  it("has no search tool when search is turned off", async () => {
    await api("PUT", "/api/settings/web", { source: "off" });
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("search_web", { query: "bin day" })]),
      fauxAssistantMessage("Could not."),
    ]);
    const [tool] = await turn("when do the bins go out?");
    expect(tool?.type === "tool" && tool.summary).not.toContain("Bin days");
  });

  it("tests a source without saving it, then saves SearXNG", async () => {
    const test = async (body: object) => (await api("POST", "/api/settings/web/test", body)).json();
    expect(await test({ source: "duckduckgo" })).toEqual({
      ok: true,
      message: "It works: 2 results came back.",
    });
    const bad = await test({ source: "searxng", searxngUrl: "http://locked.lan" });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("json");
    expect(await test({ source: "searxng", searxngUrl: "http://searx.lan:8080/" })).toEqual({
      ok: true,
      message: "It works: 1 results came back.",
    });
    expect((await api("GET", "/api/settings/web")).json().web.source).toBe("off");
    const saved = await api("PUT", "/api/settings/web", {
      source: "searxng",
      searxngUrl: "http://searx.lan:8080/",
    });
    expect(saved.json().web).toMatchObject({
      source: "searxng",
      searxngUrl: "http://searx.lan:8080",
    });
  });

  it("lets agents search and read public pages, and refuses the home network", async () => {
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("search_web", { query: "bin day & more" })]),
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "https://town.example/bins" })]),
      fauxAssistantMessage([
        fauxToolCall("read_web_page", { url: "https://town.example/bins", from: 12000 }),
      ]),
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "http://192.168.1.1/admin" })]),
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "http://router.lan/" })]),
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "https://hop.example/" })]),
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "file:///etc/passwd" })]),
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "https://img.example/a.png" })]),
      fauxAssistantMessage("Tuesday."),
    ]);
    asked.length = 0;
    const out = (await turn("when do the bins go out?")).map((e) =>
      e.type === "tool" ? e.summary : "",
    );
    expect(out[0]).toContain("1. Bin days");
    expect(out[0]).toContain("https://town.example/bins");
    expect(out[0]).not.toContain("javascript:");
    expect(asked[0]).toBe("http://searx.lan:8080/search?q=bin%20day%20%26%20more&format=json");
    expect(out[1]).toContain("Bins go out on Tuesday.");
    expect(out[2]).toContain("More text here.");
    for (const refused of [out[3], out[4], out[5]]) expect(refused).toContain("home network");
    // Pages are loaded from the addresses that were checked, and a refused one is never loaded.
    expect(pinned).toContain("town.example 93.184.216.34");
    expect(pinned.some((p) => p.startsWith("router.lan") || p.startsWith("192.168."))).toBe(false);
    expect(out[6]).toContain("Only http and https");
    expect(out[7]).toContain("not a page of text");
    // The private addresses were never fetched, not even after the redirect.
    expect(asked.some((u) => u.includes("192.168.1.1") || u.includes("router.lan"))).toBe(false);
  });

  it("drops the page tool when reading is turned off", async () => {
    await api("PUT", "/api/settings/web", { readPages: false });
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read_web_page", { url: "https://town.example/bins" })]),
      fauxAssistantMessage("No."),
    ]);
    const [tool] = await turn("read it");
    expect(tool?.type === "tool" && tool.summary).not.toContain("Tuesday");
  });
});
