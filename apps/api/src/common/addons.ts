/**
 * Complementos (add-ons) por empresa: catálogo con precios editables y el
 * estado de cada uno en Company.addonsJson:
 *   { [key]: { enabled, qty?, price?, since?, until?, requestedAt?, credits? } }
 *
 * Cobro: un complemento se cobra en cada mes en que estuvo activo al menos un
 * día. Por eso el cliente puede apagarlo hasta un día antes de la fecha de pago
 * (el día 1): si lo apaga el 30, ese mes siguiente ya no aparece.
 * La activación la hace el equipo (hay que configurarlo); el cliente lo pide.
 */
import { ADDONS, type AddonDef, type AddonKey } from './offer';

export interface AddonState {
  enabled: boolean;
  qty?: number;
  price?: number;
  since?: string | null;
  until?: string | null;
  requestedAt?: string | null;
  credits?: number;
}

const CATALOG_KEY = 'ADDON_CATALOG';

export function readAddonStates(company: { addonsJson?: string | null }): Record<string, AddonState> {
  try {
    const raw = company?.addonsJson ? JSON.parse(company.addonsJson) : {};
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** Catálogo con los precios/estados que haya ajustado el equipo. */
export async function addonCatalog(prisma: any): Promise<AddonDef[]> {
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: [CATALOG_KEY, 'SOCIAL_ADDON_PRICE'] } } });
  let overrides: Record<string, { price?: number; status?: string }> = {};
  try {
    overrides = JSON.parse(rows.find((r: any) => r.key === CATALOG_KEY)?.value ?? '{}');
  } catch {
    overrides = {};
  }
  const socialPrice = Number(rows.find((r: any) => r.key === 'SOCIAL_ADDON_PRICE')?.value);
  return ADDONS.map((a) => {
    const o = overrides[a.key] ?? {};
    const price = Number.isFinite(Number(o.price)) && Number(o.price) >= 0
      ? Number(o.price)
      : a.key === 'social' && socialPrice > 0 ? socialPrice : a.price;
    const status = o.status === 'AVAILABLE' || o.status === 'SOON' ? o.status : a.status;
    return { ...a, price, status };
  });
}

export async function saveAddonCatalog(prisma: any, overrides: Record<string, { price?: number; status?: string }>) {
  const clean: Record<string, { price?: number; status?: string }> = {};
  for (const a of ADDONS) {
    const o = overrides?.[a.key];
    if (!o) continue;
    clean[a.key] = {
      ...(Number.isFinite(Number(o.price)) && Number(o.price) >= 0 ? { price: Math.round(Number(o.price)) } : {}),
      ...(o.status === 'AVAILABLE' || o.status === 'SOON' ? { status: o.status } : {}),
    };
  }
  const value = JSON.stringify(clean);
  const existing = await prisma.platformSetting.findUnique({ where: { key: CATALOG_KEY } });
  if (existing) await prisma.platformSetting.update({ where: { key: CATALOG_KEY }, data: { value } });
  else await prisma.platformSetting.create({ data: { key: CATALOG_KEY, value } });
  return addonCatalog(prisma);
}

function periodBounds(period: string) {
  const [y, m] = period.split('-').map(Number);
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

/** ¿Estuvo activo al menos un día dentro del mes? */
export function activeDuring(state: AddonState | undefined, period: string): boolean {
  if (!state) return false;
  const { start, end } = periodBounds(period);
  const since = state.since ? new Date(state.since) : null;
  const until = state.until ? new Date(state.until) : null;
  if (!state.enabled && !until) return false;
  if (since && since >= end) return false;
  if (until && until <= start) return false;
  return true;
}

/** Líneas de complementos para la factura del mes. */
export function addonLinesFor(company: { addonsJson?: string | null }, catalog: AddonDef[], period: string) {
  const states = readAddonStates(company);
  const lines: Array<{ concept: string; amount: number }> = [];
  for (const def of catalog) {
    const st = states[def.key];
    if (!activeDuring(st, period)) continue;
    const qty = def.perUnit ? Math.max(1, Math.round(st?.qty ?? 1)) : 1;
    const unit = st?.price != null && st.price >= 0 ? st.price : def.price;
    if (unit <= 0) continue;
    lines.push({
      concept: `Complemento · ${def.name}${def.perUnit && qty > 1 ? ` (${qty} ${def.perUnit}s)` : ''}${def.key === 'social' && st?.credits ? ` · ${st.credits} créditos/mes` : ''}`,
      amount: unit * qty,
    });
  }
  return lines;
}

/** Fecha límite para apagar un complemento sin que se cobre el próximo mes. */
export function cancelDeadline(now = new Date()): Date {
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return new Date(next.getTime() - 1); // último instante antes del día de pago
}

export function isAddonKey(v: unknown): v is AddonKey {
  return typeof v === 'string' && ADDONS.some((a) => a.key === v);
}
