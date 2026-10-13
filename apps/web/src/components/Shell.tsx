import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useUpdateAppearance } from "../appearance.js";
import { ApprovalsProvider } from "../approvals.js";
import { isAdmin, useAuth, useUser } from "../auth.js";
import { activeNavId, canSee, MAIN_NAV, SETTINGS_HOME, settingsSectionFor } from "../lib/nav.js";
import { THEME_MODES } from "../lib/theme.js";
import { AuditPage } from "../pages/Audit.js";
import { BridgePage } from "../pages/Bridge.js";
import { ChatBridgesPage } from "../pages/ChatBridges.js";
import { CrewPage } from "../pages/Crew.js";
import { DiscordPage } from "../pages/Discord.js";
import { HealthPage } from "../pages/Health.js";
import { ListsPage } from "../pages/Lists.js";
import { McpPage } from "../pages/Mcp.js";
import { ProvidersPage } from "../pages/Providers.js";
import { SettingsPage } from "../pages/Settings.js";
import { ShipyardPage } from "../pages/Shipyard.js";
import { SkillsPage } from "../pages/Skills.js";
import { UsagePage } from "../pages/Usage.js";
import { UsersPage } from "../pages/Users.js";
import { WatchesPage } from "../pages/Watches.js";
import { href, navigate, useRoute } from "../router.js";
import { socket, useSocketState } from "../ws.js";
import { ApprovalTray } from "./ApprovalTray.js";
import { NavIcon } from "./icons.js";
import { Logo } from "./Logo.js";
import { QuickJump, QuickJumpButton, useQuickJumpShortcut } from "./QuickJump.js";
import { SettingsLayout } from "./SettingsLayout.js";
import { Toasts } from "./Toasts.js";
import { cx, focusRing } from "./ui.js";

function SocketDot() {
  const state = useSocketState();
  const label =
    state === "open" ? "Live" : state === "connecting" ? "Connecting…" : "Offline, retrying";
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <span
        aria-hidden="true"
        className={cx(
          "size-2 rounded-full transition-colors",
          state === "open"
            ? "animate-breathe bg-emerald-500"
            : state === "connecting"
              ? "bg-amber-400"
              : "bg-red-500",
        )}
      />
      {label}
    </span>
  );
}

