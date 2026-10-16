export const fmtUsd = (n: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: n < 10 ? 2 : 0,
  }).format(n);

export const fmtNum = (n: number) => new Intl.NumberFormat('es-CO').format(n);

export const fmtDate = (d: string | Date) =>
  new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
    .format(new Date(d));

export const fmtDateTime = (d: string | Date) =>
  new Intl.DateTimeFormat('es-CO', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(new Date(d));

export function timeAgo(d: string | Date): string {
  const diff = Date.now() - new Date(d).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `hace ${days} d`;
  return fmtDate(d);
}

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  DEV: 'Desarrollador',
  COMPANY_ADMIN: 'Admin de empresa',
  COMPANY_VIEWER: 'Visualización',
  COMPANY_AREA: 'Área de producción',
  COMPANY_COURIER: 'Domiciliario',
};

/* ─── Módulo de pedidos ─── */

export const ORDER_STATUS_LABELS: Record<string, string> = {
  borrador: 'Borrador',
  confirmado: 'Confirmado',
  programado: 'Programado',
  en_produccion: 'En producción',
  listo: 'Listo',
  empacado: 'Empacado',
  despachado: 'Despachado',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
  requiere_atencion: 'Requiere atención',
};

export function orderStatusTone(status: string): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' | 'ink' {
  switch (status) {
    case 'entregado':
      return 'ok';
    case 'requiere_atencion':
    case 'cancelado':
      return 'bad';
    case 'borrador':
      return 'neutral';
    case 'confirmado':
    case 'programado':
      return 'info';
    case 'en_produccion':
    case 'empacado':
      return 'warn';
    case 'listo':
    case 'despachado':
      return 'ink';
    default:
      return 'neutral';
  }
}

export const REMINDER_STATUS_LABELS: Record<string, string> = {
  PENDIENTE: 'Pendiente',
  PROCESANDO: 'Procesando',
  ENVIADO: 'Enviado',
  FALLIDO: 'Fallido',
  CANCELADO: 'Cancelado',
};

export const fmtCop = (n: number) =>
  new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(n);

export const COMPANY_STATUS_LABELS: Record<string, string> = {
  TRIAL: 'Trial',
  ACTIVE: 'Activa',
  SUSPENDED: 'Suspendida',
  CANCELLED: 'Cancelada',
};

export const CONVO_STATUS_LABELS: Record<string, string> = {
  OPEN: 'Abierta',
  PENDING: 'Pendiente',
  HANDOFF: 'Con humano',
  RESOLVED: 'Resuelta',
};

export const STAGE_LABELS: Record<string, string> = {
  CURIOSO: 'Curioso',
  POTENCIAL: 'Potencial',
  CALIENTE: 'Caliente',
  CLIENTE: 'Cliente',
  DESCARTADO: 'Descartado',
};

export const BOT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Activo',
  PAUSED: 'Pausado',
  DRAFT: 'Borrador',
};

export const AUTOMATION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Activa',
  PAUSED: 'Pausada',
  DRAFT: 'Borrador',
};

export const AUTOMATION_TYPE_LABELS: Record<string, string> = {
  FLOW: 'Flujo',
  CONTENT: 'Contenido',
  REPORT: 'Reporte',
  INTERNAL: 'Interna',
};

export const INTEGRATION_STATUS_LABELS: Record<string, string> = {
  DISCONNECTED: 'Sin conectar',
  PENDING: 'Pendiente',
  CONNECTED: 'Conectada',
  ERROR: 'Error',
};

export const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  MESSENGER: 'Messenger',
  TELEGRAM: 'Telegram',
  META_ADS: 'Meta Ads',
  N8N: 'n8n',
  GOOGLE_CALENDAR: 'Google Calendar',
  WEBHOOK: 'Webhook',
  WEB: 'Web',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  PAID: 'Pagada',
  PENDING: 'Pendiente',
  OVERDUE: 'Vencida',
};

export const MODULE_LABELS: Record<string, string> = {
  inbox: 'Bandeja de conversaciones',
  contacts: 'CRM / Contactos',
  orders: 'Pedidos (catering)',
  delivery: 'Domicilios en vivo (GPS y seguimiento)',
  marketing: 'Marketing (contenido y campañas)',
  bots: 'Asistentes IA',
  automations: 'Automatizaciones',
  analytics: 'Analytics',
  billing: 'Facturación y consumo',
  team: 'Equipo',
};

/** Dinero en la moneda de la empresa (COP sin decimales). */
export function fmtMoney(n: number | null | undefined, currency = 'COP'): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'COP' ? 0 : 2,
  }).format(n);
}

export const fmtTime = (d: string | Date) =>
  new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' }).format(new Date(d));

