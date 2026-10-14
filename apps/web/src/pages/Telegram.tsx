import type { CrewDto, TelegramStatusDto } from "@shipmate/core";
import { type FormEvent, useState } from "react";
import { api, errorMessage } from "../api.js";
import { useCrewName, useThemeText } from "../appearance.js";
import { isAdmin, useUser } from "../auth.js";
import { ExternalLink, LinkAccountCard, StatusCard } from "../components/BridgeParts.js";
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
import { isTelegramChatId, telegramState } from "../lib/bridges.js";
import { useResource } from "../lib/useResource.js";
import { useServerEvents } from "../ws.js";

/** The Telegram bridge settings (a tab on the Chat bridges page). */
export function TelegramPanel() {
  const user = useUser();
  const admin = isAdmin(user);
  const owner = user.role === "owner";
  const telegram = useResource(() => api.getTelegram().then((r) => r.telegram));
  const crew = useResource(() => api.listCrew().then((r) => r.crew));
  useServerEvents((ev) => {
    if (ev.type === "crew_changed") void crew.reload();
  });
  const t = telegram.data;

  return (
    <div className="space-y-6">
      <ErrorText>{telegram.error}</ErrorText>
      {telegram.loading && !t && <Loading />}
      {t && (
        <StatusCard
          state={telegramState(t)}
          error={t.error}
          connected={t.connected}
          busy={telegram.loading}
          onReload={() => void telegram.reload()}
        >
          {t.botUrl && (
            <p className="mt-3 text-sm">
              Open the bot: <ExternalLink href={t.botUrl}>{t.botUrl}</ExternalLink>
            </p>
          )}
        </StatusCard>
      )}
      {t && owner && <OwnerCard t={t} onChange={telegram.setData} onReload={telegram.reload} />}
      {t && admin && !owner && !t.configured && (
        <Card>
          <Muted>Only the owner can connect a Telegram bot.</Muted>
        </Card>
      )}
      {t?.configured && (
        <ChatsCard
          t={t}
          admin={admin}
          crew={crew.data ?? []}
          onChange={telegram.setData}
          onReload={() => void telegram.reload()}
        />
      )}
      <LinkAccountCard
        app="Telegram"
        field="telegramUserId"
        configured={t?.configured ?? false}
        createLink={api.createTelegramLink}
        unlink={api.unlinkTelegram}
      />
    </div>
  );
}

function SetupSteps() {
  const themeText = useThemeText();
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
      <li>
        In Telegram, open <ExternalLink href="https://t.me/BotFather">@BotFather</ExternalLink> and
        send <code>/newbot</code>. Pick a name and a username ending in “bot”.
      </li>
      <li>Copy the token BotFather sends back, paste it below and save.</li>
      <li>
        For group chats, send BotFather <code>/setprivacy</code>, choose the bot and pick{" "}
        <strong>Disable</strong>, so the bot sees every message in its groups (not only commands).
      </li>
      <li>
        Add the bot to a group, then write something there. The group shows up under “Chats the bot
        has seen” below; {themeText("connect it to a crew member.")}
      </li>
      <li>
        {themeText(
          "Direct messages to the bot go to the Captain. Shipmate polls Telegram for messages, so no public URL is needed.",
        )}
      </li>
    </ol>
  );
}

