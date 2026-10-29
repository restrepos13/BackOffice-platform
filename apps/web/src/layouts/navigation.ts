import {
  Activity, BarChart3, Bike, Bot, Calculator, CalendarDays, ChartNoAxesCombined, Clapperboard, ClipboardCheck, ClipboardList, Contact, CreditCard, Factory, FileSearch, FileText, FolderOpen, Gem, HandCoins, Images, Inbox, Layers, LayoutDashboard, ListChecks, Megaphone, Package, Palette, Plug, Radar, RefreshCcw, Rocket, Send, Settings, ShieldCheck, Sparkles, SlidersHorizontal, Store, SwatchBook, Target, TrendingUp, UserRound, Users, Wallet, Workflow, type LucideIcon,
} from 'lucide-react';
import type { ProductKey } from '../lib/products';

/**
 * Arquitectura de información del panel del CLIENTE (sin React: se prueba sola).
 * El equipo BackOffice conserva su barra de siempre (PlatformSidebar).
 *
 *  - Espacios de trabajo: los tres productos de la empresa.
 *  - Cada producto tiene su propio menú secundario, agrupado por tareas.
 *  - "Empresa y cuenta" es global: está igual en los tres productos.
 *
 * Mostrar u ocultar aquí es orientación: el servidor y RequireProduct siguen
 * exigiendo el producto en cada pantalla y endpoint.
 */

export type Workspace = ProductKey | 'PLATFORM';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Sección del rubro que la empresa debe tener (Company.modules) */
  module?: string;
  /** Coincidencia exacta de la ruta (sin subrutas) */
  end?: boolean;
  /** Ancla del tour de bienvenida */
  tour?: string;
  badge?: number;
}

export interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

export const WORKSPACES: Record<Workspace, { name: string; short: string; icon: LucideIcon; description: string }> = {
  AUTOMATION: { name: 'BackOffice Automation', short: 'Automation', icon: Workflow, description: 'Ventas, atención y operación con IA' },
  CREATIVE: { name: 'BackOffice Creative', short: 'Creative', icon: Palette, description: 'Diseños, marca y contenido' },
  ADS: { name: 'BackOffice Ads Intelligence', short: 'Ads Intelligence', icon: ChartNoAxesCombined, description: 'Publicidad pagada y resultados' },
  PLATFORM: { name: 'Plataforma BackOffice', short: 'Plataforma', icon: ShieldCheck, description: 'Administración de todas las empresas' },
};

export const PRODUCT_WORKSPACES: ProductKey[] = ['AUTOMATION', 'CREATIVE', 'ADS'];

/** Contexto de la empresa activa que decide qué opciones existen. */
export interface NavContext {
  products: ProductKey[];
  /** Secciones del rubro (Company.modules) */
  modules: string[];
  /** Domicilios configurados aunque no tenga la sección "delivery" */
  deliveryEnabled?: boolean;
  onboarding?: boolean;
}

/* ── Automation ── */

