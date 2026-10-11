import { type ReactNode, useEffect, useState } from "react";
import { isAdmin, useAuth, useUser } from "../auth.js";
import { BridgePage } from "../pages/Bridge.js";
import { CrewPage } from "../pages/Crew.js";
import { ProvidersPage } from "../pages/Providers.js";
import { SettingsPage } from "../pages/Settings.js";
import { UsagePage } from "../pages/Usage.js";
import { UsersPage } from "../pages/Users.js";
import { href, navigate, useRoute } from "../router.js";
import { socket, useSocketState } from "../ws.js";
import { Logo } from "./Logo.js";
import { cx, focusRing } from "./ui.js";

interface NavItem {
  path: string;
  label: string;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { path: "bridge", label: "Bridge" },
  { path: "crew", label: "Crew" },
  { path: "providers", label: "Providers" },
  { path: "usage", label: "Usage" },
  { path: "users", label: "Users", adminOnly: true },
  { path: "settings", label: "Settings" },
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
    <ul className="space-y-0.5">
      {NAV.filter((n) => !n.adminOnly || isAdmin(user)).map((n) => {
        const active = current === n.path;
        return (
          <li key={n.path}>
            <a
              href={href(`/${n.path}`)}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cx(
                "block rounded-md px-3 py-2 text-sm font-medium",
                focusRing,
                active
                  ? "bg-teal-700/10 text-teal-800 dark:bg-teal-400/10 dark:text-teal-200"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
              )}
            >
              {n.label}
            </a>
          </li>
        );
      })}
    </ul>
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
      <div className="flex items-center justify-between">
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
      className={cx("flex items-center gap-2 rounded text-teal-800 dark:text-teal-300", focusRing)}
    >
      <Logo />
      <span className="font-semibold tracking-tight">Shipmate</span>
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
    default:
      page = <NotFound />;
  }

  return (
    <div className="flex h-dvh flex-col bg-slate-50 text-slate-900 md:flex-row dark:bg-slate-950 dark:text-slate-100">
      {/* Top bar on narrow screens */}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5 md:hidden dark:border-slate-800 dark:bg-slate-900">
        <Brand />
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
      </header>

      {/* Drawer on narrow screens */}
      {drawer && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-slate-950/40"
            onClick={() => setDrawer(false)}
          />
          <nav
            aria-label="Main"
            className="absolute inset-y-0 left-0 flex w-64 flex-col bg-white shadow-xl dark:bg-slate-900"
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
        <UserBox />
      </nav>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{page}</main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="p-8 text-sm text-slate-500">
      Nothing here.{" "}
      <a className="text-teal-700 underline dark:text-teal-300" href={href("/bridge")}>
        Back to the Bridge
      </a>
    </div>
  );
}
