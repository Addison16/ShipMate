import { describe, expect, it } from "vitest";
import { deviceLabel } from "./devices.js";

describe("deviceLabel", () => {
  it("names common phones and computers", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("iPhone · Safari");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Android phone · Chrome");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toBe("Windows · Edge");
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
      ),
    ).toBe("Mac · Firefox");
  });

  it("falls back plainly", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("curl/8.5.0")).toBe("Unknown device");
  });
});
