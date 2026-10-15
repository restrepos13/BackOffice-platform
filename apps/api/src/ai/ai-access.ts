import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';

/**
 * Acceso a la IA por empresa — un solo lugar decide con qué llave se llama y
 * quién paga (las dos son cuentas de DeepInfra):
 *  - BYOK: llave propia del cliente (paga directo a DeepInfra; no se factura).
 *  - PLATFORM: llave de BackOffice (IA revendida); el consumo se registra como
 *    billedTo PLATFORM, se cuenta por conversación, el excedente se factura y se
 *    corta al llegar al tope mensual (aiSpendCapUsd).
 *  - HYBRID: las dos. Va primero la elegida en aiHybridPrimary y, si no está
 *    disponible (sin llave, tope) o DeepInfra la rechaza (401/402/403: llave
 *    inválida o sin saldo), la conversación sigue con la otra — jamás se pierde.
 * Cada asistente puede fijar su propia fuente (Bot.aiSource) para venderle a la
 * empresa un bot puntual con la IA de BackOffice.
 * Motor, agente, reportes, marketing y Dev Tools pasan TODOS por aquí.
 */

/** Quién paga una llamada concreta. */
export type AiBilling = 'BYOK' | 'PLATFORM';
/** Configuración de la empresa (o del asistente). */
export type AiMode = 'BYOK' | 'PLATFORM' | 'HYBRID';

export interface AiKey {
  apiKey: string;
  billedTo: AiBilling;
}

type AiDenied = {
  ok: false;
  code: 'NO_KEY' | 'NO_PLATFORM_KEY' | 'CAP_REACHED' | 'NO_CREDITS' | 'NO_AI';
  reason: string;
};

export type AiAccess = ({ ok: true } & AiKey & { fallback?: AiKey; mode: AiMode }) | AiDenied;

export function normalizeAiMode(value: unknown): AiMode {
  return value === 'PLATFORM' || value === 'HYBRID' ? value : 'BYOK';
}

/** Lee la llave BYOK guardada (cifrada o texto plano legado). */
export function readCompanyKey(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!isEncrypted(stored)) return stored;
  try {
    return decryptSecret(stored);
  } catch {
    return null; // llave maestra distinta: se trata como sin llave (no explota)
  }
}

/** Prepara la llave BYOK para guardar: cifrada si hay llave maestra. */
export function storeCompanyKey(plain: string | null | undefined): string | null {
  const value = (plain ?? '').trim();
  if (!value) return null;
  try {
    return encryptSecret(value);
  } catch {
    return value; // sin MASTER_ENCRYPTION_KEY (dev): se guarda como antes
  }
}

/** Máscara para mostrar en el panel: jamás sale la llave completa. */
export function maskCompanyKey(stored: string | null | undefined): string | null {
  const key = readCompanyKey(stored);
  return key ? `••••${key.slice(-4)}` : null;
}

/** Llave de BackOffice: .env del servidor o Dev Tools → Settings (DEEPINFRA_API_KEY). */
export async function platformAiKey(prisma?: any): Promise<string | null> {
  const fromEnv = process.env.DEEPINFRA_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (!prisma) return null;
  const row = await prisma.platformSetting.findUnique({ where: { key: 'DEEPINFRA_API_KEY' } });
  return row?.value?.trim() || null;
}

/** Inicio del mes calendario en curso (UTC) — periodo de lo incluido en el plan. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/* ─── Saldo prepago de IA de BackOffice ──────────────────────────────
 * 1 crédito = 1 conversación atendida por la IA de BackOffice en una ventana
 * de 24 h (igual que cuenta Meta), o 1 consulta fuera de chat (reportes,
 * marketing). Primero se usa lo incluido en el plan del mes; después los
 * paquetes, del más antiguo al más nuevo (FIFO), y vencen a los 12 meses.
 */

export const CREDIT_WINDOW_MS = 24 * 3600e3;
/** Aviso de saldo bajo: queda ≤ 20 % del último paquete. */
export const LOW_BALANCE_RATIO = 0.2;

export interface AiCredits {
  mode: AiMode;
  period: string; // YYYY-MM
  includedMonthly: number;
  includedUsed: number;
  includedLeft: number;
  balance: number; // créditos prepagos vigentes
  available: number; // includedLeft + balance
  usedThisMonth: number;
  nextExpiry: Date | null;
  lowBalance: boolean;
  spendUsd: number; // costo real del mes con la llave de BackOffice
  capUsd: number | null;
  capPct: number | null;
  capReached: boolean;
}

