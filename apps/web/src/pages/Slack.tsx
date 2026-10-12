import type { SlackChannelDto, SlackStatusDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useUser } from "../auth.js";
import { CopyBlock, ExternalLink, LinkAccountCard, StatusCard } from "../components/BridgeParts.js";
import {
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Loading,
  Muted,
  Table,
  TextField,
  td,
  th,
} from "../components/ui.js";
import { isSlackChannelId, SLACK_MANIFEST, slackState } from "../lib/bridges.js";
import { useResource } from "../lib/useResource.js";
import { useServerEvents } from "../ws.js";

/** The Slack bridge settings (a tab on the Chat bridges page). */
export function SlackPanel() {
  const user = useUser();
  const admin = isAdmin(user);
  const owner = user.role === "owner";
  const slack = useResource(() => api.getSlack().then((r) => r.slack));
  useServerEvents((ev) => {
    // New or retired crew members change the channel list.
    if (ev.type === "crew_changed") void slack.reload();
  });
  const s = slack.data;

  return (
    <div className="space-y-6">
      <ErrorText>{slack.error}</ErrorText>
      {slack.loading && !s && <Loading />}
      {s && (
        <StatusCard
          state={slackState(s)}
          error={s.error}
          connected={s.connected}
          busy={slack.loading}
          onReload={() => void slack.reload()}
        >
          {s.teamId && (
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              Workspace id: <span className="font-mono">{s.teamId}</span>
            </p>
          )}
        </StatusCard>
      )}
      {s && owner && <OwnerCard s={s} onChange={slack.setData} onReload={slack.reload} />}
      {s && admin && !owner && !s.configured && (
        <Card>
          <Muted>Only the owner can connect a Slack app.</Muted>
        </Card>
      )}
      {s?.configured && <ChannelsCard s={s} admin={admin} onChange={slack.setData} />}
      <LinkAccountCard
        app="Slack"
        field="slackUserId"
        configured={s?.configured ?? false}
        createLink={api.createSlackLink}
        unlink={api.unlinkSlack}
      />
    </div>
  );
}

function SetupSteps() {
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
        <li>
          At <ExternalLink href="https://api.slack.com/apps">api.slack.com/apps</ExternalLink>,
          choose Create New App → From a manifest, pick your workspace and paste the manifest below.
        </li>
        <li>
          Install the app to the workspace, then copy the <strong>Bot User OAuth Token</strong>{" "}
          (xoxb-…) from OAuth &amp; Permissions.
        </li>
        <li>
          Under Basic Information → App-Level Tokens, generate a token with the{" "}
          <code>connections:write</code> scope (xapp-…).
        </li>
        <li>Paste both tokens below and save. Socket Mode needs no public URL.</li>
        <li>
          Bind each crew member to a channel below. Public channels are joined automatically; invite
          the app to private ones first with <code>/invite @Shipmate</code>.
        </li>
      </ol>
      <CopyBlock label="App manifest (YAML)" value={SLACK_MANIFEST} />
    </div>
  );
}

