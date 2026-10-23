/**
 * Producciones (Automation · piloto LPulpo): reglas puras, sin base de datos.
 * Estados y transiciones, permisos por perfil, brief y faltantes, cotizaciones
 * (líneas, totales, diferencias) y tramos para el candado de recursos.
 *
 * Principio: nada comercial por defecto. Lo que LPulpo no ha confirmado queda
 * PENDIENTE y, si una operación depende de ello, se bloquea con un motivo claro.
 */
import { AuthUser, isPlatformRole } from './constants';

/* ─── Estados ─────────────────────────────────────────────────────────── */

export const STATUSES = [
  'NUEVA', 'BRIEF_INCOMPLETO', 'BRIEF_COMPLETO', 'BUSCANDO_RECURSOS', 'PROPUESTA_EN_PREPARACION',
  'COTIZACION_PENDIENTE_APROBACION', 'COTIZACION_APROBADA', 'COTIZACION_ENVIADA', 'PENDIENTE_RESPUESTA_CLIENTE',
  'ACEPTADA_POR_CLIENTE', 'CONFIRMACION_DE_RECURSOS_PENDIENTE', 'CONFIRMADA', 'EN_PRODUCCION', 'PENDIENTE_ENTREGA',
  'CERRADA', 'EN_PAUSA', 'PERDIDA', 'CANCELADA',
] as const;
export type ProductionStatus = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<ProductionStatus, string> = {
  NUEVA: 'Nueva', BRIEF_INCOMPLETO: 'Brief incompleto', BRIEF_COMPLETO: 'Brief completo', BUSCANDO_RECURSOS: 'Buscando recursos',
  PROPUESTA_EN_PREPARACION: 'Propuesta en preparación', COTIZACION_PENDIENTE_APROBACION: 'Cotización por aprobar',
  COTIZACION_APROBADA: 'Cotización aprobada', COTIZACION_ENVIADA: 'Cotización enviada', PENDIENTE_RESPUESTA_CLIENTE: 'Esperando al cliente',
  ACEPTADA_POR_CLIENTE: 'Aceptada por el cliente', CONFIRMACION_DE_RECURSOS_PENDIENTE: 'Confirmando recursos', CONFIRMADA: 'Confirmada',
  EN_PRODUCCION: 'En producción', PENDIENTE_ENTREGA: 'Pendiente de entrega', CERRADA: 'Cerrada', EN_PAUSA: 'En pausa',
  PERDIDA: 'Perdida', CANCELADA: 'Cancelada',
};

export const TERMINAL: ProductionStatus[] = ['CERRADA', 'PERDIDA', 'CANCELADA'];
/** Antes de que el cliente acepte, la producción se puede dar por perdida. */
const BEFORE_ACCEPTANCE: ProductionStatus[] = [
  'NUEVA', 'BRIEF_INCOMPLETO', 'BRIEF_COMPLETO', 'BUSCANDO_RECURSOS', 'PROPUESTA_EN_PREPARACION',
  'COTIZACION_PENDIENTE_APROBACION', 'COTIZACION_APROBADA', 'COTIZACION_ENVIADA', 'PENDIENTE_RESPUESTA_CLIENTE',
];

/**
 * Transiciones que una persona pide desde la ficha. Las de cotización
 * (enviar a aprobación, aprobar, rechazar, registrar envío) solo ocurren por
 * las acciones de la cotización, nunca por aquí.
 */
