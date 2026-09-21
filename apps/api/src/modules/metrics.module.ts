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
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  scopeCompanyId,
} from '../common/constants';

function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

@Injectable()
export class MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Vista global de plataforma (solo SUPER_ADMIN / DEV). */
  async platform() {
    const [companies, plans, usersCount, botsCount] = await Promise.all([
      this.prisma.company.findMany({ include: { plan: true } }),
      this.prisma.plan.findMany(),
      this.prisma.user.count(),
      this.prisma.bot.count(),
    ]);
    const active = companies.filter((c) => c.status === 'ACTIVE');
    const mrr = active.reduce((sum, c) => sum + (c.plan?.priceMonthly ?? 0), 0);

    const since = daysAgo(30);
    const usage = await this.prisma.usageRecord.findMany({
      where: { date: { gte: since } },
      orderBy: { date: 'asc' },
    });

    // Serie diaria agregada
    const byDay = new Map<string, { date: string; messages: number; aiCostUsd: number; waCostUsd: number }>();
    for (const u of usage) {
      const key = u.date.toISOString().slice(0, 10);
      const row = byDay.get(key) ?? { date: key, messages: 0, aiCostUsd: 0, waCostUsd: 0 };
      row.messages += u.messagesIn + u.messagesOut;
      row.aiCostUsd += u.aiCostUsd;
      row.waCostUsd += u.waCostUsd;
      byDay.set(key, row);
    }

    // Top empresas por consumo
    const byCompany = new Map<string, { messages: number; costUsd: number }>();
    for (const u of usage) {
      const row = byCompany.get(u.companyId) ?? { messages: 0, costUsd: 0 };
      row.messages += u.messagesIn + u.messagesOut;
      row.costUsd += u.aiCostUsd + u.waCostUsd + u.storageCostUsd;
      byCompany.set(u.companyId, row);
    }
    const topCompanies = [...byCompany.entries()]
      .map(([companyId, v]) => ({
        companyId,
        name: companies.find((c) => c.id === companyId)?.name ?? '—',
        ...v,
      }))
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 8);

    const attention = await this.prisma.conversation.count({
      where: { needsAttention: true },
    });
    const openConversations = await this.prisma.conversation.count({
      where: { status: { in: ['OPEN', 'PENDING', 'HANDOFF'] } },
    });

    const totalMessages30d = usage.reduce(
      (s, u) => s + u.messagesIn + u.messagesOut, 0,
    );
    const totalCost30d = usage.reduce(
      (s, u) => s + u.aiCostUsd + u.waCostUsd + u.storageCostUsd, 0,
    );

    return {
      kpis: {
        companies: companies.length,
        activeCompanies: active.length,
        trialCompanies: companies.filter((c) => c.status === 'TRIAL').length,
        suspendedCompanies: companies.filter((c) => c.status === 'SUSPENDED').length,
        mrr,
        users: usersCount,
        bots: botsCount,
        messages30d: totalMessages30d,
        consumption30d: Math.round(totalCost30d * 100) / 100,
        attention,
        openConversations,
      },
      series: [...byDay.values()],
      topCompanies,
      plansDistribution: plans.map((p) => ({
        plan: p.name,
        companies: companies.filter((c) => c.planId === p.id).length,
      })),
    };
  }

  /** Dashboard de una empresa (scoped por rol). */
  async company(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') {
      throw new ForbiddenException('Falta companyId');
    }
    const since = daysAgo(30);
    const today = daysAgo(0);
    const week = daysAgo(7);

    const [usage, conversations, contacts, bots, automations] =
      await Promise.all([
        this.prisma.usageRecord.findMany({
          where: { companyId: scoped, date: { gte: since } },
          orderBy: { date: 'asc' },
        }),
        this.prisma.conversation.findMany({
          where: { companyId: scoped },
          select: {
            status: true, needsAttention: true, channel: true,
            lastMessageAt: true, createdAt: true, integrationId: true,
          },
        }),
        this.prisma.contact.findMany({
          where: { companyId: scoped },
          select: { stage: true, createdAt: true, channel: true },
        }),
        this.prisma.bot.findMany({
          where: { companyId: scoped },
          select: { id: true, name: true, status: true },
        }),
        this.prisma.automation.findMany({
          where: { companyId: scoped },
          select: { status: true, runsCount: true, successRate: true },
        }),
      ]);

    const stageCount = (stage: string) =>
      contacts.filter((c) => c.stage === stage).length;

    // Ranking por línea/número (los "perfiles" del estudio o áreas de la clínica)
    const lines = await this.prisma.integration.findMany({
      where: { companyId: scoped, type: 'WHATSAPP' },
      select: {
        id: true, name: true, status: true, promptMode: true,
        configJson: true, bot: { select: { name: true } },
      },
    });
    const lineStats = await Promise.all(
      lines.map(async (line) => {
        const convos = conversations.filter((c) => c.integrationId === line.id);
        const messages30d = await this.prisma.message.count({
          where: {
            conversation: { integrationId: line.id },
            createdAt: { gte: since },
          },
        });
        let displayPhone = '';
        try {
          displayPhone = JSON.parse(line.configJson).displayPhone ?? '';
        } catch {}
        return {
          id: line.id,
          name: line.name,
          status: line.status,
          promptMode: line.promptMode,
          botName: line.bot?.name ?? null,
          displayPhone,
          conversations: convos.length,
          open: convos.filter((c) =>
            ['OPEN', 'PENDING', 'HANDOFF'].includes(c.status),
          ).length,
          attention: convos.filter((c) => c.needsAttention).length,
          messages30d,
        };
      }),
    );
    lineStats.sort((a, b) => b.messages30d - a.messages30d);

    const channelBreakdown = Object.entries(
      conversations.reduce<Record<string, number>>((acc, c) => {
        acc[c.channel] = (acc[c.channel] ?? 0) + 1;
        return acc;
      }, {}),
    ).map(([channel, count]) => ({ channel, count }));

    return {
      kpis: {
        conversationsToday: conversations.filter((c) => c.lastMessageAt >= today).length,
        conversations7d: conversations.filter((c) => c.lastMessageAt >= week).length,
        openConversations: conversations.filter((c) =>
          ['OPEN', 'PENDING', 'HANDOFF'].includes(c.status),
        ).length,
        attention: conversations.filter((c) => c.needsAttention).length,
        contacts: contacts.length,
        newContacts7d: contacts.filter((c) => c.createdAt >= week).length,
        hotLeads: stageCount('CALIENTE'),
        clients: stageCount('CLIENTE'),
        activeBots: bots.filter((b) => b.status === 'ACTIVE').length,
        activeAutomations: automations.filter((a) => a.status === 'ACTIVE').length,
        messages30d: usage.reduce((s, u) => s + u.messagesIn + u.messagesOut, 0),
        consumption30d:
          Math.round(
            usage.reduce(
              (s, u) => s + u.aiCostUsd + u.waCostUsd + u.storageCostUsd, 0,
            ) * 100,
          ) / 100,
      },
      series: usage.map((u) => ({
        date: u.date.toISOString().slice(0, 10),
        messagesIn: u.messagesIn,
        messagesOut: u.messagesOut,
        aiCostUsd: u.aiCostUsd,
        waCostUsd: u.waCostUsd,
        aiTokens: u.aiTokens,
      })),
      channelBreakdown,
      lines: lineStats,
      funnel: [
        { stage: 'CURIOSO', count: stageCount('CURIOSO') },
        { stage: 'POTENCIAL', count: stageCount('POTENCIAL') },
        { stage: 'CALIENTE', count: stageCount('CALIENTE') },
        { stage: 'CLIENTE', count: stageCount('CLIENTE') },
      ],
      bots,
    };
  }
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('platform')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  platform() {
    return this.metrics.platform();
  }

  @Get('company')
  company(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.metrics.company(user, companyId);
  }
}

@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}
