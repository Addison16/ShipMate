import { describe, expect, it } from "vitest";
import { lastLine, terminalSocketUrl } from "./cli-login.js";

describe("sign-in and terminal helpers", () => {
  it("shows the CLI's last words, not its prompt", () => {
    expect(
      lastLine(
        "visit:\nhttps://claude.ai/x\nPaste code here if prompted > That doesn't look like the full code.\n\nPaste code here if prompted > ",
      ),
    ).toBe("That doesn't look like the full code.");
    expect(lastLine("")).toBe("");
  });

  it("uses wss: on https pages", () => {
    expect(terminalSocketUrl({ protocol: "https:", host: "ship.example" }, 24, 80)).toBe(
      "wss://ship.example/api/terminal/ws?rows=24&cols=80",
    );
    expect(terminalSocketUrl({ protocol: "http:", host: "10.0.0.5:3000" }, 30, 100)).toBe(
      "ws://10.0.0.5:3000/api/terminal/ws?rows=30&cols=100",
    );
  });
});
