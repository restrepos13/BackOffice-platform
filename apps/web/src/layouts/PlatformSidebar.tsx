import { clsx } from 'clsx';
import {
  Activity, BarChart3, Bike, Bot, Building2, Calculator, CalendarDays, ChartNoAxesCombined, ChevronDown, CircleDollarSign,
  ClipboardCheck, Contact, Cpu, CreditCard, Eye, Factory, FileSearch, FileSignature, FileText, FolderOpen, Gem, HandCoins,
  Headset, HeartPulse, Images, Inbox, LayoutDashboard, ListChecks, LogOut, Mail, Megaphone, Package, Palette, Plug,
  RefreshCcw, ScrollText, Send, Settings, Siren, Sparkles, Store, Terminal, UserPlus, UserRound, Users, Wallet, Workflow, X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import type { SidebarProps } from './Sidebar';

/**
 * Barra del equipo BackOffice (SUPER_ADMIN / DEV). Pensada para operar y dar
 * soporte, no es la del cliente:
 *  1. Plataforma: secciones plegables por tarea (qué atender hoy, clientes y
 *     ventas, oferta, control y desarrollo).
 *  2. Empresa: se elige una, se ve su ficha (estado y productos) y su panel en
 *     bloques plegables por producto. Se abre solo el bloque en el que estás.
 * Lo plegado se recuerda en el navegador.
 */

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Sección del rubro que la empresa debe tener (Company.modules) */
  module?: string;
  end?: boolean;
  tour?: string;
  badge?: number;
}

interface Section {
  id: string;
  title: string;
  /** Ayuda corta: para qué sirve la sección */
  hint: string;
  items: Item[];
  /** Ruta que, si estás en ella, abre la sección */
  owns?: (path: string) => boolean;
  /** Producto que la empresa debe tener; si no lo tiene se muestra como no activo */
  product?: 'AUTOMATION' | 'CREATIVE' | 'ADS';
}

const OPEN_KEY = 'bo_dev_nav_open_v2';

export function platformSections(badges: { registros?: number; salud?: number } = {}): Section[] {
  return [
    {
      id: 'hoy', title: 'Atender hoy', hint: 'Lo urgente y el estado de todo',
      items: [
        { to: '/platform', label: 'Resumen', icon: LayoutDashboard, end: true },
        { to: '/platform/incidentes', label: 'Incidentes 24/7', icon: Siren },
        { to: '/platform/salud', label: 'Salud', icon: HeartPulse, badge: badges.salud },
      ],
    },
    {
      id: 'clientes', title: 'Clientes y ventas', hint: 'Empresas, registros nuevos y cobros',
      items: [
        { to: '/platform/companies', label: 'Empresas', icon: Building2 },
        { to: '/platform/registros', label: 'Registros', icon: UserPlus, badge: badges.registros },
        { to: '/platform/citas', label: 'Citas', icon: Headset },
        { to: '/platform/ventas', label: 'Ventas', icon: Wallet },
        { to: '/platform/emails', label: 'Correos', icon: Mail },
      ],
    },
    {
      id: 'oferta', title: 'Oferta e IA', hint: 'Lo que vendemos y cómo responde la IA',
      items: [
        { to: '/platform/plans', label: 'Planes', icon: CircleDollarSign },
        { to: '/platform/personas', label: 'Personalidades', icon: Sparkles },
        { to: '/platform/models', label: 'Modelos IA', icon: Cpu },
        { to: '/platform/usage', label: 'Consumo IA', icon: Activity },
        { to: '/platform/terminos', label: 'Términos', icon: FileSignature },
        { to: '/platform/publicidad', label: 'Publicidad de BackOffice', icon: Megaphone },
      ],
    },
    {
      id: 'control', title: 'Control', hint: 'Quién entra y qué se hizo',
      items: [
        { to: '/platform/users', label: 'Usuarios', icon: Users },
        { to: '/platform/audit', label: 'Auditoría', icon: ScrollText },
        { to: '/platform/dev', label: 'Dev Tools', icon: Terminal },
      ],
    },
  ];
}

