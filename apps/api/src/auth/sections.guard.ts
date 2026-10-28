import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformRole, parseJson } from '../common/constants';
import { IS_PUBLIC_KEY } from './decorators';

export const SECTION_KEY = 'section';

/**
 * El endpoint pertenece a una SECCIÓN del panel (Company.modulesJson), además
 * de a un producto. Hasta ahora las secciones solo ocultaban el menú: con esto
 * también se exigen en el servidor.
 *
 * Se aplica de a poco (hoy: Producciones). Los módulos anteriores no lo llevan
 * todavía porque hay empresas que los usan sin tener la sección marcada; el
 * mapa y el plan están en docs/nucleo/CONTEXTO_Y_PERMISOS.md.
 */
export const Section = (key: string) => SetMetadata(SECTION_KEY, key);

const TTL_MS = 30_000;
const cache = new Map<string, { modules: string[]; at: number }>();

export function forgetCompanySections(companyId: string) {
  cache.delete(companyId);
}

@Injectable()
export class SectionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  private async modulesOf(companyId: string): Promise<string[] | null> {
    const hit = cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.modules;
    const row = await this.prisma.company.findUnique({ where: { id: companyId }, select: { modulesJson: true } });
    if (!row) {
      cache.delete(companyId);
      return null;
    }
    const modules = parseJson<string[]>(row.modulesJson, []);
    if (cache.size > 5000) cache.clear();
    cache.set(companyId, { modules, at: Date.now() });
    return modules;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const section = this.reflector.getAllAndOverride<string>(SECTION_KEY, targets);
    if (!section) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user) return true; // sin sesión ya lo frenó JwtAuthGuard
    if (isPlatformRole(user.role)) return true; // plataforma administra todas las empresas
    const modules = user.companyId ? await this.modulesOf(user.companyId) : null;
    if (!modules || !modules.includes(section)) {
      throw new ForbiddenException('Esta sección no está habilitada para tu empresa. Pídele a BackOffice que la active.');
    }
    return true;
  }
}
