import type { SandboxCheckDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { errorMessage } from "../api.js";
import { useThemeText } from "../appearance.js";
import { useUser } from "../auth.js";
import {
  type SandboxForm,
  SOCKET_PRESETS,
  sandboxApi,
  sandboxForm,
  sandboxRequest,
} from "../lib/sandbox.js";
import { useResource } from "../lib/useResource.js";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
} from "./ui.js";

/** Settings → Shipyard sandbox (owner only): where crew members' code runs. */
export function SandboxSettings() {
  const user = useUser();
  if (user.role !== "owner") return null;
  return <SandboxSettingsCard />;
}

function FieldError({ text }: { text: string | undefined }) {
  return text ? <span className="text-red-700 dark:text-red-300">{text}</span> : null;
}

function CheckResult({ check }: { check: SandboxCheckDto }) {
  return (
    <div
      role="status"
      className={
        check.ok
          ? "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100"
          : "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100"
      }
    >
      <p className="font-medium">
        {check.ok ? `Connected to ${check.engine}` : "Could not connect"} at{" "}
        <code className="font-mono text-xs">{check.endpoint}</code>
      </p>
      {check.error && <p className="mt-1">{check.error}</p>}
      {check.warnings.map((w) => (
        <p key={w} className="mt-1 text-amber-800 dark:text-amber-200">
          {w}
        </p>
      ))}
    </div>
  );
}

