import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { forgetSession } from '../auth/jwt.guard';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole } from '../common/constants';
import { OPS_PROFILES } from '../common/productions';
import { assertWithinLimit, verifyWithinLimit } from '../common/limits';
import { requireTenant } from '../common/tenant';
import { publicWebUrl } from '../common/tracking';
import { AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';

/**
 * Ciclo de vida de usuarios: invitaciones a una empresa y recuperación de
 * contraseña. Tokens aleatorios de 256 bits; en la base solo queda su hash
 * SHA-256. Cada token sirve una vez, vence y se puede revocar. El reclamo es
 * atómico (updateMany condicionado), así que dos usos simultáneos no pasan.
 *
 * Mensajes neutros: «olvidé mi contraseña» responde igual exista o no la
 * cuenta, y una invitación no revela si el correo ya tiene cuenta en otra
 * empresa (eso solo se ve al intentar aceptarla, sin decir dónde).
 */

export const INVITE_TTL_MS = 7 * 86400e3;
export const RESET_TTL_MS = 30 * 60_000;
const INVITABLE_ROLES = [ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER, ROLES.COMPANY_COURIER];
const PLATFORM_MIN_PASSWORD = 10;
const COMPANY_MIN_PASSWORD = 8;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

class InviteDto {
  @IsEmail() @MaxLength(160) email!: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsIn(INVITABLE_ROLES) role!: string;
  @IsOptional() @IsIn(OPS_PROFILES.filter((p) => p !== 'ADMIN')) opsProfile?: string;
  @IsOptional() @IsString() companyId?: string;
}
class AcceptInviteDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsString() @MinLength(COMPANY_MIN_PASSWORD) @MaxLength(200) password!: string;
}
class ForgotDto {
  @IsEmail() @MaxLength(160) email!: string;
}
class ResetDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MinLength(COMPANY_MIN_PASSWORD) @MaxLength(200) password!: string;
}

