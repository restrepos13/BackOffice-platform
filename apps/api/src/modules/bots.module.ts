import { isOpenRouterModel } from '../ai/model-routing';
import { effectiveAiMode } from '../ai/ai-access';
import {
  Body,
  Controller,
  Delete,
  BadRequestException,
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
import { AGENT_PRESETS, AGENT_TOOLS, sanitizeToolsConfig } from '../ai/agent/tools';

function normalizeAiSource(value: unknown): string {
  return value === 'BYOK' || value === 'PLATFORM' || value === 'HYBRID' ? value : 'INHERIT';
}
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';
import { Products } from '../auth/products.guard';

@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(bot: any) {
    return {
      ...bot,
      personality: parseJson<Record<string, string>>(bot.personalityJson, {}),
      sales: parseJson<Record<string, string>>(bot.salesJson, {}),
      tools: sanitizeToolsConfig(parseJson<any[]>(bot.toolsJson, [])),
    };
  }

  /** Solo plataforma fija quién paga la IA de un asistente. */
  private aiSourceFor(user: AuthUser, value: unknown): string {
    if (!isPlatformRole(user.role)) {
      throw new ForbiddenException('Solo BackOffice define quién paga la IA de un asistente');
    }
    return normalizeAiSource(value);
  }

  /** Catálogo de herramientas del agente + plantillas por tipo de negocio. */
  agentCatalog() {
    return {
      tools: AGENT_TOOLS.map((t) => ({
        name: t.name, access: t.access, description: t.description,
      })),
      presets: Object.entries(AGENT_PRESETS).map(([key, p]) => ({
        key, label: p.label, description: p.description, tools: p.tools,
      })),
    };
  }

  private async assertAccess(user: AuthUser, botId: string) {
    const bot = await this.prisma.bot.findUnique({ where: { id: botId } });
    if (!bot) throw new NotFoundException('Bot no encontrado');
    if (!isPlatformRole(user.role) && bot.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return bot;
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const bots = await this.prisma.bot.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { createdAt: 'asc' },
      include: {
        company: { select: { name: true, slug: true } },
        integrations: { select: { id: true, type: true, status: true } },
        _count: { select: { conversations: true } },
      },
    });
    return bots.map((b) => this.serialize(b));
  }

  async detail(user: AuthUser, id: string) {
    await this.assertAccess(user, id);
    const bot = await this.prisma.bot.findUnique({
      where: { id },
      include: {
        company: { select: { name: true, slug: true } },
        integrations: true,
        _count: { select: { conversations: true } },
      },
    });
    return this.serialize(bot);
  }

  /** Claude Haiku (OpenRouter) solo con la IA de BackOffice: la llave del cliente es de DeepInfra. */
  private async assertModelAllowed(companyId: string, model: unknown, aiSource: unknown) {
    if (!isOpenRouterModel(String(model ?? ''))) return;
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const mode = effectiveAiMode(company ?? {}, { aiSource: aiSource ?? 'INHERIT' });
    if (mode === 'BYOK') {
      throw new BadRequestException('Claude Haiku funciona con la IA de BackOffice (paquetes). Cambia cómo se paga la IA o elige otro modelo.');
    }
  }

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role)
      ? dto.companyId
      : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    await this.assertModelAllowed(companyId, dto.model, dto.aiSource);
    const bot = await this.prisma.bot.create({
      data: {
        companyId,
        name: dto.name,
        description: dto.description,
        status: dto.status ?? 'DRAFT',
        provider: dto.provider ?? 'anthropic',
        model: dto.model ?? 'claude-sonnet-5',
        temperature: dto.temperature ?? 0.7,
        maxTokens: dto.maxTokens ?? 1024,
        systemPrompt: dto.systemPrompt ?? '',
        personalityJson: JSON.stringify(dto.personality ?? {}),
        memoryEnabled: dto.memoryEnabled ?? true,
        welcomeMessage: dto.welcomeMessage,
        handoffKeywords: dto.handoffKeywords,
        businessHours: dto.businessHours ? JSON.stringify(dto.businessHours) : null,
        replyDelayMinSec: dto.replyDelayMinSec ?? 3,
        replyDelayMaxSec: dto.replyDelayMaxSec ?? 12,
        typingSimulation: dto.typingSimulation ?? true,
        salesJson: JSON.stringify(dto.sales ?? {}),
        engineMode: dto.engineMode === 'AGENT' ? 'AGENT' : 'ORDERS',
        // Quién paga la IA del asistente: solo BackOffice lo decide (lo vende aparte)
        ...(isPlatformRole(user.role) && dto.aiSource ? { aiSource: normalizeAiSource(dto.aiSource) } : {}),
        toolsJson: JSON.stringify(
          sanitizeToolsConfig(dto.tools ?? (dto.agentPreset ? AGENT_PRESETS[dto.agentPreset]?.tools : [])),
        ),
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'bot.create', entity: 'Bot',
      entityId: bot.id, detail: bot.name,
    });
    return this.serialize(bot);
  }

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    if (dto.model !== undefined || dto.aiSource !== undefined) {
      await this.assertModelAllowed(existing.companyId, dto.model ?? existing.model, dto.aiSource ?? existing.aiSource);
    }
    const bot = await this.prisma.bot.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        status: dto.status,
        provider: dto.provider,
        model: dto.model,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        systemPrompt: dto.systemPrompt,
        memoryEnabled: dto.memoryEnabled,
        welcomeMessage: dto.welcomeMessage,
        handoffKeywords: dto.handoffKeywords,
        replyDelayMinSec: dto.replyDelayMinSec != null ? Number(dto.replyDelayMinSec) : undefined,
        replyDelayMaxSec: dto.replyDelayMaxSec != null ? Number(dto.replyDelayMaxSec) : undefined,
        typingSimulation: dto.typingSimulation,
        ...(dto.sales ? { salesJson: JSON.stringify(dto.sales) } : {}),
        ...(dto.engineMode !== undefined
          ? { engineMode: dto.engineMode === 'AGENT' ? 'AGENT' : 'ORDERS' }
          : {}),
        ...(dto.tools !== undefined
          ? { toolsJson: JSON.stringify(sanitizeToolsConfig(dto.tools)) }
          : {}),
        ...(dto.aiSource !== undefined ? { aiSource: this.aiSourceFor(user, dto.aiSource) } : {}),
        ...(dto.personality
          ? { personalityJson: JSON.stringify(dto.personality) }
          : {}),
        ...(dto.businessHours
          ? { businessHours: JSON.stringify(dto.businessHours) }
          : {}),
      },
    });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'bot.update',
      entity: 'Bot', entityId: id, detail: bot.name,
    });
    return this.serialize(bot);
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.assertAccess(user, id);
    await this.prisma.bot.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'bot.delete',
      entity: 'Bot', entityId: id, detail: existing.name,
    });
    return { ok: true };
  }
}

@Products('AUTOMATION')
@Controller('bots')
export class BotsController {
  constructor(private readonly bots: BotsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.bots.list(user, companyId);
  }

  @Get('agent-catalog')
  agentCatalog() {
    return this.bots.agentCatalog();
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bots.detail(user, id);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.bots.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.bots.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.bots.remove(user, id);
  }
}

@Module({
  controllers: [BotsController],
  providers: [BotsService],
})
export class BotsModule {}