const MANUAL: Partial<Record<ProductionStatus, ProductionStatus[]>> = {
  NUEVA: ['BRIEF_INCOMPLETO', 'BRIEF_COMPLETO'],
  BRIEF_INCOMPLETO: ['BRIEF_COMPLETO'],
  BRIEF_COMPLETO: ['BRIEF_INCOMPLETO', 'BUSCANDO_RECURSOS'],
  BUSCANDO_RECURSOS: ['PROPUESTA_EN_PREPARACION'],
  COTIZACION_ENVIADA: ['PENDIENTE_RESPUESTA_CLIENTE', 'ACEPTADA_POR_CLIENTE'],
  PENDIENTE_RESPUESTA_CLIENTE: ['ACEPTADA_POR_CLIENTE', 'PROPUESTA_EN_PREPARACION'],
  ACEPTADA_POR_CLIENTE: ['CONFIRMACION_DE_RECURSOS_PENDIENTE'],
  CONFIRMACION_DE_RECURSOS_PENDIENTE: ['CONFIRMADA'],
  CONFIRMADA: ['EN_PRODUCCION'],
  EN_PRODUCCION: ['PENDIENTE_ENTREGA'],
  PENDIENTE_ENTREGA: ['CERRADA'],
};

/** Estados a los que solo se llega por la cotización. */
export const QUOTE_DRIVEN: ProductionStatus[] = ['COTIZACION_PENDIENTE_APROBACION', 'COTIZACION_APROBADA', 'COTIZACION_ENVIADA'];

export function isStatus(v: unknown): v is ProductionStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

/** Destinos manuales posibles desde un estado (incluye pausa, pérdida y cancelación). */
export function manualTargets(from: ProductionStatus, pausedFrom?: string | null): ProductionStatus[] {
  if (TERMINAL.includes(from)) return [];
  if (from === 'EN_PAUSA') return [...(isStatus(pausedFrom) ? [pausedFrom] : []), 'CANCELADA', ...(isStatus(pausedFrom) && BEFORE_ACCEPTANCE.includes(pausedFrom) ? ['PERDIDA' as const] : [])];
  return [
    ...(MANUAL[from] ?? []),
    'EN_PAUSA',
    ...(BEFORE_ACCEPTANCE.includes(from) ? ['PERDIDA' as const] : []),
    'CANCELADA',
  ];
}

/** Estados que exigen motivo escrito. */
export const NEEDS_REASON: ProductionStatus[] = ['EN_PAUSA', 'PERDIDA', 'CANCELADA'];

/* ─── Permisos ────────────────────────────────────────────────────────── */

