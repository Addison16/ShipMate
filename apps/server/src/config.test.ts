import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("generates and persists a secret when none is given", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipmate-"));
    const env = { DATABASE_URL: "postgres://x", SHIPMATE_DATA_DIR: dir };
    const a = loadConfig(env);
    const b = loadConfig(env);
    expect(a.SHIPMATE_SECRET).toBe(b.SHIPMATE_SECRET);
    expect(readFileSync(join(dir, ".secret"), "utf8").trim()).toBe(a.SHIPMATE_SECRET);
  });

  it("treats an empty optional address as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipmate-"));
    const env = { DATABASE_URL: "postgres://x", SHIPMATE_DATA_DIR: dir };
    expect(loadConfig({ ...env, SHIPMATE_OLLAMA_URL: "" }).SHIPMATE_OLLAMA_URL).toBe(
      "http://ollama:11434",
    );
    expect(
      loadConfig({ ...env, SHIPMATE_OLLAMA_URL: "http://10.0.0.5:11434" }).SHIPMATE_OLLAMA_URL,
    ).toBe("http://10.0.0.5:11434");
  });
});