const CREATIVE_PATHS = ['/app/creative', '/app/marketing'];
const ACCOUNT_PATHS = ['/app/settings', '/app/team', '/app/mi-plan', '/app/billing', '/app/usage', '/app/bienvenida'];
const starts = (path: string, prefixes: string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));

/** El panel de la empresa elegida, en bloques por producto (lo que la empresa no tiene no se lista). */
export function companySections(company: { modules?: string[]; status?: string; orderConfig?: Record<string, any> }): Section[] {
  const modules = company.modules ?? [];
  const hasOrders = modules.includes('orders');
  const hasDelivery = modules.includes('delivery') || !!company.orderConfig?.delivery?.enabled;
  const sections: Section[] = [
    {
      id: 'automation', title: 'Automation', hint: 'Bandeja, asistentes, ventas y operación', product: 'AUTOMATION',
      owns: (p) => p.startsWith('/app') && !starts(p, [...CREATIVE_PATHS, '/app/ads', '/app/biblioteca', '/app/producto', ...ACCOUNT_PATHS]),
      items: [
        { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
        { to: '/app/inbox', label: 'Conversaciones', icon: Inbox, tour: 'nav-inbox' },
        { to: '/app/contacts', label: 'Contactos', icon: Contact },
        { to: '/app/bots', label: 'Asistentes IA', icon: Bot },
        { to: '/app/automations', label: 'Automatizaciones', icon: Workflow, module: 'automations' },
        { to: '/app/integrations', label: 'Integraciones', icon: Plug },
        { to: '/app/oportunidades', label: 'Oportunidades', icon: FileSearch },
        { to: '/app/campaigns', label: 'Campañas', icon: Send, module: 'campaigns' },
        { to: '/app/reactivacion', label: 'Reactivación', icon: RefreshCcw, module: 'reactivation' },
        { to: '/app/cobranza', label: 'Cobranza', icon: HandCoins, module: 'collections' },
        { to: '/app/auditor', label: 'Auditor de ventas', icon: FileSearch, module: 'salesAudit' },
        ...(hasOrders ? [
          { to: '/app/orders', label: 'Pedidos', icon: Package, end: true, tour: 'nav-orders' },
          { to: '/app/orders/reports', label: 'Reportes', icon: FileText, tour: 'nav-reports' },
          { to: '/app/customers', label: 'Clientes', icon: Store },
          { to: '/app/area', label: 'Vista por área', icon: Factory, module: 'production' },
        ] : []),
        ...(hasDelivery ? [{ to: '/app/deliveries', label: 'Domicilios', icon: Bike }] : []),
        { to: '/app/agenda', label: 'Agenda', icon: CalendarDays, module: 'agenda' },
        { to: '/app/media', label: 'Galería', icon: Images, module: 'media' },
        { to: '/app/analytics', label: 'Analytics', icon: BarChart3, module: 'analytics' },
        { to: '/app/gerencia', label: 'Gerencia', icon: ClipboardCheck, module: 'gerencia' },
        { to: '/app/costos-ia', label: 'Costos de IA', icon: Calculator },
        { to: '/app/orders/settings', label: hasOrders ? 'Ajustes de pedidos' : 'Mi negocio', icon: Store },
      ],
    },
    {
      id: 'creative', title: 'Creative', hint: 'Diseños, marca y calendario', product: 'CREATIVE',
      owns: (p) => starts(p, CREATIVE_PATHS),
      items: [
        { to: '/app/creative', label: 'Creative', icon: Palette },
        { to: '/app/marketing', label: 'Marketing', icon: Megaphone, module: 'marketing' },
      ],
    },
    {
      id: 'ads', title: 'Ads Intelligence', hint: 'Cuentas, campañas y resultados', product: 'ADS',
      owns: (p) => starts(p, ['/app/ads']),
      items: [{ to: '/app/ads', label: 'Publicidad', icon: ChartNoAxesCombined }],
    },
    {
      id: 'recursos', title: 'Biblioteca', hint: 'Imágenes y videos de Creative y Ads',
      owns: (p) => starts(p, ['/app/biblioteca']),
      items: [{ to: '/app/biblioteca', label: 'Biblioteca', icon: FolderOpen }],
    },
    {
      id: 'cuenta', title: 'Cuenta de la empresa', hint: 'Plan, cobro, equipo y ajustes',
      owns: (p) => starts(p, ACCOUNT_PATHS),
      items: [
        ...(company.status === 'ONBOARDING' ? [{ to: '/app/bienvenida', label: 'Primeros pasos', icon: ListChecks }] : []),
        { to: '/app/settings', label: 'Configuración', icon: Settings, tour: 'nav-settings' },
        { to: '/app/team', label: 'Equipo', icon: UserRound },
        { to: '/app/mi-plan', label: 'Mi plan', icon: Gem },
        { to: '/app/billing', label: 'Facturación', icon: CreditCard },
        { to: '/app/usage', label: 'Consumo IA', icon: Activity, tour: 'nav-usage' },
      ],
    },
  ];
  return sections.map((s) => ({ ...s, items: s.items.filter((i) => !i.module || modules.includes(i.module)) }));
}

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}');
  } catch {
    return {};
  }
}

