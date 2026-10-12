import type { UserDto } from "@shipmate/core";
import type { IconName } from "../components/icons.js";

/** Who can see a destination: everyone, owners and admins, or the owner only. */
export type Access = "all" | "admin" | "owner";

export interface Destination {
  id: string;
  /** Hash path, e.g. "/bridge" or "/settings/appearance". */
  path: string;
  label: string;
  /** One plain line saying what is there; shown under the label and searched. */
  hint: string;
  icon: IconName;
  access: Access;
  /** Extra words people might type for this place (searched, never shown). */
  keywords: string[];
}

export interface SettingsSection extends Destination {
  group: SettingsGroup;
}

export type SettingsGroup = "You" | "Crew and tools" | "AI and cost" | "This Shipmate";

/** The everyday places: the whole sidebar besides Settings. */
export const MAIN_NAV: Destination[] = [
  {
    id: "bridge",
    path: "/bridge",
    label: "Bridge",
    hint: "Chat with your crew",
    icon: "bridge",
    access: "all",
    keywords: ["chat", "conversation", "message", "talk", "captain", "ask", "home"],
  },
  {
    id: "lists",
    path: "/lists",
    label: "Lists",
    hint: "Groceries, chores, bills",
    icon: "lists",
    access: "all",
    keywords: ["shopping", "todo", "to do", "tasks", "checklist", "grocery"],
  },
  {
    id: "watches",
    path: "/watches",
    label: "Watches",
    hint: "Scheduled jobs, briefings",
    icon: "watches",
    access: "all",
    keywords: ["schedule", "cron", "reminder", "recurring", "morning", "briefing", "timer"],
  },
  {
    id: "shipyard",
    path: "/shipyard",
    label: "Shipyard",
    hint: "GitHub projects",
    icon: "shipyard",
    access: "all",
    keywords: ["github", "code", "repo", "repository", "pull request", "pr", "issues", "work"],
  },
  {
    id: "crew",
    path: "/crew",
    label: "Crew",
    hint: "Your bots",
    icon: "crew",
    access: "all",
    keywords: ["bots", "agents", "members", "starter", "persona", "import", "export"],
  },
];

export const SETTINGS_HOME: Destination = {
  id: "settings",
  path: "/settings",
  label: "Settings",
  hint: "Models, apps, account",
  icon: "settings",
  access: "all",
  keywords: ["preferences", "options", "configure", "admin", "manage"],
};

