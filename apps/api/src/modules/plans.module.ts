import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { PRODUCTS } from '../common/products';
import { AuditService } from './audit.module';
import { PLAN_LINES } from '../common/billing-engine';

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Catálogo. Cuántas empresas usa cada plan solo lo ve plataforma (es dato de otras empresas). */
  async list(user?: AuthUser) {
    const platform = !!user && isPlatformRole(user.role);
    const plans = await this.prisma.plan.findMany({
      orderBy: [{ line: 'asc' }, { sortOrder: 'asc' }, { priceMonthly: 'asc' }],
      ...(platform ? { include: { _count: { select: { companies: true } } } } : {}),
    });
    const now = new Date();
    return plans.map((p: any) => ({
      ...p,
      features: parseJson<string[]>(p.featuresJson, []),
      includedProducts: parseJson<string[] | null>(p.includedProductsJson, null),
      // A la venta = activo y dentro de su ventana; los contratos vigentes no dependen de esto
      onSale: p.active && (!p.availableFrom || p.availableFrom <= now) && (!p.availableUntil || p.availableUntil >= now),
    }));
  }

  /** Línea comercial, moneda, límites operativos y permanencia. */
  private commercialFields(dto: any) {
    const int = (v: unknown) => Math.max(0, Math.round(Number(v)));
    return {
      ...(dto.line !== undefined ? { line: (PLAN_LINES as readonly string[]).includes(dto.line) ? dto.line : 'PRO' } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency === 'COP' ? 'COP' : 'USD' } : {}),
      ...(dto.maxLines != null ? { maxLines: int(dto.maxLines) } : {}),
      ...(dto.maxCouriers != null ? { maxCouriers: int(dto.maxCouriers) } : {}),
      ...(dto.minTermMonths != null ? { minTermMonths: int(dto.minTermMonths) } : {}),
      ...(dto.setupFeeValue != null ? { setupFeeValue: Math.max(0, Number(dto.setupFeeValue)) } : {}),
      ...(dto.sortOrder != null ? { sortOrder: int(dto.sortOrder) } : {}),
      // Modalidad "Todo incluido" (línea WPP)
      ...(dto.priceManaged != null ? { priceManaged: Math.max(0, Number(dto.priceManaged)) } : {}),
      ...(dto.includedMetaUsd != null ? { includedMetaUsd: Math.max(0, Number(dto.includedMetaUsd)) } : {}),
      ...(dto.tier !== undefined ? { tier: ['BASICO', 'INTERMEDIO', 'MAX'].includes(dto.tier) ? dto.tier : null } : {}),
      ...(dto.description !== undefined ? { description: dto.description ? String(dto.description).slice(0, 600) : null } : {}),
      ...(dto.includedProducts !== undefined ? {
        includedProductsJson: Array.isArray(dto.includedProducts)
          ? JSON.stringify([...new Set(dto.includedProducts.filter((x: unknown) => (PRODUCTS as readonly string[]).includes(String(x))))])
          : null,
      } : {}),
      ...(dto.availableFrom !== undefined ? { availableFrom: this.date(dto.availableFrom) } : {}),
      ...(dto.availableUntil !== undefined ? { availableUntil: this.date(dto.availableUntil) } : {}),
    };
  }

  private date(v: unknown) {
    if (v === null || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Fecha inválida');
    return d;
  }

  async create(actor: AuthUser, dto: any) {
    const plan = await this.prisma.plan.create({
      data: {
        code: dto.code,
        name: dto.name,
        priceMonthly: dto.priceMonthly ?? 0,
        maxBots: dto.maxBots ?? 10,
        maxWorkspaces: dto.maxWorkspaces ?? 1,
        maxUsers: dto.maxUsers ?? 5,
        featuresJson: JSON.stringify(dto.features ?? []),
        includedAiConversations: Math.max(0, Math.round(Number(dto.includedAiConversations ?? 0))),
        highlight: !!dto.highlight,
        ...this.commercialFields(dto),
        isCustom: !!dto.isCustom,
      },
    });
    await this.audit.log({
      actor,
      action: 'plan.create',
      entity: 'Plan',
      entityId: plan.id,
      detail: plan.name,
    });
    return plan;
  }

  async update(actor: AuthUser, id: string, dto: any) {
    const before = await this.prisma.plan.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Plan no encontrado');
    // El precio de un plan en uso cambia lo que pagan esas empresas: se confirma a sabiendas
    const priceKeys = ['priceMonthly', 'priceManaged', 'currency'] as const;
    const priceChanges = priceKeys.filter((k) => dto[k] !== undefined && dto[k] !== (before as any)[k]);
    const inUse = await this.prisma.company.count({ where: { planId: id } });
    if (priceChanges.length && inUse > 0 && dto.confirmAffects !== true) {
      throw new BadRequestException(`Este plan lo usan ${inUse} empresas: cambiar ${priceChanges.join(', ')} cambia lo que se les cobra. Si fue un acuerdo, usa un precio pactado por empresa; si no, confirma el cambio.`);
    }
    const plan = await this.prisma.plan.update({
      where: { id },
      data: {
        name: dto.name,
        priceMonthly: dto.priceMonthly,
        maxBots: dto.maxBots,
        maxWorkspaces: dto.maxWorkspaces,
        maxUsers: dto.maxUsers,
        ...(dto.includedAiConversations != null
          ? { includedAiConversations: Math.max(0, Math.round(Number(dto.includedAiConversations))) }
          : {}),
        highlight: dto.highlight,
        ...this.commercialFields(dto),
        active: dto.active,
        ...(dto.features ? { featuresJson: JSON.stringify(dto.features) } : {}),
      },
    });
    await this.audit.log({
      actor,
      action: 'plan.update',
      entity: 'Plan',
      entityId: plan.id,
      detail: priceChanges.length
        ? `${plan.name} · ${priceChanges.map((k) => `${k}: ${(before as any)[k]} → ${(plan as any)[k]}`).join(', ')} · ${inUse} empresas`
        : plan.name,
    });
    return plan;
  }

  async remove(actor: AuthUser, id: string) {
    // Borrar un plan en uso dejaría contratos sin condiciones: se desactiva en su lugar
    const inUse = await this.prisma.company.count({ where: { planId: id } });
    if (inUse > 0) throw new BadRequestException(`Este plan lo usan ${inUse} empresas: desactívalo (deja de venderse y los contratos vigentes se conservan).`);
    await this.prisma.plan.delete({ where: { id } });
    await this.audit.log({ actor, action: 'plan.delete', entity: 'Plan', entityId: id });
    return { ok: true };
  }
}

@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.plans.list(user);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.plans.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.plans.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.plans.remove(user, id);
  }
}

@Module({
  controllers: [PlansController],
  providers: [PlansService],
})
export class PlansModule {}