export const PERMISSIONS = [
  'view', 'edit', 'assign', 'resources', 'rates', 'quotes', 'approve', 'confirm', 'finance', 'settings', 'integrations',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABEL: Record<Permission, string> = {
  view: 'Ver producciones', edit: 'Crear y editar solicitudes, brief, tareas e incidencias', assign: 'Asignar responsables',
  resources: 'Gestionar recursos y disponibilidad', rates: 'Editar tarifas', quotes: 'Crear y editar cotizaciones',
  approve: 'Aprobar o rechazar cotizaciones', confirm: 'Confirmar reservas', finance: 'Ver costos, márgenes y tarifas',
  settings: 'Administrar usuarios y configuración', integrations: 'Gestionar integraciones',
};

export const OPS_PROFILES = ['ADMIN', 'BOOKER', 'BOOKER_APPROVER', 'FINANCE', 'OPERATIONS', 'VIEWER'] as const;
export type OpsProfile = (typeof OPS_PROFILES)[number];

export const PROFILE_LABEL: Record<OpsProfile, string> = {
  ADMIN: 'Administración', BOOKER: 'Booker', BOOKER_APPROVER: 'Booker que aprueba cotizaciones',
  FINANCE: 'Finanzas', OPERATIONS: 'Operación y coordinación', VIEWER: 'Consulta',
};

const BOOKER: Permission[] = ['view', 'edit', 'assign', 'resources', 'quotes', 'confirm', 'finance'];
export const PROFILE_PERMISSIONS: Record<OpsProfile, Permission[]> = {
  ADMIN: [...PERMISSIONS],
  BOOKER,
  // Aprobar no viene con editar: es un perfil aparte que asigna el administrador
  BOOKER_APPROVER: [...BOOKER, 'approve'],
  FINANCE: ['view', 'finance', 'rates'],
  OPERATIONS: ['view', 'edit', 'resources'],
  VIEWER: ['view'],
};

/**
 * Perfil efectivo. COMPANY_ADMIN y plataforma: administración. COMPANY_VIEWER:
 * solo consulta, salvo que un administrador le asigne otro perfil. Los roles
 * restringidos (área, domiciliario) no entran a Producciones.
 */
export function effectiveProfile(user: Pick<AuthUser, 'role'> & { opsProfile?: string | null }): OpsProfile | null {
  if (isPlatformRole(user.role) || user.role === 'COMPANY_ADMIN') return 'ADMIN';
  if (user.role === 'COMPANY_VIEWER') {
    return (OPS_PROFILES as readonly string[]).includes(user.opsProfile ?? '') ? (user.opsProfile as OpsProfile) : 'VIEWER';
  }
  return null;
}

export function permissionsOf(profile: OpsProfile | null): Set<Permission> {
  return new Set(profile ? PROFILE_PERMISSIONS[profile] : []);
}

/* ─── Brief ───────────────────────────────────────────────────────────── */

export interface BriefField { key: string; label: string; group: string; kind: 'text' | 'long' | 'number' | 'choice' | 'date' }

export const BRIEF_FIELDS: BriefField[] = [
  { key: 'brand', label: 'Marca', group: 'Solicitud', kind: 'text' },
  { key: 'description', label: 'Descripción de la solicitud', group: 'Solicitud', kind: 'long' },
  { key: 'objective', label: 'Objetivo de la producción', group: 'Solicitud', kind: 'long' },
  { key: 'contentType', label: 'Tipo de campaña o contenido', group: 'Solicitud', kind: 'text' },
  { key: 'dates', label: 'Fecha o fechas', group: 'Fechas', kind: 'text' },
  { key: 'duration', label: 'Duración', group: 'Fechas', kind: 'choice' },
  { key: 'preferredLocation', label: 'Locación preferida', group: 'Recursos', kind: 'text' },
  { key: 'modelsCount', label: 'Número de modelos', group: 'Recursos', kind: 'number' },
  { key: 'modelsProfile', label: 'Perfil de los modelos', group: 'Recursos', kind: 'long' },
  { key: 'photography', label: 'Necesidades de fotografía', group: 'Recursos', kind: 'long' },
  { key: 'creativeDirection', label: 'Dirección creativa', group: 'Recursos', kind: 'long' },
  { key: 'styling', label: 'Styling y vestuario', group: 'Recursos', kind: 'long' },
  { key: 'assistants', label: 'Asistentes', group: 'Recursos', kind: 'text' },
  { key: 'catering', label: 'Alimentación y catering', group: 'Recursos', kind: 'text' },
  { key: 'clientBudget', label: 'Presupuesto indicado por el cliente', group: 'Comercial', kind: 'text' },
  { key: 'deliverables', label: 'Entregables', group: 'Comercial', kind: 'long' },
  { key: 'restrictions', label: 'Observaciones y restricciones', group: 'Comercial', kind: 'long' },
  { key: 'toConfirm', label: 'Pendiente de confirmar con el cliente', group: 'Comercial', kind: 'long' },
];
const BRIEF_KEYS = new Set(BRIEF_FIELDS.map((f) => f.key));

/** Opciones de duración (configurables en la empresa). */
export const DEFAULT_DURATIONS = ['Jornada completa', 'Media jornada', 'Varios días', 'Otra'];

/** Limpia un brief que llega del navegador: solo campos conocidos, texto acotado. */
export function sanitizeBrief(input: unknown, current: Record<string, unknown> = {}): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = { ...(current as Record<string, string | number | null>) };
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!BRIEF_KEYS.has(k)) continue;
    if (v === null || v === undefined || v === '') {
      out[k] = null;
      continue;
    }
    if (k === 'modelsCount') {
      const n = Math.round(Number(v));
      out[k] = Number.isFinite(n) && n >= 0 && n <= 500 ? n : null;
      continue;
    }
    out[k] = String(v).trim().slice(0, 2000) || null;
  }
  return out;
}