/**
 * Every settings screen, grouped. Some live at their own older paths (#/providers, #/skills…)
 * so existing links keep working; they still show inside the Settings layout.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "profile",
    path: "/settings/profile",
    group: "You",
    label: "Profile and account",
    hint: "About you, your household, name and password",
    icon: "profile",
    access: "all",
    keywords: ["password", "email", "name", "household", "timezone", "diet", "about me", "account"],
  },
  {
    id: "appearance",
    path: "/settings/appearance",
    group: "You",
    label: "Appearance",
    hint: "Light or dark mode and color theme",
    icon: "palette",
    access: "all",
    keywords: ["theme", "dark mode", "light mode", "color", "colour", "look"],
  },
  {
    id: "notifications",
    path: "/settings/notifications",
    group: "You",
    label: "Notifications",
    hint: "Push alerts on this phone or computer",
    icon: "bell",
    access: "all",
    keywords: ["push", "alerts", "devices", "phone"],
  },
  {
    id: "skills",
    path: "/skills",
    group: "Crew and tools",
    label: "Skills",
    hint: "Know-how the crew can pick up",
    icon: "skills",
    access: "all",
    keywords: ["instructions", "playbook", "abilities"],
  },
  {
    id: "mcp",
    path: "/mcp",
    group: "Crew and tools",
    label: "MCP servers",
    hint: "Extra tools the crew can use",
    icon: "mcp",
    access: "all",
    keywords: ["tools", "integrations", "plugins", "catalog", "connectors"],
  },
  {
    id: "bridges",
    path: "/bridges",
    group: "Crew and tools",
    label: "Chat apps",
    hint: "Discord, Telegram and Slack",
    icon: "bridges",
    access: "all",
    keywords: ["discord", "telegram", "slack", "chat bridges", "webhook", "bot token"],
  },
  {
    id: "providers",
    path: "/providers",
    group: "AI and cost",
    label: "Models and providers",
    hint: "API keys, subscriptions and local models",
    icon: "providers",
    access: "all",
    keywords: [
      "model",
      "api key",
      "openai",
      "anthropic",
      "claude",
      "chatgpt",
      "ollama",
      "local",
      "llm",
      "sign in with chatgpt",
    ],
  },
  {
    id: "usage",
    path: "/usage",
    group: "AI and cost",
    label: "Cost and usage",
    hint: "Spending and tokens by person and bot",
    icon: "cost",
    access: "all",
    keywords: ["cost", "spend", "money", "tokens", "budget", "cap", "limit", "billing"],
  },
  {
    id: "general",
    path: "/settings/general",
    group: "This Shipmate",
    label: "General",
    hint: "Captain name, default model and setup guide",
    icon: "general",
    access: "all",
    keywords: ["captain", "coordinator", "default model", "setup", "onboarding", "instance"],
  },
  {
    id: "media",
    path: "/settings/media",
    group: "This Shipmate",
    label: "Photos and voice",
    hint: "Photo uploads, speech-to-text and read-aloud",
    icon: "camera",
    access: "all",
    keywords: ["photo", "image", "voice", "speech", "microphone", "tts", "stt", "whisper"],
  },
  {
    id: "sandbox",
    path: "/settings/sandbox",
    group: "This Shipmate",
    label: "Shipyard sandbox",
    hint: "Where the crew's code runs",
    icon: "sandbox",
    access: "owner",
    keywords: ["docker", "podman", "socket", "container", "tls"],
  },
  {
    id: "users",
    path: "/users",
    group: "This Shipmate",
    label: "Users",
    hint: "Invite people, roles and spending caps",
    icon: "users",
    access: "admin",
    keywords: ["people", "invite", "family", "members", "role", "admin", "cap"],
  },
  {
    id: "sign-in",
    path: "/settings/sign-in",
    group: "This Shipmate",
    label: "Single sign-on",
    hint: "Sign in with an OpenID Connect provider",
    icon: "key",
    access: "owner",
    keywords: ["oidc", "sso", "authentik", "authelia", "keycloak", "login"],
  },
  {
    id: "backups",
    path: "/settings/backups",
    group: "This Shipmate",
    label: "Backups",
    hint: "Back up now, download or restore",
    icon: "backup",
    access: "owner",
    keywords: ["backup", "restore", "export", "nightly", "download"],
  },
  {
    id: "audit",
    path: "/audit",
    group: "This Shipmate",
    label: "Audit log",
    hint: "Who did what, and when",
    icon: "audit",
    access: "all",
    keywords: ["history", "activity", "log", "events"],
  },
  {
    id: "health",
    path: "/health",
    group: "This Shipmate",
    label: "Health and updates",
    hint: "Status checks and one-click updates",
    icon: "health",
    access: "admin",
    keywords: ["status", "update", "upgrade", "version", "diagnostics", "web address"],
  },
];

export const SETTINGS_GROUPS: SettingsGroup[] = [
  "You",
  "Crew and tools",
  "AI and cost",
  "This Shipmate",
];

export function canSee(user: Pick<UserDto, "role">, access: Access): boolean {
  if (access === "all") return true;
  if (access === "owner") return user.role === "owner";
  return user.role === "owner" || user.role === "admin";
}

export function visibleSections(user: Pick<UserDto, "role">): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => canSee(user, s.access));
}

/** Older top-level paths that now live under Settings, and the section each one belongs to. */
const SETTINGS_ROUTES: Record<string, string> = {
  skills: "skills",
  mcp: "mcp",
  bridges: "bridges",
  discord: "bridges",
  providers: "providers",
  usage: "usage",
  users: "users",
  audit: "audit",
  health: "health",
};

/**
 * Which settings section a route shows, "" for the Settings overview, or null when the route is
 * not part of Settings at all.
 */
export function settingsSectionFor(route: string[]): string | null {
  const [first, second] = route;
  if (first === "settings") return second ?? "";
  return (first && SETTINGS_ROUTES[first]) ?? null;
}

/** Which main sidebar item to highlight for a route. */
export function activeNavId(route: string[]): string {
  if (settingsSectionFor(route) !== null) return SETTINGS_HOME.id;
  return route[0] || "bridge";
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Rank destinations for the quick-jump box. Every word typed must appear in the label, hint or
 * keywords; label matches rank first, then keyword matches, then hint matches.
 */
export function searchDestinations<T extends Destination>(items: T[], query: string): T[] {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return items;
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const label = normalize(item.label);
    const hint = normalize(item.hint);
    const keywords = item.keywords.map(normalize);
    let score = 0;
    for (const w of words) {
      if (label.startsWith(w) || label.includes(` ${w}`)) score += 6;
      else if (label.includes(w)) score += 4;
      else if (keywords.some((k) => k.startsWith(w) || k.includes(` ${w}`))) score += 3;
      else if (keywords.some((k) => k.includes(w))) score += 2;
      else if (hint.includes(w)) score += 1;
      else return;
    }
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