@Injectable()
export class AccountService {
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
    private readonly auth: AuthService,
  ) {}

  /** Toma un token vigente de ese tipo (sin consumirlo). */
  private async valid(token: string, kind: 'INVITE' | 'PASSWORD_RESET') {
    if (typeof token !== 'string' || token.length < 20) return null;
    const row: any = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row || row.kind !== kind || row.usedAt || row.revokedAt || new Date(row.expiresAt) <= this.now()) return null;
    return row;
  }

  /** Lo consume una sola vez: si otra petición lo usó primero, falla. */
  private async consume(id: string) {
    const r = await this.prisma.authToken.updateMany({
      where: { id, usedAt: null, revokedAt: null, expiresAt: { gt: this.now() } },
      data: { usedAt: this.now() },
    });
    return r.count === 1;
  }

  /* ── Invitaciones ── */

  async invite(actor: AuthUser, dto: InviteDto) {
    const companyId = requireTenant(actor, dto.companyId);
    if (!isPlatformRole(actor.role) && actor.role !== ROLES.COMPANY_ADMIN) throw new ForbiddenException('Solo la administración de la empresa invita');
    if (!INVITABLE_ROLES.includes(dto.role as any)) throw new BadRequestException('Rol no permitido');
    if (dto.opsProfile && dto.role !== ROLES.COMPANY_VIEWER) throw new BadRequestException('El perfil de Producciones solo aplica a usuarios de consulta');
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const email = dto.email.trim().toLowerCase();
    // Una invitación pendiente por correo y empresa: la nueva reemplaza a la anterior
    const prev: any[] = await this.prisma.authToken.findMany({ where: { kind: 'INVITE', companyId, email, usedAt: null, revokedAt: null } });
    for (const p of prev) await this.prisma.authToken.update({ where: { id: p.id }, data: { revokedAt: this.now() } });
    const onReached = (l: any, used: number) => this.audit.log({ actor, companyId, action: 'limit.reached', entity: 'Company', entityId: companyId, detail: `usuarios: ${used}/${l.max} (${l.source})` });
    if (dto.role !== ROLES.COMPANY_COURIER) await assertWithinLimit(this.prisma, companyId, 'users', onReached);
    const token = newToken();
    const row = await this.prisma.authToken.create({
      data: {
        kind: 'INVITE', tokenHash: hashToken(token), email, companyId, name: dto.name?.trim() || null, role: dto.role,
        opsProfile: dto.opsProfile ?? null, invitedById: actor.id, invitedByName: actor.name,
        expiresAt: new Date(this.now().getTime() + INVITE_TTL_MS), usedAt: null, revokedAt: null, userId: null,
      },
    });
    if (dto.role !== ROLES.COMPANY_COURIER) {
      await verifyWithinLimit(this.prisma, companyId, 'users', () => this.prisma.authToken.delete({ where: { id: row.id } }), onReached);
    }
    const link = `${await publicWebUrl(this.prisma)}/invitacion?token=${token}`;
    const intro = `<p>${esc(actor.name)} te invitó a usar BackOffice en <b>${esc(company.name)}</b>.</p>`;
    const mail = await this.emails.systemSend({
      companyId, toEmail: email, subject: `Te invitaron a ${company.name} en BackOffice`,
      body: `${intro}<p><a href="${link}">Aceptar la invitación</a></p><p>El enlace vence en 7 días y sirve una sola vez.</p>`,
      storedBody: `${intro}<p>[Enlace de invitación: no se guarda por seguridad]</p>`,
    });
    await this.audit.log({ actor, companyId, action: 'user.invite', entity: 'AuthToken', entityId: row.id, detail: `${email} (${dto.role}${dto.opsProfile ? `/${dto.opsProfile}` : ''}) · correo ${mail.status}` });
    // El enlace se le muestra UNA vez a quien invita (por si el correo no está configurado)
    return { invitation: this.view(row), link, emailStatus: mail.status };
  }

  private view(r: any) {
    const now = this.now();
    const status = r.usedAt ? 'ACCEPTED' : r.revokedAt ? 'REVOKED' : new Date(r.expiresAt) <= now ? 'EXPIRED' : 'PENDING';
    return { id: r.id, email: r.email, name: r.name, role: r.role, opsProfile: r.opsProfile, invitedByName: r.invitedByName, createdAt: r.createdAt, expiresAt: r.expiresAt, status };
  }

  async listInvitations(actor: AuthUser, companyId?: string) {
    const id = requireTenant(actor, companyId);
    const rows: any[] = await this.prisma.authToken.findMany({ where: { kind: 'INVITE', companyId: id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.view(r));
  }

  async revokeInvitation(actor: AuthUser, invitationId: string, companyId?: string) {
    const id = requireTenant(actor, companyId);
    if (!isPlatformRole(actor.role) && actor.role !== ROLES.COMPANY_ADMIN) throw new ForbiddenException();
    const row: any = await this.prisma.authToken.findFirst({ where: { id: invitationId, kind: 'INVITE', companyId: id } });
    if (!row) throw new NotFoundException('Invitación no encontrada');
    if (row.usedAt) throw new BadRequestException('Esa invitación ya fue aceptada');
    if (!row.revokedAt) {
      await this.prisma.authToken.update({ where: { id: row.id }, data: { revokedAt: this.now() } });
      await this.audit.log({ actor, companyId: id, action: 'user.invite_revoked', entity: 'AuthToken', entityId: row.id, detail: row.email });
    }
    return this.view({ ...row, revokedAt: row.revokedAt ?? this.now() });
  }

  /** Vista pública previa a aceptar: solo lo necesario para que la persona confirme. */
  async previewInvitation(token: string) {
    const row = await this.valid(token, 'INVITE');
    if (!row) throw new NotFoundException('La invitación no es válida o ya venció. Pide una nueva.');
    const company = await this.prisma.company.findUnique({ where: { id: row.companyId }, select: { name: true } });
    return { companyName: company?.name ?? 'BackOffice', email: row.email, name: row.name, role: row.role, expiresAt: row.expiresAt };
  }

  async acceptInvitation(dto: AcceptInviteDto) {
    const row = await this.valid(dto.token, 'INVITE');
    const invalid = () => new BadRequestException('La invitación no es válida o ya venció. Pide una nueva.');
    if (!row) throw invalid();
    const company = await this.prisma.company.findUnique({ where: { id: row.companyId }, select: { id: true, status: true } });
    if (!company) throw invalid();
    // Correo con cuenta (en cualquier empresa): no se crea otra ni se dice dónde está
    if (await this.prisma.user.findUnique({ where: { email: row.email } })) {
      throw new BadRequestException('Esta invitación no se puede usar con ese correo. Si ya tienes cuenta, inicia sesión o pide otra invitación.');
    }
    if (!(await this.consume(row.id))) throw invalid();
    let user: any;
    try {
      user = await this.prisma.user.create({
        data: {
          email: row.email, name: (dto.name?.trim() || row.name || row.email.split('@')[0]).slice(0, 80), role: row.role,
          companyId: row.companyId, opsProfile: row.opsProfile ?? null, passwordHash: AuthService.hashPassword(dto.password),
        },
      });
    } catch (e: any) {
      // Otra petición creó la cuenta a la vez (correo único): la invitación queda usada
      if (e?.code === 'P2002') throw invalid();
      throw e;
    }
    // La invitación ya contaba como cupo: el usuario lo ocupa (la invitación quedó usada)
    await this.prisma.authToken.update({ where: { id: row.id }, data: { userId: user.id } });
    await this.audit.log({ actor: { id: user.id, name: user.name, role: user.role, companyId: user.companyId } as any, companyId: row.companyId, action: 'user.invite_accepted', entity: 'User', entityId: user.id, detail: `${user.email} (${user.role})` });
    return this.auth.sessionFor(user.id);
  }

  /* ── Recuperación de contraseña ── */

  /** Siempre responde lo mismo: no revela si el correo tiene cuenta. */
  async forgot(dto: ForgotDto) {
    const email = dto.email.trim().toLowerCase();
    const user: any = await this.prisma.user.findUnique({ where: { email } });
    if (user?.active) {
      const prev: any[] = await this.prisma.authToken.findMany({ where: { kind: 'PASSWORD_RESET', userId: user.id, usedAt: null, revokedAt: null } });
      for (const p of prev) await this.prisma.authToken.update({ where: { id: p.id }, data: { revokedAt: this.now() } });
      const token = newToken();
      const row = await this.prisma.authToken.create({
        data: {
          kind: 'PASSWORD_RESET', tokenHash: hashToken(token), email, userId: user.id, companyId: user.companyId ?? null,
          expiresAt: new Date(this.now().getTime() + RESET_TTL_MS), usedAt: null, revokedAt: null,
        },
      });
      const link = `${await publicWebUrl(this.prisma)}/restablecer?token=${token}`;
      const intro = `<p>Hola ${esc(user.name)}. Pediste cambiar tu contraseña de BackOffice.</p>`;
      const mail = await this.emails.systemSend({
        companyId: user.companyId ?? null, toEmail: email, subject: 'Restablece tu contraseña de BackOffice',
        body: `${intro}<p><a href="${link}">Crear una contraseña nueva</a></p><p>El enlace vence en 30 minutos y sirve una sola vez. Si no lo pediste, ignora este correo: tu contraseña no cambia.</p>`,
        storedBody: `${intro}<p>[Enlace de recuperación: no se guarda por seguridad]</p>`,
      });
      await this.audit.log({ actor: null, companyId: user.companyId ?? null, action: 'auth.password_reset_requested', entity: 'User', entityId: user.id, detail: `correo ${mail.status}` });
      void row;
    }
    return { ok: true, message: 'Si el correo tiene una cuenta activa, te enviamos un enlace para restablecer la contraseña.' };
  }

  async reset(dto: ResetDto) {
    const row = await this.valid(dto.token, 'PASSWORD_RESET');
    const invalid = () => new BadRequestException('El enlace no es válido o ya venció. Pide uno nuevo.');
    if (!row?.userId) throw invalid();
    const user: any = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || !user.active || user.email !== row.email) throw invalid();
    if (isPlatformRole(user.role) && dto.password.length < PLATFORM_MIN_PASSWORD) {
      throw new BadRequestException(`La contraseña de un usuario de plataforma necesita al menos ${PLATFORM_MIN_PASSWORD} caracteres`);
    }
    if (!(await this.consume(row.id))) throw invalid();
    // Clave nueva: se cierran TODAS las sesiones abiertas y se limpia el bloqueo. El MFA sigue exigiéndose al entrar.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: AuthService.hashPassword(dto.password), sessionVersion: (user.sessionVersion ?? 0) + 1, failedLogins: 0, lockedUntil: null },
    });
    forgetSession(user.id);
    const others: any[] = await this.prisma.authToken.findMany({ where: { kind: 'PASSWORD_RESET', userId: user.id, usedAt: null, revokedAt: null } });
    for (const o of others) await this.prisma.authToken.update({ where: { id: o.id }, data: { revokedAt: this.now() } });
    await this.audit.log({ actor: { id: user.id, name: user.name, role: user.role, companyId: user.companyId } as any, companyId: user.companyId ?? null, action: 'auth.password_reset', entity: 'User', entityId: user.id });
    return { ok: true, message: 'Listo: tu contraseña cambió. Inicia sesión con la nueva.' };
  }
}

