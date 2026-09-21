import { Controller, Get, Global, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, scopeCompanyId } from '../common/constants';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(params: {
    actor: AuthUser | null;
    companyId?: string | null;
    action: string;
    entity: string;
    entityId?: string;
    detail?: string;
  }) {
    await this.prisma.auditLog.create({
      data: {
        actorId: params.actor?.id ?? null,
        actorName: params.actor?.name ?? 'Sistema',
        companyId: params.companyId ?? null,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        detail: params.detail,
      },
    });
  }
}

@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('take') take = '100',
  ) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.auditLog.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(take) || 100, 500),
      include: {
        company: { select: { name: true, slug: true } },
      },
    });
  }
}

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
