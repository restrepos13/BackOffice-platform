import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RESTRICTED_ROLES, Role } from '../common/constants';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const request = ctx.switchToHttp().getRequest();
    const { user } = request;

    // COMPANY_AREA y COMPANY_COURIER operan con MÍNIMO privilegio: solo entran
    // a endpoints que los incluyen explícitamente en @Roles (su vista de área /
    // su ruta) y a lo básico de su propia cuenta (/auth/*). Todo lo demás: 403.
    if (RESTRICTED_ROLES.includes(user?.role)) {
      const isOwnAccount = String(request.url ?? '').startsWith('/api/auth/');
      if (!isOwnAccount && !(required ?? []).includes(user.role as Role)) {
        throw new ForbiddenException(
          user.role === 'COMPANY_COURIER'
            ? 'Tu rol solo tiene acceso a tu ruta de domicilios'
            : 'Tu rol solo tiene acceso a su área de producción',
        );
      }
    }

    if (!required || required.length === 0) return true;

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('No tienes permisos para esta acción');
    }
    return true;
  }
}