export function automationGroups(ctx: NavContext): NavGroup[] {
  const has = (m: string) => ctx.modules.includes(m);
  const hasOrders = has('orders');
  const hasDelivery = has('delivery') || !!ctx.deliveryEnabled;
  const groups: NavGroup[] = [
    {
      id: 'inicio', title: 'Inicio', items: [
        { to: '/app', label: 'Resumen', icon: LayoutDashboard, end: true },
        { to: '/app/analytics', label: 'Analítica', icon: BarChart3, module: 'analytics' },
        { to: '/app/gerencia', label: 'Reporte a gerencia', icon: ClipboardCheck, module: 'gerencia' },
      ],
    },
    {
      // Las conversaciones son el canal de atención; la venta se trabaja en contactos y seguimientos
      id: 'atencion', title: 'Atención y canales', items: [
        { to: '/app/inbox', label: 'Conversaciones', icon: Inbox, tour: 'nav-inbox' },
        { to: '/app/integrations', label: 'Canales e integraciones', icon: Plug },
        { to: '/app/media', label: 'Galería para chats', icon: Images, module: 'media' },
      ],
    },
    {
      id: 'ventas', title: 'Ventas y clientes', items: [
        { to: '/app/contacts', label: 'Contactos', icon: Contact },
        ...(hasOrders ? [{ to: '/app/customers', label: 'Clientes', icon: Store }] : []),
        { to: '/app/oportunidades', label: 'Oportunidades', icon: Radar },
        { to: '/app/campaigns', label: 'Campañas por WhatsApp', icon: Send, module: 'campaigns' },
        { to: '/app/reactivacion', label: 'Reactivación', icon: RefreshCcw, module: 'reactivation' },
        { to: '/app/cobranza', label: 'Cobranza', icon: HandCoins, module: 'collections' },
        { to: '/app/auditor', label: 'Auditor de ventas', icon: FileSearch, module: 'salesAudit' },
      ],
    },
    {
      // Flujo de producciones (agencias y estudios): solo empresas con la sección «productions»
      id: 'producciones', title: 'Producciones', items: [
        { to: '/app/productions', label: 'Inicio de producciones', icon: Clapperboard, end: true, module: 'productions' },
        { to: '/app/productions/list', label: 'Solicitudes', icon: ClipboardList, module: 'productions' },
        { to: '/app/productions/resources', label: 'Modelos y proveedores', icon: Users, module: 'productions' },
        { to: '/app/productions/settings', label: 'Configuración del flujo', icon: SlidersHorizontal, module: 'productions' },
      ],
    },
    {
      id: 'automatizacion', title: 'Automatización', items: [
        { to: '/app/bots', label: 'Asistentes IA', icon: Bot },
        { to: '/app/automations', label: 'Flujos y reglas', icon: Workflow, module: 'automations' },
        { to: '/app/costos-ia', label: 'Costo del asistente', icon: Calculator },
      ],
    },
    {
      id: 'operaciones', title: 'Operaciones', items: [
        ...(hasOrders ? [
          { to: '/app/orders', label: 'Pedidos', icon: Package, end: true, tour: 'nav-orders' },
          { to: '/app/orders/reports', label: 'Reportes de pedidos', icon: FileText, tour: 'nav-reports' },
          { to: '/app/area', label: 'Vista por área', icon: Factory, module: 'production' },
        ] : []),
        ...(hasDelivery ? [{ to: '/app/deliveries', label: 'Domicilios', icon: Bike }] : []),
        { to: '/app/agenda', label: 'Agenda', icon: CalendarDays, module: 'agenda' },
        // Catálogo, horario, conocimiento y pagos del negocio
        { to: '/app/orders/settings', label: hasOrders ? 'Ajustes de pedidos' : 'Mi negocio', icon: Store },
      ],
    },
  ];
  return clean(groups, ctx);
}

/* ── Creative ── */

export function creativeGroups(ctx: NavContext): NavGroup[] {
  return clean([
    { id: 'crear', title: 'Crear', items: [{ to: '/app/creative?tab=crear', label: 'Crear para vender', icon: Sparkles }] },
    { id: 'inicio', title: 'Inicio', items: [{ to: '/app/creative?tab=inicio', label: 'Oportunidades y avance', icon: LayoutDashboard }] },
    { id: 'disenos', title: 'Diseños', items: [{ to: '/app/creative?tab=disenos', label: 'Mis diseños', icon: Layers }] },
    { id: 'marca', title: 'Marca', items: [{ to: '/app/creative?tab=marca', label: 'Identidad de marca', icon: SwatchBook }] },
    { id: 'biblioteca', title: 'Biblioteca creativa', items: [{ to: '/app/biblioteca', label: 'Imágenes, logos y versiones', icon: FolderOpen }] },
    {
      id: 'publicacion', title: 'Calendario y publicación', items: [
        { to: '/app/creative?tab=calendario', label: 'Calendario orgánico', icon: CalendarDays },
        { to: '/app/creative?tab=reglas', label: 'Reglas de publicación', icon: ShieldCheck },
        { to: '/app/marketing', label: 'Piezas y redes', icon: Megaphone, module: 'marketing' },
        { to: '/app/creative?tab=creditos', label: 'Créditos de contenido', icon: Sparkles },
      ],
    },
  ], ctx);
}

