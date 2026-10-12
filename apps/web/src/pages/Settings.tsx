import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useAuth, useUser } from "../auth.js";
import { AppearanceSettings } from "../components/AppearanceSettings.js";
import { BackupSettings } from "../components/BackupSettings.js";
import { NavIcon } from "../components/icons.js";
import { ModelSelect } from "../components/ModelSelect.js";
import { OidcSettings } from "../components/OidcSettings.js";
import { PhotoSettings } from "../components/PhotoSettings.js";
import { ProfileSettings } from "../components/ProfileSettings.js";
import { PushSettings } from "../components/PushSettings.js";
import { SandboxSettings } from "../components/SandboxSettings.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Muted,
  Page,
  PageHeader,
  TextField,
} from "../components/ui.js";
import { VoiceSettings } from "../components/VoiceSettings.js";
import {
  SETTINGS_GROUPS,
  type SettingsSection,
  searchDestinations,
  visibleSections,
} from "../lib/nav.js";
import { useResource } from "../lib/useResource.js";
import { href } from "../router.js";

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
  ) : null;
}

/** One settings screen at #/settings/<section>; the overview and other sections route elsewhere. */
export function SettingsPage({ section }: { section: string }) {
  switch (section) {
    case "profile":
      return (
        <SettingsSectionPage title="Profile and account">
          <ProfileSettings />
          <MyAccount />
        </SettingsSectionPage>
      );
    case "appearance":
      return (
        <SettingsSectionPage title="Appearance">
          <AppearanceSettings />
        </SettingsSectionPage>
      );
    case "notifications":
      return (
        <SettingsSectionPage title="Notifications">
          <PushSettings />
        </SettingsSectionPage>
      );
    case "general":
      return (
        <SettingsSectionPage title="General">
          <InstanceSettings />
          <SetupGuide />
        </SettingsSectionPage>
      );
    case "media":
      return (
        <SettingsSectionPage title="Photos and voice">
          <PhotoSettings />
          <VoiceSettings />
        </SettingsSectionPage>
      );
    case "sandbox":
      return (
        <SettingsSectionPage title="Shipyard sandbox" ownerOnly>
          <SandboxSettings />
        </SettingsSectionPage>
      );
    case "sign-in":
      return (
        <SettingsSectionPage title="Single sign-on" ownerOnly>
          <OidcSettings />
        </SettingsSectionPage>
      );
    case "backups":
      return (
        <SettingsSectionPage title="Backups" ownerOnly>
          <BackupSettings />
        </SettingsSectionPage>
      );
    default:
      return <SettingsOverview />;
  }
}

function SettingsSectionPage({
  title,
  ownerOnly,
  children,
}: {
  title: string;
  ownerOnly?: boolean;
  children: ReactNode;
}) {
  const user = useUser();
  return (
    <Page>
      <PageHeader title={title} />
      {ownerOnly && user.role !== "owner" ? (
        <Muted>Only the owner can change these.</Muted>
      ) : (
        <div className="space-y-6">{children}</div>
      )}
    </Page>
  );
}

/** #/settings: every section as a tile with a one-line hint, grouped, with a filter box. */
function SettingsOverview() {
  const user = useUser();
  const [query, setQuery] = useState("");
  const sections = searchDestinations(visibleSections(user), query);
  const grouped = query.trim() ? [{ group: null, items: sections }] : groupSections(sections);
  return (
    <Page>
      <PageHeader title="Settings" description="Everything you can set up, in one place." />
      <label className="relative mb-6 block">
        <span className="sr-only">Find a setting</span>
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-slate-500 dark:text-slate-400">
          <NavIcon name="search" size={16} />
        </span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a setting, like password, Discord or API key"
          className={cx(
            "w-full rounded-lg border border-slate-300 bg-white py-2.5 pr-3 pl-9 text-sm dark:border-slate-700 dark:bg-slate-900",
            focusRing,
          )}
        />
      </label>
      {sections.length === 0 && <Muted>No settings match “{query.trim()}”.</Muted>}
      <div className="space-y-6">
        {grouped.map((g) => (
          <section key={g.group ?? "results"}>
            {g.group && (
              <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-accent-700 uppercase dark:text-accent-300">
                {g.group}
              </h2>
            )}
            <ul className="grid gap-2 sm:grid-cols-2">
              {g.items.map((s) => (
                <li key={s.id}>
                  <a
                    href={href(s.path)}
                    className={cx(
                      "flex h-full items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 transition-colors hover:border-accent-300 hover:bg-accent-50/50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-accent-700 dark:hover:bg-slate-800/60",
                      focusRing,
                    )}
                  >
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-accent-50 text-accent-700 dark:bg-accent-950/60 dark:text-accent-300">
                      <NavIcon name={s.icon} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">
                        {s.hint}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Page>
  );
}

function groupSections(sections: SettingsSection[]) {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    items: sections.filter((s) => s.group === group),
  })).filter((g) => g.items.length > 0);
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

/** Owner: open the first-launch guide again (it skips the account step). */
function SetupGuide() {
  const user = useUser();
  const { setOnboarding } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (user.role !== "owner") return null;

  async function restart() {
    setBusy(true);
    setError(null);
    try {
      const { onboarding } = await api.updateOnboarding({ restart: true });
      setOnboarding(onboarding);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Setup guide</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Walk through the first-launch steps again: model, Captain, home, starter crew, notifications
        and the Shipyard. Everything you set up stays; each step can be skipped.
      </p>
      <ErrorText>{error}</ErrorText>
      <Button onClick={() => void restart()} disabled={busy}>
        {busy ? "Opening…" : "Run the setup guide"}
      </Button>
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
