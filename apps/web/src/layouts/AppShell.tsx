import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Activity,
  BarChart3,
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
  Plug,
  ScrollText,
  Sparkles,
  Settings,
  Terminal,
  UserRound,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useActiveCompanyId, useAuth } from '../lib/auth';
import { ROLE_LABELS } from '../lib/format';
import type { Company } from '../lib/types';
import { Badge } from '../components/ui';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

const PLATFORM_NAV: NavItem[] = [
  { to: '/platform', label: 'Resumen', icon: LayoutDashboard, end: true },
  { to: '/platform/companies', label: 'Empresas', icon: Building2 },
  { to: '/platform/plans', label: 'Planes', icon: CircleDollarSign },
  { to: '/platform/personas', label: 'Personalidades', icon: Sparkles },
  { to: '/platform/models', label: 'Modelos IA', icon: Cpu },
  { to: '/platform/users', label: 'Usuarios', icon: Users },
  { to: '/platform/emails', label: 'Correos', icon: Mail },
  { to: '/platform/audit', label: 'Auditoría', icon: ScrollText },
  { to: '/platform/dev', label: 'Dev Tools', icon: Terminal },
];

const COMPANY_NAV: NavItem[] = [
  { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/app/inbox', label: 'Conversaciones', icon: Inbox },
  { to: '/app/contacts', label: 'Contactos', icon: Contact },
  { to: '/app/bots', label: 'Asistentes IA', icon: Bot },
  { to: '/app/automations', label: 'Automatizaciones', icon: Workflow },
  { to: '/app/integrations', label: 'Integraciones', icon: Plug },
  { to: '/app/media', label: 'Galería', icon: Images },
  { to: '/app/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/app/billing', label: 'Facturación', icon: CreditCard },
  { to: '/app/team', label: 'Equipo', icon: UserRound },
  { to: '/app/settings', label: 'Configuración', icon: Settings },
];

function NavSection({ title, items }: { title: string; items: NavItem[] }) {
  return (
    <div className="mb-6">
      <p className="kicker mb-2 px-3">{title}</p>
      <nav className="flex flex-col">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
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

  // Cerrar el menú móvil al navegar
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
    enabled: isPlatform,
  });

  const activeCompany = companies?.find((c) => c.id === companyId);

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
          {isPlatform && <NavSection title="Plataforma" items={PLATFORM_NAV} />}

          {isPlatform && (
            <div className="mb-4 px-3">
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
              items={COMPANY_NAV}
            />
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
            onClick={logout}
            className="flex w-full cursor-pointer items-center justify-center gap-2 border-2 border-ink px-2 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] hover:bg-ink hover:text-bone"
          >
            <LogOut size={12} /> Cerrar sesión
          </button>
        </div>
      </aside>

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
        <main className="mx-auto max-w-[1400px] px-4 py-5 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
