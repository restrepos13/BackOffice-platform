/**
 * Rubros: deciden qué ve cada empresa en su panel. Una tienda de ropa no ve
 * cocina, comandas ni domicilios con GPS; un consultorio ve agenda y no pedidos.
 * Plataforma (devs) puede desbloquear módulos sueltos después en la ficha.
 *
 * Módulos (Company.modulesJson):
 *  base: inbox, contacts, bots, automations, analytics, billing, team
 *  orders      pedidos, catálogo con precios, clientes y reportes
 *  production  áreas de producción, vista por área, distribución, comandas
 *  delivery    domicilios en vivo (GPS, rutas, seguimiento)
 *  menu        menú digital con QR
 *  agenda      citas y seguimientos
 *  campaigns   campañas por WhatsApp
 *  media       galería con precios (contenido)
 *  gerencia    reporte a gerencia
 *  marketing   piezas y reels (extra)
 */

export type Rubro = 'COMIDAS' | 'WEBCAM' | 'SERVICIOS' | 'VENTAS';

export const RUBROS: Rubro[] = ['COMIDAS', 'WEBCAM', 'SERVICIOS', 'VENTAS'];

const BASE = ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team'];

export const RUBRO_CONFIG: Record<Rubro, {
  label: string;
  hint: string;
  modules: string[];
  /** Plantilla de company-templates (orderConfig, áreas, bot) */
  templateId: string;
  /** Qué se llama "catálogo" en este rubro */
  catalogLabel: string;
}> = {
  COMIDAS: {
    label: 'Comidas',
    hint: 'Restaurantes, almuerzos, domicilios, catering, panaderías',
    modules: [...BASE, 'orders', 'production', 'delivery', 'menu', 'campaigns', 'gerencia'],
    templateId: 'domicilios',
    catalogLabel: 'menú',
  },
  WEBCAM: {
    label: 'Webcam y creadores',
    hint: 'Estudios webcam, agencias y creadores de contenido',
    modules: [...BASE, 'media', 'campaigns', 'gerencia'],
    templateId: 'webcam',
    catalogLabel: 'contenido',
  },
  SERVICIOS: {
    label: 'Servicios con citas',
    hint: 'Consultorios, clínicas, salones de belleza, talleres, gimnasios',
    modules: [...BASE, 'agenda', 'campaigns'],
    templateId: 'servicios',
    catalogLabel: 'servicios',
  },
  VENTAS: {
    label: 'Empresas y ventas',
    hint: 'Tiendas de ropa y comercio, inmobiliarias, educación, ventas por WhatsApp',
    modules: [...BASE, 'orders', 'agenda', 'campaigns'],
    templateId: 'servicios',
    catalogLabel: 'catálogo',
  },
};

/** Módulos de un rubro desconocido: lo básico (los devs desbloquean lo demás). */
export function modulesForRubro(rubro: string | null | undefined): string[] {
  return RUBRO_CONFIG[rubro as Rubro]?.modules ?? [...BASE];
}

export function isRubro(v: unknown): v is Rubro {
  return typeof v === 'string' && (RUBROS as string[]).includes(v);
}

/**
 * Clasificación de respaldo por palabras clave (si la IA no decide o duda).
 * La IA propone; esto solo desempata y nunca inventa un rubro fuera de la lista.
 */
export function guessRubro(text: string): Rubro {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const score = (words: string[]) => words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  const scores: Record<Rubro, number> = {
    COMIDAS: score(['restaurante', 'almuerzo', 'comida', 'domicilio', 'catering', 'menu', 'pizza', 'hamburguesa', 'panaderia', 'cafe', 'cocina', 'corrientazo', 'postre', 'empanada', 'arepa']),
    WEBCAM: score(['webcam', 'modelo', 'creador', 'onlyfans', 'estudio de modelos', 'contenido para adultos', 'fans', 'chaturbate', 'stripchat']),
    SERVICIOS: score(['cita', 'consultorio', 'clinica', 'odontolog', 'salon', 'peluqueria', 'barberia', 'spa', 'taller', 'gimnasio', 'veterinari', 'psicolog', 'medico', 'unas', 'estetica', 'cancha', 'reserva', 'alquiler', 'turno']),
    VENTAS: score(['tienda', 'ropa', 'calzado', 'zapatos', 'inmobiliaria', 'apartamento', 'curso', 'colegio', 'venta', 'productos', 'accesorios', 'joyeria', 'distribuidora']),
  };
  const best = (Object.entries(scores) as Array<[Rubro, number]>).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : 'VENTAS';
}

