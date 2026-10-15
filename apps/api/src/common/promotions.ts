import { parseJson } from './constants';

/**
 * Promociones y cupones — reglas puras y testeables:
 *  - PERCENT: % sobre los productos que aplica (o todo el pedido)
 *  - FIXED: valor fijo (nunca más que lo que aplica)
 *  - FREE_DELIVERY: el domicilio sale gratis
 * Con código = cupón (lo dice el cliente); sin código = se aplica sola (la
 * mejor que cumpla). Vigencia, mínimo de compra y usos máximos.
 */

export interface PromotionLike {
  id: string;
  code?: string | null;
  name: string;
  kind: string;
  value: number;
  minSubtotal?: number | null;
  productIdsJson?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxUses?: number | null;
  usedCount?: number;
  active?: boolean;
}

export interface PromoContext {
  items: Array<{ productId: string | null; quantity: number; unitPrice: number | null }>;
  subtotal: number;
  deliveryFee: number | null;
  now: Date;
}

export interface PromoResult {
  ok: boolean;
  discount: number; // valor a restar del total (incluye el domicilio si es FREE_DELIVERY)
  freeDelivery: boolean;
  reason?: string;
}

export function normalizeCode(code: string | null | undefined): string | null {
  const c = String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  return c ? c.slice(0, 30) : null;
}

export function evaluatePromotion(promo: PromotionLike, ctx: PromoContext): PromoResult {
  const no = (reason: string): PromoResult => ({ ok: false, discount: 0, freeDelivery: false, reason });
  if (promo.active === false) return no('La promoción no está activa');
  if (promo.startsAt && ctx.now < new Date(promo.startsAt)) return no('La promoción todavía no empieza');
  if (promo.endsAt && ctx.now > new Date(promo.endsAt)) return no('La promoción ya terminó');
  if (promo.maxUses != null && (promo.usedCount ?? 0) >= promo.maxUses) return no('La promoción ya se agotó');
  if (promo.minSubtotal && ctx.subtotal < promo.minSubtotal) {
    return no(`Aplica desde ${promo.minSubtotal} en productos`);
  }
  const restricted = parseJson<string[]>(promo.productIdsJson, []);
  const eligible = restricted.length
    ? ctx.items.filter((i) => i.productId && restricted.includes(i.productId))
    : ctx.items;
  const eligibleSubtotal = eligible.reduce((s, i) => s + (i.unitPrice ?? 0) * i.quantity, 0);
  if (restricted.length && eligible.length === 0) return no('El pedido no tiene los productos de la promoción');

  if (promo.kind === 'FREE_DELIVERY') {
    if (ctx.deliveryFee == null) return no('Aplica solo a domicilios');
    return { ok: true, discount: ctx.deliveryFee, freeDelivery: true };
  }
  if (promo.kind === 'PERCENT') {
    const pct = Math.min(Math.max(promo.value, 0), 100);
    return { ok: true, discount: Math.round((eligibleSubtotal * pct) / 100), freeDelivery: false };
  }
  if (promo.kind === 'FIXED') {
    return { ok: true, discount: Math.round(Math.min(Math.max(promo.value, 0), eligibleSubtotal)), freeDelivery: false };
  }
  return no('Tipo de promoción desconocido');
}

/**
 * Escoge la promoción del pedido: el cupón que dijo el cliente (si es válido)
 * o, sin cupón, la mejor de las automáticas (sin código). Nunca suma dos.
 */
export function pickPromotion(
  promos: PromotionLike[],
  ctx: PromoContext,
  code?: string | null,
): { promo: PromotionLike | null; result: PromoResult } {
  const wanted = normalizeCode(code);
  if (wanted) {
    const promo = promos.find((p) => normalizeCode(p.code) === wanted);
    if (!promo) return { promo: null, result: { ok: false, discount: 0, freeDelivery: false, reason: `El cupón ${wanted} no existe` } };
    return { promo, result: evaluatePromotion(promo, ctx) };
  }
  let best: { promo: PromotionLike; result: PromoResult } | null = null;
  for (const promo of promos.filter((p) => !p.code)) {
    const result = evaluatePromotion(promo, ctx);
    if (result.ok && (!best || result.discount > best.result.discount)) best = { promo, result };
  }
  return best ?? { promo: null, result: { ok: false, discount: 0, freeDelivery: false } };
}

export function validatePromotionInput(dto: any) {
  const kind = String(dto?.kind ?? '');
  if (!['PERCENT', 'FIXED', 'FREE_DELIVERY'].includes(kind)) throw new Error('Tipo inválido (PERCENT, FIXED o FREE_DELIVERY)');
  const name = String(dto?.name ?? '').trim().slice(0, 80);
  if (!name) throw new Error('Ponle un nombre a la promoción');
  const value = Number(dto?.value ?? 0);
  if (kind !== 'FREE_DELIVERY' && (!Number.isFinite(value) || value <= 0)) throw new Error('El valor debe ser mayor a 0');
  if (kind === 'PERCENT' && value > 100) throw new Error('El porcentaje no puede pasar de 100');
  const date = (v: unknown) => {
    if (!v) return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new Error('Fecha inválida');
    return d;
  };
  const startsAt = date(dto?.startsAt);
  const endsAt = date(dto?.endsAt);
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error('La fecha final debe ser posterior a la inicial');
  const intOrNull = (v: unknown) => (v === null || v === undefined || v === '' ? null : Math.max(0, Math.round(Number(v))));
  return {
    name,
    code: normalizeCode(dto?.code),
    description: dto?.description ? String(dto.description).slice(0, 300) : null,
    kind,
    value: kind === 'FREE_DELIVERY' ? 0 : value,
    minSubtotal: dto?.minSubtotal === '' || dto?.minSubtotal == null ? null : Math.max(0, Number(dto.minSubtotal)),
    productIdsJson: JSON.stringify(Array.isArray(dto?.productIds) ? dto.productIds.map(String).slice(0, 100) : []),
    startsAt,
    endsAt,
    maxUses: intOrNull(dto?.maxUses),
    public: dto?.public ?? true,
    active: dto?.active ?? true,
  };
}
