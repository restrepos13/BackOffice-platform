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

type AiDenied = { ok: false; code: 'NO_KEY' | 'NO_PLATFORM_KEY' | 'CAP_REACHED' | 'NO_AI'; reason: string };

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

/** Inicio del mes calendario en curso (UTC) — periodo de topes y facturación. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface AiQuota {
  mode: AiMode;
  period: string; // YYYY-MM
  conversations: number; // conversaciones IA del mes (PLATFORM)
  included: number;
  extra: number; // conversaciones por encima de las incluidas
  spendUsd: number; // costo real del mes con la llave de BackOffice
  capUsd: number | null;
  capPct: number | null; // 0..100+
  capReached: boolean;
}

/**
 * Consumo de un mes en modo PLATFORM vs incluidas y tope.
 * Sin rango = mes en curso; la facturación pasa el rango del período cerrado.
 */
export async function computeAiQuota(
  prisma: any,
  company: any,
  now = new Date(),
  range?: { from: Date; to: Date },
): Promise<AiQuota & { extraChargeUsd: number; extraPriceUsd: number }> {
  const since = range?.from ?? monthStart(now);
  const mode = normalizeAiMode(company.aiBillingMode);
  const events: Array<{ conversationId: string | null; costUsd: number }> =
    await prisma.aiUsageEvent.findMany({
      where: {
        companyId: company.id,
        billedTo: 'PLATFORM',
        createdAt: range ? { gte: range.from, lt: range.to } : { gte: since },
      },
      select: { conversationId: true, costUsd: true },
    });
  const conversations = new Set(events.map((e) => e.conversationId).filter(Boolean)).size;
  const spendUsd = Math.round(events.reduce((sum, e) => sum + (e.costUsd ?? 0), 0) * 1e4) / 1e4;
  const plan = company.planId
    ? await prisma.plan.findUnique({ where: { id: company.planId } })
    : null;
  const included = Number(company.aiIncludedOverride ?? plan?.includedAiConversations ?? 0);
  const extraPriceUsd = Number(plan?.extraAiConversationUsd ?? 0);
  const capUsd = company.aiSpendCapUsd ?? null;
  const capPct = capUsd ? Math.round((spendUsd / capUsd) * 1000) / 10 : null;
  const extra = Math.max(0, conversations - included);
  return {
    mode,
    period: since.toISOString().slice(0, 7),
    conversations,
    included,
    extra,
    extraPriceUsd,
    // Excedente facturable: solo cuenta lo que pagó BackOffice (PLATFORM, sea por
    // modo de la empresa, híbrido o un asistente vendido aparte); BYOK nunca
    extraChargeUsd: Math.round(extra * extraPriceUsd * 100) / 100,
    spendUsd,
    capUsd,
    capPct,
    capReached: capUsd != null && spendUsd >= capUsd,
  };
}

async function platformCandidate(prisma: any, company: any): Promise<AiKey | AiDenied> {
  const key = await platformAiKey(prisma);
  if (!key) {
    return {
      ok: false,
      code: 'NO_PLATFORM_KEY',
      reason: 'La IA de BackOffice no está configurada (DEEPINFRA_API_KEY en .env o Dev Tools → Settings)',
    };
  }
  if (company.aiSpendCapUsd != null) {
    const quota = await computeAiQuota(prisma, company);
    if (quota.capReached) {
      return { ok: false, code: 'CAP_REACHED', reason: `Se alcanzó el tope mensual de IA (USD ${quota.capUsd})` };
    }
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
export async function resolveAiAccess(prisma: any, company: any, bot?: any): Promise<AiAccess> {
  const mode = effectiveAiMode(company, bot);
  if (mode === 'PLATFORM') {
    const c = await platformCandidate(prisma, company);
    return isDenied(c) ? c : { ok: true, ...c, mode };
  }
  if (mode === 'BYOK') {
    const c = byokCandidate(company);
    return isDenied(c) ? c : { ok: true, ...c, mode };
  }
  // HYBRID: principal primero; la otra queda de respaldo si está disponible
  const platformFirst = company.aiHybridPrimary === 'PLATFORM';
  const first = platformFirst ? await platformCandidate(prisma, company) : byokCandidate(company);
  const second = platformFirst ? byokCandidate(company) : await platformCandidate(prisma, company);
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

/** Un registro por llamada al modelo, con el costo declarado del catálogo. */
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
  },
) {
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
}
