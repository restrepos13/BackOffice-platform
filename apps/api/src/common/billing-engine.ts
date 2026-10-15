/**
 * Motor de cobro a las empresas — 100% personalizable por mes:
 *  - Base: precio del plan, o el precio pactado con la empresa (customPriceMonthly),
 *    o un ajuste PRICE para ese mes / rango de meses ("este mes se le cobra esto").
 *  - Ajustes: cargos extra (CHARGE) y descuentos fijos o porcentuales (DISCOUNT),
 *    para un solo mes, un rango o recurrentes desde un mes en adelante.
 *  - Consumo al costo: WhatsApp (Meta) y almacenamiento.
 * La IA de BackOffice NO va aquí: se vende en paquetes prepagos (ai-credits).
 * Funciones puras (testeables) + el armado con Prisma.
 */

export type InvoiceLineKind = 'PLAN' | 'CHARGE' | 'DISCOUNT' | 'WHATSAPP' | 'STORAGE' | 'SETUP';

export interface InvoiceLine {
  kind: InvoiceLineKind;
  concept: string;
  amount: number;
  adjustmentId?: string;
}

export interface AdjustmentLike {
  id?: string;
  kind: string; // CHARGE | DISCOUNT | PRICE
  concept: string;
  amount: number;
  percent?: number | null;
  startPeriod: string;
  endPeriod?: string | null;
  recurring?: boolean;
  active?: boolean;
}

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function periodOf(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + months, 1);
  return periodOf(d);
}

/** ¿El ajuste aplica en ese mes? (los YYYY-MM se comparan como texto) */
export function adjustmentApplies(adj: AdjustmentLike, period: string): boolean {
  if (adj.active === false) return false;
  if (period < adj.startPeriod) return false;
  if (adj.endPeriod) return period <= adj.endPeriod;
  return adj.recurring ? true : period === adj.startPeriod;
}

export function roundFor(currency: string, value: number): number {
  return currency === 'COP' ? Math.round(value) : Math.round(value * 100) / 100;
}

/** Arma las líneas y el total de un mes. */
export function buildInvoiceLines(input: {
  period: string;
  currency: string;
  planName: string | null;
  planPrice: number;
  customPrice?: number | null;
  adjustments: AdjustmentLike[];
  whatsappCost?: number; // ya convertido a la moneda de la factura
  storageCost?: number;
}): { lines: InvoiceLine[]; planAmount: number; consumptionAmount: number; total: number } {
  const { currency, period } = input;
  const applicable = input.adjustments.filter((a) => adjustmentApplies(a, period));

  // 1) Base: ajuste PRICE del mes (el más reciente) > precio pactado > plan
  const priceAdj = applicable.filter((a) => a.kind === 'PRICE').pop();
  const base = priceAdj
    ? Math.max(0, priceAdj.amount)
    : input.customPrice != null
      ? Math.max(0, input.customPrice)
      : Math.max(0, input.planPrice);
  const lines: InvoiceLine[] = [];
  if (input.planName || base > 0) {
    lines.push({
      kind: 'PLAN',
      concept: priceAdj
        ? `${input.planName ?? 'Plan'} · ${priceAdj.concept}`
        : input.customPrice != null
          ? `${input.planName ?? 'Plan'} · precio pactado`
          : `Plan ${input.planName ?? ''}`.trim(),
      amount: roundFor(currency, base),
      ...(priceAdj?.id ? { adjustmentId: priceAdj.id } : {}),
    });
  }

  // 2) Cargos (y montaje por salida anticipada), después los descuentos
  for (const adj of applicable.filter((a) => a.kind === 'CHARGE' || a.kind === 'SETUP')) {
    lines.push({
      kind: adj.kind as InvoiceLineKind,
      concept: adj.concept,
      amount: roundFor(currency, Math.max(0, adj.amount)),
      adjustmentId: adj.id,
    });
  }
  for (const adj of applicable.filter((a) => a.kind === 'DISCOUNT')) {
    const value = adj.percent != null ? (base * Math.min(Math.max(adj.percent, 0), 100)) / 100 : Math.max(0, adj.amount);
    lines.push({
      kind: 'DISCOUNT',
      concept: adj.percent != null ? `${adj.concept} (${adj.percent}%)` : adj.concept,
      amount: -roundFor(currency, value),
      adjustmentId: adj.id,
    });
  }

  // 3) Consumo al costo
  if ((input.whatsappCost ?? 0) > 0) {
    lines.push({ kind: 'WHATSAPP', concept: 'Mensajes de WhatsApp (Meta, al costo)', amount: roundFor(currency, input.whatsappCost!) });
  }
  if ((input.storageCost ?? 0) > 0) {
    lines.push({ kind: 'STORAGE', concept: 'Almacenamiento', amount: roundFor(currency, input.storageCost!) });
  }

  return summarize(lines, currency);
}

