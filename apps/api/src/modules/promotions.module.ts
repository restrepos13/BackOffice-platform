import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson, scopeCompanyId } from '../common/constants';
import { normalizeCode, validatePromotionInput } from '../common/promotions';
import { AuditService } from './audit.module';
import { Products } from '../auth/products.guard';

/**
 * Promociones y cupones (CRUD). El agente las aplica en armar_pedido y las
 * ofrece con ver_promociones (solo las marcadas como públicas).
 * Respuestas rápidas del equipo humano en la bandeja ("/saludo").
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  private parse(dto: any) {
    try {
      return validatePromotionInput(dto);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const rows = await this.prisma.promotion.findMany({ where: { companyId: scoped }, orderBy: { createdAt: 'desc' } });
    return rows.map((p) => ({ ...p, productIds: parseJson<string[]>(p.productIdsJson, []) }));
  }

  async save(user: AuthUser, dto: any, id?: string, companyId?: string) {
    const data = this.parse(dto);
    let scoped: string;
    if (id) {
      const existing = await this.prisma.promotion.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Promoción no encontrada');
      if (!isPlatformRole(user.role) && existing.companyId !== user.companyId) throw new ForbiddenException();
      scoped = existing.companyId;
    } else {
      scoped = this.resolveCompany(user, companyId ?? dto?.companyId);
    }
    if (data.code) {
      const clash = await this.prisma.promotion.findFirst({
        where: { companyId: scoped, code: data.code, ...(id ? { id: { not: id } } : {}) },
      });
      if (clash) throw new BadRequestException(`Ya existe el cupón ${data.code}`);
    }
    const promo = id
      ? await this.prisma.promotion.update({ where: { id }, data })
      : await this.prisma.promotion.create({ data: { companyId: scoped, ...data } });
    await this.audit.log({
      actor: user, companyId: scoped, action: id ? 'promotion.update' : 'promotion.create',
      entity: 'Promotion', entityId: promo.id, detail: `${promo.name}${promo.code ? ` (${promo.code})` : ''}`,
    });
    return promo;
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.prisma.promotion.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Promoción no encontrada');
    if (!isPlatformRole(user.role) && existing.companyId !== user.companyId) throw new ForbiddenException();
    await this.prisma.promotion.delete({ where: { id } });
    await this.audit.log({ actor: user, companyId: existing.companyId, action: 'promotion.delete', entity: 'Promotion', entityId: id, detail: existing.name });
    return { ok: true };
  }

  /* ── Respuestas rápidas ── */

  async listQuickReplies(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    return this.prisma.quickReply.findMany({ where: { companyId: scoped }, orderBy: { shortcut: 'asc' } });
  }

  async saveQuickReply(user: AuthUser, dto: any, id?: string, companyId?: string) {
    const shortcut = String(dto?.shortcut ?? '').trim().toLowerCase().replace(/^\//, '').replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    const title = String(dto?.title ?? '').trim().slice(0, 60);
    const body = String(dto?.body ?? '').trim().slice(0, 1000);
    if (!shortcut || !title || !body) throw new BadRequestException('Atajo, título y texto son obligatorios');
    let scoped: string;
    if (id) {
      const existing = await this.prisma.quickReply.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Respuesta no encontrada');
      if (!isPlatformRole(user.role) && existing.companyId !== user.companyId) throw new ForbiddenException();
      scoped = existing.companyId;
    } else {
      scoped = this.resolveCompany(user, companyId ?? dto?.companyId);
    }
    const clash = await this.prisma.quickReply.findFirst({ where: { companyId: scoped, shortcut, ...(id ? { id: { not: id } } : {}) } });
    if (clash) throw new BadRequestException(`Ya existe el atajo /${shortcut}`);
    return id
      ? this.prisma.quickReply.update({ where: { id }, data: { shortcut, title, body } })
      : this.prisma.quickReply.create({ data: { companyId: scoped, shortcut, title, body } });
  }

  async removeQuickReply(user: AuthUser, id: string) {
    const existing = await this.prisma.quickReply.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Respuesta no encontrada');
    if (!isPlatformRole(user.role) && existing.companyId !== user.companyId) throw new ForbiddenException();
    await this.prisma.quickReply.delete({ where: { id } });
    return { ok: true };
  }
}

@Products('AUTOMATION')
@Controller()
export class PromotionsController {
  constructor(private readonly promos: PromotionsService) {}

  @Get('promotions')
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.promos.list(user, companyId);
  }

  @Post('promotions')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.promos.save(user, dto, undefined, companyId);
  }

  @Patch('promotions/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.promos.save(user, dto, id);
  }

  @Delete('promotions/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.promos.remove(user, id);
  }

  @Get('quick-replies')
  listQuick(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.promos.listQuickReplies(user, companyId);
  }

  @Post('quick-replies')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  createQuick(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.promos.saveQuickReply(user, dto, undefined, companyId);
  }

  @Patch('quick-replies/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  updateQuick(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.promos.saveQuickReply(user, dto, id);
  }

  @Delete('quick-replies/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  removeQuick(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.promos.removeQuickReply(user, id);
  }
}

@Module({
  controllers: [PromotionsController],
  providers: [PromotionsService],
})
export class PromotionsModule {}

export { normalizeCode };
