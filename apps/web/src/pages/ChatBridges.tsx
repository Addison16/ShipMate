import { cx, focusRing, Page, PageHeader } from "../components/ui.js";
import { BRIDGE_TABS, bridgeTab } from "../lib/bridges.js";
import { href } from "../router.js";
import { DiscordPanel } from "./Discord.js";
import { SlackPanel } from "./Slack.js";
import { TelegramPanel } from "./Telegram.js";

/** Discord, Telegram and Slack, one tab each: talk to the crew from the chat app you use. */
export function ChatBridgesPage({ tab: tabParam }: { tab: string | null }) {
  const tab = bridgeTab(tabParam);
  return (
    <Page>
      <PageHeader
        title="Chat bridges"
        description="Talk to the crew from Discord, Telegram or Slack. Link your account on each one you use so messages run as you."
      />
      <div
        role="tablist"
        aria-label="Chat apps"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800"
      >
        {BRIDGE_TABS.map((t) => (
          <a
            key={t.id}
            role="tab"
            id={`bridge-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`bridge-panel-${t.id}`}
            href={href(`/bridges/${t.id}`)}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              focusRing,
              tab === t.id
                ? "border-accent-700 text-accent-800 dark:border-accent-400 dark:text-accent-200"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            {t.label}
          </a>
        ))}
      </div>
      <div role="tabpanel" id={`bridge-panel-${tab}`} aria-labelledby={`bridge-tab-${tab}`}>
        {tab === "discord" && <DiscordPanel />}
        {tab === "telegram" && <TelegramPanel />}
        {tab === "slack" && <SlackPanel />}
      </div>
    </Page>
  );
}
