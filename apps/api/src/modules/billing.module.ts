import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeAiQuota } from '../ai/ai-access';
import { CurrentUser } from '../auth/decorators';
import { AuthUser, scopeCompanyId } from '../common/constants';

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Resumen de la mensualidad: plan + consumo desglosado del período. */
  async summary(user: AuthUser, companyId?: string, period?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') {
      throw new ForbiddenException('Falta companyId');
    }
    const now = new Date();
    const p = period ?? now.toISOString().slice(0, 7); // "2026-09"
    const [year, month] = p.split('-').map(Number);
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 1);

    const [company, usage] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({
        where: { id: scoped },
        include: { plan: true },
      }),
      this.prisma.usageRecord.findMany({
        where: { companyId: scoped, date: { gte: from, lt: to } },
      }),
    ]);

    const aiCostUsd = usage.reduce((s, u) => s + u.aiCostUsd, 0);
    const waCostUsd = usage.reduce((s, u) => s + u.waCostUsd, 0);
    const storageCostUsd = usage.reduce((s, u) => s + u.storageCostUsd, 0);
    const aiTokens = usage.reduce((s, u) => s + u.aiTokens, 0);
    const waConversations = usage.reduce((s, u) => s + u.waConversations, 0);
    const storageMb = usage.length
      ? Math.max(...usage.map((u) => u.storageMb))
      : 0;
    // BYOK: la IA la paga la empresa directo a DeepInfra con su llave —
    // se muestra como informativa y NO entra en la mensualidad de BackOffice.
    // PLATFORM: la IA es de BackOffice; entra el excedente de conversaciones.
    const aiQuota = await computeAiQuota(this.prisma, company, now, { from, to });
    const consumption = waCostUsd + storageCostUsd + aiQuota.extraChargeUsd;
    const planAmount = company.plan?.priceMonthly ?? 0;

    const round = (n: number) => Math.round(n * 100) / 100;

    return {
      period: p,
      company: { id: company.id, name: company.name, status: company.status },
      plan: company.plan
        ? { name: company.plan.name, code: company.plan.code, priceMonthly: planAmount }
        : null,
      consumption: {
        ai: {
          costUsd: round(aiCostUsd),
          tokens: aiTokens,
          directBilled: aiQuota.mode === 'BYOK',
          mode: aiQuota.mode,
          conversations: aiQuota.conversations,
          included: aiQuota.included,
          extra: aiQuota.extra,
          extraPriceUsd: aiQuota.extraPriceUsd,
          extraChargeUsd: aiQuota.extraChargeUsd,
        },
        whatsapp: { costUsd: round(waCostUsd), conversations: waConversations },
        storage: { costUsd: round(storageCostUsd), mb: round(storageMb) },
        totalUsd: round(consumption),
      },
      totalUsd: round(planAmount + consumption),
    };
  }

  async invoices(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.invoice.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { period: 'desc' },
      include: { company: { select: { name: true, slug: true } } },
    });
  }
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  summary(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('period') period?: string,
  ) {
    return this.billing.summary(user, companyId, period);
  }

  @Get('invoices')
  invoices(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.billing.invoices(user, companyId);
  }
}

@Module({
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
