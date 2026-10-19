import { BadRequestException, Body, Controller, Get, Injectable, Module, Post, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole } from '../common/constants';
import { AuditModule, AuditService } from './audit.module';
import { DEFAULT_TERMS_BODY, DEFAULT_TERMS_TITLE } from '../common/terms-default';

/**
 * Términos y condiciones con versión:
 *  - El texto vive en PlatformSetting TERMS_DOC y lo editan los devs.
 *  - "Corrección" cambia el texto sin pedir aceptar de nuevo; "nueva versión"
 *    sube el número y todos los usuarios de empresa deben aceptarla al entrar.
 *  - Cada aceptación queda en el usuario (versión y fecha) y en la auditoría.
 */

const KEY = 'TERMS_DOC';

export interface TermsDoc {
  version: number;
  title: string;
  body: string;
  updatedAt: string;
  updatedBy: string;
}

@Injectable()
export class TermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async current(): Promise<TermsDoc> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: KEY } });
    try {
      const doc = JSON.parse(row?.value ?? '');
      if (doc?.version && doc?.body) return doc;
    } catch {
      /* sin guardar todavía → versión inicial */
    }
    return { version: 1, title: DEFAULT_TERMS_TITLE, body: DEFAULT_TERMS_BODY, updatedAt: '2026-10-19T00:00:00.000Z', updatedBy: 'BackOffice' };
  }

  async status(user: AuthUser) {
    const doc = await this.current();
    // Aceptan quienes administran o ven la cuenta; el equipo de BackOffice y el
    // personal operativo (área, domiciliarios) no
    if (isPlatformRole(user.role) || ![ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER].includes(user.role as any)) return { required: false, version: doc.version, acceptedVersion: null, acceptedAt: null };
    const u = await this.prisma.user.findUnique({ where: { id: user.id }, select: { termsVersion: true, termsAcceptedAt: true } });
    const accepted = u?.termsVersion ?? null;
    return {
      required: accepted === null || accepted < doc.version,
      version: doc.version,
      acceptedVersion: accepted,
      acceptedAt: u?.termsAcceptedAt ?? null,
      updatedSinceAccepted: accepted !== null && accepted < doc.version,
    };
  }

  async accept(user: AuthUser, dto: { version?: number }) {
    const doc = await this.current();
    if (Number(dto?.version) !== doc.version) {
      throw new BadRequestException('Los términos cambiaron mientras los leías. Recarga la página para ver la versión nueva.');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { termsVersion: doc.version, termsAcceptedAt: new Date() } });
    await this.audit.log({
      actor: user, companyId: user.companyId, action: 'terms.accept', entity: 'Terms', entityId: String(doc.version),
      detail: `Aceptó la versión ${doc.version} de los términos`,
    });
    return { ok: true, version: doc.version };
  }

  async save(actor: AuthUser, dto: { title?: string; body?: string; newVersion?: boolean }) {
    const title = String(dto?.title ?? '').trim().slice(0, 160);
    const body = String(dto?.body ?? '').replace(/\r\n/g, '\n').trim();
    if (title.length < 5) throw new BadRequestException('Escribe un título');
    if (body.length < 200) throw new BadRequestException('El texto quedó muy corto');
    if (body.length > 60000) throw new BadRequestException('El texto es demasiado largo (máx. 60.000 letras)');
    const prev = await this.current();
    const doc: TermsDoc = {
      version: dto?.newVersion ? prev.version + 1 : prev.version,
      title, body, updatedAt: new Date().toISOString(), updatedBy: actor.name,
    };
    const existing = await this.prisma.platformSetting.findUnique({ where: { key: KEY } });
    if (existing) await this.prisma.platformSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(doc) } });
    else await this.prisma.platformSetting.create({ data: { key: KEY, value: JSON.stringify(doc) } });
    await this.audit.log({
      actor, action: dto?.newVersion ? 'terms.publish' : 'terms.edit', entity: 'Terms', entityId: String(doc.version),
      detail: dto?.newVersion ? `Nueva versión ${doc.version}: todos deben aceptar de nuevo` : `Corrección de la versión ${doc.version}`,
    });
    return { ...doc, ...(await this.acceptance(doc.version)) };
  }

  /** Cuántos usuarios de empresa ya aceptaron la versión vigente. */
  async acceptance(version?: number) {
    const v = version ?? (await this.current()).version;
    const users = await this.prisma.user.findMany({
      where: { active: true, role: { in: [ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] } },
      select: { termsVersion: true },
    });
    return { usersTotal: users.length, usersAccepted: users.filter((u: any) => (u.termsVersion ?? 0) >= v).length };
  }

  async adminView() {
    const doc = await this.current();
    return { ...doc, ...(await this.acceptance(doc.version)) };
  }
}

@Controller()
export class TermsController {
  constructor(private readonly terms: TermsService) {}

  @Public()
  @Get('public/terms')
  publicTerms() {
    return this.terms.current();
  }

  @Get('terms/status')
  status(@CurrentUser() user: AuthUser) {
    return this.terms.status(user);
  }

  @Post('terms/accept')
  accept(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.terms.accept(user, dto);
  }

  @Get('platform/terms')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  adminView() {
    return this.terms.adminView();
  }

  @Put('platform/terms')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  save(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.terms.save(user, dto);
  }
}

@Module({
  imports: [AuditModule],
  controllers: [TermsController],
  providers: [TermsService],
  exports: [TermsService],
})
export class TermsModule {}
