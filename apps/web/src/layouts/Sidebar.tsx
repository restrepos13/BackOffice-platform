import { clsx } from 'clsx';
import { Check, Factory, Lock, LogOut, PanelLeftClose, PanelLeftOpen, ShieldCheck, X } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { Company } from '../lib/types';
import type { ProductKey } from '../lib/products';
import {
  type NavContext, type NavGroup, type NavItem, type Workspace, PRODUCT_WORKSPACES, WORKSPACES, WORKSPACE_HOME,
  NAV_LAST_KEY, NAV_WS_KEY, accountItems, activeWorkspace, groupsFor, isItemActive, productOfPath, rememberedWorkspace,
} from './navigation';

/**
 * Barra lateral con tres niveles claros:
 *  1. Selector de producto (y "Plataforma" para el equipo BackOffice).
 *  2. Menú del producto activo, agrupado por tareas.
 *  3. Empresa y cuenta (global, igual en todos los productos).
 * Contraída deja solo íconos con su nombre accesible (title + aria-label).
 */

const LAST_KEY = NAV_LAST_KEY;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export interface SidebarProps {
  isPlatform: boolean;
  isArea: boolean;
  /** Empresa del panel (la propia o la elegida por plataforma) */
  company?: Company;
  companyName: string;
  companies?: Company[];
  companyId: string | null;
  onPickCompany: (id: string) => void;
  badges?: { registros?: number; salud?: number; adsFindings?: number; adsPending?: number };
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  userName: string;
  roleLabel: string;
  viewer: boolean;
  onSecurity: () => void;
  onLogout: () => void;
}

export function navContextOf(company?: Company): NavContext {
  return {
    products: (company?.products ?? []) as ProductKey[],
    modules: company?.modules ?? [],
    deliveryEnabled: !!company?.orderConfig?.delivery?.enabled,
    onboarding: company?.status === 'ONBOARDING',
  };
}

