import type { Principal, SignupRole } from '@inspectorone/shared';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setToken } from './api.js';

interface AuthState {
  principal: Principal | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  signup(input: {
    email: string;
    password: string;
    name: string;
    role: SignupRole;
    organizationName?: string;
  }): Promise<void>;
  acceptInvite(input: {
    token: string;
    name?: string;
    password?: string;
  }): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

interface SessionResponse {
  token: string;
  principal: Principal;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);

  // Resolve any stored token once at startup so a refresh keeps you signed in.
  useEffect(() => {
    let cancelled = false;
    api<{ principal: Principal }>('/api/auth/me')
      .then((r) => {
        if (!cancelled) setPrincipal(r.principal);
      })
      .catch(() => {
        if (!cancelled) setPrincipal(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const adopt = useCallback((res: SessionResponse) => {
    setToken(res.token);
    setPrincipal(res.principal);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      adopt(
        await api<SessionResponse>('/api/auth/login', {
          method: 'POST',
          body: { email, password },
        }),
      );
    },
    [adopt],
  );

  const signup = useCallback<AuthState['signup']>(
    async (input) => {
      adopt(
        await api<SessionResponse>('/api/auth/signup', {
          method: 'POST',
          body: input,
        }),
      );
    },
    [adopt],
  );

  const acceptInvite = useCallback<AuthState['acceptInvite']>(
    async (input) => {
      adopt(
        await api<SessionResponse>('/api/auth/invite/accept', {
          method: 'POST',
          body: input,
        }),
      );
    },
    [adopt],
  );

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      /* the local session goes either way */
    }
    setToken(null);
    setPrincipal(null);
  }, []);

  /** Re-read identity after joining an org, so navigation updates. */
  const refresh = useCallback(async () => {
    try {
      const r = await api<{ principal: Principal }>('/api/auth/me');
      setPrincipal(r.principal);
    } catch {
      setPrincipal(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ principal, loading, login, signup, acceptInvite, logout, refresh }),
    [principal, loading, login, signup, acceptInvite, logout, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
