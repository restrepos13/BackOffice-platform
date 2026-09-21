export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  DEV: 'DEV',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  COMPANY_VIEWER: 'COMPANY_VIEWER',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Roles con acceso al panel de plataforma (todas las empresas). */
export const PLATFORM_ROLES: Role[] = [ROLES.SUPER_ADMIN, ROLES.DEV];

/** Roles que pueden escribir dentro de una empresa. */
export const COMPANY_WRITE_ROLES: Role[] = [
  ROLES.SUPER_ADMIN,
  ROLES.DEV,
  ROLES.COMPANY_ADMIN,
];

export function isPlatformRole(role: string): boolean {
  return PLATFORM_ROLES.includes(role as Role);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  companyId: string | null;
}

/**
 * Resuelve el tenant sobre el que opera una petición:
 * roles de plataforma pueden pedir cualquier companyId; roles de empresa
 * quedan siempre restringidos a la suya.
 */
export function scopeCompanyId(
  user: AuthUser,
  requested?: string | null,
): string | undefined {
  if (isPlatformRole(user.role)) return requested ?? undefined;
  return user.companyId ?? '__none__';
}
