import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { clsx } from 'clsx';
import {
  Activity,
  BarChart3,
  Calculator,
  CalendarDays,
  ClipboardCheck,
  Mail,
  Bot,
  Building2,
  CircleDollarSign,
  Contact,
  Cpu,
  CreditCard,
  Eye,
  Images,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Factory,
  FileText,
  Megaphone,
  Palette,
  Bike,
  ListChecks,
  Store,
  Plug,
  ScrollText,
  Sparkles,
  Send,
  Settings,
  Terminal,
  UserPlus,
  UserRound,
  Users,
  Wallet,
  Headset,
  HeartPulse,
  RefreshCcw,
  HandCoins,
  FileSearch,
  Gem,
  Siren,
  FileSignature,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
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
import { Badge, Button, Field, Input, Loading, Modal } from '../components/ui';
import Tour from '../components/Tour';

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

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Módulo que la empresa debe tener (según su rubro) para ver el ítem */
  module?: string;
  end?: boolean;
  /** ancla para el tour de bienvenida */
  tour?: string;
  /** Número de pendientes (se pinta al lado) */
  badge?: number;
}

const PLATFORM_NAV: NavItem[] = [
  { to: '/platform', label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: '/platform/incidentes', label: 'Incidentes 24/7', icon: Siren },
  { to: '/platform/companies', label: 'Empresas', icon: Building2 },
  { to: '/platform/registros', label: 'Registros', icon: UserPlus },
  { to: '/platform/citas', label: 'Citas', icon: Headset },
  { to: '/platform/salud', label: 'Salud', icon: HeartPulse },
  { to: '/platform/ventas', label: 'Ventas', icon: Wallet },
  { to: '/platform/publicidad', label: 'Publicidad', icon: Megaphone },
  { to: '/platform/plans', label: 'Planes', icon: CircleDollarSign },
  { to: '/platform/personas', label: 'Personalidades', icon: Sparkles },
  { to: '/platform/models', label: 'Modelos IA', icon: Cpu },
  { to: '/platform/usage', label: 'Consumo IA', icon: Activity },
  { to: '/platform/users', label: 'Usuarios', icon: Users },
  { to: '/platform/emails', label: 'Correos', icon: Mail },
  { to: '/platform/terminos', label: 'Términos', icon: FileSignature },
  { to: '/platform/audit', label: 'Auditoría', icon: ScrollText },
  { to: '/platform/dev', label: 'Dev Tools', icon: Terminal },
];

const COMPANY_NAV: NavItem[] = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/inbox', label: 'Conversaciones', icon: Inbox, tour: 'nav-inbox' },
  { to: '/app/contacts', label: 'Contactos', icon: Contact },
  { to: '/app/campaigns', label: 'Campañas', icon: Send, module: 'campaigns' },
  { to: '/app/reactivacion', label: 'Reactivación', icon: RefreshCcw, module: 'reactivation' },
  { to: '/app/cobranza', label: 'Cobranza', icon: HandCoins, module: 'collections' },
  { to: '/app/auditor', label: 'Auditor de ventas', icon: FileSearch, module: 'salesAudit' },
  { to: '/app/agenda', label: 'Agenda', icon: CalendarDays, module: 'agenda' },
  { to: '/app/bots', label: 'Asistentes IA', icon: Bot },
  { to: '/app/automations', label: 'Automatizaciones', icon: Workflow, module: 'automations' },
  { to: '/app/integrations', label: 'Integraciones', icon: Plug },
  { to: '/app/media', label: 'Galería', icon: Images, module: 'media' },
  { to: '/app/analytics', label: 'Analytics', icon: BarChart3, module: 'analytics' },
  { to: '/app/usage', label: 'Consumo IA', icon: Activity, tour: 'nav-usage' },
  { to: '/app/costos-ia', label: 'Costos de IA', icon: Calculator },
  { to: '/app/gerencia', label: 'Gerencia', icon: ClipboardCheck, module: 'gerencia' },
  { to: '/app/mi-plan', label: 'Mi plan', icon: Gem },
  { to: '/app/billing', label: 'Facturación', icon: CreditCard },
  { to: '/app/team', label: 'Equipo', icon: UserRound },
  { to: '/app/settings', label: 'Configuración', icon: Settings, tour: 'nav-settings' },
];

/** Módulo de pedidos: solo aparece si la empresa lo tiene contratado. */
const ORDERS_NAV: NavItem[] = [
  { to: '/app/orders', label: 'Pedidos', icon: Package, end: true, tour: 'nav-orders' },
  { to: '/app/orders/reports', label: 'Reportes', icon: FileText, tour: 'nav-reports' },
  { to: '/app/customers', label: 'Clientes', icon: Store },
  { to: '/app/area', label: 'Vista por área', icon: Factory, module: 'production' },
];

/** Domicilios en vivo: con el módulo "delivery" o domicilios configurados. */
const DELIVERY_NAV: NavItem[] = [
  { to: '/app/deliveries', label: 'Domicilios', icon: Bike },
];

/** Marketing: extra por empresa (módulo "marketing"). */
const MARKETING_NAV: NavItem[] = [
  { to: '/app/marketing', label: 'Marketing', icon: Megaphone },
];

/** Creative: diseños, marca y calendario (incluido en todos los planes). */
const CREATIVE_NAV: NavItem[] = [
  { to: '/app/creative', label: 'Creative', icon: Palette },
];

