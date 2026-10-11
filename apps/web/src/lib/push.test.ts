import { describe, expect, it } from "vitest";
import { base64UrlToBytes, deviceLabel, isIos, pushSupport } from "./push.js";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  pixel:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

describe("push helpers", () => {
  it("names devices", () => {
    expect(deviceLabel(UA.iphone)).toBe("iPhone, Safari");
    expect(deviceLabel(UA.ipad, 5)).toBe("iPad, Safari");
    expect(deviceLabel(UA.ipad, 0)).toBe("Mac, Safari");
    expect(deviceLabel(UA.pixel)).toBe("Android, Chrome");
    expect(deviceLabel(UA.edge)).toBe("Windows, Edge");
    expect(deviceLabel(UA.firefox)).toBe("Linux, Firefox");
  });

  it("knows iOS needs the app on the Home Screen", () => {
    expect(isIos(UA.iphone)).toBe(true);
    expect(isIos(UA.ipad, 5)).toBe(true);
    expect(isIos(UA.pixel)).toBe(false);
    const base = {
      secure: true,
      serviceWorker: true,
      pushManager: true,
      notification: true,
      ios: false,
      standalone: false,
    };
    expect(pushSupport(base)).toBe("ok");
    expect(pushSupport({ ...base, secure: false })).toBe("insecure");
    expect(pushSupport({ ...base, ios: true, pushManager: false })).toBe("ios-install");
    expect(pushSupport({ ...base, ios: true, standalone: true })).toBe("ok");
    expect(pushSupport({ ...base, pushManager: false })).toBe("unsupported");
  });

  it("decodes the server key", () => {
    expect([...base64UrlToBytes("BAEC_w")]).toEqual([4, 1, 2, 255]);
  });
});
