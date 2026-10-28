import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformRole } from '../common/constants';
import { SUBSCRIPTION_LABEL, accessFor, effectiveStatus } from '../common/subscription';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * Suscripción suspendida o finalizada → la empresa queda en SOLO LECTURA,
 * verificado en el servidor. Siempre puede consultar, entrar a su cuenta,
 * ver su suscripción y pagar (si no, no podría regularizarse). Plataforma no
 * se limita. La empresa sale de la sesión, nunca del navegador.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { subscriptionStatus: string | null; status: string | null; at: number }>();

export function forgetSubscription(companyId: string) {
  cache.delete(companyId);
}

/** Rutas que siguen abiertas sin acceso completo (prefijos, sin /api). */
const ALWAYS_ALLOWED = ['/auth', '/public/account', '/subscriptions/me', '/payments/checkout', '/ai-credits/checkout', '/onboarding/checkout', '/terms'];

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  private async row(companyId: string) {
    const hit = cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const r = await this.prisma.company.findUnique({ where: { id: companyId }, select: { subscriptionStatus: true, status: true } });
    if (!r) return null;
    const fresh = { subscriptionStatus: r.subscriptionStatus ?? null, status: r.status ?? null, at: Date.now() };
    if (cache.size > 5000) cache.clear();
    cache.set(companyId, fresh);
    return fresh;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user || isPlatformRole(user.role) || !user.companyId) return true;
    if (['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase())) return true;
    const path = String(req.path ?? req.url ?? '').replace(/^\/api/, '');
    if (ALWAYS_ALLOWED.some((p) => path === p || path.startsWith(`${p}/`))) return true;
    const company = await this.row(user.companyId);
    if (!company) return true;
    const status = effectiveStatus(company);
    if (accessFor(status) === 'FULL') return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'SUBSCRIPTION_INACTIVE',
      message: `Tu suscripción está «${SUBSCRIPTION_LABEL[status]}». Puedes consultar tu información y regularizar el pago en Mi plan; los cambios quedan bloqueados mientras tanto.`,
      status,
    });
  }
}
