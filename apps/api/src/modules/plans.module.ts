import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { AuditService } from './audit.module';

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const plans = await this.prisma.plan.findMany({
      orderBy: { priceMonthly: 'asc' },
      include: { _count: { select: { companies: true } } },
    });
    return plans.map((p) => ({
      ...p,
      features: parseJson<string[]>(p.featuresJson, []),
    }));
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
        highlight: !!dto.highlight,
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
    const plan = await this.prisma.plan.update({
      where: { id },
      data: {
        name: dto.name,
        priceMonthly: dto.priceMonthly,
        maxBots: dto.maxBots,
        maxWorkspaces: dto.maxWorkspaces,
        maxUsers: dto.maxUsers,
        highlight: dto.highlight,
        active: dto.active,
        ...(dto.features ? { featuresJson: JSON.stringify(dto.features) } : {}),
      },
    });
    await this.audit.log({
      actor,
      action: 'plan.update',
      entity: 'Plan',
      entityId: plan.id,
      detail: plan.name,
    });
    return plan;
  }

  async remove(actor: AuthUser, id: string) {
    await this.prisma.plan.delete({ where: { id } });
    await this.audit.log({ actor, action: 'plan.delete', entity: 'Plan', entityId: id });
    return { ok: true };
  }
}

@Controller('plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.list();
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