export async function computeAiCredits(prisma: any, company: any, now = new Date()): Promise<AiCredits> {
  const since = monthStart(now);
  const [plan, usesThisMonth, lots, events] = await Promise.all([
    company.planId ? prisma.plan.findUnique({ where: { id: company.planId } }) : null,
    prisma.aiCreditUse.findMany({
      where: { companyId: company.id, createdAt: { gte: since } },
      select: { fromIncluded: true },
    }),
    prisma.aiCreditLot.findMany({
      where: { companyId: company.id, expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.aiUsageEvent.findMany({
      where: { companyId: company.id, billedTo: 'PLATFORM', createdAt: { gte: since } },
      select: { costUsd: true },
    }),
  ]);
  const includedMonthly = Number(company.aiIncludedOverride ?? plan?.includedAiConversations ?? 0);
  const includedUsed = usesThisMonth.filter((u: any) => u.fromIncluded).length;
  const includedLeft = Math.max(0, includedMonthly - includedUsed);
  const balance = lots.reduce((sum: number, l: any) => sum + Math.max(0, l.remaining), 0);
  const lastLot = lots[lots.length - 1];
  const spendUsd = Math.round(events.reduce((sum: number, e: any) => sum + (e.costUsd ?? 0), 0) * 1e4) / 1e4;
  const capUsd = company.aiSpendCapUsd ?? null;
  return {
    mode: normalizeAiMode(company.aiBillingMode),
    period: since.toISOString().slice(0, 7),
    includedMonthly,
    includedUsed,
    includedLeft,
    balance,
    available: includedLeft + balance,
    usedThisMonth: usesThisMonth.length,
    nextExpiry: lots.find((l: any) => l.remaining > 0)?.expiresAt ?? null,
    lowBalance: includedLeft === 0 && !!lastLot && balance <= lastLot.total * LOW_BALANCE_RATIO,
    spendUsd,
    capUsd,
    capPct: capUsd ? Math.round((spendUsd / capUsd) * 1000) / 10 : null,
    capReached: capUsd != null && spendUsd >= capUsd,
  };
}

/** ¿Esta conversación ya pagó su crédito en las últimas 24 h? */
async function chargedRecently(prisma: any, companyId: string, conversationId: string | null | undefined, now: Date) {
  if (!conversationId) return false;
  const recent = await prisma.aiCreditUse.findFirst({
    where: { companyId, conversationId, createdAt: { gte: new Date(now.getTime() - CREDIT_WINDOW_MS) } },
  });
  return !!recent;
}

/**
 * Descuenta 1 crédito (si corresponde). Devuelve si hay que avisar saldo
 * bajo o agotado. Idempotente por conversación dentro de la ventana de 24 h.
 */
export async function consumeAiCredit(
  prisma: any,
  company: any,
  opts: { conversationId?: string | null; purpose?: string; now?: Date } = {},
): Promise<{ charged: boolean; source: 'INCLUDED' | 'PREPAID' | 'NONE'; alert: 'LOW' | 'EMPTY' | null }> {
  const now = opts.now ?? new Date();
  if (await chargedRecently(prisma, company.id, opts.conversationId, now)) {
    return { charged: false, source: 'NONE', alert: null };
  }
  const credits = await computeAiCredits(prisma, company, now);
  const purpose = opts.purpose ?? (opts.conversationId ? 'CHAT' : 'CONSULTA');
  if (credits.includedLeft > 0) {
    await prisma.aiCreditUse.create({
      data: { companyId: company.id, conversationId: opts.conversationId ?? null, purpose, fromIncluded: true },
    });
    return { charged: true, source: 'INCLUDED', alert: null };
  }
  // FIFO sobre lotes vigentes; el updateMany condicional evita sobregiros concurrentes
  const lots = await prisma.aiCreditLot.findMany({
    where: { companyId: company.id, expiresAt: { gt: now }, remaining: { gt: 0 } },
    orderBy: { createdAt: 'asc' },
  });
  for (const lot of lots) {
    const res = await prisma.aiCreditLot.updateMany({
      where: { id: lot.id, remaining: { gt: 0 } },
      data: { remaining: { decrement: 1 } },
    });
    if (res.count === 0) continue;
    await prisma.aiCreditUse.create({
      data: { companyId: company.id, conversationId: opts.conversationId ?? null, purpose, lotId: lot.id },
    });
    const after = credits.balance - 1;
    const lastLot = lots[lots.length - 1];
    let alert: 'LOW' | 'EMPTY' | null = null;
    if (after <= 0 && !lastLot.alertedEmpty) {
      alert = 'EMPTY';
      await prisma.aiCreditLot.updateMany({ where: { id: lastLot.id }, data: { alertedEmpty: true, alertedLow: true } });
    } else if (after <= lastLot.total * LOW_BALANCE_RATIO && !lastLot.alertedLow) {
      alert = 'LOW';
      await prisma.aiCreditLot.updateMany({ where: { id: lastLot.id }, data: { alertedLow: true } });
    }
    return { charged: true, source: 'PREPAID', alert };
  }
  return { charged: false, source: 'NONE', alert: 'EMPTY' };
}

/** Acredita un paquete (compra aprobada) o un regalo de plataforma. */
export async function creditAiLot(
  prisma: any,
  input: {
    companyId: string; conversations: number; source: 'PURCHASE' | 'GRANT';
    validityMonths?: number; packageId?: string | null; paymentRef?: string | null;
    note?: string | null; createdBy?: string | null; now?: Date;
  },
) {
  const now = input.now ?? new Date();
  if (input.paymentRef) {
    const existing = await prisma.aiCreditLot.findFirst({ where: { paymentRef: input.paymentRef } });
    if (existing) return existing; // webhook repetido: no duplica saldo
  }
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + (input.validityMonths ?? 12));
  const total = Math.max(1, Math.round(input.conversations));
  return prisma.aiCreditLot.create({
    data: {
      companyId: input.companyId, source: input.source, packageId: input.packageId ?? null,
      total, remaining: total, expiresAt, paymentRef: input.paymentRef ?? null,
      note: input.note ?? null, createdBy: input.createdBy ?? null,
    },
  });
}

async function platformCandidate(
  prisma: any,
  company: any,
  conversationId?: string | null,
): Promise<AiKey | AiDenied> {
  const key = await platformAiKey(prisma);
  if (!key) {
    return {
      ok: false,
      code: 'NO_PLATFORM_KEY',
      reason: 'La IA de BackOffice no está configurada (DEEPINFRA_API_KEY en .env o Dev Tools → Settings)',
    };
  }
  const credits = await computeAiCredits(prisma, company);
  if (credits.capReached) {
    return { ok: false, code: 'CAP_REACHED', reason: `Se alcanzó el tope mensual de IA (USD ${credits.capUsd})` };
  }
  if (credits.available <= 0 && !(await chargedRecently(prisma, company.id, conversationId, new Date()))) {
    return {
      ok: false,
      code: 'NO_CREDITS',
      reason: 'Sin saldo de IA de BackOffice: recarga un paquete en Consumo IA',
    };
  }
  return { apiKey: key, billedTo: 'PLATFORM' };
}

function byokCandidate(company: any): AiKey | AiDenied {
  const key = readCompanyKey(company.deepinfraApiKey);
  if (!key) {
    return {
      ok: false,
      code: 'NO_KEY',
      reason: 'La organización no tiene llave de DeepInfra configurada (Configuración → IA)',
    };
  }
  return { apiKey: key, billedTo: 'BYOK' };
}

const isDenied = (c: AiKey | AiDenied): c is AiDenied => (c as AiDenied).ok === false;

/**
 * Modo efectivo de una llamada: el del asistente si lo fija (aiSource), si no
 * el de la empresa.
 */
export function effectiveAiMode(company: any, bot?: any): AiMode {
  if (bot?.aiSource && bot.aiSource !== 'INHERIT') return normalizeAiMode(bot.aiSource);
  return normalizeAiMode(company.aiBillingMode);
}

/**
 * Decide la(s) llave(s) de una llamada. En PLATFORM revisa el tope ANTES de
 * gastar. En HYBRID devuelve la principal + la de respaldo disponibles.
 */
export async function resolveAiAccess(
  prisma: any,
  company: any,
  bot?: any,
  ctx: { conversationId?: string | null } = {},
): Promise<AiAccess> {
  const mode = effectiveAiMode(company, bot);
  if (mode === 'PLATFORM') {
    const c = await platformCandidate(prisma, company, ctx.conversationId);
    return isDenied(c) ? c : { ok: true, ...c, mode };
  }
  if (mode === 'BYOK') {
    const c = byokCandidate(company);
    return isDenied(c) ? c : { ok: true, ...c, mode };
  }
  // HYBRID: principal primero; la otra queda de respaldo si está disponible
  const platformFirst = company.aiHybridPrimary === 'PLATFORM';
  const first = platformFirst ? await platformCandidate(prisma, company, ctx.conversationId) : byokCandidate(company);
  const second = platformFirst ? byokCandidate(company) : await platformCandidate(prisma, company, ctx.conversationId);
  const available = [first, second].filter((c): c is AiKey => !isDenied(c));
  if (available.length === 0) {
    return {
      ok: false,
      code: 'NO_AI',
      reason: `Sin IA disponible: ${(first as AiDenied).reason}; y ${(second as AiDenied).reason.charAt(0).toLowerCase()}${(second as AiDenied).reason.slice(1)}`,
    };
  }
  return { ok: true, ...available[0], fallback: available[1], mode };
}

/** DeepInfra rechazó la llave (inválida, sin saldo o sin permiso). */
export function isKeyRejected(err: unknown): boolean {
  const status = (err as any)?.providerStatus;
  return status === 401 || status === 402 || status === 403;
}

/**
 * Sesión de IA de una corrida (un mensaje, una consulta): usa la llave
 * principal y, si DeepInfra la rechaza, pasa a la de respaldo y se queda con
 * ella el resto de la corrida. `billedTo` dice quién pagó cada llamada.
 */
export class AiSession {
  private current: AiKey;
  private fallback?: AiKey;
  /** true si en esta corrida hubo que pasar a la llave de respaldo */
  switched = false;

  constructor(access: AiKey & { fallback?: AiKey }) {
    this.current = { apiKey: access.apiKey, billedTo: access.billedTo };
    this.fallback = access.fallback;
  }

  get billedTo(): AiBilling {
    return this.current.billedTo;
  }

  async run<T>(fn: (apiKey: string) => Promise<T>): Promise<{ result: T; billedTo: AiBilling }> {
    try {
      return { result: await fn(this.current.apiKey), billedTo: this.current.billedTo };
    } catch (err) {
      if (!this.fallback || !isKeyRejected(err)) throw err;
      this.current = this.fallback;
      this.fallback = undefined;
      this.switched = true;
      return { result: await fn(this.current.apiKey), billedTo: this.current.billedTo };
    }
  }
}

/**
 * Un registro por llamada al modelo, con el costo declarado del catálogo.
 * Si la pagó BackOffice, descuenta el crédito (1 por conversación cada 24 h)
 * y devuelve si hay que avisar saldo bajo o agotado.
 */
export async function recordAiUsage(
  prisma: any,
  entry: {
    companyId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    billedTo: AiBilling;
    integrationId?: string | null;
    botId?: string | null;
    conversationId?: string | null;
    purpose?: string;
  },
): Promise<{ alert: 'LOW' | 'EMPTY' | null }> {
  const catalogEntry = await prisma.aiModel.findUnique({ where: { modelId: entry.model } });
  const costUsd = catalogEntry
    ? (entry.inputTokens * catalogEntry.inputCostPerMTok +
        entry.outputTokens * catalogEntry.outputCostPerMTok) / 1_000_000
    : 0;
  await prisma.aiUsageEvent.create({
    data: {
      companyId: entry.companyId,
      integrationId: entry.integrationId ?? null,
      botId: entry.botId ?? null,
      conversationId: entry.conversationId ?? null,
      model: entry.model,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      billedTo: entry.billedTo,
    },
  });
  if (entry.billedTo !== 'PLATFORM') return { alert: null };
  const company = await prisma.company.findUnique({ where: { id: entry.companyId } });
  if (!company) return { alert: null };
  const result = await consumeAiCredit(prisma, company, {
    conversationId: entry.conversationId, purpose: entry.purpose,
  });
  if (result.alert) {
    // Queda registrado (y el panel muestra el aviso con el saldo actual)
    await prisma.auditLog.create({
      data: {
        actorName: 'Sistema', companyId: entry.companyId,
        action: result.alert === 'EMPTY' ? 'ai.credits_empty' : 'ai.credits_low',
        entity: 'AiCreditLot',
        detail: result.alert === 'EMPTY'
          ? 'Se agotó el saldo de IA de BackOffice'
          : 'Queda poco saldo de IA de BackOffice (≤ 20 % del último paquete)',
      },
    });
  }
  return { alert: result.alert };
}
