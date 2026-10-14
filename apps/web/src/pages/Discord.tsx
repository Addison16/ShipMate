import type { DiscordChannelDto, DiscordLinkCode, DiscordStatusDto } from "@shipmate/core";
import { type FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../api.js";
import { isAdmin, useAuth, useUser } from "../auth.js";
import {
  Badge,
  Button,
  Card,
  cx,
  ErrorText,
  focusRing,
  Loading,
  Muted,
  Page,
  PageHeader,
  Table,
  TextField,
  td,
  th,
} from "../components/ui.js";
import { discordState, formatCountdown, isSnowflake, secondsLeft } from "../lib/discord.js";
import { useResource } from "../lib/useResource.js";
import { useServerEvents } from "../ws.js";

export function DiscordPage() {
  return (
    <Page>
      <PageHeader
        icon="bridges"
        title="Discord"
        description="Talk to the crew from Discord: each crew member gets its own channel and posts under its own name."
      />
      <DiscordPanel />
    </Page>
  );
}

/** The Discord settings without the page frame (also a tab on the Chat bridges page). */
export function DiscordPanel() {
  const user = useUser();
  const admin = isAdmin(user);
  const owner = user.role === "owner";
  const discord = useResource(() => api.getDiscord().then((r) => r.discord));
  useServerEvents((ev) => {
    // New or retired crew members change the channel list.
    if (ev.type === "crew_changed") void discord.reload();
  });
  const d = discord.data;

  return (
    <div className="space-y-6">
      <ErrorText>{discord.error}</ErrorText>
      {discord.loading && !d && <Loading />}
      {d && <StatusCard d={d} onReload={() => void discord.reload()} busy={discord.loading} />}
      {d && owner && <OwnerCard d={d} onChange={discord.setData} onReload={discord.reload} />}
      {d && admin && !owner && !d.configured && (
        <Card>
          <Muted>Only the owner can connect a Discord bot.</Muted>
        </Card>
      )}
      {d?.configured && <ChannelsCard d={d} admin={admin} onChange={discord.setData} />}
      <LinkAccountCard configured={d?.configured ?? false} />
    </div>
  );
}

function StatusCard({
  d,
  onReload,
  busy,
}: {
  d: DiscordStatusDto;
  onReload: () => void;
  busy: boolean;
}) {
  const state = discordState(d);
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          Status <Badge tone={state.tone}>{state.label}</Badge>
        </h2>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onReload}>
          Refresh
        </Button>
      </div>
      <p className="text-sm">{state.detail}</p>
      {d.connected && d.error && (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">Last problem: {d.error}</p>
      )}
      {d.configured && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-slate-500 sm:grid-cols-2 dark:text-slate-400">
          <div className="flex gap-1.5">
            <dt>Server:</dt>
            <dd>{d.guildName ?? d.guildId ?? "not chosen"}</dd>
          </div>
          {d.applicationId && (
            <div className="flex gap-1.5">
              <dt>Application id:</dt>
              <dd className="font-mono">{d.applicationId}</dd>
            </div>
          )}
        </dl>
      )}
      {d.inviteUrl && (
        <div className="mt-4">
          <a
            href={d.inviteUrl}
            target="_blank"
            rel="noreferrer noopener"
            className={cx(
              "inline-flex items-center rounded-md bg-accent-700 px-3.5 py-2 text-sm font-medium text-white hover:bg-accent-800 dark:bg-accent-600 dark:hover:bg-accent-700",
              focusRing,
            )}
          >
            Add the bot to your server
          </a>
        </div>
      )}
    </Card>
  );
}

