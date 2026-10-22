import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Eye, Menu, Siren, Zap } from 'lucide-react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, setToken } from '../lib/api';
import { TermsGate } from '../components/Terms';
import MfaSettings from '../components/MfaSettings';
import { useIncidents } from '../pages/platform/Incidents';
import { useActiveCompanyId, useAuth } from '../lib/auth';
import { useLiveEvents } from '../lib/events';
import { ROLE_LABELS } from '../lib/format';
import type { Company } from '../lib/types';
import { Button, Field, Input, Loading, Modal } from '../components/ui';
import Tour from '../components/Tour';
import Sidebar from './Sidebar';

function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () =>
      api.post<{ token?: string }>('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: (r) => {
      // Las demás sesiones se cerraron; esta sigue con el token nuevo
      if (r?.token) setToken(r.token);
      toast.success('Contraseña actualizada. Cerramos tus otras sesiones.');
      setCurrent('');
      setNext('');
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Mi cuenta" title="Seguridad de mi cuenta">
      <div className="space-y-4">
        <Field label="Contraseña actual" required>
          <Input type="password" autoComplete="current-password" value={current}
            onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nueva contraseña" hint="Mínimo 8 caracteres" required>
          <Input type="password" autoComplete="new-password" value={next}
            onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Button
          className="w-full"
          disabled={!current || next.length < 8 || change.isPending}
          onClick={() => change.mutate()}
        >
          {change.isPending ? 'Guardando…' : 'Actualizar contraseña'}
        </Button>
        <MfaSettings />
      </div>
    </Modal>
  );
}

