/**
 * Reservas: configuración, horas locales y turnos posibles. Código puro (sin
 * base): lo usan el servicio de reservas, las herramientas del agente y las
 * pruebas. La IA solo interpreta lo que pide el cliente; qué está libre y qué
 * se puede reservar lo decide este código y el servidor.
 *
 * Configuración en Company.orderConfigJson.bookings. Sirve para cualquier cosa
 * reservable por tramos (canchas, salas, consultorios, turnos de servicio…).
 */
import { randomBytes } from 'crypto';

export interface BookingResource {
  id: string;
  name: string;
  active: boolean;
}

export interface BookingService {
  key: string;
  name: string;
  /** Múltiplo de slotMinutes */
  durationMin: number;
  price: number | null;
  /** Recursos donde se puede prestar (vacío = todos los activos) */
  resourceIds: string[];
}

export interface BookingConfig {
  enabled: boolean;
  /** Tamaño del tramo: las reservas empiezan en múltiplos de esto */
  slotMinutes: number;
  resources: BookingResource[];
  services: BookingService[];
  /** Horario por día (0 = domingo). Vacío = el horario general del negocio */
  hours: Array<{ day: number; open: string; close: string }>;
  /** Anticipación mínima para reservar */
  leadMinutes: number;
  /** Hasta cuántos días adelante se puede reservar */
  maxDaysAhead: number;
  /** El asistente solo cancela o reprograma con al menos estas horas de anticipación */
  cancelUntilHours: number;
  /** Reservas futuras activas por cliente (más que esto, lo revisa una persona) */
  maxActivePerContact: number;
  /** Pedir el nombre del cliente antes de reservar */
  requireName: boolean;
  reminders: { enabled: boolean; hoursBefore: number };
  /** Avisar al cliente cuando el equipo crea, cambia o cancela desde el panel */
  notifyOnStaffChanges: boolean;
}

export const DEFAULT_BOOKING_CONFIG: BookingConfig = {
  enabled: false,
  slotMinutes: 60,
  resources: [],
  services: [],
  hours: [],
  leadMinutes: 60,
  maxDaysAhead: 30,
  cancelUntilHours: 2,
  maxActivePerContact: 3,
  requireName: true,
  reminders: { enabled: true, hoursBefore: 24 },
  notifyOnStaffChanges: true,
};

const SLOT_SIZES = [15, 20, 30, 45, 60, 90, 120];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};
const slugify = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 30);

export class BookingConfigError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

