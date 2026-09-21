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
  parseJson,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';

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

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role)
      ? dto.companyId
      : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
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

@Controller('bots')
export class BotsController {
  constructor(private readonly bots: BotsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.bots.list(user, companyId);
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
