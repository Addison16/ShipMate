import type { GeminiCliStatusDto, GeminiKeyRequest } from "@shipmate/core";
import { request } from "../api.js";

export const geminiCliApi = {
  status: () => request<{ geminiCli: GeminiCliStatusDto }>("GET", "/api/gemini-cli"),
  setKey: (key: GeminiKeyRequest["key"]) =>
    request<{ geminiCli: GeminiCliStatusDto }>("PUT", "/api/gemini-cli/key", { key }),
};

/** The Gemini CLI models crew can pick while it has an API key or a login; none otherwise. */
export function geminiChoices(
  s: GeminiCliStatusDto | null | undefined,
): Array<{ ref: string; name: string }> {
  return s?.installed && s.signedIn ? s.models : [];
}