/** Totales de un conjunto de líneas (también para facturas editadas a mano). */
export function summarize(lines: InvoiceLine[], currency: string) {
  const planAmount = roundFor(
    currency,
    lines.filter((l) => ['PLAN', 'CHARGE', 'DISCOUNT', 'SETUP'].includes(l.kind)).reduce((s, l) => s + l.amount, 0),
  );
  const consumptionAmount = roundFor(
    currency,
    lines.filter((l) => l.kind === 'WHATSAPP' || l.kind === 'STORAGE').reduce((s, l) => s + l.amount, 0),
  );
  const total = Math.max(0, roundFor(currency, planAmount + consumptionAmount));
  return { lines, planAmount, consumptionAmount, total };
}

/** Valida líneas editadas a mano en una factura pendiente. */
export function sanitizeLines(raw: unknown, currency: string): InvoiceLine[] {
  if (!Array.isArray(raw)) return [];
  const kinds: InvoiceLineKind[] = ['PLAN', 'CHARGE', 'DISCOUNT', 'WHATSAPP', 'STORAGE', 'SETUP'];
  return raw
    .filter((l: any) => l && kinds.includes(l.kind) && typeof l.concept === 'string' && Number.isFinite(Number(l.amount)))
    .slice(0, 40)
    .map((l: any) => {
      const amount = roundFor(currency, Number(l.amount));
      return {
        kind: l.kind,
        concept: String(l.concept).trim().slice(0, 140) || 'Concepto',
        // los descuentos siempre restan; lo demás siempre suma
        amount: l.kind === 'DISCOUNT' ? -Math.abs(amount) : Math.abs(amount),
      };
    });
}

/**
 * Salida anticipada: cobro proporcional del montaje por los meses que faltan
 * para cumplir la permanencia (el montaje fue gratis con permanencia).
 */
export function earlyExitFee(input: {
  contractStartAt: Date | null;
  minTermMonths: number;
  setupFeeValue: number;
  exitAt?: Date;
}): { remainingMonths: number; amount: number } {
  if (!input.contractStartAt || input.minTermMonths <= 0 || input.setupFeeValue <= 0) {
    return { remainingMonths: 0, amount: 0 };
  }
  const exit = input.exitAt ?? new Date();
  const start = input.contractStartAt;
  const elapsed = (exit.getFullYear() - start.getFullYear()) * 12 + (exit.getMonth() - start.getMonth());
  const remainingMonths = Math.max(0, input.minTermMonths - Math.max(0, elapsed));
  return {
    remainingMonths,
    amount: (input.setupFeeValue * remainingMonths) / input.minTermMonths,
  };
}

/** Moneda de facturación de una empresa: la del plan (NEGOCIOS → COP). */
export function invoiceCurrency(company: any): string {
  return company.plan?.currency ?? 'USD';
}

/** Arma la factura (o la vista previa) de un mes con datos reales. */
export async function computeCompanyInvoice(prisma: any, company: any, period: string) {
  const [y, m] = period.split('-').map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 1);
  const currency = invoiceCurrency(company);
  const [adjustments, usage, rateRow] = await Promise.all([
    prisma.billingAdjustment.findMany({ where: { companyId: company.id, active: true }, orderBy: { createdAt: 'asc' } }),
    prisma.usageRecord.findMany({ where: { companyId: company.id, date: { gte: from, lt: to } } }),
    prisma.platformSetting.findUnique({ where: { key: 'USD_COP_RATE' } }),
  ]);
  const rate = Number(rateRow?.value || 4000);
  const toCurrency = (usd: number) => (currency === 'COP' ? usd * rate : usd);
  return buildInvoiceLines({
    period,
    currency,
    planName: company.plan?.name ?? null,
    planPrice: company.plan?.priceMonthly ?? 0,
    customPrice: company.customPriceMonthly,
    adjustments,
    whatsappCost: toCurrency(usage.reduce((s: number, u: any) => s + (u.waCostUsd ?? 0), 0)),
    storageCost: toCurrency(usage.reduce((s: number, u: any) => s + (u.storageCostUsd ?? 0), 0)),
  });
}
