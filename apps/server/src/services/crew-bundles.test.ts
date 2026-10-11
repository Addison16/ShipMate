import { describe, expect, it } from "vitest";
import { fetchBundleText, isPublicAddress, redactSecrets } from "./crew-bundles.js";

const publicDns = async () => [{ address: "93.184.216.34" }];

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

describe("crew bundles", () => {
  it("redacts values that look like credentials", () => {
    const r = redactSecrets(
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok",
    );
    expect(r.count).toBe(2);
    expect(r.text).toBe("key [redacted] and [redacted] ok");
    expect(redactSecrets("Plan meals; ask before buying.").count).toBe(0);
  });

  it("knows private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    for (const ip of ["::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "100.64.0.1", "0.0.0.0"]) {
      expect(isPublicAddress(ip)).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });

  it("downloads only from public https hosts, with a size limit", async () => {
    const ok = await fetchBundleText("https://example.com/galley.json", {
      lookup: publicDns,
      fetch: async () => response('{"format":"shipmate-crew"}'),
    });
    expect(ok).toContain("shipmate-crew");

    await expect(fetchBundleText("http://example.com/x.json")).rejects.toThrow(/only https/);
    await expect(
      fetchBundleText("https://intranet.local/x.json", {
        lookup: async () => [{ address: "10.0.0.5" }],
        fetch: async () => response("{}"),
      }),
    ).rejects.toThrow(/private or local/);
    await expect(fetchBundleText("https://127.0.0.1/x.json")).rejects.toThrow(/private or local/);
    // A redirect is checked like the first hop.
    await expect(
      fetchBundleText("https://example.com/x.json", {
        lookup: async (host) =>
          host === "example.com" ? [{ address: "93.184.216.34" }] : [{ address: "127.0.0.1" }],
        fetch: async (url) =>
          url.includes("example.com")
            ? response("", { status: 302, headers: { location: "https://localhost/secret" } })
            : response("{}"),
      }),
    ).rejects.toThrow(/private or local/);
    await expect(
      fetchBundleText("https://example.com/big.json", {
        lookup: publicDns,
        fetch: async () => response("x".repeat(600 * 1024)),
      }),
    ).rejects.toThrow(/too large/);
  });
});
