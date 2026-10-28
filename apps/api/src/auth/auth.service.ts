import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../modules/audit.module';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { qrSvg } from '../common/qr';
import { newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from '../common/totp';
import { forgetSession } from './jwt.guard';

/** Intentos fallidos permitidos antes del bloqueo temporal de la cuenta. */
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** Costo de bcrypt para contraseñas nuevas (los hashes viejos de costo 10 siguen sirviendo). */
export const BCRYPT_COST = 12;

/** Emisor, audiencia y algoritmo fijos: un token de otro sistema o del paso MFA no sirve aquí. */
export const JWT_ISSUER = 'backoffice-api';
export const JWT_AUDIENCE = 'backoffice-web';
const MFA_AUDIENCE = 'backoffice-mfa';

/** Hash señuelo: se compara SIEMPRE aunque el correo no exista, para que el
 *  tiempo de respuesta no revele qué cuentas existen (anti-enumeración). */
const DECOY_HASH = bcrypt.hashSync('decoy-password-no-usable', 10);

/** Campos que jamás salen del API. */
const PRIVATE_FIELDS = ['passwordHash', 'failedLogins', 'lockedUntil', 'mfaSecretEnc', 'mfaRecoveryJson', 'mfaLastStep', 'sessionVersion'] as const;
export function publicUser<T extends Record<string, any>>(user: T) {
  const out: Record<string, any> = { ...user };
  for (const k of PRIVATE_FIELDS) delete out[k];
  return out;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  private async issue(user: any) {
    const token = await this.jwt.signAsync(
      { sub: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId, sv: user.sessionVersion ?? 0 },
      { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' },
    );
    return {
      token,
      user: {
        id: user.id, email: user.email, name: user.name, role: user.role, companyId: user.companyId,
        company: user.company, jobTitle: user.jobTitle, tourDoneAt: user.tourDoneAt, mfaEnabled: !!user.mfaEnabled,
      },
    };
  }

  /** Sesión para un usuario recién creado o que acaba de restablecer su clave (invitación, recuperación). */
  async sessionFor(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    return this.issue(user);
  }

  /** Cuenta un intento fallido y bloquea al llegar al tope (contraseña o código MFA). */
  private async registerFailure(user: any, what: string) {
    const failed = (user.failedLogins ?? 0) + 1;
    const willLock = failed >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: willLock ? 0 : failed, ...(willLock ? { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60e3) } : {}) },
    });
    if (willLock) {
      await this.audit.log({
        actor: null, companyId: user.companyId, action: 'auth.lockout', entity: 'User', entityId: user.id,
        detail: `${MAX_FAILED_LOGINS} ${what} fallidos → bloqueada ${LOCK_MINUTES} min`,
      });
    }
  }

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
      if (user && user.active && !locked && !ok) await this.registerFailure(user, 'intentos');
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Verificación en dos pasos: la contraseña sola no basta
    if (user.mfaEnabled) {
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, sv: user.sessionVersion ?? 0, purpose: 'mfa' },
        { issuer: JWT_ISSUER, audience: MFA_AUDIENCE, algorithm: 'HS256', expiresIn: '5m' },
      );
      return { mfaRequired: true, mfaToken };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null },
    });
    return this.issue(user);
  }

  /** Segundo paso del login: código de la app (o uno de recuperación). */
  async verifyMfa(mfaToken: string, code: string) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(String(mfaToken ?? ''), {
        secret: process.env.JWT_SECRET, issuer: JWT_ISSUER, audience: MFA_AUDIENCE, algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('El paso de verificación venció. Vuelve a iniciar sesión.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
    if (!user || !user.active || locked || !user.mfaEnabled || (user.sessionVersion ?? 0) !== (payload.sv ?? 0)) {
      throw new UnauthorizedException('Código inválido');
    }
    const usedStep = verifyTotp(this.secretOf(user), code, user.mfaLastStep);
    let recoveryLeft: string[] | null = null;
    if (usedStep == null) {
      recoveryLeft = await this.consumeRecovery(user, code);
      if (!recoveryLeft) {
        await this.registerFailure(user, 'códigos MFA');
        throw new UnauthorizedException('Código inválido');
      }
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null,
        ...(usedStep != null ? { mfaLastStep: usedStep } : { mfaRecoveryJson: JSON.stringify(recoveryLeft) }),
      },
    });
    if (usedStep == null) {
      await this.audit.log({ actor: null, companyId: user.companyId, action: 'auth.mfa_recovery_used', entity: 'User', entityId: user.id, detail: `quedan ${recoveryLeft!.length} códigos` });
    }
    return this.issue(user);
  }

  private secretOf(user: any): string {
    if (!isEncrypted(user.mfaSecretEnc)) return '';
    try {
      return decryptSecret(user.mfaSecretEnc);
    } catch {
      return '';
    }
  }

  /** Devuelve los códigos restantes si `code` era uno de recuperación válido (y lo gasta). */
  private async consumeRecovery(user: any, code: string): Promise<string[] | null> {
    const clean = String(code ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{5}-[0-9a-f]{5}$/.test(clean)) return null;
    let hashes: string[] = [];
    try { hashes = JSON.parse(user.mfaRecoveryJson ?? '[]'); } catch { hashes = []; }
    for (const [i, h] of hashes.entries()) {
      if (await bcrypt.compare(clean, h)) return hashes.filter((_, j) => j !== i);
    }
    return null;
  }

  /* ── MFA: activar y desactivar (la propia cuenta) ── */

  async mfaStatus(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    let left = 0;
    try { left = JSON.parse(u.mfaRecoveryJson ?? '[]').length; } catch { left = 0; }
    return { enabled: !!u.mfaEnabled, recoveryCodesLeft: left };
  }

  /** Paso 1: secreto nuevo (pendiente hasta confirmar con un código). */
  async mfaSetup(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.mfaEnabled) throw new BadRequestException('La verificación en dos pasos ya está activa');
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaSecretEnc: encryptSecret(secret), mfaLastStep: null } });
    const uri = otpauthUri(secret, u.email);
    return { secret, uri, qrSvg: qrSvg(uri, { size: 220 }) };
  }

  /** Paso 2: confirmar con el código de la app → activa y entrega los códigos de recuperación (una sola vez). */
  async mfaEnable(userId: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.mfaEnabled) throw new BadRequestException('La verificación en dos pasos ya está activa');
    const step = verifyTotp(this.secretOf(u), code, null);
    if (step == null) throw new BadRequestException('El código no coincide. Revisa la hora del celular e intenta otra vez.');
    const codes = newRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaEnabled: true, mfaLastStep: step,
        mfaRecoveryJson: JSON.stringify(codes.map((c) => bcrypt.hashSync(c, 10))),
        // Las sesiones abiertas antes de activar el MFA se cierran
        sessionVersion: (u.sessionVersion ?? 0) + 1,
      },
    });
    forgetSession(userId);
    await this.audit.log({ actor: { id: u.id, name: u.name, role: u.role, companyId: u.companyId } as any, companyId: u.companyId, action: 'auth.mfa_enabled', entity: 'User', entityId: u.id });
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { company: { select: { id: true, name: true, slug: true, status: true } } } });
    return { ...(await this.issue(fresh)), recoveryCodes: codes };
  }

  /** Apagar el MFA pide la contraseña y un código vigente. */
  async mfaDisable(userId: string, password: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!u.mfaEnabled) return { ok: true };
    if (!(await bcrypt.compare(String(password ?? ''), u.passwordHash))) throw new UnauthorizedException('La contraseña no coincide');
    if (verifyTotp(this.secretOf(u), code, u.mfaLastStep) == null && !(await this.consumeRecovery(u, code))) {
      throw new UnauthorizedException('Código inválido');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryJson: null, mfaLastStep: null, sessionVersion: (u.sessionVersion ?? 0) + 1 },
    });
    forgetSession(userId);
    await this.audit.log({ actor: { id: u.id, name: u.name, role: u.role, companyId: u.companyId } as any, companyId: u.companyId, action: 'auth.mfa_disabled', entity: 'User', entityId: u.id });
    return { ok: true };
  }

  /* ── Sesión ── */

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!user) throw new UnauthorizedException();
    return publicUser(user);
  }

  /** Cerrar sesión de verdad: todos los tokens emitidos antes dejan de servir. */
  async logout(userId: string) {
    await revokeSessions(this.prisma, userId);
    return { ok: true };
  }

  /** Cambio de contraseña propio (cualquier rol). Cierra las demás sesiones y devuelve un token nuevo. */
  async changePassword(userId: string, current: string, next: string) {
    if (!next || next.length < 8) {
      throw new BadRequestException('La nueva contraseña debe tener al menos 8 caracteres');
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const ok = await bcrypt.compare(current, user.passwordHash);
    if (!ok) throw new UnauthorizedException('La contraseña actual no coincide');
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: bcrypt.hashSync(next, BCRYPT_COST), sessionVersion: (user.sessionVersion ?? 0) + 1 },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    forgetSession(userId);
    await this.audit.log({ actor: { id: user.id, name: user.name, role: user.role, companyId: user.companyId } as any, companyId: user.companyId, action: 'auth.password_changed', entity: 'User', entityId: user.id });
    return { ok: true, ...(await this.issue(updated)) };
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
    return bcrypt.hashSync(plain, BCRYPT_COST);
  }
}

/** Sube la versión de sesión del usuario: sus tokens viejos quedan inválidos al instante. */
export async function revokeSessions(prisma: any, userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } });
  if (!u) return;
  await prisma.user.update({ where: { id: userId }, data: { sessionVersion: (u.sessionVersion ?? 0) + 1 } });
  forgetSession(userId);
}