function SetupSteps() {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
      <li>
        Create an application at{" "}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-accent-800 underline underline-offset-2 dark:text-accent-300"
        >
          discord.com/developers
        </a>
        .
      </li>
      <li>Open Bot and add a bot to the application.</li>
      <li>
        Under Privileged Gateway Intents, turn on <strong>Message Content Intent</strong>.
      </li>
      <li>Reset and copy the bot token, paste it below and save.</li>
      <li>
        Use “Add the bot to your server” to invite it. Added it before? Invite it again, so the crew
        can post pictures.
      </li>
      <li>
        In Discord, turn on Developer Mode (Settings → Advanced), right-click your server, Copy
        Server ID, paste it below as the guild id and save.
      </li>
      <li>Press Sync to create a channel for each crew member.</li>
    </ol>
  );
}

function OwnerCard({
  d,
  onChange,
  onReload,
}: {
  d: DiscordStatusDto;
  onChange: (d: DiscordStatusDto) => void;
  onReload: () => Promise<void>;
}) {
  const [botToken, setBotToken] = useState("");
  const [guildId, setGuildId] = useState(d.guildId ?? "");
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setGuildId(d.guildId ?? "");
  }, [d.guildId]);

  const guild = guildId.trim();
  const guildInvalid = guild !== "" && !isSnowflake(guild);
  const changed = botToken.trim() !== "" || guild !== (d.guildId ?? "");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (guildInvalid || !changed) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const body: { botToken?: string; guildId?: string } = {};
      if (botToken.trim()) body.botToken = botToken.trim();
      if (guild !== (d.guildId ?? "")) body.guildId = guild;
      const { discord } = await api.updateDiscord(body);
      onChange(discord);
      setBotToken("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Disconnect Discord? The bot goes offline and its token is forgotten. Channels in your server are left as they are.",
      )
    )
      return;
    setBusy("disconnect");
    setError(null);
    try {
      await api.disconnectDiscord();
      await onReload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Bot</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        One Discord application for this instance. Only you (the owner) can change it.
      </p>
      {!d.configured && (
        <div className="mb-4">
          <SetupSteps />
        </div>
      )}
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={d.configured ? "Replace bot token" : "Bot token"}
            type="password"
            autoComplete="new-password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            hint={d.configured ? "A token is stored; leave blank to keep it." : undefined}
          />
          <TextField
            label="Server (guild) id"
            inputMode="numeric"
            autoComplete="off"
            value={guildId}
            onChange={(e) => setGuildId(e.target.value)}
            hint={
              guildInvalid ? (
                <span className="text-red-700 dark:text-red-300">
                  A server id is a long number, e.g. 123456789012345678.
                </span>
              ) : (
                "Right-click the server in Discord → Copy Server ID."
              )
            }
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={busy !== null || !changed || guildInvalid}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {d.configured && (
            <Button variant="danger" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
          )}
          {saved && !changed && (
            <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
          )}
        </div>
      </form>
      {d.configured && (
        <details className="mt-4 text-sm">
          <summary className={cx("cursor-pointer rounded font-medium", focusRing)}>
            Setup checklist
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
  d,
  admin,
  onChange,
}: {
  d: DiscordStatusDto;
  admin: boolean;
  onChange: (d: DiscordStatusDto) => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = d.channels.filter((c) => !c.channelId || !c.webhook).length;

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const { discord } = await api.syncDiscord();
      onChange(discord);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Channels</h2>
        {admin && (
          <Button
            size="sm"
            variant={missing > 0 ? "primary" : "secondary"}
            disabled={syncing || !d.connected}
            title={d.connected ? undefined : "The bot must be connected to sync"}
            onClick={() => void sync()}
          >
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        )}
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Each crew member talks in its own channel, through a webhook so it posts under its own name
        and avatar.
        {admin && " Sync creates any missing channels and webhooks in a “Shipmate” category."}
      </p>
      <ErrorText>{error}</ErrorText>
      {d.channels.length === 0 ? (
        <Muted>No crew members to show.</Muted>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Crew member</th>
              <th className={th}>Channel</th>
              <th className={th}>Webhook</th>
              {admin && (
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {d.channels.map((c) => (
              <ChannelRow key={c.crewSlug} c={c} admin={admin} onChange={onChange} />
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
  onChange,
}: {
  c: DiscordChannelDto;
  admin: boolean;
  onChange: (d: DiscordStatusDto) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bind(channelId: string | null) {
    setBusy(true);
    setError(null);
    try {
      const { discord } = await api.bindDiscordChannel(c.crewSlug, channelId);
      onChange(discord);
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
              if (isSnowflake(value)) void bind(value);
            }}
          >
            <label className="sr-only" htmlFor={`bind-${c.crewSlug}`}>
              Channel id for {c.crewName}
            </label>
            <input
              id={`bind-${c.crewSlug}`}
              value={editing}
              inputMode="numeric"
              placeholder="Channel id"
              onChange={(e) => setEditing(e.target.value)}
              className={cx(
                "w-44 rounded-md border border-control bg-white px-2 py-1 font-mono text-xs dark:bg-slate-900",
                focusRing,
              )}
            />
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={busy || !isSnowflake(value)}
            >
              Bind
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </form>
        ) : c.channelId ? (
          <span>#{c.channelName ?? c.channelId}</span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">not set up</span>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
      </td>
      <td className={td}>
        {c.webhook ? (
          <span className="text-emerald-700 dark:text-emerald-300">
            ✓<span className="sr-only">webhook ready</span>
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">
            –<span className="sr-only">no webhook</span>
          </span>
        )}
      </td>
      {admin && (
        <td className={cx(td, "text-right whitespace-nowrap")}>
          {editing === null && (
            <span className="inline-flex gap-1">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing("")}>
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

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function LinkAccountCard({ configured }: { configured: boolean }) {
  const user = useUser();
  const { setUser } = useAuth();
  const [code, setCode] = useState<DiscordLinkCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(code !== null);
  const live = code !== null && secondsLeft(code.expiresAt, now) > 0;
  const linked = user.discordUserId;

  // While a code is live, check every few seconds whether the link went through.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      api
        .me()
        .then((me) => {
          if (me.user?.discordUserId) {
            setUser(me.user);
            setCode(null);
          }
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [live, setUser]);

  async function getCode() {
    setBusy(true);
    setError(null);
    try {
      setCode(await api.createDiscordLink());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!window.confirm("Unlink your Discord account? Messages from it will no longer run."))
      return;
    setBusy(true);
    setError(null);
    try {
      await api.unlinkDiscord();
      setUser({ ...user, discordUserId: null });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-semibold">My Discord account</h2>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        Link your Discord account so messages you send there run as you. Messages from unlinked
        accounts are ignored.
      </p>
      {linked ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm">
            <Badge tone="ok">linked</Badge>{" "}
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{linked}</span>
          </p>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void unlink()}>
            Unlink
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {!configured && <Muted>Discord is not set up on this instance yet.</Muted>}
          {code && live ? (
            <div className="space-y-2 rounded-md border border-accent-200 bg-accent-50 p-3 dark:border-accent-900 dark:bg-accent-950/50">
              <p className="text-sm">
                Your code:{" "}
                <code className="rounded bg-white px-2 py-0.5 font-mono text-lg font-semibold tracking-widest dark:bg-slate-900">
                  {code.code}
                </code>
              </p>
              <p className="text-sm">{code.instructions}</p>
              <p className="text-xs text-slate-600 dark:text-slate-400" aria-live="off">
                Expires in {formatCountdown(code.expiresAt, now)}. This page updates once you are
                linked.
              </p>
            </div>
          ) : (
            code && <Muted>That code expired. Get a new one.</Muted>
          )}
          <Button
            variant={code && live ? "secondary" : "primary"}
            disabled={busy || !configured}
            onClick={() => void getCode()}
          >
            {busy ? "Getting a code…" : code && live ? "Get a new code" : "Get a link code"}
          </Button>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
    </Card>
  );
}