/** Valida la configuración que manda el panel. Los ids de recursos existentes se conservan. */
export function normalizeBookingConfig(raw: unknown): BookingConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const slotMinutes = SLOT_SIZES.includes(Number(o.slotMinutes)) ? Number(o.slotMinutes) : DEFAULT_BOOKING_CONFIG.slotMinutes;
  const seenRes = new Set<string>();
  const resources: BookingResource[] = (Array.isArray(o.resources) ? o.resources : []).slice(0, 50).map((r: any) => {
    const name = str(r?.name, 60);
    let id = /^r_[a-z0-9-]{3,40}$/.test(String(r?.id ?? '')) ? String(r.id) : `r_${slugify(name) || 'recurso'}-${randomBytes(3).toString('hex')}`;
    while (seenRes.has(id)) id = `${id}-${randomBytes(2).toString('hex')}`;
    seenRes.add(id);
    return { id, name, active: r?.active !== false };
  }).filter((r: BookingResource) => r.name);
  const seenNames = new Set<string>();
  for (const r of resources) {
    const k = r.name.toLowerCase();
    if (seenNames.has(k)) throw new BookingConfigError('resources', `Hay dos recursos con el nombre «${r.name}»`);
    seenNames.add(k);
  }
  const resourceIds = new Set(resources.map((r) => r.id));
  const seenSvc = new Set<string>();
  const services: BookingService[] = (Array.isArray(o.services) ? o.services : []).slice(0, 30).map((sv: any) => {
    const name = str(sv?.name, 60);
    let key = /^[a-z0-9-]{2,40}$/.test(String(sv?.key ?? '')) ? String(sv.key) : slugify(name) || 'servicio';
    while (seenSvc.has(key)) key = `${key}-${randomBytes(2).toString('hex')}`;
    seenSvc.add(key);
    const minutes = int(sv?.durationMin, slotMinutes, 24 * 60, slotMinutes);
    const price = sv?.price === null || sv?.price === '' || sv?.price === undefined ? null : int(sv.price, 0, 1_000_000_000, 0);
    return {
      key, name,
      // La duración siempre en tramos completos
      durationMin: Math.ceil(minutes / slotMinutes) * slotMinutes,
      price,
      resourceIds: (Array.isArray(sv?.resourceIds) ? sv.resourceIds : []).map(String).filter((id: string) => resourceIds.has(id)),
    };
  }).filter((sv: BookingService) => sv.name);
  const hours = (Array.isArray(o.hours) ? o.hours : [])
    .map((h: any) => ({ day: int(h?.day, 0, 6, -1), open: String(h?.open ?? ''), close: String(h?.close ?? '') }))
    .filter((h: { day: number; open: string; close: string }) => h.day >= 0 && HHMM.test(h.open) && HHMM.test(h.close) && h.open < h.close);
  const enabled = o.enabled === true;
  if (enabled && !resources.some((r) => r.active)) throw new BookingConfigError('resources', 'Agrega al menos un espacio o recurso activo para recibir reservas');
  if (enabled && !services.length) throw new BookingConfigError('services', 'Agrega al menos un servicio reservable (por ejemplo «Cancha 1 hora»)');
  return {
    enabled,
    slotMinutes,
    resources,
    services,
    hours: [...new Map(hours.map((h: any) => [h.day, h])).values()] as BookingConfig['hours'],
    leadMinutes: int(o.leadMinutes, 0, 7 * 24 * 60, DEFAULT_BOOKING_CONFIG.leadMinutes),
    maxDaysAhead: int(o.maxDaysAhead, 1, 365, DEFAULT_BOOKING_CONFIG.maxDaysAhead),
    cancelUntilHours: int(o.cancelUntilHours, 0, 168, DEFAULT_BOOKING_CONFIG.cancelUntilHours),
    maxActivePerContact: int(o.maxActivePerContact, 1, 50, DEFAULT_BOOKING_CONFIG.maxActivePerContact),
    requireName: o.requireName !== false,
    reminders: {
      enabled: o.reminders?.enabled !== false,
      hoursBefore: int(o.reminders?.hoursBefore, 1, 168, DEFAULT_BOOKING_CONFIG.reminders.hoursBefore),
    },
    notifyOnStaffChanges: o.notifyOnStaffChanges !== false,
  };
}

/** Configuración guardada de una empresa (tolerante a datos viejos o dañados). */
export function bookingConfigOf(orderConfig: Record<string, any> | null | undefined): BookingConfig {
  try {
    return normalizeBookingConfig(orderConfig?.bookings ?? {});
  } catch {
    // Configuración incompleta guardada: se trata como apagada (nunca rompe el chat)
    return { ...normalizeBookingConfig({ ...(orderConfig?.bookings ?? {}), enabled: false }), enabled: false };
  }
}

/* ── Horas locales (zona de la empresa) ───────────────────────────── */

/** Minutos que la zona está por delante de UTC en ese instante (Bogotá = -300). */
export function tzOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** "2026-10-24" + "18:00" en la zona del negocio → instante UTC. */
export function localToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let at = new Date(guess - tzOffsetMinutes(timeZone, new Date(guess)) * 60000);
  // Segunda pasada por si el cambio de horario cae en medio
  at = new Date(guess - tzOffsetMinutes(timeZone, at) * 60000);
  return at;
}