const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';

export function missingFields(brief: Record<string, unknown>, required: string[]): Array<{ key: string; label: string }> {
  return required
    .filter((k) => BRIEF_KEYS.has(k) && !filled(brief[k]))
    .map((k) => ({ key: k, label: BRIEF_FIELDS.find((f) => f.key === k)!.label }));
}

/* ─── Configuración (sin valores comerciales inventados) ─────────────── */

export type Decision = { status: 'PENDING' | 'CONFIRMED' | 'NOT_APPLICABLE'; value?: unknown; note?: string };

export interface ProductionConfig {
  serviceTypes: Array<{ key: string; label: string; enabled: boolean }>;
  durations: string[];
  priorities: string[];
  brief: { requiredToComplete: string[]; requiredToQuote: string[]; status: Decision['status'] };
  taskRules: Record<string, { enabled: boolean; title: string }>;
  engine: { maxAttempts: number };
  commercial: {
    commission: Decision; margins: Decision; taxes: Decision; cancellation: Decision; deposit: Decision;
    clientCoveredExpenses: Decision;
  };
  availability: { holdHours: Decision; rules: Decision };
  approval: { approvers: Decision; threshold: Decision };
  consent: Decision;
}

export const SERVICE_TYPES = [
  { key: 'MODEL', label: 'Modelos' }, { key: 'LOCATION', label: 'Locación' }, { key: 'PHOTOGRAPHY', label: 'Fotografía' },
  { key: 'CREATIVE_DIRECTION', label: 'Dirección creativa' }, { key: 'STYLING', label: 'Styling' },
  { key: 'ASSISTANT', label: 'Asistentes' }, { key: 'CATERING', label: 'Alimentación y catering' }, { key: 'OTHER', label: 'Otros servicios' },
];

/** Reglas de tareas: configuración inicial de ejemplo, desactivable por empresa. */
export const TASK_RULES: Record<string, { status: ProductionStatus; title: string }> = {
  BRIEF: { status: 'BRIEF_INCOMPLETO', title: 'Completar el brief' },
  AVAILABILITY: { status: 'BUSCANDO_RECURSOS', title: 'Revisar disponibilidad de recursos' },
  PRICES: { status: 'BUSCANDO_RECURSOS', title: 'Solicitar precios a proveedores' },
  QUOTE: { status: 'PROPUESTA_EN_PREPARACION', title: 'Preparar la cotización' },
  APPROVE: { status: 'COTIZACION_PENDIENTE_APROBACION', title: 'Aprobar la cotización' },
  CONFIRM: { status: 'CONFIRMACION_DE_RECURSOS_PENDIENTE', title: 'Confirmar recursos' },
  LOGISTICS: { status: 'CONFIRMADA', title: 'Coordinar logística' },
  DELIVERABLES: { status: 'PENDIENTE_ENTREGA', title: 'Verificar entregables' },
  CLOSE: { status: 'PENDIENTE_ENTREGA', title: 'Cerrar la producción' },
};

const pending = (note?: string): Decision => ({ status: 'PENDING', ...(note ? { note } : {}) });

export function defaultConfig(): ProductionConfig {
  return {
    serviceTypes: SERVICE_TYPES.map((s) => ({ ...s, enabled: true })),
    durations: [...DEFAULT_DURATIONS],
    priorities: ['BAJA', 'NORMAL', 'ALTA', 'URGENTE'],
    // Sugerencia inicial para poder trabajar; la lista definitiva la confirma LPulpo
    brief: { requiredToComplete: ['description', 'dates', 'duration', 'modelsCount'], requiredToQuote: ['description', 'dates', 'duration', 'modelsCount', 'deliverables'], status: 'PENDING' },
    taskRules: Object.fromEntries(Object.entries(TASK_RULES).map(([k, r]) => [k, { enabled: true, title: r.title }])),
    engine: { maxAttempts: 5 },
    commercial: {
      commission: pending('Se indicó 30 %; falta confirmar sobre qué base y a qué servicios aplica.'),
      margins: pending(), taxes: pending(), cancellation: pending(), deposit: pending(),
      clientCoveredExpenses: pending('Qué gastos cubre el cliente directamente (alimentación, vestuario…).'),
    },
    availability: { holdHours: pending('Duración de una retención temporal.'), rules: pending() },
    approval: { approvers: pending('Hoy aprueba quien tenga el perfil «Booker que aprueba» o Administración.'), threshold: pending() },
    consent: pending('Consentimiento para contactar modelos y usar sus fotos.'),
  };
}

