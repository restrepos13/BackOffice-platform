/**
 * Puertas de publicación compartidas por Creative, Marketing y Redes: ninguna
 * pieza se programa ni se publica sin aprobación (humana o por reglas de
 * autonomía), dentro del horario, el tope diario, las redes autorizadas y sin
 * pausa global. Cambiar el contenido después de aprobar quita la aprobación.
 */
import { BadRequestException } from '@nestjs/common';
import { parseJson } from './constants';
import { PublishPolicy, readPolicy, scheduleProblem } from './creative-policy';

export async function policyOf(prisma: any, companyId: string): Promise<PublishPolicy> {
  const b = await prisma.brandProfile.findUnique({ where: { companyId }, select: { policyJson: true } }).catch(() => null);
  return readPolicy(parseJson(b?.policyJson, {}));
}

/** Lanza si la pieza no puede programarse/publicarse en ese momento y a esas redes. */
export async function assertSchedulable(prisma: any, piece: any, when: Date, targets: string[]) {
  if (!piece.approvedAt) throw new BadRequestException('Esta pieza necesita aprobación antes de programarse o publicarse');
  const policy = await policyOf(prisma, piece.companyId);
  const outside = targets.filter((t) => !(policy.networks as string[]).includes(t));
  if (outside.length) throw new BadRequestException(`Tu marca no autorizó publicar en: ${outside.join(', ')}`);
  const company = await prisma.company.findUnique({ where: { id: piece.companyId }, select: { timezone: true } });
  const sameDay = await prisma.contentPiece.count({
    where: {
      companyId: piece.companyId, id: { not: piece.id }, status: { in: ['PROGRAMADO', 'PUBLICANDO', 'PUBLICADO'] },
      scheduledAt: { gte: new Date(when.getTime() - 12 * 3600e3), lte: new Date(when.getTime() + 12 * 3600e3) },
    },
  });
  const problem = scheduleProblem(when, company?.timezone ?? 'America/Bogota', policy, sameDay);
  if (problem) throw new BadRequestException(problem);
  return policy;
}

/** Campos para quitar la aprobación cuando cambia el contenido (vuelve a borrador si estaba aprobada o programada). */
export function resetApproval(status: string | null | undefined) {
  return {
    approvedAt: null, approvedBy: null, autoApproved: null,
    ...(['APROBADO', 'PROGRAMADO', 'EN_REVISION'].includes(String(status)) ? { status: 'BORRADOR', scheduledAt: null } : {}),
  };
}

/** Estados que el navegador puede poner a mano (los de publicación solo los pone el servidor). */
export const MANUAL_STATUSES = ['IDEA', 'BORRADOR', 'LISTO'];
