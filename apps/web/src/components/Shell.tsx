import { type ReactNode, useEffect, useState } from "react";
import { useUpdateAppearance } from "../appearance.js";
import { ApprovalsProvider } from "../approvals.js";
import { isAdmin, useAuth, useUser } from "../auth.js";
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
import { type IconName, NavIcon } from "./icons.js";
import { Logo } from "./Logo.js";
import { Toasts } from "./Toasts.js";
import { cx, focusRing } from "./ui.js";

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
  adminOnly?: boolean;
}

const NAV: Array<{ group: string | null; items: NavItem[] }> = [
  {
    group: null,
    items: [
      { path: "bridge", label: "Bridge", icon: "bridge" },
      { path: "lists", label: "Lists", icon: "lists" },
      { path: "watches", label: "Watches", icon: "watches" },
      { path: "shipyard", label: "Shipyard", icon: "shipyard" },
    ],
  },
  {
    group: "Crew & tools",
    items: [
      { path: "crew", label: "Crew", icon: "crew" },
      { path: "skills", label: "Skills", icon: "skills" },
      { path: "mcp", label: "MCP servers", icon: "mcp" },
    ],
  },
  {
    group: "Manage",
    items: [
      { path: "providers", label: "Providers", icon: "providers" },
      { path: "usage", label: "Cost", icon: "cost" },
      { path: "audit", label: "Audit", icon: "audit" },
      { path: "users", label: "Users", icon: "users", adminOnly: true },
      { path: "bridges", label: "Chat bridges", icon: "bridges" },
      { path: "health", label: "Health", icon: "health", adminOnly: true },
      { path: "settings", label: "Settings", icon: "settings" },
    ],
  },
];

function SocketDot() {
  const state = useSocketState();
  const label =
    state === "open" ? "Live" : state === "connecting" ? "Connecting…" : "Offline, retrying";
  return (
    <span className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
      <span
        aria-hidden="true"
        className={cx(
          "size-2 rounded-full",
          state === "open"
            ? "bg-emerald-500"
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
  return (
    <div className="space-y-5">
      {NAV.map((g) => (
        <div key={g.group ?? "main"}>
          {g.group && (
            <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-accent-700 uppercase dark:text-accent-300">
              {g.group}
            </p>
          )}
          <NavList
            items={g.items.filter((n) => !n.adminOnly || isAdmin(user))}
            current={current}
            onNavigate={onNavigate}
          />
        </div>
      ))}
    </div>
  );
}

function NavList({
  items,
  current,
  onNavigate,
}: {
  items: NavItem[];
  current: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="space-y-0.5">
      {items.map((n) => {
        const active = current === n.path;
        return (
          <li key={n.path}>
            <a
              href={href(`/${n.path}`)}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx(
                "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                focusRing,
                active
                  ? "bg-accent-600 text-white shadow-sm dark:bg-accent-500/20 dark:text-accent-100"
                  : "text-slate-700 hover:bg-accent-50 hover:text-accent-800 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-accent-200",
              )}
            >
              <span
                className={cx(
                  !active &&
                    "text-slate-500 group-hover:text-accent-600 dark:text-slate-400 dark:group-hover:text-accent-300",
                )}
              >
                <NavIcon name={n.icon} />
              </span>
              {n.label}
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
      <span className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent-500 to-accent-700 text-white shadow-sm">
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
  const section = route[0] ?? "";

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
      page = <SettingsPage />;
      break;
    case "health":
      page = isAdmin(user) ? <HealthPage /> : <NotFound />;
      break;
    default:
      page = <NotFound />;
  }

  return (
    <ApprovalsProvider>
      <div className="flex h-dvh flex-col bg-slate-50 text-slate-900 md:flex-row dark:bg-slate-950 dark:text-slate-100">
        {/* Top bar on narrow screens */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 md:hidden dark:border-slate-800 dark:bg-slate-900">
          <Brand />
          <div className="flex items-center gap-2">
            <ApprovalTray variant="topbar" />
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
              className={cx("rounded-md p-2 hover:bg-slate-100 dark:hover:bg-slate-800", focusRing)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </button>
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
              className="slide-over-panel absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col bg-white shadow-xl dark:bg-slate-900"
            >
              <div className="flex items-center justify-between px-4 py-3">
                <Brand />
              </div>
              <div className="flex-1 overflow-y-auto px-2">
                <NavLinks current={section} onNavigate={() => setDrawer(false)} />
              </div>
              <UserBox />
            </nav>
          </div>
        )}

        {/* Sidebar on wide screens */}
        <nav
          aria-label="Main"
          className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="px-4 py-4">
            <Brand />
          </div>
          <div className="flex-1 overflow-y-auto px-2">
            <NavLinks current={section} />
          </div>
          <div className="px-2 pb-2">
            <ApprovalTray variant="sidebar" />
          </div>
          <UserBox />
        </nav>

        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">{page}</main>
        <Toasts />
      </div>
    </ApprovalsProvider>
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
