import {
  type CustomThemeDto,
  type CustomThemeSpec,
  DEFAULT_THEME_WORDS,
  STOCK_CAPTAIN_NAME,
  type ThemeWordMap,
  themeWords,
  type UserPreferences,
} from "@shipmate/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ApiError, api, errorMessage } from "./api.js";
import { useAuth } from "./auth.js";
import {
  applyAppearance,
  type PaintedTheme,
  paintTheme,
  readCachedAppearance,
  readCachedTheme,
} from "./lib/theme.js";
import { useServerEvents } from "./ws.js";

function cached<T>(read: (s: Storage | null) => T): T {
  try {
    return read(localStorage);
  } catch {
    return read(null);
  }
}

interface ActiveTheme {
  /** The custom theme in use, or null for the standard Shipmate look. */
  theme: CustomThemeSpec | null;
  words: ThemeWordMap;
}

const ThemeContext = createContext<ActiveTheme>({ theme: null, words: DEFAULT_THEME_WORDS });

/** The custom theme in use (null for none) and the app's words for it. */
export const useActiveTheme = () => useContext(ThemeContext);
export const useThemeWords = () => useContext(ThemeContext).words;

/**
 * A crew member's display name as this person sees it: a coordinator still on the stock name
 * "Captain" goes by the theme's word for it ("Assistant", "CEO", "Professor").
 */
export function useCrewName(): (name: string) => string {
  const words = useThemeWords();
  return useCallback(
    (name: string) => (name === STOCK_CAPTAIN_NAME ? words.captain : name),
    [words],
  );
}

/**
 * Keeps <html> in step with the signed-in user's appearance and custom theme, and shares the
 * theme's words with the app. Signed out, the last applied one stays, so the sign-in page
 * matches. Auto follows the device as it switches.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { user, setUser, refresh } = useAuth();
  const [fallback] = useState(() => cached(readCachedAppearance));
  const prefs = user?.preferences ?? fallback;
  const { themeMode, colorTheme, customTheme, style } = prefs;
  const [painted, setPainted] = useState<PaintedTheme | null>(() => cached(readCachedTheme));
  const [reloads, setReloads] = useState(0);

  useServerEvents((ev) => {
    if (ev.type === "themes_changed") setReloads((n) => n + 1);
    if (ev.type === "preferences_changed" && user) {
      setUser({ ...user, preferences: ev.preferences });
    }
  });

  // Fetch the picked theme (and again when themes change); signed out, keep the cached one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads triggers a refetch
  useEffect(() => {
    if (!user) return;
    if (!customTheme) {
      setPainted(null);
      return;
    }
    let live = true;
    api
      .getTheme(customTheme)
      .then(({ theme }) => {
        if (live) setPainted(paintTheme(theme.id, theme));
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) {
          // Deleted (the server already cleared it from this person's preferences).
          setPainted(null);
          void refresh();
          return;
        }
        // The server is unreachable: the cached paint stays until we know more.
        setPainted((p) => (p?.id === customTheme ? p : null));
      });
    return () => {
      live = false;
    };
  }, [user?.id, customTheme, reloads]);

  const active = painted && painted.id === customTheme ? painted : null;

  useEffect(() => {
    const appearance = { themeMode, colorTheme, customTheme, style };
    applyAppearance(appearance, undefined, active);
    if (themeMode !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(appearance, media.matches, active);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode, colorTheme, customTheme, style, active]);

  const value = useMemo<ActiveTheme>(
    () => ({ theme: active?.theme ?? null, words: themeWords(active?.theme, style) }),
    [active, style],
  );

  useEffect(() => {
    document.title = value.words.appName;
  }, [value.words.appName]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Changes the signed-in user's appearance right away and saves it to their account. */
export function useUpdateAppearance() {
  const { user, setUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(
    async (patch: Partial<UserPreferences>) => {
      if (!user) return;
      setError(null);
      setUser({ ...user, preferences: { ...user.preferences, ...patch } });
      try {
        const res = await api.updatePreferences(patch);
        setUser(res.user);
      } catch (err) {
        setUser(user);
        setError(errorMessage(err));
      }
    },
    [user, setUser],
  );

  return { update, error };
}

/** The instance's custom themes, kept fresh as anyone saves or deletes one. */
export function useThemeList() {
  const [themes, setThemes] = useState<CustomThemeDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  useServerEvents((ev) => {
    if (ev.type === "themes_changed") setReloads((n) => n + 1);
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads triggers a refetch
  useEffect(() => {
    let live = true;
    api
      .listThemes()
      .then((r) => {
        if (live) {
          setThemes(r.themes);
          setError(null);
        }
      })
      .catch((err) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  return { themes, error, reload };
}