export default function Sidebar(p: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const ctx = navContextOf(p.company);
  const hasCompany = !!p.company;
  const available: Workspace[] = [...(p.isPlatform ? (['PLATFORM'] as Workspace[]) : []), ...ctx.products];
  const ws = activeWorkspace(location.pathname, available, rememberedWorkspace());
  const collapsed = p.collapsed && !p.mobileOpen; // en el celular el menú siempre va expandido

  // Recuerda el producto y la pantalla en la que estabas dentro de cada uno
  useEffect(() => {
    const own = productOfPath(location.pathname);
    if (!own) return;
    try {
      localStorage.setItem(NAV_WS_KEY, JSON.stringify(own));
      localStorage.setItem(LAST_KEY, JSON.stringify({ ...readJson<Record<string, string>>(LAST_KEY, {}), [own]: location.pathname + location.search }));
    } catch { /* almacenamiento no disponible: solo se pierde el recuerdo */ }
  }, [location.pathname, location.search]);

  const switchTo = (target: Workspace) => {
    if (target === ws && productOfPath(location.pathname) === target) return;
    const last = readJson<Record<string, string>>(LAST_KEY, {})[target];
    navigate(last ?? WORKSPACE_HOME[target]);
  };

  const groups: NavGroup[] = ws ? groupsFor(ws, ctx, p.badges) : [];
  const account = hasCompany && !p.isArea ? accountItems(ctx) : [];

  return (
    <aside
      aria-label="Navegación principal"
      className={clsx(
        'fixed inset-y-0 left-0 z-40 flex h-full shrink-0 flex-col border-r-2 border-ink bg-bone transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
        collapsed ? 'w-64 lg:w-[72px]' : 'w-64 lg:w-64',
        p.mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
      )}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {/* Marca + contraer */}
      <div className={clsx('flex items-center border-b-2 border-ink py-3', collapsed ? 'justify-center px-2' : 'justify-between px-4')}>
        {collapsed ? (
          <p className="display text-xl leading-none" aria-label="BackOffice">B<span className="text-ok">.</span></p>
        ) : (
          <p className="display text-2xl leading-none">BackOffice<span className="text-ok">.</span></p>
        )}
        <button className="cursor-pointer border-2 border-ink p-1 lg:hidden" onClick={p.onCloseMobile} aria-label="Cerrar menú">
          <X size={14} />
        </button>
        {!collapsed && (
          <button className="hidden cursor-pointer border-2 border-transparent p-1 text-ink-2 hover:border-line hover:text-ink lg:inline-flex"
            onClick={p.onToggleCollapse} aria-label="Contraer menú" aria-expanded title="Contraer menú">
            <PanelLeftClose size={16} />
          </button>
        )}
      </div>
      {collapsed && (
        <button className="hidden cursor-pointer justify-center border-b-2 border-line py-2 text-ink-2 hover:text-ink lg:flex"
          onClick={p.onToggleCollapse} aria-label="Expandir menú" aria-expanded={false} title="Expandir menú">
          <PanelLeftOpen size={16} />
        </button>
      )}

      <div className="flex-1 overflow-y-auto py-3">
        {p.isArea ? (
          <SecondaryNav collapsed={collapsed} groups={[{ id: 'area', title: p.companyName, items: [{ to: '/app/area', label: 'Mi área', icon: Factory, tour: 'nav-area' }] }]} />
        ) : (
          <>
            {/* Empresa (plataforma elige cuál ve) */}
            {p.isPlatform ? (
              !collapsed && (
                <div className="mb-3 px-3" data-tour="company-picker">
                  <label className="kicker mb-1 block" htmlFor="company-picker">Empresa</label>
                  <select id="company-picker" aria-label="Empresa activa"
                    className="w-full cursor-pointer border-2 border-ink bg-paper px-2 py-1.5 text-xs font-semibold"
                    value={p.companyId ?? ''} onChange={(e) => e.target.value && p.onPickCompany(e.target.value)}>
                    <option value="" disabled>Elegir empresa…</option>
                    {p.companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )
            ) : !collapsed && (
              <p className="mb-3 truncate px-4 text-xs font-semibold uppercase tracking-[0.08em] text-ink-2" title={p.companyName}>{p.companyName}</p>
            )}

            <ProductSwitcher
              collapsed={collapsed}
              isPlatform={p.isPlatform}
              hasCompany={hasCompany}
              active={ws}
              states={p.company?.productStates ?? []}
              onSwitch={switchTo}
            />

            <div data-tour={ws === 'PLATFORM' ? 'nav-platform' : 'nav-company'} className="border-t-2 border-ink pt-3">
              {p.isPlatform && !hasCompany && ws !== 'PLATFORM' ? (
                !collapsed && <p className="px-4 text-xs text-ink-3">Elige una empresa para ver su panel.</p>
              ) : (
                <SecondaryNav collapsed={collapsed} groups={groups} />
              )}
            </div>

            {account.length > 0 && (
              <div className="mt-2 border-t-2 border-ink pt-3">
                <SecondaryNav collapsed={collapsed} groups={[{ id: 'cuenta', title: 'Empresa y cuenta', items: account }]} />
              </div>
            )}
          </>
        )}
      </div>

      {/* Usuario */}
      <div className={clsx('border-t-2 border-ink py-3', collapsed ? 'px-2' : 'px-4')}>
        <div className={clsx('mb-2 flex items-center gap-2', collapsed && 'justify-center')}>
          <div aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center border-2 border-ink bg-ink font-display text-sm text-bone">
            {p.userName.slice(0, 1).toUpperCase()}
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold leading-tight">{p.userName}</p>
              <p className="kicker !text-[9px]">{p.roleLabel}{p.viewer ? ' · solo lectura' : ''}</p>
            </div>
          )}
        </div>
        <button onClick={p.onSecurity} title="Seguridad de mi cuenta" aria-label="Seguridad de mi cuenta"
          className="mb-1.5 flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-line px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2 hover:border-ink hover:text-ink">
          <ShieldCheck size={12} />{!collapsed && ' Seguridad de mi cuenta'}
        </button>
        <button onClick={p.onLogout} title="Cerrar sesión" aria-label="Cerrar sesión"
          className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] hover:bg-ink hover:text-bone">
          <LogOut size={12} />{!collapsed && ' Cerrar sesión'}
        </button>
      </div>
    </aside>
  );
}

