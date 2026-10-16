/**
 * Extra "Redes sociales con IA" (sobrecosto mensual por empresa, lo paga en
 * su factura; la IA que genera imágenes y videos la paga BackOffice).
 *  - Créditos al mes: imagen = 1, video = 4 → 20 créditos = 20 imágenes o 5 videos.
 *  - Precio y créditos por empresa (Company.addonsJson.social), con valores por
 *    defecto en Dev Tools (SOCIAL_ADDON_PRICE / SOCIAL_ADDON_CREDITS).
 *  - Cada generación registra su costo real estimado (SocialUsage.costUsd) para
 *    ver el margen del extra empresa por empresa.
 */
import { periodOf } from './billing-engine';

export const CREDIT_COST = { image: 1, video: 4 } as const;
export const DEFAULT_SOCIAL_PRICE = 150000;
export const DEFAULT_SOCIAL_CREDITS = 20;

/** Costo de referencia por generación (USD, oct 2026; se ajusta con el precio real). */
export const PROVIDER_COST_USD: Record<string, number> = {
  'deepinfra:black-forest-labs/FLUX-1-schnell': 0.0005,
  'deepinfra:black-forest-labs/FLUX-1-dev': 0.009,
  'deepinfra:black-forest-labs/FLUX-1.1-pro': 0.04,
  'gemini:gemini-2.5-flash-image': 0.039,
  'gemini:gemini-3.1-flash-image': 0.039,
  'simulado:placeholder': 0,
  'mpt:video': 0.02, // MoneyPrinterTurbo: stock + voz (solo cómputo propio)
  'higgsfield:video-10s': 0.7, // Kling 2.6 ≈ $0.07/s
};

export interface SocialAddon {
  enabled: boolean;
  price: number;
  credits: number;
}

export function readAddons(company: { addonsJson?: string | null }): Record<string, any> {
  try {
    return company?.addonsJson ? JSON.parse(company.addonsJson) : {};
  } catch {
    return {};
  }
}

export function socialAddon(company: { addonsJson?: string | null }, defaults?: { price?: number; credits?: number }): SocialAddon {
  const raw = readAddons(company).social ?? {};
  const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  return {
    enabled: raw.enabled === true,
    price: num(raw.price, defaults?.price ?? DEFAULT_SOCIAL_PRICE),
    credits: Math.round(num(raw.credits, defaults?.credits ?? DEFAULT_SOCIAL_CREDITS)),
  };
}

/** Líneas de extras que van a la factura del mes. */
export function addonInvoiceLines(company: { addonsJson?: string | null }): Array<{ concept: string; amount: number }> {
  const social = socialAddon(company);
  return social.enabled && social.price > 0
    ? [{ concept: `Extra · Redes sociales con IA (${social.credits} créditos/mes)`, amount: social.price }]
    : [];
}

export async function socialDefaults(prisma: any) {
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: ['SOCIAL_ADDON_PRICE', 'SOCIAL_ADDON_CREDITS'] } } });
  const get = (k: string) => Number(rows.find((r: any) => r.key === k)?.value);
  return {
    price: Number.isFinite(get('SOCIAL_ADDON_PRICE')) && get('SOCIAL_ADDON_PRICE') > 0 ? get('SOCIAL_ADDON_PRICE') : DEFAULT_SOCIAL_PRICE,
    credits: Number.isFinite(get('SOCIAL_ADDON_CREDITS')) && get('SOCIAL_ADDON_CREDITS') > 0 ? get('SOCIAL_ADDON_CREDITS') : DEFAULT_SOCIAL_CREDITS,
  };
}

export async function socialUsage(prisma: any, companyId: string, period = periodOf()) {
  const row = await prisma.socialUsage.findFirst({ where: { companyId, period } });
  return { images: row?.images ?? 0, videos: row?.videos ?? 0, credits: row?.credits ?? 0, costUsd: row?.costUsd ?? 0 };
}

/**
 * Reserva los créditos ANTES de generar (dos clics a la vez no pasan el tope).
 * Devuelve false si no alcanza. Si la generación falla se devuelven con refund.
 */
export async function reserveCredits(prisma: any, companyId: string, limit: number, kind: 'image' | 'video', period = periodOf()) {
  const cost = CREDIT_COST[kind];
  if (cost > limit) return false;
  const existing = await prisma.socialUsage.findFirst({ where: { companyId, period } });
  if (!existing) {
    try {
      await prisma.socialUsage.create({ data: { companyId, period, credits: 0 } });
    } catch {
      /* otro proceso lo creó primero (índice único) */
    }
  }
  const res = await prisma.socialUsage.updateMany({
    where: { companyId, period, credits: { lte: limit - cost } },
    data: { credits: { increment: cost }, ...(kind === 'image' ? { images: { increment: 1 } } : { videos: { increment: 1 } }) },
  });
  return res.count === 1;
}

export async function refundCredits(prisma: any, companyId: string, kind: 'image' | 'video', period = periodOf()) {
  await prisma.socialUsage.updateMany({
    where: { companyId, period },
    data: { credits: { decrement: CREDIT_COST[kind] }, ...(kind === 'image' ? { images: { decrement: 1 } } : { videos: { decrement: 1 } }) },
  });
}

export async function addSocialCost(prisma: any, companyId: string, usd: number, period = periodOf()) {
  if (!(usd > 0)) return;
  await prisma.socialUsage.updateMany({ where: { companyId, period }, data: { costUsd: { increment: usd } } });
}
