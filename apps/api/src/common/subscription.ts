import { deterministicId } from './automation/run-signals';

/**
 * Ciclo de vida de la suscripción de una empresa (fuente única: Company).
 *
 *   PENDING_ACTIVATION ─┬─► TRIAL ─────────────┐
 *                       └─► ACTIVE ◄───────────┤ (pago comprobado o activación de plataforma)
 *   ACTIVE ─► PAYMENT_PENDING ─► GRACE ─► SUSPENDED ─► ENDED
 *   ACTIVE / PAYMENT_PENDING / GRACE ─► CANCELED (renovación cancelada: el
 *        acceso sigue hasta el fin del periodo) ─► ENDED (cancelación efectiva)
 *
 * Cancelar la renovación NO quita el acceso. ENDED sí.
 * `Company.status` (campo anterior) se mantiene sincronizado para que todo lo
 * que ya lo consulta (crons de complementos, menú público…) siga igual.
 */

export const SUBSCRIPTION_STATUSES = [
  'PENDING_ACTIVATION', 'TRIAL', 'ACTIVE', 'PAYMENT_PENDING', 'GRACE', 'SUSPENDED', 'CANCELED', 'ENDED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_LABEL: Record<SubscriptionStatus, string> = {
  PENDING_ACTIVATION: 'Pendiente de activación',
  TRIAL: 'En prueba',
  ACTIVE: 'Activa',
  PAYMENT_PENDING: 'Pago pendiente',
  GRACE: 'Vencida (en periodo de gracia)',
  SUSPENDED: 'Suspendida',
  CANCELED: 'Cancelada (acceso hasta el fin del periodo)',
  ENDED: 'Finalizada',
};

/** Transiciones permitidas. Todo lo demás se rechaza. */
export const TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  PENDING_ACTIVATION: ['TRIAL', 'ACTIVE', 'ENDED'],
  TRIAL: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAYMENT_PENDING', 'CANCELED', 'SUSPENDED'],
  PAYMENT_PENDING: ['ACTIVE', 'GRACE', 'SUSPENDED', 'CANCELED'],
  GRACE: ['ACTIVE', 'SUSPENDED', 'CANCELED'],
  SUSPENDED: ['ACTIVE', 'ENDED'],
  CANCELED: ['ACTIVE', 'ENDED'],
  ENDED: ['ACTIVE'],
};

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Estado anterior (Company.status) → ciclo de vida. Sin migrar datos. */
const FROM_LEGACY: Record<string, SubscriptionStatus> = {
  ONBOARDING: 'PENDING_ACTIVATION', TRIAL: 'TRIAL', ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED', CANCELLED: 'ENDED', INACTIVE: 'ENDED',
};

/** Ciclo de vida → estado anterior que esperan los módulos existentes. */
export const TO_LEGACY: Record<SubscriptionStatus, string> = {
  PENDING_ACTIVATION: 'ONBOARDING', TRIAL: 'TRIAL', ACTIVE: 'ACTIVE', PAYMENT_PENDING: 'ACTIVE', GRACE: 'ACTIVE',
  CANCELED: 'ACTIVE', SUSPENDED: 'SUSPENDED', ENDED: 'CANCELLED',
};

export function effectiveStatus(company: { subscriptionStatus?: string | null; status?: string | null }): SubscriptionStatus {
  if (company.subscriptionStatus && (SUBSCRIPTION_STATUSES as readonly string[]).includes(company.subscriptionStatus)) {
    return company.subscriptionStatus as SubscriptionStatus;
  }
  return FROM_LEGACY[String(company.status ?? '').toUpperCase()] ?? 'PENDING_ACTIVATION';
}

/**
 * Qué puede hacer la empresa en cada estado:
 *  - FULL: todo (incluidos prueba, pago pendiente, gracia y cancelada hasta fin de periodo).
 *  - READ_ONLY: suspendida o finalizada → consulta, facturación y pago; nada más.
 *    El bot no responde (las conversaciones pasan a una persona).
 *  - El alta (PENDING_ACTIVATION) conserva el comportamiento anterior (FULL):
 *    hoy las empresas en alta configuran su cuenta antes de pagar.
 */
export function accessFor(status: SubscriptionStatus): 'FULL' | 'READ_ONLY' {
  return status === 'SUSPENDED' || status === 'ENDED' ? 'READ_ONLY' : 'FULL';
}

/** Clave de idempotencia de un cambio → _id del evento (repetirlo no duplica). */
export const subscriptionEventId = (companyId: string, key: string) => deterministicId('sev', companyId, key);

/**
 * Política comercial de cobro. Lo que no está definido queda en null y el
 * sistema NO lo inventa: sin días de gracia no hay suspensión automática.
 */
export interface BillingPolicy {
  /** Días después del vencimiento de una factura para pasar a gracia → suspensión. null = decisión pendiente (solo se marca) */
  graceDays: number | null;
  /** Días que una factura emitida tiene para pagarse antes de considerarse vencida */
  dueDays: number | null;
}

export const DEFAULT_POLICY: BillingPolicy = { graceDays: null, dueDays: null };

export function readPolicy(json: string | null | undefined): BillingPolicy {
  try {
    const p = json ? JSON.parse(json) : {};
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 365 ? v : null);
    return { graceDays: n(p.graceDays), dueDays: n(p.dueDays) };
  } catch {
    return DEFAULT_POLICY;
  }
}

/** Fin de un periodo: mismo día del mes siguiente (o 12 meses si es anual). */
export function periodEndFrom(start: Date, cycle: string | null | undefined) {
  // En UTC: con la hora local, un periodo que empieza el 1 a medianoche UTC terminaba un día antes
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + (cycle === 'ANNUAL' ? 12 : 1));
  return end;
}
