'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type User } from '@/lib/api';
import { clearIdentity, loadIdentity, saveIdentity, type StoredIdentity } from '@/lib/crypto/store';

interface AuthContextValue {
  user: User | null;
  identity: StoredIdentity | null;
  /** true until the stored session has been checked once */
  loading: boolean;
  signIn(user: User, identity: StoredIdentity): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const channel = useRef<BroadcastChannel | null>(null);

  const clear = useCallback(() => {
    setUser(null);
    setIdentity(null);
  }, []);

  useEffect(() => {
    channel.current = new BroadcastChannel('messenger-auth');
    channel.current.onmessage = () => {
      api.clearAccessToken();
      clear();
    };
    api.onSessionExpired = clear;

    (async () => {
      try {
        const stored = await loadIdentity();
        if (stored && (await api.refresh())) {
          setUser(await api.me());
          setIdentity(stored);
        } else if (stored) {
          await clearIdentity();
        }
      } catch {
        // the API is unreachable; the next sign-in attempt will surface that
      } finally {
        setLoading(false);
      }
    })();

    return () => {
      channel.current?.close();
      api.onSessionExpired = null;
    };
  }, [clear]);

  const signIn = useCallback(async (nextUser: User, nextIdentity: StoredIdentity) => {
    await saveIdentity(nextIdentity);
    setUser(nextUser);
    setIdentity(nextIdentity);
  }, []);

  const logout = useCallback(async () => {
    // local state goes regardless of whether the server heard about it
    await Promise.all([api.logout().catch(() => undefined), clearIdentity()]);
    channel.current?.postMessage('logout');
    clear();
  }, [clear]);

  const value = useMemo(() => ({ user, identity, loading, signIn, logout }), [user, identity, loading, signIn, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}