/** Los productos: nombre, ícono y descripción; el activo se marca con fondo invertido, barra y aria-current. */
function ProductSwitcher({ collapsed, isPlatform, hasCompany, active, states, onSwitch }: {
  collapsed: boolean; isPlatform: boolean; hasCompany: boolean; active: Workspace | null;
  states: NonNullable<Company['productStates']>; onSwitch: (w: Workspace) => void;
}) {
  const tiles: Array<{ key: Workspace; enabled: boolean }> = [
    ...(isPlatform ? [{ key: 'PLATFORM' as Workspace, enabled: true }] : []),
    ...PRODUCT_WORKSPACES.map((k) => ({ key: k as Workspace, enabled: hasCompany && !!states.find((s) => s.key === k)?.enabled })),
  ];
  return (
    <nav aria-label="Productos" className="mb-4 px-2" data-tour="product-switcher">
      {!collapsed && <p className="kicker mb-1.5 px-1">Productos</p>}
      <ul className="flex flex-col gap-1">
        {tiles.map(({ key, enabled }) => {
          const w = WORKSPACES[key];
          const isActive = active === key;
          const Icon = w.icon;
          // Sin empresa elegida (plataforma) los productos esperan; sin contrato, llevan a pedirlo
          if (!enabled) {
            if (!hasCompany) {
              return collapsed ? null : (
                <li key={key} className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-ink-3"><Icon size={15} aria-hidden /> {w.short}</li>
              );
            }
            return (
              <li key={key}>
                <Link to={`/app/producto/${key.toLowerCase()}`} title={`${w.name}: no activo`} aria-label={`${w.name}: no activo, ver cómo activarlo`}
                  className={clsx('flex items-center gap-2 border-2 border-dashed border-line text-ink-3 hover:border-ink-3 hover:text-ink-2', collapsed ? 'justify-center p-2' : 'px-2 py-1.5')}>
                  <Lock size={14} aria-hidden />
                  {!collapsed && <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{w.short}</span><span className="block text-[11px]">No activo · ver opciones</span></span>}
                </Link>
              </li>
            );
          }
          return (
            <li key={key}>
              <button type="button" onClick={() => onSwitch(key)} aria-current={isActive ? 'true' : undefined}
                title={collapsed ? `${w.name} — ${w.description}` : undefined} aria-label={collapsed ? w.name : undefined}
                className={clsx(
                  'flex w-full cursor-pointer items-center gap-2 border-2 text-left transition-colors',
                  collapsed ? 'justify-center p-2' : 'px-2 py-1.5',
                  isActive ? 'border-ink bg-ink text-bone' : 'border-line bg-paper text-ink hover:border-ink',
                )}>
                <Icon size={16} aria-hidden />
                {!collapsed && (
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold leading-tight">{w.short}</span>
                    <span className={clsx('block truncate text-[11px]', isActive ? 'text-bone/80' : 'text-ink-3')}>{w.description}</span>
                  </span>
                )}
                {isActive && !collapsed && <Check size={14} strokeWidth={3} aria-hidden />}
                {isActive && <span className="sr-only"> (producto activo)</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function SecondaryNav({ groups, collapsed }: { groups: NavGroup[]; collapsed: boolean }) {
  const { pathname, search } = useLocation();
  return (
    <>
      {groups.map((g, gi) => (
        <div key={g.id} className={clsx(collapsed ? 'mb-2' : 'mb-4')} role="group" aria-label={g.title}>
          {collapsed ? (gi > 0 && <hr className="mx-3 mb-2 border-line" aria-hidden />) : <p className="kicker mb-1 px-4">{g.title}</p>}
          <ul className="flex flex-col">
            {g.items.map((item) => <NavEntry key={item.to} item={item} active={isItemActive(item, pathname, search)} collapsed={collapsed} />)}
          </ul>
        </div>
      ))}
    </>
  );
}

function NavEntry({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  return (
    <li>
      <Link to={item.to} data-tour={item.tour} aria-current={active ? 'page' : undefined}
        title={collapsed ? item.label : undefined} aria-label={collapsed ? item.label : undefined}
        className={clsx(
          'relative flex items-center gap-3 border-l-4 text-[13px] font-medium transition-colors',
          collapsed ? 'justify-center px-2 py-2' : 'px-3 py-1.5',
          active ? 'border-ink bg-ink text-bone' : 'border-transparent text-ink-2 hover:border-line hover:bg-bone-2 hover:text-ink',
        )}>
        <Icon size={15} strokeWidth={2} aria-hidden />
        {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {!!item.badge && (
          <span className={clsx('min-w-5 bg-bad px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white', collapsed ? 'absolute right-1 top-0.5' : 'ml-auto')} aria-label={`${item.badge} pendientes`}>
            {item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
      </Link>
    </li>
  );
}
