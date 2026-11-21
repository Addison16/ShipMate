import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL, testApp } from "./testing.js";

const db = TEST_DATABASE_URL;

describe.skipIf(!db)("signing in from the app, and the owner's terminal", () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let owner = "";
  let admin = "";
  let member = "";
  const before = process.env.SHIPMATE_CODEX_BIN;
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    String(res.headers["set-cookie"]).split(";")[0] ?? "";
  const api = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    body?: unknown,
    cookie = owner,
  ) =>
    t.app.inject({
      method,
      url,
      ...(body !== undefined ? { payload: body as object } : {}),
      headers: { cookie },
    });

  /** Open the socket and collect its messages from the start (the server may answer at once). */
  const open = async (url: string, headers: Record<string, string>) => {
    const messages: Array<{ t: string; d?: string; message?: string }> = [];
    const ws = await t.app.injectWS(
      url,
      { headers },
      {
        onOpen: (s) => s.on("message", (b: Buffer) => messages.push(JSON.parse(String(b)))),
      },
    );
    const next = async (ok: (m: { t: string; d?: string; message?: string }) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const m = messages.find(ok);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 30));
      }
      return { t: "timeout", d: JSON.stringify(messages) };
    };
    return { ws, messages, next };
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
    const bin = join(dir, "codex");
    writeFileSync(
      bin,
      `#!/bin/sh\necho "1. Open this link https://auth.openai.com/codex/device"\necho "2. Enter this one-time code"\necho "   ABCD-12345"\nsleep 30\n`,
    );
    chmodSync(bin, 0o755);
    process.env.SHIPMATE_CODEX_BIN = bin;
    t = await testApp(db as string);
    owner = cookieOf(
      await api(
        "POST",
        "/api/setup",
        { email: "owner@example.com", displayName: "Addison", password: "correct horse" },
        "",
      ),
    );
    for (const [email, role] of [
      ["admin@example.com", "admin"],
      ["kid@example.com", "member"],
    ] as const) {
      await api("POST", "/api/users", { email, displayName: role, password: "password1", role });
    }
    admin = cookieOf(
      await api(
        "POST",
        "/api/auth/login",
        { email: "admin@example.com", password: "password1" },
        "",
      ),
    );
    member = cookieOf(
      await api("POST", "/api/auth/login", { email: "kid@example.com", password: "password1" }, ""),
    );
  });
  afterAll(async () => {
    if (before === undefined) delete process.env.SHIPMATE_CODEX_BIN;
    else process.env.SHIPMATE_CODEX_BIN = before;
    await t?.app.close();
  });

  it("lets admins start a sign-in, see its link and code, and stop it", async () => {
    expect((await api("POST", "/api/cli-login/codex", undefined, member)).statusCode).toBe(403);
    expect((await api("POST", "/api/cli-login/nope")).statusCode).toBe(400);
    expect((await api("POST", "/api/cli-login/codex", undefined, admin)).statusCode).toBe(200);
    let login = null;
    for (let i = 0; i < 60 && !login?.code; i++) {
      await new Promise((r) => setTimeout(r, 50));
      login = (await api("GET", "/api/cli-login/codex", undefined, admin)).json().login;
    }
    expect(login).toMatchObject({
      state: "running",
      code: "ABCD-12345",
      links: ["https://auth.openai.com/codex/device"],
    });
    const audit = (await api("GET", "/api/audit")).json();
    expect(JSON.stringify(audit)).toContain("Started signing in Codex");
    expect((await api("DELETE", "/api/cli-login/codex", undefined, admin)).json()).toEqual({
      login: null,
    });
    expect((await api("GET", "/api/cli-login/codex")).json()).toEqual({ login: null });
  });

  it("keeps the terminal off until the owner turns it on, and only for the owner", async () => {
    expect((await api("GET", "/api/terminal", undefined, admin)).statusCode).toBe(403);
    expect((await api("GET", "/api/terminal")).json()).toEqual({
      terminal: { enabled: false, allowed: true },
    });
    const origin = { cookie: owner, origin: "http://localhost", host: "localhost:80" };
    const off = await open("/api/terminal/ws", origin);
    expect(await off.next((m) => m.t === "x")).toEqual({
      t: "x",
      message: "The terminal is off. Turn it on first.",
    });

    expect((await api("PUT", "/api/terminal", { enabled: true }, admin)).statusCode).toBe(403);
    expect((await api("PUT", "/api/terminal", { enabled: true })).json().terminal.enabled).toBe(
      true,
    );

    // Another site's page can't open it, and neither can an admin.
    const foreign = await open("/api/terminal/ws", { ...origin, origin: "https://evil.example" });
    expect((await foreign.next((m) => m.t === "x")).message).toMatch(/Shipmate's own page/);
    const byAdmin = await open("/api/terminal/ws", { ...origin, cookie: admin });
    expect((await byAdmin.next((m) => m.t === "x")).message).toMatch(/Only the owner/);

    const term = await open("/api/terminal/ws?rows=20&cols=90", origin);
    term.ws.send(JSON.stringify({ t: "i", d: 'echo "SIZE=$(stty size)"\n' }));
    const seen = () =>
      term.messages
        .filter((m) => m.t === "o")
        .map((m) => m.d)
        .join("");
    await term.next(() => seen().includes("SIZE=20 90"));
    expect(seen()).toContain("SIZE=20 90");
    term.ws.send(JSON.stringify({ t: "i", d: "exit\n" }));
    expect((await term.next((m) => m.t === "e")).t).toBe("e");
    expect(JSON.stringify((await api("GET", "/api/audit")).json())).toContain(
      "Opened the web terminal",
    );

    expect((await api("PUT", "/api/terminal", { enabled: false })).json().terminal.enabled).toBe(
      false,
    );
  });
});
