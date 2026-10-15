import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';

/**
 * Acceso a la IA por empresa — un solo lugar decide con qué llave se llama y
 * quién paga:
 *  - BYOK: llave propia del cliente (paga directo a DeepInfra; no se factura).
 *  - PLATFORM: llave de BackOffice (DEEPINFRA_API_KEY del servidor); el consumo
 *    se registra como billedTo PLATFORM, se cuenta por conversación y se corta
 *    al llegar al tope mensual (aiSpendCapUsd).
 * Motor, reportes, marketing y Dev Tools pasan TODOS por aquí.
 */

export type AiBilling = 'BYOK' | 'PLATFORM';

export type AiAccess =
  | { ok: true; apiKey: string; billedTo: AiBilling }
  | { ok: false; code: 'NO_KEY' | 'NO_PLATFORM_KEY' | 'CAP_REACHED'; reason: string };

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
  mode: AiBilling;
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
  const mode: AiBilling = company.aiBillingMode === 'PLATFORM' ? 'PLATFORM' : 'BYOK';
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
    // Excedente facturable: solo en modo PLATFORM (BYOK lo paga el cliente directo)
    extraChargeUsd: mode === 'PLATFORM' ? Math.round(extra * extraPriceUsd * 100) / 100 : 0,
    spendUsd,
    capUsd,
    capPct,
    capReached: capUsd != null && spendUsd >= capUsd,
  };
}

/**
 * Decide la llave de una llamada. En PLATFORM revisa el tope ANTES de gastar:
 * con el tope alcanzado la IA se detiene (el motor escala a una persona).
 */
export async function resolveAiAccess(prisma: any, company: any): Promise<AiAccess> {
  if (company.aiBillingMode === 'PLATFORM') {
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
        return {
          ok: false,
          code: 'CAP_REACHED',
          reason: `Se alcanzó el tope mensual de IA (USD ${quota.capUsd})`,
        };
      }
    }
    return { ok: true, apiKey: key, billedTo: 'PLATFORM' };
  }
  const key = readCompanyKey(company.deepinfraApiKey);
  if (!key) {
    return {
      ok: false,
      code: 'NO_KEY',
      reason: 'La organización no tiene llave de DeepInfra configurada (Configuración → IA)',
    };
  }
  return { ok: true, apiKey: key, billedTo: 'BYOK' };
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
