import type { ReactNode } from "react";
import { useUser } from "../auth.js";
import { SETTINGS_GROUPS, visibleSections } from "../lib/nav.js";
import { href } from "../router.js";
import { NavIcon } from "./icons.js";
import { cx, focusRing } from "./ui.js";

/**
 * A settings screen with its neighbours one click away: a grouped list on wide screens, a
 * "Settings" back link on phones. The overview itself (#/settings) renders without it.
 */
export function SettingsLayout({ current, children }: { current: string; children: ReactNode }) {
  const user = useUser();
  const sections = visibleSections(user);
  return (
    <div className="flex min-h-full">
      <nav
        aria-label="Settings"
        className="sticky top-0 hidden max-h-dvh w-60 shrink-0 overflow-y-auto border-r border-slate-200 px-2 py-4 lg:block dark:border-slate-800"
      >
        <a
          href={href("/settings")}
          className={cx(
            "mb-3 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold text-slate-900 hover:text-accent-700 dark:text-white dark:hover:text-accent-300",
            focusRing,
          )}
        >
          Settings
        </a>
        <div className="space-y-4">
          {SETTINGS_GROUPS.map((group) => {
            const items = sections.filter((s) => s.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-slate-500 uppercase dark:text-slate-400">
                  {group}
                </p>
                <ul className="space-y-0.5">
                  {items.map((s) => {
                    const active = s.id === current;
                    return (
                      <li key={s.id}>
                        <a
                          href={href(s.path)}
                          aria-current={active ? "page" : undefined}
                          className={cx(
                            "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
                            focusRing,
                            active
                              ? "bg-accent-50 font-medium text-accent-800 dark:bg-accent-500/15 dark:text-accent-100"
                              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
                          )}
                        >
                          <span
                            className={cx(
                              active
                                ? "text-accent-600 dark:text-accent-300"
                                : "text-slate-500 dark:text-slate-400",
                            )}
                          >
                            <NavIcon name={s.icon} size={16} />
                          </span>
                          {s.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>
      <div className="min-w-0 flex-1">
        <div className="px-4 pt-4 sm:px-6 lg:hidden">
          <a
            href={href("/settings")}
            className={cx(
              "inline-flex items-center gap-1 rounded-md py-1 pr-2 text-sm font-medium text-accent-700 dark:text-accent-300",
              focusRing,
            )}
          >
            <NavIcon name="back" size={16} />
            Settings
          </a>
        </div>
        {children}
      </div>
    </div>
  );
}