export default function AppShell() {
  const { user, logout, isPlatform, hasRole } = useAuth();
  const { companyId, setCompanyId } = useActiveCompanyId();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  // Cerrar el menú móvil al navegar
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const isArea = user?.role === 'COMPANY_AREA';
  const isCourier = user?.role === 'COMPANY_COURIER';
  // Registros por la web: pendientes de contactar y aviso cuando entra uno nuevo
  const { data: signupSummary } = useQuery({
    queryKey: ['registros-summary'],
    queryFn: () => api.get<{ pendingFollow: number; latestDone: { id: string; name: string; at: string } | null }>('/onboarding/registros/summary'),
    enabled: !!isPlatform,
    refetchInterval: 60_000,
  });
  const { data: openIncidents } = useIncidents(!!isPlatform);
  const lastSeenSignup = useRef<string | null>(null);
  useEffect(() => {
    const latest = signupSummary?.latestDone;
    if (!latest) return;
    if (lastSeenSignup.current && lastSeenSignup.current !== latest.id) {
      toast.success(`Nueva empresa registrada: ${latest.name}`, {
        description: 'Escríbele para mostrarle cómo funciona y agendar una reunión.',
        action: { label: 'Ver', onClick: () => navigate('/platform/registros') },
        duration: 15_000,
      });
    }
    lastSeenSignup.current = latest.id;
  }, [signupSummary?.latestDone, navigate]);
  // Salud de la plataforma: cuántas alertas en amarillo o rojo hay en la última foto
  const { data: health } = useQuery({
    queryKey: ['health-summary'],
    queryFn: () => api.get<{ crit: number; warn: number }>('/platform/health/summary'),
    enabled: !!isPlatform,
    refetchInterval: 5 * 60_000,
  });
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
    enabled: !!user && !isArea && user.role !== 'COMPANY_COURIER', // usuarios de empresa reciben solo la suya
  });

  const activeCompany = isPlatform
    ? companies?.find((c) => c.id === companyId)
    : companies?.[0];

  // ─── Notificaciones en vivo (SSE): alertas que importan, estén donde estén ───
  const scopedCompanyId = isPlatform ? companyId : (user?.companyId ?? null);
  useLiveEvents(
    scopedCompanyId,
    (event) => {
      if (event.type === 'conversation.updated' && event.needsAttention) {
        toast.warning('Una conversación necesita atención humana', {
          id: `attn-${event.conversationId}`, // sin duplicados
          action: {
            label: 'Ver bandeja',
            onClick: () => navigate(`/app/inbox?open=${event.conversationId}`),
          },
        });
      }
      if (event.type === 'feedback.new') {
        toast.info('Un cliente respondió la encuesta de su pedido', {
          id: `fb-${event.orderId}`,
          action: {
            label: 'Ver pedido',
            onClick: () => navigate(`/app/orders/${event.orderId}`),
          },
        });
      }
      const e = event as typeof event & { level?: string; status?: string; minutes?: number; code?: string; matches?: boolean };
      if (e.type === 'ai.credits') {
        if (e.level === 'TOPUP') toast.success('Paquete de IA acreditado', { id: 'ai-credits' });
        else toast.warning(e.level === 'EMPTY' ? 'Se acabaron las conversaciones de IA: compra un paquete para seguir' : 'Te queda poco saldo de IA (menos del 20%)', {
          id: 'ai-credits',
          action: { label: 'Recargar', onClick: () => navigate('/app/usage') },
        });
      }
      if (e.type === 'delivery.delay') {
        toast.error(`Pedido #${e.code} va ${e.minutes} min tarde`, {
          id: `delay-${e.orderId}`,
          action: { label: 'Ver', onClick: () => navigate('/app/deliveries') },
        });
      }
      if (e.type === 'delivery.unassigned') {
        toast.warning(`Pedido #${e.code} listo hace ${e.minutes} min sin domiciliario`, {
          id: `unassigned-${e.orderId}`,
          action: { label: 'Asignar', onClick: () => navigate('/app/deliveries') },
        });
      }
      if (e.type === 'order.payment' && e.status) {
        const text = e.status === 'PAID' ? 'Pago confirmado' : e.status === 'REPORTED'
          ? (e.matches === false ? 'Comprobante recibido: el monto NO coincide' : 'Comprobante recibido: verifica el pago')
          : 'Pago fallido';
        toast[e.status === 'PAID' ? 'success' : e.status === 'FAILED' || e.matches === false ? 'error' : 'info'](text, {
          id: `pay-${e.orderId}-${e.status}`,
          action: { label: 'Ver pedido', onClick: () => navigate(`/app/orders/${e.orderId}`) },
        });
      }
      if (event.type === 'report.daily') {
        toast.info('El reporte diario está listo', {
          id: `rep-${event.at}`,
          action: { label: 'Abrirlo', onClick: () => navigate('/app/orders/reports') },
        });
      }
    },
    !!user && user.role !== 'COMPANY_AREA' && user.role !== 'COMPANY_COURIER' && !!scopedCompanyId,
  );
  // Pendientes de Publicidad en el menú (misma consulta que la pantalla: no se pide dos veces)
  const adsScope = isPlatform && companyId ? `?companyId=${companyId}` : '';
  const { data: adsOverview } = useQuery({
    queryKey: ['ads-overview', isPlatform && companyId ? `companyId=${companyId}` : '', undefined],
    queryFn: () => api.get<{ openFindings: number; pendingActions: number }>(`/ads/overview${adsScope}`),
    enabled: !!activeCompany?.products?.includes('ADS') && location.pathname.startsWith('/app'),
    retry: false,
    staleTime: 60_000,
  });
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('bo_nav_collapsed') === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((c) => {
    try { localStorage.setItem('bo_nav_collapsed', c ? '0' : '1'); } catch { /* sin almacenamiento */ }
    return !c;
  });
  const onboarding = activeCompany?.status === 'ONBOARDING';

  // El domiciliario tiene su propia app móvil, fuera del panel
  if (isCourier) return <Navigate to="/courier" replace />;

  return (
    <div className="flex min-h-screen">
      {/* ─── Overlay móvil ─── */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-ink/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden
        />
      )}

      {/* ─── Sidebar ─── */}
      <Sidebar
        isPlatform={!!isPlatform}
        isArea={isArea}
        company={activeCompany}
        companyName={isPlatform ? (activeCompany?.name ?? 'Sin empresa') : (user?.company?.name ?? activeCompany?.name ?? 'Mi empresa')}
        companies={companies}
        companyId={companyId}
        onPickCompany={(id) => { setCompanyId(id); navigate('/app'); }}
        badges={{
          registros: signupSummary?.pendingFollow,
          salud: (health?.crit ?? 0) + (health?.warn ?? 0) || undefined,
          adsFindings: adsOverview?.openFindings || undefined,
          adsPending: adsOverview?.pendingActions || undefined,
        }}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        userName={user?.name ?? ''}
        roleLabel={ROLE_LABELS[user?.role ?? ''] ?? ''}
        viewer={user?.role === 'COMPANY_VIEWER'}
        onSecurity={() => setChangingPassword(true)}
        onLogout={logout}
      />

      <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
      <Tour />

      {/* ─── Contenido ─── */}
      <div className="min-w-0 flex-1">
        {/* Barra superior móvil */}
        <div className="sticky top-0 z-20 flex items-center justify-between border-b-2 border-ink bg-bone px-4 py-2.5 lg:hidden">
          <button
            className="flex cursor-pointer items-center gap-2 border-2 border-ink px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em]"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menú"
          >
            <Menu size={14} /> Menú
          </button>
          <p className="display text-lg leading-none">
            BackOffice<span className="text-ok">.</span>
          </p>
        </div>
        {user?.role === 'COMPANY_VIEWER' && (
          <div className="flex items-center gap-2 border-b-2 border-ink bg-warn-soft px-6 py-1.5">
            <Eye size={12} className="text-warn" />
            <p className="kicker !text-warn">
              Modo visualización — sin permisos de edición
            </p>
          </div>
        )}
        {hasRole('DEV') && (
          <div className="flex items-center gap-2 border-b-2 border-ink bg-info-soft px-6 py-1.5">
            <Zap size={12} className="text-info" />
            <p className="kicker !text-info">Sesión de desarrollador</p>
          </div>
        )}
        {isPlatform && !!openIncidents?.open.length && location.pathname !== '/platform/incidentes' && (
          <NavLink to="/platform/incidentes" className="flex items-center gap-2 border-b-2 border-ink bg-bad px-4 py-2 text-xs font-semibold text-white md:px-6">
            <Siren size={13} />
            {openIncidents.open.length === 1 ? 'Hay 1 incidente abierto' : `Hay ${openIncidents.open.length} incidentes abiertos`}: {openIncidents.open[0].label}
            {openIncidents.open[0].companyId ? ` · ${openIncidents.open[0].companyName}` : ''}. Ver detalle
          </NavLink>
        )}
        {onboarding && !isPlatform && location.pathname !== '/app/bienvenida' && (
          <div className="border-b-2 border-ink bg-ink px-4 py-2 text-xs text-bone md:px-6">
            <span className="font-semibold uppercase tracking-[0.1em]">Tu empresa está en configuración.</span>{' '}
            Te escribimos por WhatsApp para dejarla lista.{' '}
            <NavLink to="/app/bienvenida" className="font-semibold underline">Ver primeros pasos</NavLink>
          </div>
        )}
        <main className="mx-auto max-w-[1400px] px-4 py-5 md:px-6 md:py-6">
          {/* El menú queda quieto mientras carga la pantalla siguiente */}
          <Suspense fallback={<Loading />}>
            <Outlet />
            <TermsGate />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