/** Lista de pendientes para dejar la empresa operando (onboarding y aviso al dev). */
export function onboardingChecklist(input: {
  rubro: string | null;
  company: any;
  products: number;
  bots: number;
  connectedLines: number;
  hasPayments: boolean;
  requestedPlan: boolean;
  /** Productos contratados (AUTOMATION | CREATIVE | ADS); sin esto, como antes (todo es de Automation) */
  contracted?: string[];
  /** Creative: ya confirmó su marca */
  brandReady?: boolean;
  /** Ads Intelligence: cuentas publicitarias conectadas (reales o de demostración) */
  adAccounts?: number;
  /** Capacidades incluidas del perfil de incorporación (null en empresas anteriores) */
  capabilities?: string[];
}) {
  const cfg = (() => {
    try { return JSON.parse(input.company?.orderConfigJson ?? '{}'); } catch { return {}; }
  })();
  const rubro = input.rubro as Rubro | null;
  const catalog = RUBRO_CONFIG[rubro as Rubro]?.catalogLabel ?? 'catálogo';
  const hasOrders = rubro === 'COMIDAS' || rubro === 'VENTAS';
  const biz = hasOrders ? 'Pedidos → Configuración' : 'Mi negocio';
  const items = [
    { key: 'datos', label: 'Datos de la empresa (nombre, teléfono, color de marca)', done: !!input.company?.contactPhone && !!input.company?.name, link: '/app/settings', place: 'Configuración' },
    ...(rubro === 'WEBCAM'
      ? [{ key: 'catalogo', label: 'Perfiles y contenido con precios', done: input.products > 0 || input.bots > 1, link: '/app/media', place: 'Galería' }]
      : [{ key: 'catalogo', label: `Tu ${catalog} con precios`, done: input.products > 0, link: '/app/orders/settings?tab=productos', place: `${biz} → ${hasOrders ? 'Productos' : 'Catálogo'}` }]),
    { key: 'horario', label: 'Horario de atención', done: !!cfg.schedule?.days?.length, link: '/app/orders/settings?tab=agenda', place: `${biz} → Horario` },
    { key: 'preguntas', label: 'Preguntas frecuentes para la IA', done: Array.isArray(cfg.knowledgeBase) && cfg.knowledgeBase.length >= 3, link: '/app/orders/settings?tab=conocimiento', place: `${biz} → Conocimiento` },
    { key: 'asistente', label: 'Tu asistente IA (nombre, tono, bienvenida)', done: input.bots > 0, link: '/app/bots', place: 'Asistentes IA' },
    ...(rubro === 'COMIDAS'
      ? [{ key: 'domicilios', label: 'Punto de despacho y tarifas de domicilio', done: !!cfg.delivery?.origin, link: '/app/orders/settings?tab=domicilios', place: `${biz} → Domicilios` }]
      : []),
    // Negocios con agenda: sin espacios, servicios y horario el asistente no puede reservar
    ...(input.capabilities?.includes('AGENDA')
      ? [{ key: 'reservas', label: 'Tus reservas: espacios, servicios y horario', done: !!cfg.bookings?.enabled, link: '/app/agenda?tab=reservas', place: 'Agenda → Reservas en línea' }]
      : []),
    { key: 'pagos', label: 'Cómo te pagan (Nequi, transferencia, Wompi)', done: input.hasPayments, link: '/app/orders/settings?tab=pagos', place: `${biz} → Pagos` },
    { key: 'whatsapp', label: 'Conectar tu WhatsApp (lo hacemos contigo)', done: input.connectedLines > 0, link: '/app/integrations', place: 'Integraciones (te acompaña el equipo)' },
    { key: 'plan', label: 'Elegir tu plan', done: input.requestedPlan || !!input.company?.planId, link: '/app/bienvenida#planes', place: 'Primeros pasos → Elige tu plan' },
  ];
  // Solo los pasos de lo que contrató: sin Automation no hay WhatsApp, asistente ni catálogo que configurar
  const has = (p: string) => !input.contracted || input.contracted.includes(p);
  const automationKeys = ['catalogo', 'horario', 'preguntas', 'asistente', 'reservas', 'domicilios', 'pagos', 'whatsapp'];
  const scoped = [
    ...items.filter((i) => has('AUTOMATION') || !automationKeys.includes(i.key)),
    ...(input.contracted?.includes('CREATIVE')
      ? [{ key: 'marca', label: 'Tu marca: colores, logo y tono', done: !!input.brandReady, link: '/app/creative?tab=marca', place: 'Creative → Marca' }]
      : []),
    ...(input.contracted?.includes('ADS')
      ? [{ key: 'publicidad', label: 'Conectar tu cuenta de publicidad', done: (input.adAccounts ?? 0) > 0, link: '/app/ads?tab=cuentas', place: 'Publicidad → Cuentas' }]
      : []),
  ];
  // El plan siempre al final
  const ordered = [...scoped.filter((i) => i.key !== 'plan'), ...scoped.filter((i) => i.key === 'plan')];
  const done = ordered.filter((i) => i.done).length;
  return { items: ordered, done, total: ordered.length, percent: Math.round((done / ordered.length) * 100) };
}
