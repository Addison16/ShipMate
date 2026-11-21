import type { TwoStepSetup } from "@shipmate/core";
import qrcode from "qrcode-generator";
import { type FormEvent, useMemo, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth, useUser } from "../auth.js";
import { Badge, Button, Card, ErrorText, TextField } from "./ui.js";

/** The QR picture for an otpauth address, as an SVG path on a white card (scans in dark mode too). */
function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x} ${y}h1v1h-1z`;
    }
    return { size: n, path: d };
  }, [text]);
  return (
    <svg
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      className="h-44 w-44 rounded-lg bg-white"
      role="img"
      aria-label="QR code for your authenticator app"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

const codeProps = {
  inputMode: "numeric" as const,
  autoComplete: "one-time-code",
  maxLength: 12,
  placeholder: "123456",
};

/** Settings → Profile: turn sign-in codes (an authenticator app) on or off for yourself. */
export function TwoStepSettings() {
  const user = useUser();
  const { refresh } = useAuth();
  const [setup, setSetup] = useState<TwoStepSetup | null>(null);
  const [backup, setBackup] = useState<string[] | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => setSetup(await api.twoStepSetup()));
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = await api.twoStepEnable({ code, password });
      setBackup(res.backupCodes);
      setSetup(null);
      setCode("");
      setPassword("");
      await refresh();
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.twoStepDisable(code);
      setTurningOff(false);
      setCode("");
      await refresh();
    });
  };

  if (!user.hasPassword) return null;

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">Sign-in codes</h2>
        <Badge tone={user.twoStep ? "accent" : "neutral"}>{user.twoStep ? "On" : "Off"}</Badge>
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        After your password, sign-in asks for a code from an authenticator app on your phone.
      </p>
      <ErrorText>{error}</ErrorText>

      {backup && (
        <div className="space-y-3">
          <p className="text-sm font-medium">Sign-in codes are on. Save these backup codes.</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Each one signs you in once if you lose your phone. They are not shown again.
          </p>
          <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-3 font-mono text-sm dark:bg-slate-800">
            {backup.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(backup.join("\n"))
                  .then(() => setCopied(true))
                  .catch(() => setError("Could not copy. Write the codes down instead."))
              }
            >
              {copied ? "Copied" : "Copy codes"}
            </Button>
            <Button variant="primary" onClick={() => setBackup(null)}>
              I saved them
            </Button>
          </div>
        </div>
      )}

      {!backup && !user.twoStep && !setup && (
        <Button disabled={busy} onClick={() => void start()}>
          Turn on
        </Button>
      )}

      {!backup && !user.twoStep && setup && (
        <form onSubmit={enable} className="space-y-4">
          <p className="text-sm">
            1. Add Shipmate to your authenticator app. On this phone, tap the button. On a computer,
            scan the picture with your phone.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <QrCode text={setup.uri} />
            <div className="min-w-0 space-y-2">
              <a
                href={setup.uri}
                className="inline-flex rounded-md border border-control px-3 py-1.5 text-sm font-medium"
              >
                Open authenticator app
              </a>
              <p className="text-sm text-slate-500 dark:text-slate-400">Or type this key:</p>
              <code className="block text-sm break-all select-all">
                {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
            </div>
          </div>
          <p className="text-sm">2. Type the code the app shows, and your password.</p>
          <TextField
            label="Code from the app"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            {...codeProps}
          />
          <TextField
            label="Your password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Checking…" : "Turn on sign-in codes"}
            </Button>
            <Button onClick={() => setSetup(null)}>Cancel</Button>
          </div>
          <details className="text-sm text-slate-500 dark:text-slate-400">
            <summary className="cursor-pointer">More details</summary>
            <p className="mt-2">
              Any authenticator app works, such as Google Authenticator, Microsoft Authenticator,
              Apple Passwords, 1Password or Aegis. Turning this on signs your other devices out. It
              does not apply when you sign in with single sign-on.
            </p>
          </details>
        </form>
      )}

      {!backup && user.twoStep && !turningOff && (
        <Button onClick={() => setTurningOff(true)}>Turn off</Button>
      )}

      {!backup && user.twoStep && turningOff && (
        <form onSubmit={disable} className="space-y-4">
          <TextField
            label="Code from the app, or a backup code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            {...codeProps}
            inputMode="text"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="danger" disabled={busy}>
              Turn off sign-in codes
            </Button>
            <Button onClick={() => setTurningOff(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
