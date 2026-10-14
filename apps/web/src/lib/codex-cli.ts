import type { CodexCliStatusDto } from "@shipmate/core";
import { request } from "../api.js";

export const codexCliApi = {
  status: () => request<{ codexCli: CodexCliStatusDto }>("GET", "/api/codex-cli"),
};

/** The Codex models crew can pick while Codex is signed in; none otherwise. */
export function codexChoices(
  s: CodexCliStatusDto | null | undefined,
): Array<{ ref: string; name: string }> {
  return s?.signedIn ? s.models : [];
}
