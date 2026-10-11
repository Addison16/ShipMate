import type { ReactNode } from "react";

/** Small 20px line icons for navigation and settings. Decorative; labels carry the meaning. */
function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {children}
    </svg>
  );
}

export type IconName =
  | "bridge"
  | "watches"
  | "lists"
  | "shipyard"
  | "crew"
  | "skills"
  | "mcp"
  | "providers"
  | "cost"
  | "audit"
  | "users"
  | "bridges"
  | "settings"
  | "light"
  | "dark"
  | "auto"
  | "check";

const paths: Record<IconName, ReactNode> = {
  // Speech bubble: talk to the crew.
  bridge: <path d="M4 5h16v11H9l-5 4V5z" />,
  // Bell for scheduled watches.
  watches: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  // Checklist.
  lists: (
    <>
      <path d="M4 6.5l1.5 1.5L8 5.5M4 12.5l1.5 1.5L8 11.5M4.5 18h3" />
      <path d="M11 7h9M11 13h9M11 18h9" />
    </>
  ),
  // Code brackets for the work section.
  shipyard: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
  crew: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" />
    </>
  ),
  // Open book.
  skills: (
    <>
      <path d="M12 6.5C10 5 7 4.5 3 5v13c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5z" />
      <path d="M12 6.5v13" />
    </>
  ),
  // Plug.
  mcp: (
    <>
      <path d="M9 3v4M15 3v4M6 7h12v3a6 6 0 0 1-12 0V7z" />
      <path d="M12 16v5" />
    </>
  ),
  // Stacked servers.
  providers: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.5" />
      <path d="M7.5 7.25h.01M7.5 16.75h.01" />
    </>
  ),
  // Coin.
  cost: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1.1 0-2-.4-2.5-1.2M12 6.5V8M12 16v1.5" />
    </>
  ),
  // Clipboard with lines.
  audit: (
    <>
      <path d="M9 4h6v3H9z" />
      <path d="M9 5.5H6v15h12v-15h-3M9 12h6M9 16h4" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  // Two bubbles: other chat apps.
  bridges: (
    <>
      <path d="M3 4h12v8H7l-4 3V4z" />
      <path d="M18 8h3v11l-4-3H9v-2" />
    </>
  ),
  // Sliders.
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  dark: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  // Laptop: follow the device.
  auto: (
    <>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2 19.5h20" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
};

export function NavIcon({ name, size }: { name: IconName; size?: number }) {
  return <Icon size={size}>{paths[name]}</Icon>;
}
