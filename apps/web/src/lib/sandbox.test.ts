import { describe, expect, it } from "vitest";
import { normalizeHost, sandboxForm, sandboxRequest } from "./sandbox.js";

const KEY = "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----";
const CERT = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----";

describe("sandbox endpoint form", () => {
  it("adds tcp:// to a bare host", () => {
    expect(normalizeHost(" nas.lan:2376 ")).toBe("tcp://nas.lan:2376");
    expect(normalizeHost("tcp://nas:2375")).toBe("tcp://nas:2375");
    expect(normalizeHost("")).toBe("");
  });

  it("sends only the mode for the environment default", () => {
    expect(sandboxRequest({ ...sandboxForm(null), socketPath: "/x" })).toEqual({
      ok: true,
      request: { mode: "env" },
    });
  });

  it("builds a socket request and checks paths", () => {
    const f = { ...sandboxForm(null), mode: "socket" as const };
    expect(sandboxRequest({ ...f, socketPath: "/run/podman/podman.sock" })).toEqual({
      ok: true,
      request: { mode: "socket", socketPath: "/run/podman/podman.sock" },
    });
    expect(sandboxRequest({ ...f, socketPath: "podman.sock" })).toMatchObject({ ok: false });
    expect(sandboxRequest({ ...f, workspacesPath: "relative" })).toMatchObject({
      ok: false,
      errors: { workspacesPath: expect.any(String) },
    });
  });

  it("keeps stored TLS files unless new ones are pasted or removal is asked for", () => {
    const f = { ...sandboxForm(null), mode: "tcp" as const, host: "nas:2376" };
    expect(sandboxRequest(f)).toEqual({
      ok: true,
      request: { mode: "tcp", host: "tcp://nas:2376" },
    });
    expect(sandboxRequest({ ...f, tlsCert: CERT, tlsKey: KEY })).toEqual({
      ok: true,
      request: { mode: "tcp", host: "tcp://nas:2376", tlsCert: CERT, tlsKey: KEY },
    });
    expect(sandboxRequest({ ...f, tlsKey: "hunter2" })).toMatchObject({
      ok: false,
      errors: { tlsKey: expect.any(String) },
    });
    expect(sandboxRequest({ ...f, clearTls: true, tlsKey: KEY })).toEqual({
      ok: true,
      request: { mode: "tcp", host: "tcp://nas:2376", tlsCa: "", tlsCert: "", tlsKey: "" },
    });
    expect(sandboxRequest({ ...f, host: "" })).toMatchObject({ ok: false });
    expect(sandboxRequest({ ...f, host: "ssh://nas" })).toMatchObject({ ok: false });
  });
});