function OwnerCard({
  t,
  onChange,
  onReload,
}: {
  t: TelegramStatusDto;
  onChange: (t: TelegramStatusDto) => void;
  onReload: () => Promise<void>;
}) {
  const themeText = useThemeText();
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed = botToken.trim() !== "";

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!changed) return;
    setBusy("save");
    setError(null);
    setSaved(false);
    try {
      const { telegram } = await api.updateTelegram(botToken.trim());
      onChange(telegram);
      setBotToken("");
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect Telegram? The bot stops answering and its token is forgotten."))
      return;
    setBusy("disconnect");
    setError(null);
    try {
      await api.disconnectTelegram();
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
        {themeText(
          "One Telegram bot for this instance. A Telegram bot has one name, so each reply starts with the crew member who is speaking. Only you (the owner) can change it.",
        )}
      </p>
      {!t.configured && (
        <div className="mb-4">
          <SetupSteps />
        </div>
      )}
      <form onSubmit={save} className="space-y-4">
        <TextField
          label={t.configured ? "Replace bot token" : "Bot token"}
          type="password"
          autoComplete="new-password"
          value={botToken}
          onChange={(e) => setBotToken(e.target.value)}
          hint={
            t.configured
              ? "A token is stored; leave blank to keep it."
              : "Looks like 123456789:AAE… — it is stored encrypted."
          }
        />
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy !== null || !changed}>
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {t.configured && (
            <Button variant="danger" disabled={busy !== null} onClick={() => void disconnect()}>
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
          )}
          {saved && !changed && (
            <span className="text-sm text-emerald-700 dark:text-emerald-300">Saved</span>
          )}
        </div>
      </form>
      {t.configured && (
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

function CrewSelect({
  id,
  label,
  crew,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  crew: CrewDto[];
  value: string;
  onChange: (slug: string) => void;
  disabled?: boolean;
}) {
  const themeText = useThemeText();
  const crewName = useCrewName();
  const options = crew.filter((c) => c.status === "active");
  return (
    <>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cx(
          "rounded-md border border-control bg-white px-2 py-1 text-sm dark:bg-slate-900",
          focusRing,
        )}
      >
        {value === "" && <option value="">{themeText("Choose a crew member…")}</option>}
        {!options.some((c) => c.slug === value) && value !== "" && (
          <option value={value}>{value}</option>
        )}
        {options.map((c) => (
          <option key={c.slug} value={c.slug}>
            {crewName(c.name)}
          </option>
        ))}
      </select>
    </>
  );
}

function ChatsCard({
  t,
  admin,
  crew,
  onChange,
  onReload,
}: {
  t: TelegramStatusDto;
  admin: boolean;
  crew: CrewDto[];
  onChange: (t: TelegramStatusDto) => void;
  onReload: () => void;
}) {
  const themeText = useThemeText();
  const crewName = useCrewName();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [manualCrew, setManualCrew] = useState("");
  const [picks, setPicks] = useState<Record<string, string>>({});

  async function map(chatId: string, slug: string | null) {
    setBusy(chatId);
    setError(null);
    try {
      const { telegram } = await api.mapTelegramChat(chatId, slug);
      onChange(telegram);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const manual = manualId.trim();
  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Chats</h2>
        <Button size="sm" variant="ghost" onClick={onReload}>
          Refresh
        </Button>
      </div>
      <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
        {themeText(
          "Each Telegram chat (a group, or a direct message) is answered by one crew member. Direct messages that are not listed here go to the Captain.",
        )}
      </p>
      <ErrorText>{error}</ErrorText>
      {t.chats.length === 0 ? (
        <Muted>No chats are connected yet.</Muted>
      ) : (
        <Table>
          <thead>
            <tr>
              <th className={th}>Chat</th>
              <th className={th}>{themeText("Crew member")}</th>
              {admin && (
                <th className={th}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {t.chats.map((c) => (
              <tr key={c.chatId}>
                <td className={td}>
                  <span className="font-medium">{c.title ?? "Untitled chat"}</span>
                  <span className="ml-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {c.chatId}
                  </span>
                </td>
                <td className={td}>
                  {admin ? (
                    <CrewSelect
                      id={`tg-crew-${c.chatId}`}
                      label={`${themeText("Crew member")} for ${c.title ?? c.chatId}`}
                      crew={crew}
                      value={c.crewSlug}
                      disabled={busy !== null}
                      onChange={(slug) => void map(c.chatId, slug)}
                    />
                  ) : (
                    crewName(c.crewName)
                  )}
                </td>
                {admin && (
                  <td className={cx(td, "text-right")}>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm(`Disconnect “${c.title ?? c.chatId}” from the crew?`))
                          void map(c.chatId, null);
                      }}
                    >
                      Disconnect
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {admin && (
        <div className="mt-6 space-y-3">
          <h3 className="text-sm font-semibold">Chats the bot has seen</h3>
          {t.seenChats.length === 0 ? (
            <Muted>
              {t.connected
                ? "None yet. Add the bot to a group and write something there, then refresh."
                : "Connect the bot first."}
            </Muted>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              {t.seenChats.map((c) => {
                const pick = picks[c.chatId] ?? "";
                return (
                  <li key={c.chatId} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{c.title}</span>{" "}
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {c.kind === "private" ? "direct message" : c.kind}
                      </span>
                    </span>
                    <CrewSelect
                      id={`tg-seen-${c.chatId}`}
                      label={`${themeText("Crew member")} for ${c.title}`}
                      crew={crew}
                      value={pick}
                      onChange={(slug) => setPicks({ ...picks, [c.chatId]: slug })}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy !== null || !pick}
                      onClick={() => void map(c.chatId, pick)}
                    >
                      Connect
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!isTelegramChatId(manual) || !manualCrew) return;
              if (await map(manual, manualCrew)) setManualId("");
            }}
          >
            <TextField
              label="Or connect a chat by id"
              className="w-56"
              inputMode="numeric"
              placeholder="-1001234567890"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
            />
            <div className="pb-0.5">
              <CrewSelect
                id="tg-manual-crew"
                label={themeText("Crew member for that chat")}
                crew={crew}
                value={manualCrew}
                onChange={setManualCrew}
              />
            </div>
            <Button
              type="submit"
              disabled={busy !== null || !isTelegramChatId(manual) || !manualCrew}
            >
              Connect
            </Button>
          </form>
        </div>
      )}
    </Card>
  );
}
