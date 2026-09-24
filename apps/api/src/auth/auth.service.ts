import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../modules/audit.module';

/** Intentos fallidos permitidos antes del bloqueo temporal de la cuenta. */
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

/** Hash señuelo: se compara SIEMPRE aunque el correo no exista, para que el
 *  tiempo de respuesta no revele qué cuentas existen (anti-enumeración). */
const DECOY_HASH = bcrypt.hashSync('decoy-password-no-usable', 10);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: String(email ?? '').toLowerCase().trim() },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });

    // La comparación corre SIEMPRE (usuario inexistente → señuelo) y el
    // mensaje es SIEMPRE el mismo: nada filtra si la cuenta existe o no.
    const ok = await bcrypt.compare(String(password ?? ''), user?.passwordHash ?? DECOY_HASH);
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();

    if (!user || !user.active || locked || !ok) {
      if (user && user.active && !locked && !ok) {
        // Intento fallido real: cuenta los fallos y bloquea al llegar al tope
        const failed = (user.failedLogins ?? 0) + 1;
        const willLock = failed >= MAX_FAILED_LOGINS;
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLogins: willLock ? 0 : failed,
            ...(willLock
              ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60e3) }
              : {}),
          },
        });
        if (willLock) {
          await this.audit.log({
            actor: null, companyId: user.companyId, action: 'auth.lockout',
            entity: 'User', entityId: user.id,
            detail: `${MAX_FAILED_LOGINS} intentos fallidos → bloqueada ${LOCK_MINUTES} min`,
          });
        }
      }
      throw new UnauthorizedException('Credenciales inválidas');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
    });

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      companyId: user.companyId,
    });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        companyId: user.companyId,
        company: user.company,
        jobTitle: user.jobTitle,
        tourDoneAt: user.tourDoneAt,
      },
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!user) throw new UnauthorizedException();
    const { passwordHash: _ph, failedLogins: _fl, lockedUntil: _lu, ...safe } = user;
    return safe;
  }

  /** Cambio de contraseña propio (cualquier rol). */
  async changePassword(userId: string, current: string, next: string) {
    if (!next || next.length < 8) {
      throw new BadRequestException('La nueva contraseña debe tener al menos 8 caracteres');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ok = await bcrypt.compare(current, user.passwordHash);
    if (!ok) throw new UnauthorizedException('La contraseña actual no coincide');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: bcrypt.hashSync(next, 10) },
    });
    return { ok: true };
  }

  /** Marca el tour de bienvenida como visto (no se vuelve a mostrar). */
  async completeTour(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { tourDoneAt: new Date() },
    });
    return { ok: true };
  }

  static hashPassword(plain: string): string {
    return bcrypt.hashSync(plain, 10);
  }
}