function SandboxSettingsCard() {
  const current = useResource(() => sandboxApi.get().then((r) => r.sandbox));
  const t = useThemeText();
  const [form, setForm] = useState<SandboxForm>(sandboxForm(null));
  const [errors, setErrors] = useState<Partial<Record<keyof SandboxForm, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<SandboxCheckDto | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (current.data) setForm(sandboxForm(current.data));
  }, [current.data]);

  const set = <K extends keyof SandboxForm>(k: K, v: SandboxForm[K]) => {
    setForm({ ...form, [k]: v });
    setSaved(false);
    setCheck(null);
  };

  async function run(kind: "save" | "test", e?: FormEvent) {
    e?.preventDefault();
    const result = sandboxRequest(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setError(null);
    setBusy(kind);
    try {
      if (kind === "test") {
        setCheck((await sandboxApi.test(result.request)).check);
      } else {
        const { sandbox } = await sandboxApi.update(result.request);
        current.setData(sandbox);
        setSaved(true);
        setCheck((await sandboxApi.test(result.request)).check);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const d = current.data;
  const tls = d?.tls;
  const storedTls = Boolean(tls && (tls.ca || tls.cert || tls.key));
  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="font-semibold">{t("Shipyard sandbox")}</h2>
        {d && (
          <Badge>
            {d.mode === "env" ? "from environment" : d.mode === "socket" ? "socket" : "remote host"}
          </Badge>
        )}
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {t(
          "Where crew members run code. Shipmate starts one sandbox container per project through a Docker-compatible API: the Docker socket, rootless Podman's socket, or a Docker or Podman host elsewhere on your network. Code never runs outside a sandbox.",
        )}
      </p>
      <ErrorText>{current.error}</ErrorText>
      {d && (
        <form onSubmit={(e) => void run("save", e)} className="space-y-4">
          <p className="text-sm">
            In use now: <code className="font-mono text-xs">{d.effective}</code>
          </p>
          <SelectField
            label="Sandbox engine"
            value={form.mode}
            onChange={(e) => set("mode", e.target.value as SandboxForm["mode"])}
          >
            <option value="env">From the server environment ({d.fromEnv})</option>
            <option value="socket">A socket mounted into Shipmate (Docker or Podman)</option>
            <option value="tcp">A remote Docker or Podman host (TCP)</option>
          </SelectField>
          {form.mode === "env" && (
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Set <code className="font-mono text-xs">DOCKER_HOST</code> (and{" "}
              <code className="font-mono text-xs">DOCKER_TLS_VERIFY</code>,{" "}
              <code className="font-mono text-xs">DOCKER_CERT_PATH</code>) or mount{" "}
              <code className="font-mono text-xs">/var/run/docker.sock</code> to change this.
            </p>
          )}
          {form.mode === "socket" && (
            <>
              <TextField
                label="Socket path"
                placeholder="/var/run/docker.sock"
                spellCheck={false}
                list="sandbox-socket-presets"
                value={form.socketPath}
                onChange={(e) => set("socketPath", e.target.value)}
                hint={
                  <>
                    <FieldError text={errors.socketPath} />
                    {!errors.socketPath &&
                      "The path inside the Shipmate container. For rootless Podman, mount $XDG_RUNTIME_DIR/podman/podman.sock into the container."}
                  </>
                }
              />
              <datalist id="sandbox-socket-presets">
                {SOCKET_PRESETS.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.label}
                  </option>
                ))}
              </datalist>
            </>
          )}
          {form.mode === "tcp" && (
            <>
              <TextField
                label="Host"
                placeholder="tcp://nas.lan:2376"
                spellCheck={false}
                autoComplete="off"
                value={form.host}
                onChange={(e) => set("host", e.target.value)}
                hint={errors.host && <FieldError text={errors.host} />}
              />
              <Notice>
                Whoever can reach this port controls that host. Protect it with TLS client
                certificates: paste the CA, the client certificate and its key below.
              </Notice>
              {storedTls && (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Stored:{" "}
                  {[tls?.ca && "CA", tls?.cert && "client certificate", tls?.key && "client key"]
                    .filter(Boolean)
                    .join(", ")}
                  . Leave the boxes empty to keep them.
                </p>
              )}
              <div className="grid gap-4 md:grid-cols-3">
                <TextAreaField
                  label="CA certificate"
                  rows={3}
                  mono
                  placeholder="-----BEGIN CERTIFICATE-----"
                  disabled={form.clearTls}
                  value={form.tlsCa}
                  onChange={(e) => set("tlsCa", e.target.value)}
                  hint={errors.tlsCa && <FieldError text={errors.tlsCa} />}
                />
                <TextAreaField
                  label="Client certificate"
                  rows={3}
                  mono
                  placeholder="-----BEGIN CERTIFICATE-----"
                  disabled={form.clearTls}
                  value={form.tlsCert}
                  onChange={(e) => set("tlsCert", e.target.value)}
                  hint={errors.tlsCert && <FieldError text={errors.tlsCert} />}
                />
                <TextAreaField
                  label="Client key"
                  rows={3}
                  mono
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  disabled={form.clearTls}
                  value={form.tlsKey}
                  onChange={(e) => set("tlsKey", e.target.value)}
                  hint={errors.tlsKey && <FieldError text={errors.tlsKey} />}
                />
              </div>
              {storedTls && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.clearTls}
                    onChange={(e) => set("clearTls", e.target.checked)}
                    className="size-4 accent-accent-700"
                  />
                  Remove the stored TLS files
                </label>
              )}
            </>
          )}
          {form.mode !== "env" && (
            <TextField
              label="Workspaces path on the sandbox host (optional)"
              placeholder="/mnt/tank/shipmate/workspaces"
              spellCheck={false}
              value={form.workspacesPath}
              onChange={(e) => set("workspacesPath", e.target.value)}
              hint={
                <>
                  <FieldError text={errors.workspacesPath} />
                  {!errors.workspacesPath &&
                    "Where that host sees Shipmate's workspaces folder, for mounting into sandboxes. Needed for a remote host (share the folder over NFS or SMB)."}
                </>
              }
            />
          )}
          {check && <CheckResult check={check} />}
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" disabled={busy !== null}>
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button disabled={busy !== null} onClick={() => void run("test")}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </Button>
            {saved && <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>}
          </div>
        </form>
      )}
    </Card>
  );
}
