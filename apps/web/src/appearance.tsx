import type { UserPreferences } from "@shipmate/core";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "./api.js";
import { useAuth } from "./auth.js";
import { applyAppearance, readCachedAppearance } from "./lib/theme.js";

function cachedAppearance(): UserPreferences {
  try {
    return readCachedAppearance(localStorage);
  } catch {
    return readCachedAppearance(null);
  }
}

/**
 * Keeps <html> in step with the signed-in user's appearance. Signed out, the last applied one
 * stays, so the sign-in page matches. Auto follows the device as it switches.
 */
export function AppearanceSync() {
  const { user } = useAuth();
  const [fallback] = useState(cachedAppearance);
  const prefs = user?.preferences ?? fallback;
  const { themeMode, colorTheme } = prefs;

  useEffect(() => {
    const appearance = { themeMode, colorTheme };
    applyAppearance(appearance);
    if (themeMode !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(appearance, media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [themeMode, colorTheme]);

  return null;
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
