import {
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
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';
import { Products } from '../auth/products.guard';

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertAccess(user: AuthUser, id: string) {
    const automation = await this.prisma.automation.findUnique({ where: { id } });
    if (!automation) throw new NotFoundException('Automatización no encontrada');
    if (!isPlatformRole(user.role) && automation.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return automation;
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.automation.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { createdAt: 'asc' },
      include: {
        company: { select: { name: true, slug: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 5 },
      },
    });
  }

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const automation = await this.prisma.automation.create({
      data: {
        companyId,
        name: dto.name,
        description: dto.description,
        type: dto.type ?? 'FLOW',
        trigger: dto.trigger,
        status: dto.status ?? 'DRAFT',
        configJson: JSON.stringify(dto.config ?? {}),
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'automation.create',
      entity: 'Automation', entityId: automation.id, detail: automation.name,
    });
    return automation;
  }

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    const automation = await this.prisma.automation.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        type: dto.type,
        trigger: dto.trigger,
        status: dto.status,
        ...(dto.config ? { configJson: JSON.stringify(dto.config) } : {}),
      },
    });
    if (dto.status && dto.status !== existing.status) {
      await this.audit.log({
        actor: user, companyId: existing.companyId, action: 'automation.status',
        entity: 'Automation', entityId: id,
        detail: `${automation.name}: ${existing.status} → ${dto.status}`,
      });
    }
    return automation;
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.assertAccess(user, id);
    await this.prisma.automation.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'automation.delete',
      entity: 'Automation', entityId: id, detail: existing.name,
    });
    return { ok: true };
  }
}

@Products('AUTOMATION')
@Controller('automations')
export class AutomationsController {
  constructor(private readonly automations: AutomationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.automations.list(user, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.automations.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.automations.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.automations.remove(user, id);
  }
}

@Module({
  controllers: [AutomationsController],
  providers: [AutomationsService],
})
export class AutomationsModule {}