function NavLinks({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  const user = useUser();
  const items = [...MAIN_NAV.filter((n) => canSee(user, n.access)), SETTINGS_HOME];
  return (
    <ul className="space-y-0.5">
      {items.map((n) => {
        const active = current === n.id;
        return (
          <li key={n.id}>
            <a
              href={href(n.path)}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx(
                "group flex items-center gap-3 rounded-lg px-3 py-2 transition-[background-color,color,box-shadow] duration-200",
                focusRing,
                active
                  ? "bg-accent-600 text-white shadow-sm dark:bg-accent-500/20 dark:text-accent-100"
                  : "text-slate-700 hover:bg-accent-50 active:bg-accent-100 hover:text-accent-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-accent-200",
              )}
            >
              <span
                className={cx(
                  "transition-transform duration-200 group-hover:scale-110",
                  !active &&
                    "text-slate-500 group-hover:text-accent-600 dark:text-slate-400 dark:group-hover:text-accent-300",
                )}
              >
                <NavIcon name={n.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{n.label}</span>
                <span
                  className={cx(
                    "block truncate text-xs",
                    active
                      ? "text-white/80 dark:text-accent-200/80"
                      : "text-slate-500 dark:text-slate-400",
                  )}
                >
                  {n.hint}
                </span>
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Light, Dark or Auto, one click away; color themes live in Settings. */
function ModeToggle() {
  const user = useUser();
  const { update } = useUpdateAppearance();
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
    >
      {THEME_MODES.map((m) => {
        const on = user.preferences.themeMode === m.id;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a styled segmented control, not native radios
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={on}
            title={m.id === "auto" ? "Auto (follow this device)" : m.label}
            onClick={() => void update({ themeMode: m.id })}
            className={cx(
              "flex items-center justify-center gap-1 rounded-md py-1 text-xs font-medium transition-colors",
              focusRing,
              on
                ? "bg-white text-accent-700 shadow-sm dark:bg-slate-950 dark:text-accent-300"
                : "text-slate-600 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100",
            )}
          >
            <NavIcon name={m.id} size={14} />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

function UserBox() {
  const user = useUser();
  const { logout } = useAuth();
  return (
    <div className="border-t border-slate-200 p-3 dark:border-slate-800">
      <div className="mb-2 min-w-0">
        <p className="truncate text-sm font-medium">{user.displayName}</p>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
          {user.email} · {user.role}
        </p>
      </div>
      <ModeToggle />
      <div className="mt-3 flex items-center justify-between">
        <SocketDot />
        <button
          type="button"
          onClick={() => void logout()}
          className={cx(
            "rounded px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
            focusRing,
          )}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <a
      href={href("/bridge")}
      className={cx(
        "flex items-center gap-2.5 rounded-lg text-slate-900 dark:text-white",
        focusRing,
      )}
    >
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-sm shadow-accent-900/20 transition-transform duration-300 ease-out hover:rotate-12">
        <Logo size={20} />
      </span>
      <span className="text-[17px] font-semibold tracking-tight">Shipmate</span>
    </a>
  );
}

export function Shell() {
  const route = useRoute();
  const user = useUser();
  const [drawer, setDrawer] = useState(false);
  const [jump, setJump] = useState(false);
  const section = route[0] ?? "";
  const settingsSection = settingsSectionFor(route);
  const openJump = useCallback(() => {
    setDrawer(false);
    setJump(true);
  }, []);
  useQuickJumpShortcut(openJump);

  useEffect(() => {
    socket.start();
    return () => socket.stop();
  }, []);

  useEffect(() => {
    if (!section) navigate("/bridge");
  }, [section]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  let page: ReactNode;
  switch (section) {
    case "":
    case "bridge":
      page = <BridgePage conversationId={route[1] ?? null} />;
      break;
    case "crew":
      page = <CrewPage slug={route[1] ?? null} />;
      break;
    case "lists":
      page = <ListsPage listId={route[1] ?? null} />;
      break;
    case "watches":
      page = (
        <WatchesPage
          watchId={route[1] ?? null}
          runId={route[2] === "runs" ? (route[3] ?? null) : null}
          edit={route[2] === "edit"}
        />
      );
      break;
    case "shipyard":
      page = <ShipyardPage projectId={route[1] ?? null} tab={route[2] ?? null} />;
      break;
    case "discord":
      page = <DiscordPage />;
      break;
    case "bridges":
      page = <ChatBridgesPage tab={route[1] ?? null} />;
      break;
    case "skills":
      page = <SkillsPage skillId={route[1] ?? null} />;
      break;
    case "mcp":
      page = <McpPage />;
      break;
    case "audit":
      page = <AuditPage />;
      break;
    case "providers":
      page = <ProvidersPage />;
      break;
    case "usage":
      page = <UsagePage />;
      break;
    case "users":
      page = isAdmin(user) ? <UsersPage /> : <NotFound />;
      break;
    case "settings":
      page = <SettingsPage section={route[1] ?? ""} />;
      break;
    case "health":
      page = isAdmin(user) ? <HealthPage /> : <NotFound />;
      break;
    default:
      page = <NotFound />;
  }
  // Settings screens other than the overview get the grouped settings list beside them.
  if (settingsSection) page = <SettingsLayout current={settingsSection}>{page}</SettingsLayout>;
  // Each place fades in when you arrive. Keyed by place, not by item, so moving between chats or
  // settings sections keeps the page (and its scroll) instead of replaying the animation.
  const pageKey = settingsSection ? "settings-section" : section;
  const activeNav = activeNavId(route);

  return (
    <ApprovalsProvider>
      <div className="flex h-dvh flex-col bg-slate-50 text-slate-900 md:flex-row dark:bg-slate-950 dark:text-slate-100">
        {/* Top bar on narrow screens */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 pt-[calc(0.625rem+env(safe-area-inset-top))] pb-2.5 md:hidden dark:border-slate-800 dark:bg-slate-900">
          {/* Menu on the left, the side it slides in from. */}
          <button
            type="button"
            aria-label="Open navigation"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
            className={cx(
              "-ml-2 rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800",
              focusRing,
            )}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Search"
              onClick={openJump}
              className={cx("rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800", focusRing)}
            >
              <NavIcon name="search" size={20} />
            </button>
            <ApprovalTray variant="topbar" />
            <div className="ml-1">
              <Brand />
            </div>
          </div>
        </header>

        {/* Drawer on narrow screens */}
        {drawer && (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="slide-over-backdrop absolute inset-0 bg-slate-950/40"
              onClick={() => setDrawer(false)}
            />
            <nav
              aria-label="Main"
              className="slide-over-panel absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col bg-white pt-[env(safe-area-inset-top)] pb-[var(--safe-bottom)] shadow-xl dark:bg-slate-900"
            >
              <div className="flex items-center justify-between px-4 py-3">
                <Brand />
              </div>
              <div className="relative flex-1 overflow-y-auto px-2">
                <NavLinks current={activeNav} onNavigate={() => setDrawer(false)} />
              </div>
              <UserBox />
            </nav>
          </div>
        )}

        {/* Sidebar on wide screens */}
        <nav
          aria-label="Main"
          className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="space-y-3 px-3 py-4">
            <div className="px-1">
              <Brand />
            </div>
            <QuickJumpButton onOpen={openJump} />
          </div>
          <div className="relative flex-1 overflow-y-auto px-2">
            <NavLinks current={activeNav} />
          </div>
          <div className="px-2 pb-2">
            <ApprovalTray variant="sidebar" />
          </div>
          <UserBox />
        </nav>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-accent-100/50 via-accent-50/20 to-transparent dark:from-accent-900/20 dark:via-accent-950/10"
          />
          <div key={pageKey} className="relative h-full animate-page-in">
            {page}
          </div>
        </main>
        {/* Thumb-reach tabs on phones; an open chat keeps the whole height for the composer. */}
        {!(section === "bridge" && route[1]) && <TabBar current={activeNav} />}
        {jump && <QuickJump onClose={() => setJump(false)} />}
        <Toasts />
      </div>
    </ApprovalsProvider>
  );
}

/** Bottom tabs on narrow screens for the everyday places; Settings stays in the menu. */
function TabBar({ current }: { current: string }) {
  const user = useUser();
  return (
    <nav
      aria-label="Quick"
      className="shrink-0 border-t border-slate-200 bg-white pb-[max(var(--safe-bottom),0.25rem)] md:hidden dark:border-slate-800 dark:bg-slate-900"
    >
      <ul className="flex">
        {MAIN_NAV.filter((n) => canSee(user, n.access)).map((n) => {
          const active = current === n.id;
          return (
            <li key={n.id} className="flex-1">
              <a
                href={href(n.path)}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
                  focusRing,
                  active
                    ? "text-accent-700 dark:text-accent-300"
                    : "text-slate-600 dark:text-slate-400",
                )}
              >
                <span
                  className={cx(
                    "grid h-7 w-12 place-items-center rounded-full",
                    active && "bg-accent-100 dark:bg-accent-500/20",
                  )}
                >
                  <NavIcon name={n.icon} size={20} />
                </span>
                {n.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function NotFound() {
  return (
    <div className="p-8 text-sm text-slate-500">
      Nothing here.{" "}
      <a className="text-accent-700 underline dark:text-accent-300" href={href("/bridge")}>
        Back to the Bridge
      </a>
    </div>
  );
}