/** Mezcla la configuración guardada con la base, validando lo que se puede cambiar. */
export function mergeConfig(saved: unknown): ProductionConfig {
  const base = defaultConfig();
  if (!saved || typeof saved !== 'object') return base;
  const s = saved as Partial<ProductionConfig>;
  const dec = (d: unknown, fallback: Decision): Decision => {
    if (!d || typeof d !== 'object') return fallback;
    const x = d as Decision;
    return {
      status: ['PENDING', 'CONFIRMED', 'NOT_APPLICABLE'].includes(x.status) ? x.status : fallback.status,
      ...(x.value !== undefined ? { value: x.value } : {}),
      note: typeof x.note === 'string' ? x.note.slice(0, 500) : fallback.note,
    };
  };
  const keys = (list: unknown, fallback: string[]) =>
    Array.isArray(list) ? list.filter((k) => typeof k === 'string' && BRIEF_KEYS.has(k)) : fallback;
  return {
    serviceTypes: Array.isArray(s.serviceTypes)
      ? base.serviceTypes.map((t) => ({ ...t, ...(s.serviceTypes!.find((x) => x?.key === t.key) ? { enabled: !!s.serviceTypes!.find((x) => x?.key === t.key)!.enabled, label: String(s.serviceTypes!.find((x) => x?.key === t.key)!.label || t.label).slice(0, 60) } : {}) }))
      : base.serviceTypes,
    durations: Array.isArray(s.durations) && s.durations.length ? s.durations.map((d) => String(d).slice(0, 40)).slice(0, 10) : base.durations,
    priorities: base.priorities,
    brief: {
      requiredToComplete: keys(s.brief?.requiredToComplete, base.brief.requiredToComplete),
      requiredToQuote: keys(s.brief?.requiredToQuote, base.brief.requiredToQuote),
      status: s.brief?.status === 'CONFIRMED' ? 'CONFIRMED' : 'PENDING',
    },
    taskRules: Object.fromEntries(Object.entries(base.taskRules).map(([k, r]) => [k, { ...r, enabled: s.taskRules?.[k]?.enabled ?? r.enabled }])),
    engine: { maxAttempts: Math.min(10, Math.max(1, Math.round(Number(s.engine?.maxAttempts) || base.engine.maxAttempts))) },
    commercial: Object.fromEntries(Object.entries(base.commercial).map(([k, d]) => [k, dec((s.commercial as any)?.[k], d)])) as ProductionConfig['commercial'],
    availability: { holdHours: dec(s.availability?.holdHours, base.availability.holdHours), rules: dec(s.availability?.rules, base.availability.rules) },
    approval: { approvers: dec(s.approval?.approvers, base.approval.approvers), threshold: dec(s.approval?.threshold, base.approval.threshold) },
    consent: dec(s.consent, base.consent),
  };
}

/** Horas de retención confirmadas (null = no hay regla; se pide fecha explícita). */
export function confirmedHoldHours(cfg: ProductionConfig): number | null {
  const d = cfg.availability.holdHours;
  const n = Number(d.value);
  return d.status === 'CONFIRMED' && Number.isFinite(n) && n > 0 && n <= 24 * 30 ? n : null;
}

/* ─── Cotizaciones ────────────────────────────────────────────────────── */

