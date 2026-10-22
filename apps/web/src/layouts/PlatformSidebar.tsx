import { clsx } from 'clsx';
import { Activity, BarChart3, Calculator, CalendarDays, ClipboardCheck, Mail, Bot, Building2, CircleDollarSign, Contact, Cpu, CreditCard, Eye, Images, Inbox, LayoutDashboard, LogOut, Package, Factory, FileText, Megaphone, Palette, ChartNoAxesCombined, FolderOpen, Lock, Bike, ListChecks, Store, Plug, ScrollText, Sparkles, Send, Settings, Terminal, UserPlus, UserRound, Users, Wallet, Headset, HeartPulse, RefreshCcw, HandCoins, FileSearch, Gem, Siren, FileSignature, Workflow, X } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { ROLE_LABELS } from '../lib/format';
import type { ProductKey } from '../lib/products';
import type { SidebarProps } from './Sidebar';

/**
 * Barra lateral del equipo BackOffice (SUPER_ADMIN / DEV), tal como estaba:
 * Plataforma, selector de empresa y el panel de la empresa elegida en una lista.
 * La navegación por producto (Sidebar) es solo para los usuarios de empresa.
 */

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
  /** Producto no activo: se ve atenuado y lleva a pedirlo */
  muted?: boolean;
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

/** BackOffice Creative: diseños, marca y calendario. */
const CREATIVE_NAV: NavItem[] = [
  { to: '/app/creative', label: 'Creative', icon: Palette },
];

/** BackOffice Ads Intelligence: publicidad pagada. */
const ADS_NAV: NavItem[] = [
  { to: '/app/ads', label: 'Publicidad', icon: ChartNoAxesCombined },
];

/** Biblioteca de recursos compartida por Creative y Ads Intelligence. */
const LIBRARY_NAV: NavItem[] = [
  { to: '/app/biblioteca', label: 'Biblioteca', icon: FolderOpen },
];

/** Cuenta: común a los tres productos. */
const ACCOUNT_PATHS = ['/app/usage', '/app/mi-plan', '/app/billing', '/app/team', '/app/settings'];

/** Usuario de área de producción: SOLO ve su área. */
const AREA_NAV: NavItem[] = [
  { to: '/app/area', label: 'Mi área', icon: Factory, tour: 'nav-area' },
];

function NavSection({ title, items, tour }: { title: string; items: NavItem[]; tour?: string }) {
  if (!items.length) return null;
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
                  : item.muted
                    ? 'border-transparent text-ink-3 hover:border-line hover:bg-bone-2 hover:text-ink-2'
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

export default function PlatformSidebar(p: SidebarProps & { userRole: string }) {
  const navigate = useNavigate();
  const { mobileOpen, companies, companyId } = p;
  const setMobileOpen = (v: boolean) => { if (!v) p.onCloseMobile(); };
  const setCompanyId = (id: string) => p.onPickCompany(id);
  const activeCompany = p.company;
  const isPlatform = true;
  const isArea = false;
  const user = { name: p.userName, role: p.userRole, company: { name: p.companyName } };
  const setChangingPassword = (_: boolean) => p.onSecurity();
  const logout = p.onLogout;
  const platformNav = PLATFORM_NAV.map((item) =>
    item.to === '/platform/registros' ? { ...item, badge: p.badges?.registros }
      : item.to === '/platform/salud' ? { ...item, badge: p.badges?.salud }
        : item,
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
  // Productos activos (el servidor también los exige; aquí solo se ordena el menú)
  const products = activeCompany?.products ?? [];
  const hasProduct = (k: ProductKey) => products.includes(k);
  const automationNav = hasProduct('AUTOMATION') ? [
    ...COMPANY_NAV.slice(0, 2), // Dashboard, Conversaciones
    ...(hasOrders ? ORDERS_NAV : []),
    ...(hasDelivery ? DELIVERY_NAV : []),
    // Sin pedidos: catálogo/servicios, horario, conocimiento y pagos viven en "Mi negocio"
    ...(!hasOrders ? [{ to: '/app/orders/settings', label: 'Mi negocio', icon: Store }] : []),
    ...COMPANY_NAV.slice(2).filter((i) => !ACCOUNT_PATHS.includes(i.to)),
  ].filter(allowed) : [];
  const creativeNav = hasProduct('CREATIVE') ? [...CREATIVE_NAV, ...(hasMarketing ? MARKETING_NAV : [])] : [];
  const adsNav = hasProduct('ADS') ? ADS_NAV : [];
  const libraryNav = hasProduct('CREATIVE') || hasProduct('ADS') ? LIBRARY_NAV : [];
  const accountNav = [
    ...(onboarding ? [{ to: '/app/bienvenida', label: 'Primeros pasos', icon: ListChecks }] : []),
    ...COMPANY_NAV.filter((i) => ACCOUNT_PATHS.includes(i.to)),
  ];
  const inactiveNav: NavItem[] = activeCompany
    ? (activeCompany.productStates ?? []).filter((p) => !p.enabled).map((p) => ({ to: `/app/producto/${p.key.toLowerCase()}`, label: p.short, icon: Lock, muted: true }))
    : [];

  return (
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
            <div data-tour="nav-company">
              <p className="kicker mb-3 px-3 !text-ink">
                {isPlatform ? `Viendo: ${activeCompany?.name ?? '…'}` : (user?.company?.name ?? 'Mi empresa')}
              </p>
              <NavSection title="Automation" items={automationNav} />
              <NavSection title="Creative" items={creativeNav} />
              <NavSection title="Ads Intelligence" items={adsNav} />
              <NavSection title="Recursos" items={libraryNav} />
              <NavSection title="Cuenta" items={accountNav} />
              <NavSection title="Otros productos" items={inactiveNav} />
            </div>
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
  );
}
