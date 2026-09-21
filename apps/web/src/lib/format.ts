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
};

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
  bots: 'Asistentes IA',
  automations: 'Automatizaciones',
  analytics: 'Analytics',
  billing: 'Facturación y consumo',
  team: 'Equipo',
};
