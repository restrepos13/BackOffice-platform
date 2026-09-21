import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './decorators';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Falta el token');
    try {
      const payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });
      req.user = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
        companyId: payload.companyId ?? null,
      };
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