@Controller('users/invitations')
export class InvitationsController {
  constructor(private readonly s: AccountService) {}

  @Get() @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  list(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.listInvitations(u, c); }

  @Post() @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN) @Throttle({ default: { ttl: 60_000, limit: 20 } })
  invite(@CurrentUser() u: AuthUser, @Body() dto: InviteDto) { return this.s.invite(u, dto); }

  @Delete(':id') @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.revokeInvitation(u, id, c); }
}

@Controller('public/account')
export class PublicAccountController {
  constructor(private readonly s: AccountService) {}

  @Public() @Throttle({ default: { ttl: 60_000, limit: 20 } }) @Get('invitations/:token')
  preview(@Param('token') token: string) { return this.s.previewInvitation(token); }

  @Public() @Throttle({ default: { ttl: 10 * 60_000, limit: 10 } }) @Post('invitations/accept')
  accept(@Body() dto: AcceptInviteDto) { return this.s.acceptInvitation(dto); }

  @Public() @Throttle({ default: { ttl: 10 * 60_000, limit: 5 } }) @Post('password/forgot')
  forgot(@Body() dto: ForgotDto) { return this.s.forgot(dto); }

  @Public() @Throttle({ default: { ttl: 10 * 60_000, limit: 10 } }) @Post('password/reset')
  reset(@Body() dto: ResetDto) { return this.s.reset(dto); }
}

@Module({
  imports: [EmailsModule],
  controllers: [InvitationsController, PublicAccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