export const LINE_CATEGORIES = ['MODEL', 'LOCATION', 'PHOTOGRAPHY', 'CREATIVE_DIRECTION', 'STYLING', 'ASSISTANT', 'CATERING', 'EXPENSE', 'COMMISSION', 'OTHER'] as const;
export const UNITS = ['HOUR', 'HALF_DAY', 'FULL_DAY', 'DAY', 'PROJECT', 'UNIT', 'OTHER'] as const;
export type ValueStatus = 'PENDING' | 'ESTIMATED' | 'CONFIRMED';
/** INCLUDED: va en el total · CLIENT_DIRECT: lo paga el cliente aparte · TO_CONFIRM: por definir */
export type Billing = 'INCLUDED' | 'CLIENT_DIRECT' | 'TO_CONFIRM';

export interface QuoteLine {
  id: string;
  category: (typeof LINE_CATEGORIES)[number];
  description: string;
  resourceId: string | null;
  quantity: number;
  unit: (typeof UNITS)[number];
  unitCost: number | null;
  costStatus: ValueStatus;
  unitPrice: number | null;
  priceStatus: ValueStatus;
  billing: Billing;
  /** Solo líneas COMMISSION: porcentaje sobre el precio o el costo de las líneas indicadas */
  commission: { percent: number | null; base: 'PRICE' | 'COST'; appliesTo: string[] } | null;
  notes: string | null;
}

const money = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e12 ? Math.round(n * 100) / 100 : null;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => ((list as readonly string[]).includes(String(v)) ? (v as T) : fallback);

export function sanitizeLines(input: unknown): QuoteLine[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).map((raw, i) => {
    const l = (raw ?? {}) as Record<string, any>;
    const category = oneOf(l.category, LINE_CATEGORIES, 'OTHER');
    const unitCost = money(l.unitCost);
    const unitPrice = money(l.unitPrice);
    const status = (v: unknown, amount: number | null): ValueStatus => (amount === null ? 'PENDING' : oneOf(v, ['ESTIMATED', 'CONFIRMED'] as const, 'ESTIMATED'));
    const qty = Number(l.quantity);
    return {
      id: typeof l.id === 'string' && /^[\w-]{1,40}$/.test(l.id) ? l.id : `l${i + 1}_${Math.random().toString(36).slice(2, 8)}`,
      category,
      description: String(l.description ?? '').trim().slice(0, 300),
      resourceId: typeof l.resourceId === 'string' && l.resourceId ? l.resourceId : null,
      quantity: Number.isFinite(qty) && qty > 0 && qty <= 10000 ? Math.round(qty * 100) / 100 : 1,
      unit: oneOf(l.unit, UNITS, 'UNIT'),
      unitCost: category === 'COMMISSION' ? null : unitCost,
      costStatus: category === 'COMMISSION' ? 'CONFIRMED' : status(l.costStatus, unitCost),
      unitPrice: category === 'COMMISSION' ? null : unitPrice,
      priceStatus: category === 'COMMISSION' ? 'CONFIRMED' : status(l.priceStatus, unitPrice),
      billing: oneOf(l.billing, ['INCLUDED', 'CLIENT_DIRECT', 'TO_CONFIRM'] as const, 'TO_CONFIRM'),
      commission: category === 'COMMISSION'
        ? {
            percent: (() => { const p = money(l.commission?.percent); return p !== null && p <= 100 ? p : null; })(),
            base: l.commission?.base === 'COST' ? 'COST' : 'PRICE',
            appliesTo: Array.isArray(l.commission?.appliesTo) ? l.commission.appliesTo.filter((x: unknown) => typeof x === 'string').slice(0, 100) : [],
          }
        : null,
      notes: l.notes ? String(l.notes).trim().slice(0, 500) : null,
    };
  });
}

export interface QuoteTotals {
  clientTotal: number | null;
  costTotal: number | null;
  margin: number | null;
  clientDirect: number;
  pending: Array<{ lineId: string; what: string }>;
  complete: boolean;
}