/** Minutos que faltan para una hora (null si ya pasó o no hay dato). */
export function minutesUntil(d: string | Date | null | undefined): number | null {
  if (!d) return null;
  const diff = Math.round((new Date(d).getTime() - Date.now()) / 60000);
  return diff >= 0 ? diff : 0;
}

/** Texto de llegada para el equipo: "llega en 8 min", "llegando" o "retrasado 12 min". */
export function etaLabel(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  const diff = Math.round((new Date(d).getTime() - Date.now()) / 60000);
  if (diff >= 2) return `llega en ${diff} min`;
  if (diff >= -2) return 'llegando';
  return `retrasado ${-diff} min`;
}

/* ─── Agente con herramientas ─── */

export const AGENT_TOOL_LABELS: Record<string, string> = {
  ver_menu: 'Ver menú y precios',
  ver_horarios: 'Horarios y si está abierto',
  ver_cliente: 'Ficha del cliente',
  calcular_envio: 'Calcular envío por ubicación',
  armar_pedido: 'Armar el pedido',
  confirmar_pedido: 'Confirmar el pedido',
  estado_pedido: 'Estado del pedido',
  cancelar_pedido: 'Cancelar pedido',
  guardar_direccion: 'Guardar direcciones',
  pasar_a_humano: 'Pasar a una persona',
  ver_promociones: 'Promociones y cupones',
  enviar_link_pago: 'Enviar link de pago',
  buscar_conocimiento: 'Buscar en la base de conocimiento',
};

/** Qué hace cada herramienta, explicado para el dueño del negocio. */
export const AGENT_TOOL_HELP: Record<string, string> = {
  ver_menu: 'Consulta los productos activos con su precio para ofrecer y cotizar sin inventar.',
  ver_horarios: 'Sabe a qué hora atienden, el corte de pedidos y si el negocio está abierto ahora.',
  ver_cliente: 'Reconoce al cliente: su nombre, direcciones guardadas y últimos pedidos.',
  calcular_envio: 'Calcula el costo del domicilio y el tiempo de llegada con la ubicación del cliente.',
  armar_pedido: 'Arma el pedido con precios y total, y se lo muestra al cliente para que lo apruebe.',
  confirmar_pedido: 'Confirma el pedido solo cuando el cliente dice que sí, y le envía el link de seguimiento.',
  estado_pedido: 'Responde "¿dónde va mi pedido?" con el estado, el domiciliario y la hora estimada.',
  cancelar_pedido: 'Cancela pedidos que aún no entraron a cocina; los demás los pasa a una persona.',
  guardar_direccion: 'Guarda direcciones del cliente (casa, oficina) para que no las repita.',
  pasar_a_humano: 'Pasa la conversación a tu equipo ante reclamos, casos raros o dudas.',
  ver_promociones: 'Ofrece las promociones vigentes y los cupones públicos.',
  enviar_link_pago: 'Manda el link de pago en línea (Wompi) o las instrucciones de pago manual.',
  buscar_conocimiento: 'Responde dudas con tus documentos: políticas, preguntas frecuentes, tu página web.',
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  NONE: 'Sin pagar',
  PENDING: 'Link enviado',
  REPORTED: 'Comprobante por verificar',
  PAID: 'Pagado',
  FAILED: 'Pago fallido',
};

export function paymentTone(status?: string | null): 'ok' | 'warn' | 'bad' | 'info' | 'neutral' {
  switch (status) {
    case 'PAID': return 'ok';
    case 'REPORTED': return 'warn';
    case 'PENDING': return 'info';
    case 'FAILED': return 'bad';
    default: return 'neutral';
  }
}

export const ORDER_SOURCE_LABELS: Record<string, string> = {
  WHATSAPP: 'WhatsApp', MENU: 'Menú digital', MANUAL: 'Manual', RAPPI: 'Rappi',
  UBER_EATS: 'Uber Eats', DIDI: 'DiDi Food', IFOOD: 'iFood', WEB: 'Tienda web', POS: 'Punto de venta', OTRO: 'Otro',
};

export const ADJUSTMENT_LABELS: Record<string, string> = {
  CHARGE: 'Cargo extra', DISCOUNT: 'Descuento', PRICE: 'Precio del mes', SETUP: 'Montaje (salida anticipada)',
};

export const LINE_KIND_LABELS: Record<string, string> = {
  PLAN: 'Plan', CHARGE: 'Cargo', DISCOUNT: 'Descuento', WHATSAPP: 'WhatsApp', STORAGE: 'Almacenamiento', SETUP: 'Montaje',
};

/** "2026-11" → "noviembre 2026" */
export function fmtPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

/* ─── Quién paga la IA ─── */

export const AI_MODE_LABELS: Record<string, string> = {
  INHERIT: 'Lo que tenga la empresa',
  BYOK: 'Cuenta DeepInfra de la empresa',
  PLATFORM: 'IA de BackOffice (revendida)',
  HYBRID: 'Híbrido: las dos, con respaldo',
};