/** Usuario de área de producción: SOLO ve su área. */
const AREA_NAV: NavItem[] = [
  { to: '/app/area', label: 'Mi área', icon: Factory, tour: 'nav-area' },
];

function NavSection({ title, items, tour }: { title: string; items: NavItem[]; tour?: string }) {
  return (
    <div className="mb-6" data-tour={tour}>
      <p className="kicker mb-2 px-3">{title}</p>
      <nav className="flex flex-col">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            data-tour={item.tour}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 border-l-2 px-3 py-2 text-[13px] font-medium transition-colors',
                isActive
                  ? 'border-ink bg-ink text-bone'
                  : 'border-transparent text-ink-2 hover:border-line hover:bg-bone-2 hover:text-ink',
              )
            }
          >
            <item.icon size={15} strokeWidth={2} />
            {item.label}
            {!!item.badge && (
              <span className="ml-auto min-w-5 bg-bad px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white" aria-label={`${item.badge} pendientes`}>
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
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
  const platformNav = PLATFORM_NAV.map((item) =>
    item.to === '/platform/registros' ? { ...item, badge: signupSummary?.pendingFollow }
      : item.to === '/platform/salud' ? { ...item, badge: (health?.crit ?? 0) + (health?.warn ?? 0) || undefined }
        : item,
  );
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
  // Nav según módulos contratados por la empresa activa
  const hasOrders = activeCompany?.modules?.includes('orders') ?? false;
  const hasMarketing = activeCompany?.modules?.includes('marketing') ?? false;
  const hasDelivery =
    (activeCompany?.modules?.includes('delivery') ?? false) || !!activeCompany?.orderConfig?.delivery?.enabled;
  // Cada rubro ve solo sus herramientas (los devs pueden prender módulos sueltos)
  const companyModules = activeCompany?.modules ?? [];
  const allowed = (item: NavItem) => !item.module || companyModules.includes(item.module);
  const onboarding = activeCompany?.status === 'ONBOARDING';
  const companyNav = [
    ...(onboarding ? [{ to: '/app/bienvenida', label: 'Primeros pasos', icon: ListChecks }] : []),
    ...COMPANY_NAV.slice(0, 2), // Dashboard, Conversaciones
    ...(hasOrders ? ORDERS_NAV : []),
    ...(hasDelivery ? DELIVERY_NAV : []),
    ...(hasMarketing ? MARKETING_NAV : []),
    ...CREATIVE_NAV,
    // Sin pedidos: catálogo/servicios, horario, conocimiento y pagos viven en "Mi negocio"
    ...(!hasOrders ? [{ to: '/app/orders/settings', label: 'Mi negocio', icon: Store }] : []),
    ...COMPANY_NAV.slice(2),
  ].filter(allowed);

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
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r-2 border-ink bg-bone transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
        <div className="flex items-start justify-between border-b-2 border-ink px-4 py-4">
          <div>
            <p className="display text-2xl leading-none">
              BackOffice<span className="text-ok">.</span>
            </p>
            <p className="kicker mt-1">Estudio de automatización con IA</p>
          </div>
          <button
            className="cursor-pointer border-2 border-ink p-1 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Cerrar menú"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-4">
          {isArea ? (
            <NavSection
              title={user?.company?.name ?? 'Mi empresa'}
              items={AREA_NAV}
            />
          ) : (
            <>
          {isPlatform && <NavSection title="Plataforma" items={platformNav} tour="nav-platform" />}

          {isPlatform && (
            <div className="mb-4 px-3" data-tour="company-picker">
              <p className="kicker mb-1">Panel de empresa</p>
              <select
                aria-label="Empresa activa"
                className="w-full cursor-pointer border-2 border-ink bg-paper px-2 py-1.5 text-xs font-semibold"
                value={companyId ?? ''}
                onChange={(e) => {
                  if (e.target.value) {
                    setCompanyId(e.target.value);
                    navigate('/app');
                  }
                }}
              >
                <option value="" disabled>
                  Elegir empresa…
                </option>
                {companies?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(!isPlatform || companyId) && (
            <NavSection
              title={
                isPlatform
                  ? `Viendo: ${activeCompany?.name ?? '…'}`
                  : (user?.company?.name ?? 'Mi empresa')
              }
              items={companyNav}
              tour="nav-company"
            />
          )}
            </>
          )}
        </div>

        {/* ─── Usuario ─── */}
        <div className="border-t-2 border-ink px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <div
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-ink bg-ink font-display text-sm text-bone"
            >
              {user?.name?.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold leading-tight">
                {user?.name}
              </p>
              <div className="mt-0.5 flex items-center gap-1">
                {user?.role === 'COMPANY_VIEWER' && <Eye size={10} className="text-ink-3" />}
                <p className="kicker !text-[9px]">{ROLE_LABELS[user?.role ?? '']}</p>
              </div>
            </div>
          </div>
          <button
            onClick={() => setChangingPassword(true)}
            className="mb-1.5 flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-line px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2 hover:border-ink hover:text-ink"
          >
            Seguridad de mi cuenta
          </button>
          <button
            onClick={logout}
            className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] hover:bg-ink hover:text-bone"
          >
            <LogOut size={12} /> Cerrar sesión
          </button>
        </div>
      </aside>

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
