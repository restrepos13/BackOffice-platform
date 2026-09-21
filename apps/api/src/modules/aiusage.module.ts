import {
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, scopeCompanyId } from '../common/constants';

/**
 * Consumo de IA en detalle (eventos AiUsageEvent).
 * El costo lo asume cada empresa directo con DeepInfra (BYOK): estos paneles
 * son transparencia operativa, no facturación de BackOffice.
 * Proyección de fin de mes: gasto acumulado del mes / días transcurridos × días del mes.
 */

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

interface Filters {
  companyId?: string;
  days: number;
  integrationId?: string;
  model?: string;
}

@Injectable()
export class AiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  private async fetchEvents(f: Filters) {
    const since = startOfDay(new Date());
    since.setDate(since.getDate() - (f.days - 1));
    return this.prisma.aiUsageEvent.findMany({
      where: {
        ...(f.companyId ? { companyId: f.companyId } : {}),
        ...(f.integrationId ? { integrationId: f.integrationId } : {}),
        ...(f.model ? { model: f.model } : {}),
        createdAt: { gte: since },
      },
      select: {
        companyId: true, integrationId: true, model: true,
        inputTokens: true, outputTokens: true, costUsd: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Proyección del mes en curso (sin filtro de rango: siempre mes calendario). */
  private async monthProjection(companyId?: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const agg = await this.prisma.aiUsageEvent.aggregate({
      where: {
        ...(companyId ? { companyId } : {}),
        createdAt: { gte: monthStart },
      },
      _sum: { costUsd: true, inputTokens: true, outputTokens: true },
      _count: true,
    });
    const costMonth = agg._sum.costUsd ?? 0;
    return {
      costMonth: round2(costMonth),
      projectedMonth: round2((costMonth / dayOfMonth) * daysInMonth),
      tokensMonth: (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0),
      eventsMonth: agg._count,
      dayOfMonth,
      daysInMonth,
    };
  }

  /** Panel de consumo de UNA empresa (con filtros por línea y modelo). */
  async company(user: AuthUser, q: {
    companyId?: string; days?: string; integrationId?: string; model?: string;
  }) {
    const scoped = scopeCompanyId(user, q.companyId);
    if (!scoped || scoped === '__none__') {
      throw new ForbiddenException('Falta companyId');
    }
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 180);
    const [events, projection, company, lines] = await Promise.all([
      this.fetchEvents({
        companyId: scoped, days,
        integrationId: q.integrationId || undefined,
        model: q.model || undefined,
      }),
      this.monthProjection(scoped),
      this.prisma.company.findUnique({
        where: { id: scoped },
        select: { deepinfraApiKey: true },
      }),
      this.prisma.integration.findMany({
        where: { companyId: scoped, type: 'WHATSAPP' },
        select: { id: true, name: true },
      }),
    ]);

    // Serie diaria
    const byDay = new Map<string, { date: string; costUsd: number; inputTokens: number; outputTokens: number; events: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = startOfDay(new Date());
      d.setDate(d.getDate() - i);
      byDay.set(dayKey(d), { date: dayKey(d), costUsd: 0, inputTokens: 0, outputTokens: 0, events: 0 });
    }
    // Desgloses
    const byModel = new Map<string, { model: string; costUsd: number; tokens: number; events: number }>();
    const byLine = new Map<string, { integrationId: string | null; costUsd: number; tokens: number; events: number }>();
    let totalCost = 0, totalIn = 0, totalOut = 0;

    for (const ev of events) {
      totalCost += ev.costUsd;
      totalIn += ev.inputTokens;
      totalOut += ev.outputTokens;
      const dRow = byDay.get(dayKey(ev.createdAt));
      if (dRow) {
        dRow.costUsd = round4(dRow.costUsd + ev.costUsd);
        dRow.inputTokens += ev.inputTokens;
        dRow.outputTokens += ev.outputTokens;
        dRow.events += 1;
      }
      const mRow = byModel.get(ev.model) ?? { model: ev.model, costUsd: 0, tokens: 0, events: 0 };
      mRow.costUsd = round4(mRow.costUsd + ev.costUsd);
      mRow.tokens += ev.inputTokens + ev.outputTokens;
      mRow.events += 1;
      byModel.set(ev.model, mRow);
      const lineKey = ev.integrationId ?? '__none__';
      const lRow = byLine.get(lineKey) ?? { integrationId: ev.integrationId, costUsd: 0, tokens: 0, events: 0 };
      lRow.costUsd = round4(lRow.costUsd + ev.costUsd);
      lRow.tokens += ev.inputTokens + ev.outputTokens;
      lRow.events += 1;
      byLine.set(lineKey, lRow);
    }

    const lineName = (id: string | null) =>
      id ? (lines.find((l) => l.id === id)?.name ?? 'Línea eliminada') : 'Sin línea';

    return {
      kpis: {
        costRange: round2(totalCost),
        tokensIn: totalIn,
        tokensOut: totalOut,
        events: events.length,
        avgCostPerEvent: events.length ? round4(totalCost / events.length) : 0,
        avgDaily: round2(totalCost / days),
        ...projection,
      },
      hasDeepinfraKey: !!company?.deepinfraApiKey,
      series: [...byDay.values()],
      byModel: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd),
      byLine: [...byLine.values()]
        .map((r) => ({ ...r, name: lineName(r.integrationId) }))
        .sort((a, b) => b.costUsd - a.costUsd),
      lines,
      lastEventAt: events.length ? events[events.length - 1].createdAt : null,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Panel de consumo GLOBAL de plataforma (todas las empresas). */
  async platform(q: { days?: string; companyId?: string }) {
    const days = Math.min(Math.max(Number(q.days) || 30, 1), 180);
    const [events, companies, projection] = await Promise.all([
      this.fetchEvents({ days, companyId: q.companyId || undefined }),
      this.prisma.company.findMany({
        select: { id: true, name: true, deepinfraApiKey: true, status: true },
      }),
      this.monthProjection(q.companyId || undefined),
    ]);

    const byDay = new Map<string, { date: string; costUsd: number; events: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = startOfDay(new Date());
      d.setDate(d.getDate() - i);
      byDay.set(dayKey(d), { date: dayKey(d), costUsd: 0, events: 0 });
    }
    const byCompany = new Map<string, { companyId: string; costUsd: number; tokens: number; events: number }>();
    let totalCost = 0;
    for (const ev of events) {
      totalCost += ev.costUsd;
      const dRow = byDay.get(dayKey(ev.createdAt));
      if (dRow) {
        dRow.costUsd = round4(dRow.costUsd + ev.costUsd);
        dRow.events += 1;
      }
      const cRow = byCompany.get(ev.companyId) ?? { companyId: ev.companyId, costUsd: 0, tokens: 0, events: 0 };
      cRow.costUsd = round4(cRow.costUsd + ev.costUsd);
      cRow.tokens += ev.inputTokens + ev.outputTokens;
      cRow.events += 1;
      byCompany.set(ev.companyId, cRow);
    }

    // Proyección por empresa (mes calendario)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthAgg = await this.prisma.aiUsageEvent.groupBy({
      by: ['companyId'],
      where: { createdAt: { gte: monthStart } },
      _sum: { costUsd: true },
    });
    const monthByCompany = new Map(
      monthAgg.map((r) => [r.companyId, r._sum.costUsd ?? 0]),
    );

    return {
      kpis: {
        costRange: round2(totalCost),
        events: events.length,
        companiesWithKey: companies.filter((c) => !!c.deepinfraApiKey).length,
        companies: companies.length,
        ...projection,
      },
      series: [...byDay.values()],
      byCompany: [...byCompany.values()]
        .map((r) => {
          const c = companies.find((x) => x.id === r.companyId);
          const costMonth = monthByCompany.get(r.companyId) ?? 0;
          return {
            ...r,
            name: c?.name ?? '—',
            status: c?.status ?? '—',
            hasKey: !!c?.deepinfraApiKey,
            costMonth: round2(costMonth),
            projectedMonth: round2((costMonth / now.getDate()) * daysInMonth),
          };
        })
        .sort((a, b) => b.costUsd - a.costUsd),
      generatedAt: new Date().toISOString(),
    };
  }
}

@Controller('ai-usage')
export class AiUsageController {
  constructor(private readonly usage: AiUsageService) {}

  @Get('company')
  company(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('days') days?: string,
    @Query('integrationId') integrationId?: string,
    @Query('model') model?: string,
  ) {
    return this.usage.company(user, { companyId, days, integrationId, model });
  }

  @Get('platform')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  platform(@Query('days') days?: string, @Query('companyId') companyId?: string) {
    return this.usage.platform({ days, companyId });
  }
}

@Module({
  controllers: [AiUsageController],
  providers: [AiUsageService],
})
export class AiUsageModule {}
