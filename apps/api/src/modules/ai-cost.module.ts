import { Controller, ForbiddenException, Get, Injectable, Module, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators';
import { AuthUser, NOT_DELETED, isPlatformRole, parseJson } from '../common/constants';
import { CostModel, REFERENCE_MODELS, estimateAiCosts } from '../common/ai-cost';
import { AI_RESALE_MARKUP } from '../common/offer';
import { usdCopRate } from '../common/trm';

/**
 * "¿Cuánto me cuesta la IA?" para cada empresa, con SUS números: tamaño de las
 * instrucciones de su asistente, su catálogo, su base de conocimiento y cuántos
 * clientes le escriben al día. Todo con código; nunca se gasta IA en esto.
 */

const DEFAULT_DAILY_CHATS = 20;

@Injectable()
export class AiCostService {
  constructor(private readonly prisma: PrismaService) {}

  async models(): Promise<CostModel[]> {
    const rows = await this.prisma.aiModel.findMany({ where: { active: true } });
    const db: CostModel[] = rows.map((m: any) => ({
      modelId: m.modelId, name: m.name, provider: m.provider, inputCostPerMTok: m.inputCostPerMTok,
      outputCostPerMTok: m.outputCostPerMTok, creditsPerConversation: m.creditsPerConversation ?? 1,
      recommended: m.recommended, notes: m.notes,
    }));
    const known = new Set(db.map((m) => m.modelId));
    return [...db, ...REFERENCE_MODELS.filter((m) => !known.has(m.modelId))];
  }

  async trm(): Promise<number> {
    return usdCopRate(this.prisma);
  }

  async estimate(user: AuthUser, query: { companyId?: string; dailyChats?: string }) {
    const companyId = isPlatformRole(user.role) ? query.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const [company, bots, products, knowledge, packages, models, trm] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
      this.prisma.bot.findMany({ where: { companyId } }),
      this.prisma.product.count({ where: { companyId, active: true, ...NOT_DELETED } }),
      this.prisma.knowledgeDoc.findMany({ where: { companyId, status: 'READY' }, select: { chars: true } }),
      this.prisma.aiCreditPackage.findMany({ where: { active: true }, orderBy: { conversations: 'asc' } }),
      this.models(),
      this.trm(),
    ]);
    const bot: any = bots.find((b: any) => b.active !== false) ?? bots[0] ?? null;
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const asked = Number(query.dailyChats);
    const dailyChats = Number.isFinite(asked) && asked > 0 && asked <= 5000
      ? Math.round(asked)
      : Number(ob.dailyChats) > 0 ? Number(ob.dailyChats) : DEFAULT_DAILY_CHATS;
    const promptChars = bot
      ? String(bot.systemPrompt ?? '').length + String(bot.personalityJson ?? '').length + String(bot.welcomeMessage ?? '').length
      : 1500;
    const result = estimateAiCosts(
      {
        promptChars,
        knowledgeChars: knowledge.reduce((a: number, k: any) => a + (k.chars ?? 0), 0),
        products,
        dailyChats,
        agentMode: bot?.engineMode === 'AGENT',
        trm,
        currentModel: bot?.model ?? null,
      },
      models,
      packages.map((p: any) => ({ id: p.id, name: p.name, conversations: p.conversations, price: p.price, validityMonths: p.validityMonths })),
    );
    // "Todo incluido": lo que ve el cliente es lo que se le cobra (con la gestión incluida)
    if (company.serviceMode === 'MANAGED') {
      const k = 1 + AI_RESALE_MARKUP;
      const scale = (v: { usd: number; cop: number }) => ({ usd: Math.round(v.usd * k * 1e5) / 1e5, cop: Math.round(v.cop * k * 10) / 10 });
      for (const m of result.models) {
        m.perConversation = scale(m.perConversation);
        m.perMonth = scale(m.perMonth);
        m.report.perQuery = scale(m.report.perQuery);
        m.report.perMonth = scale(m.report.perMonth);
      }
    }
    return {
      ...result,
      company: { name: company.name, aiBillingMode: company.aiBillingMode ?? 'BYOK', serviceMode: company.serviceMode === 'MANAGED' ? 'MANAGED' : 'SELF' },
      bot: bot ? { name: bot.name, model: bot.model } : null,
      dailyChatsSource: Number.isFinite(asked) && asked > 0 ? 'manual' : Number(ob.dailyChats) > 0 ? 'registro' : 'estimado',
    };
  }
}

@Controller('ai-costs')
export class AiCostController {
  constructor(private readonly costs: AiCostService) {}

  @Get('estimate')
  estimate(@CurrentUser() user: AuthUser, @Query() query: { companyId?: string; dailyChats?: string }) {
    return this.costs.estimate(user, query);
  }
}

@Module({
  controllers: [AiCostController],
  providers: [AiCostService],
  exports: [AiCostService],
})
export class AiCostModule {}
