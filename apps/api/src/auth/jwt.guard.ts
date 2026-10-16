import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './decorators';
import { PrismaService } from '../prisma/prisma.service';

/**
 * El token dura horas: para que desactivar, borrar o cambiar el rol de alguien
 * corte su acceso enseguida, cada petición confirma el usuario contra la base
 * (con un caché corto para no consultar Mongo en cada clic).
 */
const SESSION_TTL_MS = 30_000;
type SessionRow = { active: boolean; role: string; companyId: string | null; at: number };
const sessions = new Map<string, SessionRow>();

export function forgetSession(userId: string) {
  sessions.delete(userId);
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  private async session(userId: string): Promise<SessionRow | null> {
    const hit = sessions.get(userId);
    if (hit && Date.now() - hit.at < SESSION_TTL_MS) return hit;
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { active: true, role: true, companyId: true },
    });
    if (!row) {
      sessions.delete(userId);
      return null;
    }
    const fresh = { active: row.active, role: row.role, companyId: row.companyId ?? null, at: Date.now() };
    if (sessions.size > 5000) sessions.clear();
    sessions.set(userId, fresh);
    return fresh;
  }

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
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    const current = await this.session(payload.sub);
    if (!current || !current.active) {
      throw new UnauthorizedException('Tu usuario fue desactivado');
    }
    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: current.role,
      companyId: current.companyId,
    };
    return true;
  }
}
