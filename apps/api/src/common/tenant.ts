/**
 * Contexto de empresa (tenant) en UN solo lugar.
 *
 * La empresa sale SIEMPRE de la sesión: un usuario de empresa nunca puede
 * pedir otra con ?companyId= ni en el cuerpo. Solo los roles de plataforma
 * eligen empresa. Reemplaza de a poco las copias locales de
 * `resolveCompany` / `scoped` / `companyIdOf` que hay en los módulos.
 *
 * Ver docs/nucleo/CONTEXTO_Y_PERMISOS.md.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthUser, isPlatformRole } from './constants';

/**
 * Empresa sobre la que opera una escritura o una consulta de UNA empresa.
 * Plataforma debe indicarla; un usuario de empresa queda clavado a la suya.
 */
export function requireTenant(user: AuthUser, requested?: string | null): string {
  const id = isPlatformRole(user.role) ? (requested || null) : user.companyId;
  if (!id) throw new ForbiddenException(isPlatformRole(user.role) ? 'Elige una empresa (companyId)' : 'Tu usuario no tiene empresa');
  return id;
}

/**
 * Filtro para listados: plataforma sin empresa elegida ve todas (undefined);
 * un usuario de empresa, solo la suya (o nada si no tiene).
 * Mismo comportamiento que `scopeCompanyId` de constants.ts.
 */
export function tenantFilter(user: AuthUser, requested?: string | null): string | undefined {
  if (isPlatformRole(user.role)) return requested || undefined;
  return user.companyId ?? '__none__';
}

/** El recurso existe y es de la empresa del usuario (o el usuario es de plataforma). Si no, 404: no se revela que exista en otra. */
export function assertSameTenant<T extends { companyId?: string | null }>(user: AuthUser, resource: T | null | undefined, label = 'Registro'): T {
  if (!resource) throw new NotFoundException(`${label} no encontrado`);
  if (!isPlatformRole(user.role) && resource.companyId !== user.companyId) throw new NotFoundException(`${label} no encontrado`);
  return resource;
}

/**
 * Referencias que llegan del navegador (usuario asignado, cliente, contacto…):
 * deben ser de la MISMA empresa. Evita enlazar datos de otra empresa.
 * Valores vacíos o null se aceptan (quitar la referencia).
 */
export async function assertRefsInTenant(
  prisma: any,
  companyId: string,
  refs: { userId?: string | null; customerId?: string | null; contactId?: string | null; pipelineId?: string | null; botId?: string | null; integrationId?: string | null },
) {
  const checks: Array<[string | null | undefined, string, () => Promise<unknown>]> = [
    [refs.userId, 'El responsable', () => prisma.user.findFirst({ where: { id: refs.userId, companyId } })],
    [refs.customerId, 'El cliente', () => prisma.customer.findFirst({ where: { id: refs.customerId, companyId } })],
    [refs.contactId, 'El contacto', () => prisma.contact.findFirst({ where: { id: refs.contactId, companyId } })],
    [refs.pipelineId, 'El embudo', () => prisma.pipeline.findFirst({ where: { id: refs.pipelineId, companyId } })],
    [refs.botId, 'El asistente', () => prisma.bot.findFirst({ where: { id: refs.botId, companyId } })],
    [refs.integrationId, 'La línea o canal', () => prisma.integration.findFirst({ where: { id: refs.integrationId, companyId } })],
  ];
  for (const [value, label, find] of checks) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !(await find())) throw new BadRequestException(`${label} no pertenece a esta empresa`);
  }
}