/** Totales consistentes: si falta un valor incluido, el total queda sin calcular y se dice qué falta. */
export function quoteTotals(lines: QuoteLine[]): QuoteTotals {
  const pending: QuoteTotals['pending'] = [];
  const byId = new Map(lines.map((l) => [l.id, l]));
  const linePrice = (l: QuoteLine): number | null => {
    if (l.category !== 'COMMISSION') return l.unitPrice === null ? null : Math.round(l.unitPrice * l.quantity * 100) / 100;
    const c = l.commission;
    if (!c || c.percent === null || !c.appliesTo.length) return null;
    let sum = 0;
    for (const id of c.appliesTo) {
      const t = byId.get(id);
      if (!t || t.category === 'COMMISSION') return null;
      const v = c.base === 'PRICE' ? t.unitPrice : t.unitCost;
      if (v === null) return null;
      sum += v * t.quantity;
    }
    return Math.round(sum * c.percent) / 100;
  };
  let client = 0;
  let cost = 0;
  let clientKnown = true;
  let costKnown = true;
  let clientDirect = 0;
  for (const l of lines) {
    if (l.billing === 'TO_CONFIRM') pending.push({ lineId: l.id, what: 'Falta definir si va en el total o lo paga el cliente aparte' });
    const price = linePrice(l);
    if (l.billing === 'CLIENT_DIRECT') {
      if (price !== null) clientDirect += price;
      continue;
    }
    if (price === null) {
      clientKnown = false;
      pending.push({ lineId: l.id, what: l.category === 'COMMISSION' ? 'Comisión sin porcentaje o sin líneas base con valor' : 'Precio al cliente pendiente' });
    } else client += price;
    if (l.category !== 'COMMISSION') {
      if (l.unitCost === null) costKnown = false;
      else cost += l.unitCost * l.quantity;
    }
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const clientTotal = clientKnown ? round(client) : null;
  const costTotal = costKnown ? round(cost) : null;
  return {
    clientTotal, costTotal, margin: clientTotal !== null && costTotal !== null ? round(clientTotal - costTotal) : null,
    clientDirect: round(clientDirect), pending, complete: pending.length === 0 && lines.length > 0,
  };
}

export interface QuoteDiff { added: string[]; removed: string[]; changed: Array<{ lineId: string; fields: string[] }> }

export function quoteDiff(prev: QuoteLine[], next: QuoteLine[]): QuoteDiff {
  const before = new Map(prev.map((l) => [l.id, l]));
  const after = new Map(next.map((l) => [l.id, l]));
  const fields: Array<keyof QuoteLine> = ['category', 'description', 'resourceId', 'quantity', 'unit', 'unitCost', 'costStatus', 'unitPrice', 'priceStatus', 'billing', 'commission', 'notes'];
  return {
    added: next.filter((l) => !before.has(l.id)).map((l) => l.id),
    removed: prev.filter((l) => !after.has(l.id)).map((l) => l.id),
    changed: next
      .filter((l) => before.has(l.id))
      .map((l) => ({ lineId: l.id, fields: fields.filter((f) => JSON.stringify(l[f]) !== JSON.stringify(before.get(l.id)![f])) as string[] }))
      .filter((c) => c.fields.length),
  };
}

/** Lo que está protegido para quien no ve datos financieros. */
export function redactLines(lines: QuoteLine[]): Array<Partial<QuoteLine>> {
  return lines.map(({ unitCost: _c, unitPrice: _p, commission: _m, ...rest }) => rest);
}

/* ─── Tramos para el candado de recursos ─────────────────────────────── */

export const MAX_SLOT_HOURS = 24 * 14;

/** Horas (UTC, inicio de hora) que ocupa un rango [inicio, fin). */
export function hourSlots(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const t = new Date(start);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 0; t.getTime() < end.getTime() && i <= MAX_SLOT_HOURS; i++) {
    out.push(new Date(t));
    t.setUTCHours(t.getUTCHours() + 1);
  }
  return out;
}
