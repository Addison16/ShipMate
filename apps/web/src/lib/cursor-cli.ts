import type { CursorCliStatusDto } from "@shipmate/core";
import { request } from "../api.js";

export const cursorCliApi = {
  status: () => request<{ cursorCli: CursorCliStatusDto }>("GET", "/api/cursor-cli"),
};

/** The Cursor models crew can pick while Cursor is signed in; none otherwise. */
export function cursorChoices(
  s: CursorCliStatusDto | null | undefined,
): Array<{ ref: string; name: string }> {
  return s?.signedIn ? s.models : [];
}
