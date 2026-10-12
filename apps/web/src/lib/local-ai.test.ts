import type { LocalModelPullDto } from "@shipmate/core";
import { describe, expect, it } from "vitest";
import { formatSize, isInstalled, ollamaRef, pullFor, pullLabel, pullPercent } from "./local-ai.js";

const pull = (p: Partial<LocalModelPullDto>): LocalModelPullDto => ({
  model: "qwen3:4b",
  status: "pulling",
  detail: "pulling manifest",
  completedBytes: 0,
  totalBytes: 0,
  error: null,
  startedAt: "2026-10-11T00:00:00Z",
  ...p,
});

describe("local AI helpers", () => {
  it("matches model names with or without a tag", () => {
    const status = { installed: [{ name: "llama3.2:latest", sizeBytes: 1 }] };
    expect(isInstalled(status, "llama3.2")).toBe(true);
    expect(isInstalled(status, "qwen3:4b")).toBe(false);
    expect(ollamaRef(" qwen3:4b ")).toBe("ollama/qwen3:4b");
    expect(pullFor({ pulls: [pull({ model: "llama3.2:latest" })] }, "llama3.2")).toBeDefined();
  });

  it("describes pull progress", () => {
    expect(pullPercent(pull({}))).toBeNull();
    expect(pullLabel(pull({}))).toBe("Pulling manifest");
    const half = pull({ detail: "pulling abc", completedBytes: 1.25e9, totalBytes: 2.5e9 });
    expect(pullPercent(half)).toBe(50);
    expect(pullLabel(half)).toBe("Downloading, 1.3 GB of 2.5 GB (50%)");
    expect(
      pullLabel(pull({ detail: "verifying sha256 digest", completedBytes: 9, totalBytes: 9 })),
    ).toBe("Verifying sha256 digest");
    expect(pullPercent(pull({ status: "done" }))).toBe(100);
    expect(pullLabel(pull({ status: "failed", error: "file does not exist" }))).toBe(
      "Failed: file does not exist",
    );
    expect(formatSize(820_000_000)).toBe("820 MB");
    expect(formatSize(null)).toBe("");
  });
});