const STATUS_LABEL: Record<string, string> = { TRIAL: 'Prueba', ONBOARDING: 'En configuración', ACTIVE: 'Activa', SUSPENDED: 'Suspendida', CANCELLED: 'Cancelada' };

export default function PlatformSidebar(p: SidebarProps & { userRole: string }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const company = p.company;
  const platform = platformSections({ registros: p.badges?.registros, salud: p.badges?.salud });
  const panel = company ? companySections(company) : [];
  const products = new Set(company?.products ?? []);

  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* sin almacenamiento */ }
  }, [open]);

  // Por defecto se ve lo del lado en el que estás: en Plataforma, sus secciones abiertas;
  // dentro de una empresa, Plataforma plegada para que su panel quede a la vista
  const inPlatform = pathname.startsWith('/platform');
  const isOpen = (s: Section, scope: 'platform' | 'company') => open[`${scope}:${inPlatform ? 'p' : 'c'}:${s.id}`] ?? (scope === 'platform' ? inPlatform : !!s.owns?.(pathname));
  const toggle = (key: string, now: boolean) => setOpen((o) => ({ ...o, [key]: !now }));
  const keyOf = (s: Section, scope: 'platform' | 'company') => `${scope}:${inPlatform ? 'p' : 'c'}:${s.id}`;

  return (
    <aside
      aria-label="Navegación del equipo BackOffice"
      className={clsx(
        'fixed inset-y-0 left-0 z-40 flex h-full w-64 shrink-0 flex-col border-r-2 border-ink bg-bone transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:translate-x-0',
        p.mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}
    >
      <div className="flex items-start justify-between border-b-2 border-ink px-4 py-4">
        <div>
          <p className="display text-2xl leading-none">BackOffice<span className="text-ok">.</span></p>
          <p className="kicker mt-1">Panel del equipo</p>
        </div>
        <button className="cursor-pointer border-2 border-ink p-1 lg:hidden" onClick={p.onCloseMobile} aria-label="Cerrar menú">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {/* ── 1. Plataforma ── */}
        <p className="kicker bg-ink px-4 py-1.5 !text-bone">Plataforma</p>
        <div data-tour="nav-platform" className="pt-1">
          {platform.map((s) => (
            <Accordion key={s.id} section={s} open={isOpen(s, 'platform')} onToggle={(now) => toggle(keyOf(s, 'platform'), now)} pathname={pathname} />
          ))}
        </div>

        {/* ── 2. Empresa ── */}
        <p className="kicker mt-3 bg-ink px-4 py-1.5 !text-bone">Panel de una empresa</p>
        <div className="px-3 pb-2 pt-2" data-tour="company-picker">
          <label className="sr-only" htmlFor="dev-company-picker">Empresa activa</label>
          <select id="dev-company-picker" aria-label="Empresa activa"
            className="w-full cursor-pointer border-2 border-ink bg-paper px-2 py-1.5 text-xs font-semibold"
            value={p.companyId ?? ''} onChange={(e) => e.target.value && p.onPickCompany(e.target.value)}>
            <option value="" disabled>Elegir empresa…</option>
            {p.companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>

        {company ? (
          <div data-tour="nav-company">
            {/* Ficha: qué es y qué tiene, de un vistazo */}
            <div className="mx-3 mb-2 border-2 border-ink bg-paper px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <Link to={`/platform/companies/${company.id}`} className="min-w-0 truncate text-[13px] font-semibold underline-offset-2 hover:underline" title="Abrir la ficha de la empresa">
                  {company.name}
                </Link>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">{STATUS_LABEL[company.status] ?? company.status}</span>
              </div>
              <p className="mt-1 text-[11px] text-ink-3">
                {(company.productStates ?? []).map((s) => `${s.short} ${s.enabled ? '✓' : '—'}`).join(' · ') || 'Sin productos'}
              </p>
            </div>
            {panel.map((s) => {
              const missing = s.product && !products.has(s.product);
              if (missing) {
                return (
                  <Link key={s.id} to={`/app/producto/${s.product!.toLowerCase()}`}
                    className="mx-3 mb-1 flex items-center justify-between border-2 border-dashed border-line px-2 py-1.5 text-[12px] text-ink-3 hover:border-ink-3">
                    <span className="font-semibold">{s.title}</span><span>No lo tiene</span>
                  </Link>
                );
              }
              if (s.id === 'recursos' && !products.has('CREATIVE') && !products.has('ADS')) return null;
              return <Accordion key={s.id} section={s} open={isOpen(s, 'company')} onToggle={(now) => toggle(keyOf(s, 'company'), now)} pathname={pathname} />;
            })}
          </div>
        ) : (
          <p className="px-4 text-xs text-ink-3">Elige una empresa para ver su panel tal como lo usa el cliente.</p>
        )}
      </div>

      <div className="border-t-2 border-ink px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <div aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-ink bg-ink font-display text-sm text-bone">
            {p.userName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold leading-tight">{p.userName}</p>
            <div className="mt-0.5 flex items-center gap-1">
              {p.viewer && <Eye size={10} className="text-ink-3" />}
              <p className="kicker !text-[9px]">{p.roleLabel}</p>
            </div>
          </div>
        </div>
        <button onClick={p.onSecurity}
          className="mb-1.5 flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-line px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2 hover:border-ink hover:text-ink">
          Seguridad de mi cuenta
        </button>
        <button onClick={p.onLogout}
          className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] hover:bg-ink hover:text-bone">
          <LogOut size={12} /> Cerrar sesión
        </button>
      </div>
    </aside>
  );
}

function isActive(item: Item, pathname: string) {
  if (item.end) return pathname === item.to;
  if (item.to === '/app/orders') return pathname === item.to;
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

function Accordion({ section, open, onToggle, pathname }: { section: Section; open: boolean; onToggle: (now: boolean) => void; pathname: string }) {
  if (!section.items.length) return null;
  const pending = section.items.reduce((n, i) => n + (i.badge ?? 0), 0);
  const id = `dev-nav-${section.id}`;
  return (
    <div className="border-b border-line">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => onToggle(open)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left hover:bg-bone-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-bold uppercase tracking-[0.08em]">{section.title}</span>
          <span className="block truncate text-[11px] text-ink-3">{section.hint}</span>
        </span>
        {!open && pending > 0 && (
          <span className="min-w-5 bg-bad px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white" aria-label={`${pending} pendientes`}>{pending > 99 ? '99+' : pending}</span>
        )}
        <ChevronDown size={14} aria-hidden className={clsx('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <nav id={id} aria-label={section.title} className="flex flex-col pb-2">
          {section.items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end || item.to === '/app/orders'} data-tour={item.tour}
              className={({ isActive: on }) => clsx(
                'flex items-center gap-3 border-l-4 py-1.5 pl-5 pr-3 text-[13px] font-medium transition-colors',
                on ? 'border-ink bg-ink text-bone' : 'border-transparent text-ink-2 hover:border-line hover:bg-bone-2 hover:text-ink',
              )}>
              <item.icon size={15} strokeWidth={2} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {!!item.badge && (
                <span className="min-w-5 bg-bad px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white" aria-label={`${item.badge} pendientes`}>
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}
