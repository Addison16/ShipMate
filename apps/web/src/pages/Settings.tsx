import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth, useUser } from "../auth.js";
import { AppearanceSettings } from "../components/AppearanceSettings.js";
import { BackupSettings } from "../components/BackupSettings.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { OidcSettings } from "../components/OidcSettings.js";
import { Badge, Button, Card, ErrorText, Page, PageHeader, TextField } from "../components/ui.js";
import { useResource } from "../lib/useResource.js";

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
  ) : null;
}

export function SettingsPage() {
  return (
    <Page>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <AppearanceSettings />
        <InstanceSettings />
        <OidcSettings />
        <BackupSettings />
        <MyAccount />
      </div>
    </Page>
  );
}

function InstanceSettings() {
  const user = useUser();
  const owner = user.role === "owner";
  const settings = useResource(() => api.getSettings());
  const models = useResource(() => api.listModels().then((r) => r.models));
  const [captainName, setCaptainName] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setCaptainName(settings.data.captainName);
      setDefaultModel(settings.data.defaultModel);
    }
  }, [settings.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await api.updateSettings({
        captainName: captainName.trim(),
        defaultModel,
      });
      settings.setData(next);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Instance</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {owner ? "Shared by everyone on this instance." : "Only the owner can change these."}
      </p>
      <ErrorText>{settings.error}</ErrorText>
      {settings.data && (
        <form onSubmit={save} className="space-y-4">
          <TextField
            label="Coordinator name"
            hint={`The coordinator crew member (${settings.data.captainSlug}) runs the Bridge.`}
            required
            disabled={!owner}
            value={captainName}
            onChange={(e) => setCaptainName(e.target.value)}
          />
          <ModelSelect
            label="Default model"
            value={defaultModel}
            onChange={setDefaultModel}
            models={models.data}
            disabled={!owner}
          />
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Core MCP servers:</span>
            {settings.data.mcpEnabled ? <Badge tone="ok">enabled</Badge> : <Badge>disabled</Badge>}
            <span className="text-xs text-slate-500 dark:text-slate-400">
              (set in the server config)
            </span>
          </div>
          <ErrorText>{error}</ErrorText>
          {owner && (
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Saved show={saved} />
            </div>
          )}
        </form>
      )}
    </Card>
  );
}

function MyAccount() {
  const user = useUser();
  const { setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSaved, setPwSaved] = useState(false);

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setNameError(null);
    setNameSaved(false);
    try {
      const { user: u } = await api.updateUser(user.id, { displayName: displayName.trim() });
      setUser(u);
      setNameSaved(true);
    } catch (err) {
      setNameError(errorMessage(err));
    }
  }

  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPwSaved(false);
    if (password !== confirm) {
      setPwError("Passwords do not match.");
      return;
    }
    setPwError(null);
    try {
      await api.updateUser(user.id, { password });
      setPassword("");
      setConfirm("");
      setPwSaved(true);
    } catch (err) {
      setPwError(errorMessage(err));
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">My account</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Signed in as {user.email} ({user.role}).
      </p>
      <form onSubmit={saveName} className="space-y-3">
        <TextField
          label="Display name"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        <ErrorText>{nameError}</ErrorText>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={displayName.trim() === user.displayName}>
            Save name
          </Button>
          <Saved show={nameSaved} />
        </div>
      </form>
      <hr className="my-6 border-slate-200 dark:border-slate-800" />
      <form onSubmit={savePassword} className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextField
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <ErrorText>{pwError}</ErrorText>
        <div className="flex items-center gap-3">
          <Button type="submit">Change password</Button>
          <Saved show={pwSaved} />
        </div>
      </form>
    </Card>
  );
}
