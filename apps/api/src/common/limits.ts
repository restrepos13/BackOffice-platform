/**
 * Límites de uso por empresa (usuarios y asistentes).
 *
 * Fuente vigente (sin inventar valores):
 *  1. Company.limitsJson (excepción pactada por plataforma) — si es un entero ≥ 0.
 *  2. Plan.maxUsers / Plan.maxBots del plan asignado.
 *  3. Sin plan y sin excepción → sin límite (comportamiento anterior).
 * Valores inválidos en la excepción (negativos, texto, decimales) se ignoran y
 * se usa el del plan.
 *
 * Qué cuenta:
 *  - usuarios: personas de la empresa activas (administración, consulta y área)
 *    + invitaciones pendientes. Los domiciliarios tienen su propio tope
 *    (Plan.maxCouriers) y no cuentan aquí.
 *  - asistentes: bots de la empresa.
 *
 * Concurrencia: además de revisar antes, se vuelve a contar DESPUÉS de crear;
 * si dos solicitudes simultáneas pasaron el límite, la que sobra se deshace.
 */
import { BadRequestException } from '@nestjs/common';
import { parseJson } from './constants';

export type LimitKind = 'users' | 'bots';
export const SEAT_ROLES = ['COMPANY_ADMIN', 'COMPANY_VIEWER', 'COMPANY_AREA'];

export interface EffectiveLimit {
  max: number | null;
  source: 'COMPANY_OVERRIDE' | 'PLAN' | 'NONE';
  planName: string | null;
}

const FIELD: Record<LimitKind, 'maxUsers' | 'maxBots'> = { users: 'maxUsers', bots: 'maxBots' };
const LABEL: Record<LimitKind, [string, string]> = { users: ['persona', 'personas'], bots: ['asistente', 'asistentes'] };

const validLimit = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1_000_000 ? v : null);

export async function effectiveLimit(prisma: any, companyId: string, kind: LimitKind): Promise<EffectiveLimit> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { limitsJson: true, planId: true } });
  if (!company) return { max: null, source: 'NONE', planName: null };
  const plan = company.planId ? await prisma.plan.findUnique({ where: { id: company.planId } }) : null;
  const override = validLimit(parseJson<Record<string, unknown>>(company.limitsJson, {})[FIELD[kind]]);
  if (override !== null) return { max: override, source: 'COMPANY_OVERRIDE', planName: plan?.name ?? null };
  const fromPlan = plan ? validLimit(plan[FIELD[kind]]) : null;
  if (fromPlan !== null) return { max: fromPlan, source: 'PLAN', planName: plan.name };
  return { max: null, source: 'NONE', planName: plan?.name ?? null };
}

export async function usage(prisma: any, companyId: string, kind: LimitKind): Promise<number> {
  if (kind === 'bots') return prisma.bot.count({ where: { companyId } });
  const [users, invites] = await Promise.all([
    prisma.user.count({ where: { companyId, active: true, role: { in: SEAT_ROLES } } }),
    prisma.authToken.count({ where: { companyId, kind: 'INVITE', role: { in: SEAT_ROLES }, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } }),
  ]);
  return users + invites;
}

export function limitMessage(kind: LimitKind, l: EffectiveLimit) {
  const [one, many] = LABEL[kind];
  const where = l.source === 'COMPANY_OVERRIDE' ? 'tu cuenta' : `tu plan ${l.planName ?? ''}`.trim();
  return `Llegaste al límite de ${l.max} ${l.max === 1 ? one : many} de ${where}. Para agregar más, habla con BackOffice.`;
}

/** Antes de crear: ¿cabe uno más? (`adding` = cuántos se agregan). */
export async function assertWithinLimit(prisma: any, companyId: string, kind: LimitKind, onReached?: (l: EffectiveLimit, used: number) => Promise<void>, adding = 1) {
  const l = await effectiveLimit(prisma, companyId, kind);
  if (l.max === null) return l;
  const used = await usage(prisma, companyId, kind);
  if (used + adding > l.max) {
    await onReached?.(l, used);
    throw new BadRequestException(limitMessage(kind, l));
  }
  return l;
}

/**
 * Después de crear: si el total pasó el límite (dos solicitudes a la vez),
 * se deshace lo recién creado con `undo` y se responde igual que al llegar al límite.
 */
export async function verifyWithinLimit(prisma: any, companyId: string, kind: LimitKind, undo: () => Promise<unknown>, onReached?: (l: EffectiveLimit, used: number) => Promise<void>) {
  const l = await effectiveLimit(prisma, companyId, kind);
  if (l.max === null) return;
  const used = await usage(prisma, companyId, kind);
  if (used > l.max) {
    await undo();
    await onReached?.(l, used - 1);
    throw new BadRequestException(limitMessage(kind, l));
  }
}
