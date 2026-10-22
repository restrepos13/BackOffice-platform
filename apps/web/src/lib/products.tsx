import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from './api';
import { useActiveCompanyId, useAuth } from './auth';
import type { Company } from './types';
import { Badge, Button, Card, Loading, PageHeader } from '../components/ui';

/**
 * Las tres líneas de producto de BackOffice. El servidor exige el producto en
 * cada endpoint; aquí solo se decide qué mostrar y se explica lo que falta.
 */

export type ProductKey = 'AUTOMATION' | 'CREATIVE' | 'ADS';

export interface ProductState {
  key: ProductKey;
  name: string;
  short: string;
  home: string;
  summary: string;
  enabled: boolean;
  since?: string | null;
  until?: string | null;
  requestedAt?: string | null;
  requestedBy?: string | null;
}

export const PRODUCT_ORDER: ProductKey[] = ['AUTOMATION', 'CREATIVE', 'ADS'];

/** Lo que incluye cada producto (solo lo que existe hoy en el sistema). */
export const PRODUCT_INCLUDES: Record<ProductKey, string[]> = {
  AUTOMATION: [
    'Conversaciones de WhatsApp, Instagram y Messenger con asistente de IA y paso a una persona',
    'Contactos, embudos, agenda, pedidos y domicilios',
    'Campañas por WhatsApp, seguimientos, reactivación, cobranza y auditor de ventas',
    'Reportes de gerencia y analítica de la operación',
  ],
  CREATIVE: [
    'Identidad visual de tu marca',
    'Diseños editables por capas con propuestas de dirección de arte',
    'Revisión de calidad, adaptación a otros formatos y exportación',
    'Calendario de contenido orgánico (publicar requiere conectar tus redes)',
  ],
  ADS: [
    'Tus cuentas publicitarias de Meta en un solo lugar (Google y TikTok están en preparación)',
    'Métricas, comparaciones y oportunidades explicadas con su evidencia',
    'Reglas con aprobación: nada que gaste dinero se hace sin tu confirmación',
    'Biblioteca de imágenes y videos para tus anuncios, con o sin Creative',
  ],
};

/** Empresa activa del panel (la propia o la que eligió plataforma), con sus productos. */
export function useActiveCompany() {
  const { user, isPlatform } = useAuth();
  const { companyId } = useActiveCompanyId();
  const { data: companies, isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
    enabled: !!user && user.role !== 'COMPANY_AREA' && user.role !== 'COMPANY_COURIER',
  });
  const company = isPlatform ? companies?.find((c) => c.id === companyId) : companies?.[0];
  const products = (company?.products ?? []) as ProductKey[];
  return {
    company,
    loading: isLoading,
    products,
    states: (company?.productStates ?? []) as ProductState[],
    has: (key: ProductKey) => products.includes(key),
  };
}

/** Pantalla de un producto: si la empresa no lo tiene, explica y ofrece pedirlo. */
export function RequireProduct({ any, children }: { any: ProductKey[]; children: ReactNode }) {
  const { isPlatform, user } = useAuth();
  const { company, loading, has } = useActiveCompany();
  // Área y domiciliario no cargan la ficha de la empresa: su acceso lo decide el servidor
  if (user?.role === 'COMPANY_AREA' || user?.role === 'COMPANY_COURIER') return <>{children}</>;
  if (loading) return <Loading />;
  // Plataforma sin empresa elegida: la pantalla misma pide elegir una
  if (!company) return isPlatform ? <>{children}</> : <Loading />;
  if (any.some(has)) return <>{children}</>;
  return <ProductLocked product={any[0]} />;
}

/** Inicio del panel: Automation abre su tablero; si no lo tiene, va al primer producto que sí tenga. */
export function ProductHome({ children }: { children: ReactNode }) {
  const { isPlatform } = useAuth();
  const { company, loading, has, states } = useActiveCompany();
  if (loading) return <Loading />;
  if (!company) return isPlatform ? <>{children}</> : <Loading />;
  if (has('AUTOMATION')) return <>{children}</>;
  const first = states.find((s) => s.enabled);
  if (first) return <Navigate to={first.home} replace />;
  return <ProductLocked product="AUTOMATION" />;
}

export function ProductLocked({ product }: { product: ProductKey }) {
  const { isPlatform, user } = useAuth();
  const { company, states } = useActiveCompany();
  const qc = useQueryClient();
  const state = states.find((s) => s.key === product);
  const isAdmin = user?.role === 'COMPANY_ADMIN';
  // Empresa anterior a la separación por productos y sin plan: lo que le falta es elegir plan
  const needsPlan = !!company && !company.planId && !company.productsExplicit && product !== 'AUTOMATION';
  const ask = useMutation({
    mutationFn: () => api.post<{ already: string | null }>(`/products/${product}/request`),
    onSuccess: (r) => {
      toast.success(r.already === 'ACTIVE' ? 'Ya está activo' : 'Listo: le avisamos al equipo de BackOffice para activarlo');
      qc.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const name = state?.name ?? product;
  return (
    <div>
      <PageHeader kicker="Producto no activo" title={name} />
      <Card>
        <p className="max-w-2xl text-sm text-ink-2">{state?.summary}</p>
        <ul className="mt-4 max-w-2xl list-disc space-y-1 pl-5 text-sm text-ink-2">
          {PRODUCT_INCLUDES[product].map((x) => <li key={x}>{x}</li>)}
        </ul>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {isPlatform ? (
            company && <Link to={`/platform/companies/${company.id}`}><Button>Activarlo en la ficha de la empresa</Button></Link>
          ) : needsPlan ? (
            <Link to="/app/mi-plan"><Button>Elegir un plan</Button></Link>
          ) : state?.requestedAt ? (
            <Badge tone="info">Solicitud enviada · el equipo de BackOffice te contacta</Badge>
          ) : isAdmin ? (
            <Button onClick={() => ask.mutate()} disabled={ask.isPending}>{ask.isPending ? 'Enviando…' : 'Pedir que lo activen'}</Button>
          ) : (
            <p className="text-sm text-ink-3">Pídele a un administrador de tu empresa que lo solicite.</p>
          )}
        </div>
        <p className="mt-4 text-xs text-ink-3">Los demás productos que tienes activos siguen funcionando igual.</p>
      </Card>
    </div>
  );
}

/** /app/producto/:key — qué incluye un producto y cómo pedirlo (si ya está activo, va a su inicio). */
export function ProductPage() {
  const { key } = useParams();
  const { company, loading, states } = useActiveCompany();
  const k = String(key ?? '').toUpperCase() as ProductKey;
  if (!PRODUCT_ORDER.includes(k)) return <Navigate to="/app" replace />;
  if (loading || !company) return <Loading />;
  const state = states.find((s) => s.key === k);
  if (state?.enabled) return <Navigate to={state.home} replace />;
  return <ProductLocked product={k} />;
}
