import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@shipmate/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchQuery, splitPassages } from "./services/documents.js";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe("document passages", () => {
  it("keeps short paragraphs together and splits long ones at a space", () => {
    expect(splitPassages("One.\n\nTwo.\n\n\nThree.", 100)).toEqual(["One.\n\nTwo.\n\nThree."]);
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const parts = splitPassages(long, 100);
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
    expect(parts.join(" ")).toBe(long);
    expect(splitPassages("x".repeat(250), 100)).toHaveLength(3);
    expect(splitPassages("  \n\n ")).toEqual([]);
  });

  it("turns a question into an any-word query", () => {
    expect(searchQuery("What does E24 mean?")).toBe("what | does | e24 | mean");
    expect(searchQuery("a ! & |")).toBeNull();
    expect(searchQuery("pump pump PUMP")).toBe("pump");
  });
});

describe.skipIf(!db)("Document library", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let ownerCookie = "";
  let kidCookie = "";
  let otherCookie = "";
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
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
  const upload = (name: string, data: string | Buffer, cookie = ownerCookie, query = "") =>
    t.app.inject({
      method: "POST",
      url: `/api/documents${query}`,
      payload: Buffer.isBuffer(data) ? data : Buffer.from(data),
      headers: {
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-file-type": "text/plain",
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

  const manual = [
    "Dishwasher manual",
    "Loading: place plates in the lower rack and glasses in the upper rack.",
    "Error E24 means the drain hose is blocked or kinked. Clean the filter and check the hose.",
    ...Array.from(
      { length: 40 },
      (_, i) => `Section ${i + 1}. ${"General care notes about the appliance. ".repeat(20)}`,
    ),
    "Warranty: two years from the purchase date, covering parts and labor.",
  ].join("\n\n");

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
    for (const [email, name] of [
      ["kid@example.com", "Kid"],
      ["other@example.com", "Other"],
    ]) {
      await api("POST", "/api/users", {
        email,
        displayName: name,
        password: "password1",
        role: "member",
      });
    }
    const login = async (email: string) =>
      cookieOf(await api("POST", "/api/auth/login", { email, password: "password1" }, ""));
    kidCookie = await login("kid@example.com");
    otherCookie = await login("other@example.com");
    await api("PUT", "/api/settings", { defaultModel: "faux/m" });
  });
  afterAll(async () => {
    await t?.app.close();
  });

  it("adds a shared document and finds the passage that answers a question", async () => {
    const res = await upload("Dishwasher manual.txt", manual);
    expect(res.statusCode).toBe(200);
    const doc = res.json().document;
    expect(doc).toMatchObject({ name: "Dishwasher manual.txt", kind: "text", shared: true });
    expect(doc.chars).toBe(manual.length);

    // Everyone sees a shared document; only its adder (or an admin) may change it.
    const seen = (await api("GET", "/api/documents", undefined, kidCookie)).json().documents;
    expect(seen).toEqual([expect.objectContaining({ id: doc.id, mine: false })]);

    const { hits } = (
      await api(
        "GET",
        "/api/documents/search?q=what%20does%20error%20E24%20mean",
        undefined,
        kidCookie,
      )
    ).json();
    expect(hits[0]).toMatchObject({ name: "Dishwasher manual.txt", part: 1 });
    expect(hits[0].text).toContain("drain hose is blocked");
    expect((await api("GET", "/api/documents/search?q=%21%21")).json().hits).toEqual([]);

    const file = await api("GET", `/api/documents/${doc.id}`, undefined, kidCookie);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.body).toBe(manual);
  });

  it("keeps a private document to the person who added it", async () => {
    const res = await upload(
      "Payslip.txt",
      "Net pay in March was 2,431 dollars.",
      kidCookie,
      "?private=1",
    );
    const doc = res.json().document;
    expect(doc).toMatchObject({ shared: false, mine: true });
    const names = async (cookie: string) =>
      (await api("GET", "/api/documents", undefined, cookie))
        .json()
        .documents.map((d: { name: string }) => d.name);
    expect(await names(kidCookie)).toContain("Payslip.txt");
    expect(await names(ownerCookie)).not.toContain("Payslip.txt");
    expect((await api("GET", "/api/documents/search?q=payslip%20march")).json().hits).toEqual([]);
    expect((await api("GET", `/api/documents/${doc.id}`)).statusCode).toBe(404);
    expect((await api("DELETE", `/api/documents/${doc.id}`)).statusCode).toBe(404);
    const mine = (
      await api("GET", "/api/documents/search?q=march%20pay", undefined, kidCookie)
    ).json().hits;
    expect(mine[0].name).toBe("Payslip.txt");

    // Sharing it makes it everyone's; an admin can then unshare it back to its adder.
    const shared = await api("PATCH", `/api/documents/${doc.id}`, { shared: true }, kidCookie);
    expect(shared.json().document.shared).toBe(true);
    expect(await names(otherCookie)).toContain("Payslip.txt");
    expect(
      (await api("PATCH", `/api/documents/${doc.id}`, { name: "x" }, otherCookie)).statusCode,
    ).toBe(403);
    expect(
      (await api("DELETE", `/api/documents/${doc.id}`, undefined, otherCookie)).statusCode,
    ).toBe(403);
    await api("PATCH", `/api/documents/${doc.id}`, { shared: false });
    expect(await names(ownerCookie)).not.toContain("Payslip.txt");
    expect(await names(kidCookie)).toContain("Payslip.txt");
    expect((await api("DELETE", `/api/documents/${doc.id}`, undefined, kidCookie)).statusCode).toBe(
      200,
    );
    expect(await names(kidCookie)).not.toContain("Payslip.txt");
  });

  it("gives a second document with the same name a name of its own", async () => {
    const again = (await upload("dishwasher MANUAL.txt", "A different manual.", kidCookie)).json()
      .document;
    expect(again.name).toBe("dishwasher MANUAL (2).txt");
    const renamed = await api(
      "PATCH",
      `/api/documents/${again.id}`,
      { name: "Dishwasher manual.txt" },
      kidCookie,
    );
    expect(renamed.json().document.name).toBe("Dishwasher manual (2).txt");
    await api("DELETE", `/api/documents/${again.id}`, undefined, kidCookie);
  });

  it("refuses photos, empty files and unknown types", async () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(20)]);
    expect((await upload("photo.png", png)).statusCode).toBe(415);
    expect((await upload("thing.bin", Buffer.from([0, 1, 2, 3]))).statusCode).toBe(415);
    expect((await upload("blank.txt", "   \n ")).statusCode).toBe(422);
  });

  it("lets agents search and read the documents with tools", async () => {
    const conv = (await api("POST", "/api/conversations", {})).json().conversation;
    t.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("search_documents", { query: "warranty how long" })]),
      fauxAssistantMessage([fauxToolCall("read_document", { document: "dishwasher" })]),
      fauxAssistantMessage([fauxToolCall("read_document", { document: "dishwasher", part: 7 })]),
      fauxAssistantMessage([fauxToolCall("list_documents", {})]),
      fauxAssistantMessage([fauxToolCall("read_document", { document: "toaster" })]),
      fauxAssistantMessage("Two years."),
    ]);
    const ws = await t.app.injectWS("/api/ws", { headers: { cookie: ownerCookie } });
    const events: ServerEvent[] = [];
    ws.on("message", (raw: Buffer) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    ws.send(
      JSON.stringify({ type: "send", conversationId: conv.id, text: "how long is the warranty?" }),
    );
    await until(() => events.some((e) => e.type === "status" && !e.busy));
    ws.terminate();
    const out = events
      .filter((e) => e.type === "tool" && e.phase === "end")
      .map((e) => (e.type === "tool" ? e.summary : ""));
    expect(out[0]).toContain("Dishwasher manual.txt (part");
    expect(out[1]).toContain("parts 1 to 6 of");
    expect(out[2]).toContain("parts 7 to 12 of");
    expect(out[3]).toContain("- Dishwasher manual.txt (shared)");
    expect(out[4]).toContain('No document named "toaster"');
  });
});
