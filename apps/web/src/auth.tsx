import type { MeResponse, OnboardingDto, UserDto } from "@shipmate/core";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, errorMessage } from "./api.js";

interface AuthState {
  loading: boolean;
  error: string | null;
  user: UserDto | null;
  setupRequired: boolean;
  /** The owner's first-launch guide; null for everyone else. */
  onboarding: OnboardingDto | null;
}

interface AuthContextValue extends AuthState {
  /** Reload who is signed in; resolves to the server's answer, or null when it could not be read. */
  refresh: () => Promise<MeResponse | null>;
  setUser: (user: UserDto | null) => void;
  setOnboarding: (onboarding: OnboardingDto) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    loading: true,
    error: null,
    user: null,
    setupRequired: false,
    onboarding: null,
  });

  const refresh = useCallback(async (): Promise<MeResponse | null> => {
    try {
      const me = await api.me();
      setState({
        loading: false,
        error: null,
        user: me.user,
        setupRequired: me.setupRequired,
        onboarding: me.onboarding ?? null,
      });
      return me;
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: errorMessage(err) }));
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setUser = useCallback((user: UserDto | null) => {
    setState((s) => ({ ...s, user, setupRequired: user ? false : s.setupRequired }));
  }, []);

  const setOnboarding = useCallback((onboarding: OnboardingDto) => {
    setState((s) => ({ ...s, onboarding }));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setState((s) => ({ ...s, user: null, onboarding: null }));
    }
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, refresh, setUser, setOnboarding, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The signed-in user; only call inside the authenticated shell. */
export function useUser(): UserDto {
  const { user } = useAuth();
  if (!user) throw new Error("useUser without a signed-in user");
  return user;
}

export function isAdmin(user: UserDto): boolean {
  return user.role === "owner" || user.role === "admin";
}
