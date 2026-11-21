import type { CliLoginProvider, CliLoginResponse, TerminalStatusDto } from "@shipmate/core";
import { request } from "../api.js";

export const cliLoginApi = {
  get: (p: CliLoginProvider) => request<CliLoginResponse>("GET", `/api/cli-login/${p}`),
  start: (p: CliLoginProvider) => request<CliLoginResponse>("POST", `/api/cli-login/${p}`),
  answer: (p: CliLoginProvider, code: string) =>
    request<CliLoginResponse>("POST", `/api/cli-login/${p}/answer`, { code }),
  stop: (p: CliLoginProvider) => request<CliLoginResponse>("DELETE", `/api/cli-login/${p}`),
};

export const terminalApi = {
  status: () => request<{ terminal: TerminalStatusDto }>("GET", "/api/terminal"),
  set: (enabled: boolean) =>
    request<{ terminal: TerminalStatusDto }>("PUT", "/api/terminal", { enabled }),
};

/** The terminal's socket address for this page (ws: on http, wss: on https). */
export function terminalSocketUrl(
  loc: { protocol: string; host: string },
  rows: number,
  cols: number,
) {
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${loc.host}/api/terminal/ws?rows=${rows}&cols=${cols}`;
}

/** The last thing the CLI said, for a one-line hint under the code box. */
export function lastLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) =>
      l
        .replace(/\s+/g, " ")
        .replace(/^(paste code here if prompted\s*>|enter the authorization code:)\s*/i, "")
        .trim(),
    )
    .filter(Boolean);
  return lines.at(-1) ?? "";
}
