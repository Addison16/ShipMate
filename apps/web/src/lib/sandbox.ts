import type {
  SandboxCheckDto,
  SandboxEndpointDto,
  UpdateSandboxEndpointRequest,
} from "@shipmate/core";
import { request } from "../api.js";

export const sandboxApi = {
  get: () => request<{ sandbox: SandboxEndpointDto }>("GET", "/api/shipyard/sandbox"),
  update: (body: UpdateSandboxEndpointRequest) =>
    request<{ sandbox: SandboxEndpointDto }>("PUT", "/api/shipyard/sandbox", body),
  test: (body: UpdateSandboxEndpointRequest) =>
    request<{ check: SandboxCheckDto }>("POST", "/api/shipyard/sandbox/test", body),
};

/** Common sockets, as Shipmate sees them inside its container. */
export const SOCKET_PRESETS: Array<{ path: string; label: string }> = [
  { path: "/var/run/docker.sock", label: "Docker (or Podman mounted at Docker's path)" },
  { path: "/run/podman/podman.sock", label: "Podman, rootful" },
  { path: "/run/user/1000/podman/podman.sock", label: "Podman, rootless (user 1000)" },
];

export interface SandboxForm {
  mode: SandboxEndpointDto["mode"];
  socketPath: string;
  host: string;
  tlsCa: string;
  tlsCert: string;
  tlsKey: string;
  /** Remove the stored TLS files. */
  clearTls: boolean;
  workspacesPath: string;
}

export function sandboxForm(d: SandboxEndpointDto | null): SandboxForm {
  return {
    mode: d?.mode ?? "env",
    socketPath: d?.socketPath ?? "",
    host: d?.host ?? "",
    tlsCa: "",
    tlsCert: "",
    tlsKey: "",
    clearTls: false,
    workspacesPath: d?.workspacesPath ?? "",
  };
}

/** "nas.lan:2376" → "tcp://nas.lan:2376"; leaves anything with a scheme alone. */
export function normalizeHost(input: string): string {
  const t = input.trim();
  if (!t || /^[a-z]+:\/\//i.test(t)) return t;
  return `tcp://${t}`;
}

export type SandboxFormResult =
  | { ok: true; request: UpdateSandboxEndpointRequest }
  | { ok: false; errors: Partial<Record<keyof SandboxForm, string>> };

/**
 * Build the request: blanks are left out (TLS files then keep what is stored), "Remove TLS
 * files" sends "" for each.
 */
export function sandboxRequest(f: SandboxForm): SandboxFormResult {
  if (f.mode === "env") return { ok: true, request: { mode: "env" } };
  const errors: Partial<Record<keyof SandboxForm, string>> = {};
  const workspacesPath = f.workspacesPath.trim();
  if (workspacesPath && !workspacesPath.startsWith("/")) {
    errors.workspacesPath = "Use an absolute path, e.g. /mnt/tank/shipmate/workspaces.";
  }
  const req: UpdateSandboxEndpointRequest = { mode: f.mode };
  if (workspacesPath) req.workspacesPath = workspacesPath;
  if (f.mode === "socket") {
    const path = f.socketPath.trim();
    if (path && !path.startsWith("/")) errors.socketPath = "Use an absolute path.";
    if (path) req.socketPath = path;
  } else {
    const host = normalizeHost(f.host);
    if (!host) errors.host = "Enter the host, e.g. tcp://nas.lan:2376.";
    else if (!/^tcp:\/\/[^/\s]+$/i.test(host)) errors.host = "Use tcp://host:port.";
    req.host = host;
    if (f.clearTls) {
      req.tlsCa = "";
      req.tlsCert = "";
      req.tlsKey = "";
    } else {
      if (f.tlsCa.trim()) req.tlsCa = f.tlsCa.trim();
      if (f.tlsCert.trim()) req.tlsCert = f.tlsCert.trim();
      if (f.tlsKey.trim()) req.tlsKey = f.tlsKey.trim();
      if (req.tlsCert && !req.tlsCert.includes("BEGIN CERTIFICATE")) {
        errors.tlsCert = "Paste the PEM text of the client certificate.";
      }
      if (req.tlsKey && !/BEGIN [A-Z ]*PRIVATE KEY/.test(req.tlsKey)) {
        errors.tlsKey = "Paste the PEM text of the client key.";
      }
      if (req.tlsCa && !req.tlsCa.includes("BEGIN CERTIFICATE")) {
        errors.tlsCa = "Paste the PEM text of the CA certificate.";
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, request: req };
}