/* ── Ads Intelligence ── */

export function adsGroups(ctx: NavContext): NavGroup[] {
  return clean([
    { id: 'resumen', title: 'Resumen publicitario', items: [{ to: '/app/ads?tab=resumen', label: 'Resultados', icon: TrendingUp, tour: 'ads-resumen' }] },
    {
      id: 'campanas', title: 'Campañas y cuentas', items: [
        { to: '/app/ads?tab=campanas', label: 'Campañas', icon: Target, tour: 'ads-campanas' },
        { to: '/app/ads?tab=nueva', label: 'Crear anuncio', icon: Rocket, tour: 'ads-crear' },
        { to: '/app/ads?tab=semana', label: 'Programación semanal', icon: CalendarDays, tour: 'ads-semana' },
        { to: '/app/ads?tab=cuentas', label: 'Cuentas publicitarias', icon: Plug, tour: 'ads-cuentas' },
      ],
    },
    { id: 'recursos', title: 'Creatividades y recursos', items: [{ to: '/app/biblioteca', label: 'Imágenes y videos', icon: FolderOpen }] },
    { id: 'inteligencia', title: 'Inteligencia y oportunidades', items: [{ to: '/app/ads?tab=oportunidades', label: 'Oportunidades', icon: Radar, tour: 'ads-oportunidades' }] },
    // Reglas sobre anuncios (pausar con aprobación): no son los flujos de Automation
    { id: 'autopilot', title: 'Automatización publicitaria', items: [{ to: '/app/ads?tab=autopilot', label: 'Autopilot y reglas', icon: Sparkles, tour: 'ads-autopilot' }] },
    { id: 'atribucion', title: 'Leads, ventas y atribución', items: [{ to: '/app/ads?tab=leads', label: 'Leads y ventas', icon: Wallet, tour: 'ads-leads' }] },
  ], ctx);
}

/* ── Global: empresa y cuenta (igual en los tres productos) ── */

export function accountItems(ctx: Pick<NavContext, 'onboarding'>): NavItem[] {
  return [
    ...(ctx.onboarding ? [{ to: '/app/bienvenida', label: 'Primeros pasos', icon: ListChecks }] : []),
    { to: '/app/settings', label: 'Configuración', icon: Settings, tour: 'nav-settings' },
    { to: '/app/team', label: 'Equipo', icon: UserRound },
    { to: '/app/mi-plan', label: 'Mi plan', icon: Gem },
    { to: '/app/billing', label: 'Facturación', icon: CreditCard },
    { to: '/app/usage', label: 'Consumo IA', icon: Activity, tour: 'nav-usage' },
  ];
}

/** Rutas globales: no cambian el producto activo (se queda el último que usaste). */
export const GLOBAL_PATHS = ['/app/settings', '/app/team', '/app/mi-plan', '/app/billing', '/app/usage', '/app/bienvenida', '/app/producto'];

/* ── Qué producto corresponde a una ruta ── */

