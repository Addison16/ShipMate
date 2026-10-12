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
  | "health"
  | "light"
  | "dark"
  | "auto"
  | "check"
  | "search"
  | "profile"
  | "palette"
  | "bell"
  | "general"
  | "camera"
  | "sandbox"
  | "key"
  | "backup"
  | "back"
  | "chevron"
  | "pencil"
  | "trash"
  | "pin";

const paths: Record<IconName, ReactNode> = {
  // Speech bubble: talk to the crew.
  bridge: <path d="M4 5h16v11H9l-5 4V5z" />,
  // Clock for scheduled watches.
  watches: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
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
  // Heartbeat line.
  health: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />,
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
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="9" r="3.5" />
      <path d="M6.5 18.5a6.5 6.5 0 0 1 11 0" />
      <circle cx="12" cy="12" r="9" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.4 1.6-1.4H17a3.5 3.5 0 0 0 3.5-3.5c0-4.3-3.8-7.8-8.5-7.8z" />
      <path d="M7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  // Ship's wheel: the instance itself.
  general: (
    <>
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.9 2.9M15.5 15.5l2.9 2.9M5.6 18.4l2.9-2.9M15.5 8.5l2.9-2.9" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8h3.5L9 5.5h6L16.5 8H20v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  // Shipping container: where code runs.
  sandbox: (
    <>
      <path d="M12 3l8.5 4.5v9L12 21l-8.5-4.5v-9L12 3z" />
      <path d="M3.5 7.5L12 12l8.5-4.5M12 12v9" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2" />
    </>
  ),
  backup: (
    <>
      <rect x="3.5" y="4" width="17" height="4.5" rx="1" />
      <path d="M5 8.5V20h14V8.5M10 12.5h4" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  pencil: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 7V4.5h4V7M6 7l1 13h10l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  pin: <path d="M15 3l6 6-3 1-3.5 3.5L15 18l-2 2-4-4-5 5M9 16l-4-4 2-2 4.5.5L13 6l2-3" />,
};

export function NavIcon({ name, size }: { name: IconName; size?: number }) {
  return <Icon size={size}>{paths[name]}</Icon>;
}
