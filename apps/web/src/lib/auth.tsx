import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, getToken, setToken } from './api';
import type { AuthUser, Role } from './types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Devuelve el usuario, o el paso de verificación en dos pasos si la cuenta lo tiene activo. */
  login: (email: string, password: string) => Promise<AuthUser | { mfaToken: string }>;
  /** Segundo paso del login: código de la app o de recuperación. */
  verifyMfa: (mfaToken: string, code: string) => Promise<AuthUser>;
  /** Entra con una sesión ya emitida (registro por la web). */
  adopt: (token: string, user: AuthUser) => void;
  logout: () => void;
  /** Rol de plataforma (SUPER_ADMIN o DEV): acceso a todas las empresas. */
  isPlatform: boolean;
  /** Puede escribir (todo menos COMPANY_VIEWER). */
  canWrite: boolean;
  hasRole: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api
      .get<AuthUser>('/auth/me')
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ token: string; user: AuthUser } | { mfaRequired: true; mfaToken: string }>(
      '/auth/login',
      { email, password },
    );
    if ('mfaRequired' in res) return { mfaToken: res.mfaToken };
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const verifyMfa = useCallback(async (mfaToken: string, code: string) => {
    const res = await api.post<{ token: string; user: AuthUser }>('/auth/mfa/verify', { mfaToken, code });
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const adopt = useCallback((token: string, next: AuthUser) => {
    setToken(token);
    setUser(next);
  }, []);

  const logout = useCallback(() => {
    // Cierra la sesión también en el servidor: el token deja de servir aunque alguien lo haya copiado
    if (getToken()) void api.post('/auth/logout').catch(() => undefined);
    setToken(null);
    localStorage.removeItem('bo_company');
    setUser(null);
    window.location.href = '/login';
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const isPlatform = user?.role === 'SUPER_ADMIN' || user?.role === 'DEV';
    return {
      user,
      loading,
      login,
      verifyMfa,
      adopt,
      logout,
      isPlatform,
      canWrite: !!user && user.role !== 'COMPANY_VIEWER',
      hasRole: (...roles: Role[]) => !!user && roles.includes(user.role),
    };
  }, [user, loading, login, verifyMfa, adopt, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}

/**
 * Empresa activa para las vistas de panel de empresa.
 * Usuarios de empresa: siempre la suya. Roles de plataforma: la última
 * seleccionada (persistida) — les permite "entrar" al panel de cualquier tenant.
 */
export function useActiveCompanyId(): {
  companyId: string | null;
  setCompanyId: (id: string) => void;
} {
  const { user, isPlatform } = useAuth();
  const [selected, setSelected] = useState<string | null>(
    () => localStorage.getItem('bo_company'),
  );
  const setCompanyId = useCallback((id: string) => {
    localStorage.setItem('bo_company', id);
    setSelected(id);
  }, []);
  if (!isPlatform) return { companyId: user?.companyId ?? null, setCompanyId };
  return { companyId: selected, setCompanyId };
}

/** Sufijo ?companyId= para peticiones scoped cuando el usuario es de plataforma. */
export function companyQuery(companyId: string | null, prefix = '?'): string {
  return companyId ? `${prefix}companyId=${companyId}` : '';
}