/** Producto dueño de una ruta, o null si es global o compartida (biblioteca). */
export function productOfPath(pathname: string): Workspace | null {
  if (pathname.startsWith('/platform')) return 'PLATFORM';
  if (pathname.startsWith('/app/creative') || pathname.startsWith('/app/marketing')) return 'CREATIVE';
  if (pathname.startsWith('/app/ads')) return 'ADS';
  if (pathname.startsWith('/app/biblioteca')) return null;
  if (GLOBAL_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  if (pathname === '/app' || pathname.startsWith('/app/')) return 'AUTOMATION';
  return null;
}

/**
 * Producto activo: el de la ruta; en rutas globales o compartidas, el último
 * que usaste (si lo sigues teniendo); si no, el primero disponible.
 */
export function activeWorkspace(pathname: string, available: Workspace[], last: Workspace | null): Workspace | null {
  const own = productOfPath(pathname);
  if (own && available.includes(own)) return own;
  if (own === 'PLATFORM') return own;
  // La biblioteca es de Creative y de Ads: se queda en el que venías
  if (pathname.startsWith('/app/biblioteca')) {
    const libraryOwners: Workspace[] = available.filter((w) => w === 'CREATIVE' || w === 'ADS');
    if (last && libraryOwners.includes(last)) return last;
    return libraryOwners[0] ?? null;
  }
  if (last && available.includes(last)) return last;
  return own ?? available.find((w) => w !== 'PLATFORM') ?? available[0] ?? null;
}

/** Inicio de cada espacio (cuando no hay una ruta recordada). */
export const WORKSPACE_HOME: Record<Workspace, string> = {
  AUTOMATION: '/app',
  CREATIVE: '/app/creative?tab=inicio',
  ADS: '/app/ads?tab=resumen',
  PLATFORM: '/platform',
};

/** Grupos del menú secundario de un espacio. */
export function groupsFor(ws: Workspace, ctx: NavContext, badges: { registros?: number; salud?: number; adsFindings?: number; adsPending?: number } = {}): NavGroup[] {
  // Plataforma tiene su propia barra (PlatformSidebar), sin esta navegación
  if (ws === 'PLATFORM') return [];
  if (!ctx.products.includes(ws)) return [];
  if (ws === 'AUTOMATION') return automationGroups(ctx);
  if (ws === 'CREATIVE') return creativeGroups(ctx);
  return adsGroups(ctx).map((g) => ({
    ...g,
    items: g.items.map((i) => (i.to.endsWith('tab=oportunidades') ? { ...i, badge: badges.adsFindings } : i.to.endsWith('tab=autopilot') ? { ...i, badge: badges.adsPending } : i)),
  }));
}

/**
 * ¿El ítem está activo? Compara ruta y, si el ítem la tiene, la pestaña
 * (?tab=). Sin pestaña en la URL vale la primera del producto.
 */
export function isItemActive(item: NavItem, pathname: string, search: string): boolean {
  const [path, query] = item.to.split('?');
  if (item.end || path === '/app') return pathname === path;
  if (!(pathname === path || pathname.startsWith(`${path}/`))) return false;
  if (!query) {
    // "Pedidos" no debe quedar activo en /app/orders/reports ni /app/orders/settings
    return !(path === '/app/orders' && /^\/app\/orders\/(reports|settings)/.test(pathname));
  }
  const want = new URLSearchParams(query).get('tab');
  // El editor de un diseño pertenece a "Mis diseños"
  if (pathname.startsWith('/app/creative/editor')) return want === 'disenos';
  const have = new URLSearchParams(search).get('tab');
  const defaults: Record<string, string> = { '/app/creative': 'crear', '/app/ads': 'resumen' };
  return (have ?? defaults[path]) === want;
}

/** Quita lo que la empresa no tiene (secciones del rubro) y los grupos vacíos. */
function clean(groups: NavGroup[], ctx: NavContext): NavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.module || ctx.modules.includes(i.module)) }))
    .filter((g) => g.items.length > 0);
}

/* ── Recuerdo del producto activo (por navegador) ── */

export const NAV_WS_KEY = 'bo_nav_ws';
export const NAV_LAST_KEY = 'bo_nav_last';

/** Último producto que se usó en este navegador (para rutas globales y compartidas). */
export function rememberedWorkspace(): Workspace | null {
  try {
    const raw = localStorage.getItem(NAV_WS_KEY);
    return raw ? (JSON.parse(raw) as Workspace) : null;
  } catch {
    return null;
  }
}