/** Fecha, hora y día de la semana locales de un instante. */
export function localParts(at: Date, timeZone: string): { date: string; time: string; weekday: number; minutes: number } {
  const local = new Date(at.getTime() + tzOffsetMinutes(timeZone, at) * 60000);
  const iso = local.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
    weekday: local.getUTCDay(),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

export function addDaysLocal(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Horario de un día: el de reservas o, si no hay, el general del negocio (orderConfig.schedule). */
export function hoursFor(cfg: BookingConfig, orderConfig: Record<string, any>, date: string, weekday: number): { open: string; close: string } | null {
  const closedDays = [...(orderConfig?.holidays ?? []), ...(orderConfig?.nonWorkingDays ?? [])].map(String);
  if (closedDays.includes(date)) return null;
  if (cfg.hours.length) {
    const h = cfg.hours.find((x) => x.day === weekday);
    return h ? { open: h.open, close: h.close } : null;
  }
  const s = orderConfig?.schedule;
  if (!s || !Array.isArray(s.days) || !s.days.includes(weekday) || !HHMM.test(s.open ?? '') || !HHMM.test(s.close ?? '')) return null;
  return { open: s.open, close: s.close };
}

/** Recursos donde se puede prestar un servicio. */
export function resourcesFor(cfg: BookingConfig, service: BookingService): BookingResource[] {
  const active = cfg.resources.filter((r) => r.active);
  return service.resourceIds.length ? active.filter((r) => service.resourceIds.includes(r.id)) : active;
}

/** Tramos (inicio de cada uno) que ocupa una reserva. */
export function unitsOf(start: Date, durationMin: number, slotMinutes: number): Date[] {
  const out: Date[] = [];
  for (let m = 0; m < durationMin; m += slotMinutes) out.push(new Date(start.getTime() + m * 60000));
  return out;
}

export type SlotProblem = 'DISABLED' | 'NO_SERVICE' | 'CLOSED' | 'OFF_GRID' | 'OUT_OF_HOURS' | 'TOO_SOON' | 'TOO_FAR' | 'PAST';

/** ¿Ese inicio es reservable para el servicio (sin mirar si está ocupado)? */
export function slotProblem(cfg: BookingConfig, orderConfig: Record<string, any>, service: BookingService | null, start: Date, timeZone: string, now: Date): SlotProblem | null {
  if (!cfg.enabled) return 'DISABLED';
  if (!service) return 'NO_SERVICE';
  if (start.getTime() <= now.getTime()) return 'PAST';
  const lp = localParts(start, timeZone);
  const hours = hoursFor(cfg, orderConfig, lp.date, lp.weekday);
  if (!hours) return 'CLOSED';
  if (lp.minutes % cfg.slotMinutes !== 0) return 'OFF_GRID';
  if (lp.minutes < toMin(hours.open) || lp.minutes + service.durationMin > toMin(hours.close)) return 'OUT_OF_HOURS';
  if (start.getTime() < now.getTime() + cfg.leadMinutes * 60000) return 'TOO_SOON';
  const today = localParts(now, timeZone).date;
  if (lp.date > addDaysLocal(today, cfg.maxDaysAhead)) return 'TOO_FAR';
  return null;
}

export const PROBLEM_TEXT: Record<SlotProblem, string> = {
  DISABLED: 'Las reservas en línea no están activas en este negocio.',
  NO_SERVICE: 'Ese servicio no existe.',
  PAST: 'Esa hora ya pasó.',
  CLOSED: 'Ese día no hay atención.',
  OFF_GRID: 'Las reservas empiezan en horas exactas del calendario del negocio.',
  OUT_OF_HOURS: 'Esa hora está fuera del horario de reservas.',
  TOO_SOON: 'Se necesita reservar con más anticipación.',
  TOO_FAR: 'Esa fecha todavía no está abierta para reservas.',
};

/** Inicios posibles de un día para un servicio (sin mirar ocupación). */
export function candidateStarts(cfg: BookingConfig, orderConfig: Record<string, any>, service: BookingService, date: string, timeZone: string, now: Date): Date[] {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const hours = hoursFor(cfg, orderConfig, date, weekday);
  if (!hours) return [];
  const out: Date[] = [];
  for (let min = toMin(hours.open); min + service.durationMin <= toMin(hours.close); min += cfg.slotMinutes) {
    const start = localToUtc(date, toHHMM(min), timeZone);
    if (!slotProblem(cfg, orderConfig, service, start, timeZone, now)) out.push(start);
  }
  return out;
}

/** Código corto para que el cliente nombre su reserva (como el de los pedidos). */
export function bookingCode(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}
