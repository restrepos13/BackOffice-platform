/**
 * Recomendación de plan y paquete de IA, SOLO con código (sin gastar IA):
 * se elige el plan más económico del rubro que cubre lo que el negocio
 * necesita (volumen, herramientas, usuarios, domiciliarios) y se explica por
 * qué. Si algo lo exige, se sube un nivel y se dice la razón en palabras simples.
 */
import { recommendPackage, type PackageOption } from './ai-cost';

export interface PlanLike {
  id: string;
  name: string;
  priceMonthly: number;
  maxUsers: number;
  maxLines: number;
  maxCouriers: number;
  sortOrder: number;
  highlight?: boolean;
  features: string[];
  minTermMonths?: number;
}

export interface NeedsInput {
  dailyChats: number;
  modules: string[];
  users: number;
  lines: number;
}

/** Herramientas "pesadas": con varias de estas conviene el plan de en medio. */
const HEAVY = ['production', 'delivery', 'gerencia', 'automations', 'media'];

export function recommendPlan(plans: PlanLike[], needs: NeedsInput) {
  const sorted = [...plans].filter((p) => p.priceMonthly > 0).sort((a, b) => a.priceMonthly - b.priceMonthly || a.sortOrder - b.sortOrder);
  if (!sorted.length) return null;
  const couriers = needs.modules.includes('delivery') ? 2 : 0;
  const heavy = needs.modules.filter((m) => HEAVY.includes(m)).length;
  // Nivel mínimo por volumen y por herramientas (0 = el más básico)
  const byVolume = needs.dailyChats > 150 ? 2 : needs.dailyChats > 50 ? 1 : 0;
  // Las herramientas suben como mucho un nivel; el plan tope lo piden el volumen o el equipo
  const byTools = heavy >= 2 ? 1 : 0;
  const minTier = Math.min(sorted.length - 1, Math.max(byVolume, byTools));
  const reasons: string[] = [];
  let pick = sorted.findIndex((p, i) =>
    i >= minTier && p.maxUsers >= needs.users && p.maxLines >= needs.lines && p.maxCouriers >= couriers);
  if (pick === -1) pick = sorted.length - 1;
  const plan = sorted[pick];

  reasons.push(`Te escriben unos ${needs.dailyChats} clientes al día (unas ${needs.dailyChats * 30} conversaciones al mes).`);
  if (byVolume > 0 && pick >= byVolume) reasons.push('Por ese volumen te conviene un plan con más capacidad que el básico.');
  if (byTools > 0 && pick >= byTools) reasons.push('Vas a usar herramientas que trabajan mejor desde este plan (producción, domicilios, reportes).');
  if (couriers > 0) reasons.push(`Incluye domiciliarios en la app (${plan.maxCouriers >= 999 ? 'sin límite' : `hasta ${plan.maxCouriers}`}).`);
  if (needs.users > 1) reasons.push(`Tu equipo: ${plan.maxUsers >= 999 ? 'personas sin límite' : `hasta ${plan.maxUsers} personas`} con acceso.`);
  if (pick === 0) reasons.push('Es el plan de entrada: puedes subir de plan cuando crezcas, sin perder nada.');

  const cheaper = pick > 0 ? sorted[pick - 1] : null;
  const upsell = pick < sorted.length - 1 ? sorted[pick + 1] : null;
  return {
    planId: plan.id,
    planName: plan.name,
    reasons,
    /** El de abajo (si lo quiere más barato) y por qué no alcanza */
    cheaper: cheaper ? { planId: cheaper.id, planName: cheaper.name, note: 'Más económico, pero se queda corto para lo que contaste.' } : null,
    upsell: upsell ? { planId: upsell.id, planName: upsell.name, note: 'Si esperas crecer pronto o quieres más usuarios y líneas.' } : null,
  };
}

export function recommendCheckout(plans: PlanLike[], packages: PackageOption[], needs: NeedsInput, aiBillingMode: string) {
  const plan = recommendPlan(plans, needs);
  const monthly = Math.round(needs.dailyChats * 30);
  const pkg = aiBillingMode === 'BYOK' ? null : recommendPackage(monthly, packages);
  return {
    plan,
    aiPackage: pkg
      ? { packageId: pkg.id, name: pkg.name, conversations: pkg.conversations, price: pkg.price, monthsItLasts: pkg.monthsItLasts,
          reason: `Te alcanza para unos ${pkg.monthsItLasts ?? '—'} ${pkg.monthsItLasts === 1 ? 'mes' : 'meses'} con tu volumen actual (vence a los ${pkg.validityMonths} meses).` }
      : null,
    aiNote: aiBillingMode === 'BYOK'
      ? 'Tu IA se paga con tu propia cuenta del proveedor: no necesitas paquete de BackOffice.'
      : 'La IA de BackOffice se compra en paquetes de conversaciones; el primero lo puedes llevar con tu plan.',
  };
}
