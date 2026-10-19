/**
 * Configuración de los complementos automáticos (vive en
 * Company.addonsJson[key].config) con valores por defecto sensatos, y utilidades
 * comunes de los motores: hora local de la empresa, plantillas aprobadas,
 * conversación por la línea de WhatsApp y textos con variables.
 */
import { readAddonStates } from './addons';
import { parseJson } from './constants';

export interface ReactivationConfig {
  /** Días sin comprar que disparan un mensaje (un escalón por umbral) */
  thresholds: number[];
  /** Plantilla aprobada por Meta (categoría MARKETING) para fuera de las 24 h */
  templateKey: string | null;
  /** Texto cuando el cliente está dentro de las 24 h ({{nombre}} {{empresa}} {{oferta}} {{producto}}) */
  message: string;
  /** Gancho opcional: promo, descuento, novedad */
  offer: string;
  maxPerDay: number;
  /** Hora local de envío (8 a 20) */
  sendHour: number;
  /** Días mínimos entre dos mensajes de reactivación a la misma persona */
  cooldownDays: number;
}

export interface CollectionsConfig {
  /** Días después del vencimiento para el primer recordatorio (0 = el mismo día) */
  firstReminderDays: number;
  repeatEveryDays: number;
  maxReminders: number;
  /** Plantilla aprobada (categoría UTILIDAD) para fuera de las 24 h */
  templateKey: string | null;
  /** {{nombre}} {{empresa}} {{valor}} {{concepto}} {{fecha}} {{pago}} */
  message: string;
  sendHour: number;
  /** Crear cuentas por cobrar solas con los pedidos sin pagar */
  autoFromOrders: boolean;
}

export interface SalesAuditConfig {
  /** Correo del informe semanal (vacío = administradores de la empresa) */
  email: string;
  /** Usar IA para afinar motivos y recomendaciones (si no, solo reglas) */
  useAi: boolean;
}

export const DEFAULT_REACTIVATION: ReactivationConfig = {
  thresholds: [30, 60, 90],
  templateKey: null,
  message: '¡Hola {{nombre}}! Hace rato no sabemos de ti en {{empresa}}. {{oferta}} ¿Te ayudamos con algo hoy?',
  offer: '',
  maxPerDay: 40,
  sendHour: 10,
  cooldownDays: 20,
};

export const DEFAULT_COLLECTIONS: CollectionsConfig = {
  firstReminderDays: 1,
  repeatEveryDays: 3,
  maxReminders: 3,
  templateKey: null,
  message: 'Hola {{nombre}}, te escribimos de {{empresa}} por el saldo pendiente de {{valor}} ({{concepto}}), que venció el {{fecha}}. {{pago}} Si ya pagaste, envíanos el comprobante por aquí y lo confirmamos. ¡Gracias!',
  sendHour: 10,
  autoFromOrders: true,
};

export const DEFAULT_SALES_AUDIT: SalesAuditConfig = { email: '', useAi: true };

const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const text = (v: unknown, max: number, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback);

export function reactivationConfig(company: { addonsJson?: string | null }): ReactivationConfig {
  const raw: any = readAddonStates(company).reactivation?.config ?? {};
  const thresholds = [...new Set((Array.isArray(raw.thresholds) ? raw.thresholds : DEFAULT_REACTIVATION.thresholds)
    .map((d: unknown) => int(d, 7, 365, 0)).filter((d: number) => d >= 7))].sort((a: any, b: any) => a - b).slice(0, 4) as number[];
  return {
    thresholds: thresholds.length ? thresholds : DEFAULT_REACTIVATION.thresholds,
    templateKey: typeof raw.templateKey === 'string' && raw.templateKey ? raw.templateKey : null,
    message: text(raw.message, 600, DEFAULT_REACTIVATION.message),
    offer: typeof raw.offer === 'string' ? raw.offer.trim().slice(0, 200) : '',
    maxPerDay: int(raw.maxPerDay, 1, 200, DEFAULT_REACTIVATION.maxPerDay),
    sendHour: int(raw.sendHour, 8, 20, DEFAULT_REACTIVATION.sendHour),
    cooldownDays: int(raw.cooldownDays, 7, 90, DEFAULT_REACTIVATION.cooldownDays),
  };
}

export function collectionsConfig(company: { addonsJson?: string | null }): CollectionsConfig {
  const raw: any = readAddonStates(company).collections?.config ?? {};
  return {
    firstReminderDays: int(raw.firstReminderDays, 0, 30, DEFAULT_COLLECTIONS.firstReminderDays),
    repeatEveryDays: int(raw.repeatEveryDays, 1, 15, DEFAULT_COLLECTIONS.repeatEveryDays),
    maxReminders: int(raw.maxReminders, 1, 6, DEFAULT_COLLECTIONS.maxReminders),
    templateKey: typeof raw.templateKey === 'string' && raw.templateKey ? raw.templateKey : null,
    message: text(raw.message, 600, DEFAULT_COLLECTIONS.message),
    sendHour: int(raw.sendHour, 8, 20, DEFAULT_COLLECTIONS.sendHour),
    autoFromOrders: raw.autoFromOrders !== false,
  };
}

export function salesAuditConfig(company: { addonsJson?: string | null }): SalesAuditConfig {
  const raw: any = readAddonStates(company).salesAudit?.config ?? {};
  const email = typeof raw.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.email.trim()) ? raw.email.trim() : '';
  return { email, useAi: raw.useAi !== false };
}

/** Guarda la configuración de un complemento sin tocar su estado de cobro. */
export function withAddonConfig(company: { addonsJson?: string | null }, key: string, config: object): string {
  const states: any = readAddonStates(company);
  states[key] = { ...(states[key] ?? { enabled: false }), config };
  return JSON.stringify(states);
}

export function addonEnabled(company: { addonsJson?: string | null }, key: string): boolean {
  return !!readAddonStates(company)[key]?.enabled;
}

/** Hora local (0-23) y fecha local YYYY-MM-DD de la empresa. */
export function localClock(timezone: string | null | undefined, now = new Date()) {
  const tz = timezone || 'America/Bogota';
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now)) % 24;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  return { hour, day };
}

export interface WaTemplate { key: string; name?: string; contentSid?: string; category?: string; body?: string }

/** Plantillas aprobadas (con contentSid) de una categoría. */
export function approvedTemplates(company: { waTemplatesJson?: string | null }, category?: 'MARKETING' | 'UTILIDAD'): WaTemplate[] {
  return parseJson<WaTemplate[]>(company.waTemplatesJson, [])
    .filter((t) => t?.key && t.contentSid && (!category || (t.category ?? 'MARKETING') === category));
}

/** {{variable}} → valor (las que no estén quedan vacías y se limpian los espacios). */
export function fillText(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => String(vars[k.toLowerCase()] ?? '').trim())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();
}

export const firstName = (name: string | null | undefined) => String(name ?? '').trim().split(/\s+/)[0] || '';

export const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
