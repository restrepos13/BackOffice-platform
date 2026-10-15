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
import { buildConnectUrl } from './companies.module';
import { encryptSecret } from '../common/crypto';

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(i: any) {
    // Los secretos cifrados JAMÁS salen del API (ni cifrados): se quita el
    // configJson CRUDO y cualquier variante de credencial del config parseado.
    const { configJson: _raw, ...row } = i;
    const {
      authTokenEnc,
      authToken: _plain,
      authTokenEncrypted: _legacy,
      accessTokenEnc,
      accessToken: _metaPlain,
      ...config
    } = parseJson<Record<string, any>>(i.configJson, {});
    return {
      ...row,
      config: { ...config, twilioConfigured: !!authTokenEnc, metaConfigured: !!accessTokenEnc },
      overridePersonality: parseJson<Record<string, string>>(
        i.overridePersonalityJson,
        {},
      ),
      overrideSales: parseJson<Record<string, string>>(i.overrideSalesJson, {}),
    };
  }

  /** Mezcla la config nueva con la existente y cifra los secretos entrantes.
   *  El authToken de Twilio llega en claro UNA vez y se guarda cifrado. */
  private mergeConfig(existingJson: string, incoming: Record<string, any>): string {
    const { twilioConfigured: _ignored, metaConfigured: _ignored2, authToken, accessToken, ...rest } = incoming;
    const merged: Record<string, any> = {
      ...parseJson<Record<string, any>>(existingJson, {}),
      ...rest,
    };
    if (typeof authToken === 'string' && authToken.trim()) {
      merged.authTokenEnc = encryptSecret(authToken.trim());
    }
    if (authToken === '') delete merged.authTokenEnc; // quitar credencial
    // Token de página de Meta (Instagram / Messenger / WhatsApp Cloud API)
    if (typeof accessToken === 'string' && accessToken.trim()) {
      merged.accessTokenEnc = encryptSecret(accessToken.trim());
    }
    if (accessToken === '') delete merged.accessTokenEnc;
    return JSON.stringify(merged);
  }

  private async assertAccess(user: AuthUser, id: string) {
    const integration = await this.prisma.integration.findUnique({ where: { id } });
    if (!integration) throw new NotFoundException('Integración no encontrada');
    if (!isPlatformRole(user.role) && integration.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return integration;
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const items = await this.prisma.integration.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { createdAt: 'asc' },
      include: {
        company: { select: { name: true, slug: true } },
        bot: { select: { id: true, name: true, model: true } },
        _count: { select: { conversations: true } },
      },
    });
    return items.map((i) => this.serialize(i));
  }

  async detail(user: AuthUser, id: string) {
    await this.assertAccess(user, id);
    const integration = await this.prisma.integration.findUnique({
      where: { id },
      include: {
        company: { select: { name: true, slug: true } },
        bot: true,
        _count: { select: { conversations: true } },
      },
    });
    return this.serialize(integration);
  }

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: companyId },
    });
    const integration = await this.prisma.integration.create({
      data: {
        companyId,
        botId: dto.botId,
        type: dto.type,
        name: dto.name ?? dto.type,
        status: 'DISCONNECTED',
        connectUrl: dto.connectUrl ?? buildConnectUrl(dto.type, company.slug),
        webhookUrl: `http://localhost:4001/api/webhooks/${company.slug}/${String(dto.type).toLowerCase()}`,
        configJson: this.mergeConfig('{}', dto.config ?? {}),
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'integration.create',
      entity: 'Integration', entityId: integration.id, detail: integration.name,
    });
    return this.serialize(integration);
  }

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    const integration = await this.prisma.integration.update({
      where: { id },
      data: {
        name: dto.name,
        status: dto.status,
        botId: dto.botId,
        connectUrl: dto.connectUrl,
        errorMsg: dto.errorMsg,
        promptMode: dto.promptMode,
        overridePrompt: dto.overridePrompt,
        overrideWelcome: dto.overrideWelcome,
        overrideHandoff: dto.overrideHandoff,
        overrideModel: dto.overrideModel,
        overrideTemperature: dto.overrideTemperature,
        overrideReplyDelayMinSec:
          dto.overrideReplyDelayMinSec === null
            ? null
            : dto.overrideReplyDelayMinSec != null
              ? Number(dto.overrideReplyDelayMinSec)
              : undefined,
        overrideReplyDelayMaxSec:
          dto.overrideReplyDelayMaxSec === null
            ? null
            : dto.overrideReplyDelayMaxSec != null
              ? Number(dto.overrideReplyDelayMaxSec)
              : undefined,
        ...(dto.overrideSales
          ? { overrideSalesJson: JSON.stringify(dto.overrideSales) }
          : {}),
        ...(dto.overridePersonality
          ? { overridePersonalityJson: JSON.stringify(dto.overridePersonality) }
          : {}),
        ...(dto.config
          ? { configJson: this.mergeConfig(existing.configJson, dto.config) }
          : {}),
        ...(dto.status === 'CONNECTED' ? { lastSyncAt: new Date() } : {}),
      },
    });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'integration.update',
      entity: 'Integration', entityId: id,
      detail: `${integration.name} → ${integration.status}`,
    });
    return this.serialize(integration);
  }

  /** Clona una línea con toda su personalidad (queda desconectada). */
  async clone(user: AuthUser, id: string) {
    const source = await this.assertAccess(user, id);
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: source.companyId },
    });
    const copy = await this.prisma.integration.create({
      data: {
        companyId: source.companyId,
        botId: source.botId,
        type: source.type,
        name: `${source.name} (copia)`,
        status: 'DISCONNECTED',
        configJson: '{}',
        connectUrl: buildConnectUrl(source.type, company.slug),
        webhookUrl: `http://localhost:4001/api/webhooks/${company.slug}/${source.type.toLowerCase()}`,
        promptMode: source.promptMode,
        overridePrompt: source.overridePrompt,
        overridePersonalityJson: source.overridePersonalityJson,
        overrideWelcome: source.overrideWelcome,
        overrideHandoff: source.overrideHandoff,
        overrideModel: source.overrideModel,
        overrideTemperature: source.overrideTemperature,
        overrideReplyDelayMinSec: source.overrideReplyDelayMinSec,
        overrideReplyDelayMaxSec: source.overrideReplyDelayMaxSec,
        overrideSalesJson: source.overrideSalesJson,
      },
    });
    await this.audit.log({
      actor: user, companyId: source.companyId, action: 'integration.clone',
      entity: 'Integration', entityId: copy.id,
      detail: `${source.name} → ${copy.name}`,
    });
    return this.serialize(copy);
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.assertAccess(user, id);
    await this.prisma.integration.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'integration.delete',
      entity: 'Integration', entityId: id, detail: existing.name,
    });
    return { ok: true };
  }
}

@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.integrations.list(user, companyId);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.integrations.detail(user, id);
  }

  @Post(':id/clone')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  clone(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.integrations.clone(user, id);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.integrations.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.integrations.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.integrations.remove(user, id);
  }
}

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
