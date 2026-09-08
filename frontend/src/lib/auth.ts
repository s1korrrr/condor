import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import { TOKEN_KEY, authHeaders } from "./auth-token";
import { queryClient } from "./queryClient";
import { fetchTailscaleLogin } from "./auth-login";

export interface User {
  id: number;
  username: string;
  first_name: string;
  role: string;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  loginWithToken: (loginToken: string) => Promise<void>;
  loginWithTailscale: () => Promise<boolean>;
  logout: () => void;
}

const USER_KEY = "condor_user";

/** Selected Hummingbot API server. Session state: cleared on logout. */
export const SERVER_KEY = "condor_selected_server";

export const AuthContext = createContext<AuthState>({
  user: null,
  token: null,
  isAuthenticated: false,
  loginWithToken: async () => {},
  loginWithTailscale: async () => false,
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthState(): AuthState {
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem(TOKEN_KEY),
  );
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  });

  const acceptSession = useCallback((data: { token: string; user: User }) => {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
  }, []);

  const loginWithTailscale = useCallback(async () => {
    const session = await fetchTailscaleLogin();
    if (!session) return false;
    acceptSession(session);
    return true;
  }, [acceptSession]);

  const loginWithToken = useCallback(async (loginToken: string) => {
    const res = await fetch("/api/v1/auth/token-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: loginToken }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || "Login failed");
    }
    const data = await res.json();
    acceptSession(data);
  }, [acceptSession]);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(SERVER_KEY);
    // Every cached response belongs to the session that fetched it. Logging out
    // is a pure client-side transition (no page reload), so without this the
    // next user to log in renders the previous user's portfolio, bots, API keys
    // and conversations straight from the cache.
    queryClient.clear();
    setToken(null);
    setUser(null);
  }, []);

  // Validate token on mount
  useEffect(() => {
    if (!token) return;
    fetch("/api/v1/auth/me", {
      headers: authHeaders(),
    }).then((res) => {
      if (!res.ok) {
        logout();
      }
    }).catch(() => {
      // server not available, keep token
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    user,
    token,
    isAuthenticated: !!token && !!user,
    loginWithToken,
    loginWithTailscale,
    logout,
  };
}
