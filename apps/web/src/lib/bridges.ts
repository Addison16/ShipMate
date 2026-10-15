import type { SlackStatusDto, TelegramStatusDto } from "@shipmate/core";

export type BridgeTab = "discord" | "telegram" | "slack";
export const BRIDGE_TABS: Array<{ id: BridgeTab; label: string }> = [
  { id: "discord", label: "Discord" },
  { id: "telegram", label: "Telegram" },
  { id: "slack", label: "Slack" },
];

export function bridgeTab(value: string | null | undefined): BridgeTab {
  return BRIDGE_TABS.find((t) => t.id === value)?.id ?? "discord";
}

interface State {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
  detail: string;
}

export function telegramState(t: TelegramStatusDto): State {
  if (!t.configured) {
    return {
      tone: "neutral",
      label: "not set up",
      detail: "No bot token is stored yet, so Shipmate is not on Telegram.",
    };
  }
  if (t.connected) {
    return {
      tone: "ok",
      label: "connected",
      detail: t.botUsername
        ? `Listening as @${t.botUsername}.`
        : "Listening for messages to the bot.",
    };
  }
  return {
    tone: t.error ? "danger" : "warn",
    label: "not connected",
    detail: t.error ?? "A bot token is stored, but the bot is not polling right now.",
  };
}

export function slackState(s: SlackStatusDto): State {
  if (!s.hasBotToken && !s.hasAppToken) {
    return {
      tone: "neutral",
      label: "not set up",
      detail: "No Slack tokens are stored yet, so Shipmate is not in Slack.",
    };
  }
  if (s.connected) {
    return {
      tone: "ok",
      label: "connected",
      detail: s.teamName ? `Connected to the "${s.teamName}" workspace.` : "Connected to Slack.",
    };
  }
  return {
    tone: s.error ? "danger" : "warn",
    label: "not connected",
    detail:
      s.error ??
      (s.configured
        ? "Both tokens are stored, but the app is not connected right now."
        : "Add both tokens to connect."),
  };
}

/** Telegram chat ids are integers; groups are negative (often -100…). */
export function isTelegramChatId(value: string): boolean {
  return /^-?\d{1,20}$/.test(value.trim());
}

/** Slack channel ids look like C0123ABCD (public) or G… (older private channels). */
export function isSlackChannelId(value: string): boolean {
  return /^[CG][A-Z0-9]{6,}$/.test(value.trim());
}

/** Paste into api.slack.com/apps → Create New App → From an app manifest. */
export const SLACK_MANIFEST = `display_information:
  name: Shipmate
  description: Talk to your Shipmate crew from Slack
features:
  bot_user:
    display_name: Shipmate
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  slash_commands:
    - command: /shipmate
      description: Link your Shipmate account
      usage_hint: link 123456
      should_escape: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:join
      - channels:read
      - chat:write
      - chat:write.customize
      - commands
      - files:write
      - groups:history
      - groups:read
      - im:history
      - reactions:write
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;
