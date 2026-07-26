import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as authApi from "../api/auth";
import { session, setUnauthorizedHandler } from "../api/client";
import type { User } from "../api/auth";

type AuthState = {
  user: User | null;
  accessToken: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => session.getAccess());
  const [loading, setLoading] = useState(true);

  const persist = useCallback((access: string, refreshToken: string, nextUser: User) => {
    session.set(access, refreshToken);
    setAccessToken(access);
    setUser(nextUser);
  }, []);

  const clear = useCallback(() => {
    session.clear();
    setAccessToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setAccessToken(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      const token = session.getAccess();
      if (!token) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const profile = await authApi.me(token);
        if (!cancelled) {
          setAccessToken(token);
          setUser(profile);
        }
      } catch {
        const refreshToken = session.getRefresh();
        if (refreshToken) {
          try {
            const renewed = await authApi.refresh(refreshToken);
            if (!cancelled) persist(renewed.accessToken, renewed.refreshToken, renewed.user);
          } catch {
            if (!cancelled) clear();
          }
        } else if (!cancelled) {
          clear();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
  }, [clear, persist]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await authApi.login(email, password);
      persist(res.accessToken, res.refreshToken, res.user);
    },
    [persist]
  );

  const logout = useCallback(async () => {
    const token = session.getAccess();
    try {
      if (token) await authApi.logout(token);
    } finally {
      clear();
    }
  }, [clear]);

  const value = useMemo(
    () => ({ user, accessToken, loading, login, logout }),
    [user, accessToken, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