function OwnerCard({
  s,
  onChange,
  onReload,
}: {
  s: SlackStatusDto;
  onChange: (s: SlackStatusDto) => void;
  onReload: () => Promise<void>;
}) {
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const bot = botToken.trim();
  const app = appToken.trim();
  const botInvalid = bot !== "" && !bot.startsWith("xoxb-");
  const appInvalid = app !== "" && !app.startsWith("xapp-");
  const changed = bot !== "" || app !== "";
  const anyStored = s.hasBotToken || s.hasAppToken;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!changed || botInvalid || appInvalid) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const body: { botToken?: string; appToken?: string } = {};
      if (bot) body.botToken = bot;
      if (app) body.appToken = app;
      const { slack } = await api.updateSlack(body);
      onChange(slack);
      setBotToken("");
      setAppToken("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Slack? The app goes offline and both tokens are forgotten."))
      return;
    setBusy("disconnect");
    setError(null);
    try {
      await api.disconnectSlack();
      await onReload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">App</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        One Slack app for this instance. Crew members post under their own names and icons. Only you
        (the owner) can change it.
      </p>
      {!s.configured && (
        <div className="mb-4">
          <SetupSteps />
        </div>
      )}
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={s.hasBotToken ? "Replace bot token" : "Bot token (xoxb-…)"}
            type="password"
            autoComplete="new-password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            hint={
              botInvalid ? (
                <span className="text-red-700 dark:text-red-300">
                  The bot token starts with xoxb-.
                </span>
              ) : s.hasBotToken ? (
                "A token is stored; leave blank to keep it."
              ) : (
                "OAuth & Permissions → Bot User OAuth Token."
              )
            }
          />
          <TextField
            label={s.hasAppToken ? "Replace app-level token" : "App-level token (xapp-…)"}
            type="password"
            autoComplete="new-password"
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            hint={
              appInvalid ? (
                <span className="text-red-700 dark:text-red-300">
                  The app-level token starts with xapp-.
                </span>
              ) : s.hasAppToken ? (
                "A token is stored; leave blank to keep it."
              ) : (
                "Basic Information → App-Level Tokens (connections:write)."
              )
            }
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy !== null || !changed || botInvalid || appInvalid}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {anyStored && (
            <Button variant="danger" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
          )}
          {saved && !changed && (
            <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
          )}
        </div>
      </form>
      {s.configured && (
        <details className="mt-4 text-sm">
          <summary className={cx("cursor-pointer rounded font-medium", focusRing)}>
            Setup checklist and manifest
          </summary>
          <div className="mt-2">
            <SetupSteps />
          </div>
        </details>
      )}
    </Card>
  );
}

function ChannelsCard({
  s,
  admin,
  onChange,
}: {
  s: SlackStatusDto;
  admin: boolean;
  onChange: (s: SlackStatusDto) => void;
}) {
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Channels</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Each crew member talks in its own channel. Direct messages to the app go to the Captain.
        {admin &&
          " To find a channel id, open the channel's details in Slack; the id (C…) is at the bottom."}
      </p>
      {s.channels.length === 0 ? (
        <Muted>No crew members to show.</Muted>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Crew member</th>
              <th className={th}>Channel</th>
              {admin && (
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {s.channels.map((c) => (
              <ChannelRow
                key={c.crewSlug}
                c={c}
                admin={admin}
                connected={s.connected}
                onChange={onChange}
              />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ChannelRow({
  c,
  admin,
  connected,
  onChange,
}: {
  c: SlackChannelDto;
  admin: boolean;
  connected: boolean;
  onChange: (s: SlackStatusDto) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bind(channelId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const { slack } = await api.bindSlackChannel(c.crewSlug, channelId);
      onChange(slack);
      setEditing(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const value = editing?.trim() ?? "";
  return (
    <tr>
      <td className={td}>
        <span className="font-medium">{c.crewName}</span>
      </td>
      <td className={td}>
        {editing !== null ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (isSlackChannelId(value)) void bind(value);
            }}
          >
            <label className="sr-only" htmlFor={`slack-bind-${c.crewSlug}`}>
              Channel id for {c.crewName}
            </label>
            <input
              id={`slack-bind-${c.crewSlug}`}
              value={editing}
              placeholder="C0123ABCD"
              autoCapitalize="characters"
              onChange={(e) => setEditing(e.target.value)}
              className={cx(
                "w-36 rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-900",
                focusRing,
              )}
            />
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={busy || !isSlackChannelId(value)}
            >
              Bind
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </form>
        ) : c.channelId ? (
          <span>
            #{c.channelName ?? c.channelId}
            {c.channelName && (
              <span className="ml-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                {c.channelId}
              </span>
            )}
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">not bound</span>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </td>
      {admin && (
        <td className={cx(td, "text-right whitespace-nowrap")}>
          {editing === null && (
            <span className="inline-flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !connected}
                title={connected ? undefined : "The app must be connected to bind a channel"}
                onClick={() => setEditing("")}
              >
                {c.channelId ? "Rebind" : "Bind"}
              </Button>
              {c.channelId && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Unbind ${c.crewName} from its channel?`)) void bind(null);
                  }}
                >
                  Unbind
                </Button>
              )}
            </span>
          )}
        </td>
      )}
    </tr>
  );
}
