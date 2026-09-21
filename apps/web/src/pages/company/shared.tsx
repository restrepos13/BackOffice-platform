import { useAuth, useActiveCompanyId } from '../../lib/auth';
import { EmptyState } from '../../components/ui';

/**
 * Scope de empresa para las páginas del panel de cliente.
 * Devuelve companyId activo y el query string para el API.
 */
export function useCompanyScope() {
  const { isPlatform, canWrite } = useAuth();
  const { companyId } = useActiveCompanyId();
  return {
    companyId,
    canWrite,
    isPlatform,
    q: isPlatform && companyId ? `companyId=${companyId}` : '',
    ready: !!companyId || !isPlatform,
  };
}

export function PickCompany() {
  return (
    <EmptyState
      title="Elige una empresa"
      hint="Selecciona una empresa en el menú lateral («Panel de empresa») para entrar a su panel."
    />
  );
}

/** Une el path con el query de scope. */
export function withScope(path: string, q: string): string {
  if (!q) return path;
  return path.includes('?') ? `${path}&${q}` : `${path}?${q}`;
}
