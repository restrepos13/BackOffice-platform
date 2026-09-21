import {
  BadRequestException,
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
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
} from '../common/constants';
import { AuditService } from './audit.module';

/** Payload del wizard de aprovisionamiento (crear empresa sin tocar código). */
interface ProvisionCompanyDto {
  // Paso 1 — datos de la empresa
  name: string;
  slug?: string;
  legalName?: string;
  industry?: string;
  country?: string;
  city?: string;
  website?: string;
  contactEmail?: string;
  contactPhone?: string;
  timezone?: string;
  language?: string;
  brandColor?: string;
  notes?: string;
  // Paso 2 — plan y límites
  planId?: string;
  status?: string;
  trialDays?: number;
  limits?: { maxBots?: number; maxUsers?: number; maxWorkspaces?: number };
  // Paso 3 — módulos habilitados
  modules?: string[];
  // Paso 4 — usuario administrador inicial
  admin?: { name: string; email: string; password: string; jobTitle?: string };
  // Paso 5 — bot inicial y canales a dejar preparados
  bot?: {
    name: string;
    description?: string;
    systemPrompt?: string;
    model?: string;
    welcomeMessage?: string;
  };
  channels?: string[]; // WHATSAPP, INSTAGRAM, MESSENGER, TELEGRAM, META_ADS, N8N, GOOGLE_CALENDAR
}

const CHANNEL_LABELS: Record<string, string> = {
  WHATSAPP: 'WhatsApp Business API',
  INSTAGRAM: 'Instagram DM',
  MESSENGER: 'Facebook Messenger',
  TELEGRAM: 'Telegram',
  META_ADS: 'Meta Ads',
  N8N: 'n8n Automations',
  GOOGLE_CALENDAR: 'Google Calendar',
  WEBHOOK: 'Webhook personalizado',
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function buildConnectUrl(type: string, slug: string): string {
  const appId = process.env.META_APP_ID || 'META_APP_ID_PENDIENTE';
  const redirect = encodeURIComponent(
    process.env.META_REDIRECT_URI ??
      'http://localhost:4001/integrations/meta/callback',
  );
  switch (type) {
    case 'WHATSAPP':
      return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&state=${slug}:whatsapp&scope=whatsapp_business_management,whatsapp_business_messaging,business_management`;
    case 'INSTAGRAM':
      return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&state=${slug}:instagram&scope=instagram_basic,instagram_manage_messages,pages_manage_metadata`;
    case 'MESSENGER':
      return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&state=${slug}:messenger&scope=pages_messaging,pages_manage_metadata`;
    case 'META_ADS':
      return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${redirect}&state=${slug}:ads&scope=ads_read,ads_management`;
    case 'TELEGRAM':
      return 'https://core.telegram.org/bots#how-do-i-create-a-bot';
    case 'GOOGLE_CALENDAR':
      return 'https://console.cloud.google.com/apis/credentials';
    case 'N8N':
      return 'http://localhost:5678';
    default:
      return '';
  }
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(company: any) {
    const { deepinfraApiKey, ...rest } = company;
    return {
      ...rest,
      modules: parseJson<string[]>(company.modulesJson, []),
      limits: parseJson<Record<string, number>>(company.limitsJson, {}),
      // La llave de DeepInfra jamás sale completa del API
      hasDeepinfraKey: !!deepinfraApiKey,
      deepinfraKeyMasked: deepinfraApiKey
        ? `••••${String(deepinfraApiKey).slice(-4)}`
        : null,
    };
  }

  async list(user: AuthUser) {
    if (!isPlatformRole(user.role)) {
      const own = await this.prisma.company.findUnique({
        where: { id: user.companyId ?? '__none__' },
        include: { plan: true },
      });
      return own ? [this.serialize(own)] : [];
    }
    const companies = await this.prisma.company.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        plan: true,
        _count: {
          select: { users: true, bots: true, conversations: true, contacts: true },
        },
      },
    });
    return companies.map((c) => this.serialize(c));
  }

  async detail(user: AuthUser, id: string) {
    if (!isPlatformRole(user.role) && user.companyId !== id) {
      throw new ForbiddenException();
    }
    const company = await this.prisma.company.findUnique({
      where: { id },
      include: {
        plan: true,
        users: {
          select: {
            id: true, name: true, email: true, role: true, jobTitle: true,
            active: true, lastLoginAt: true, createdAt: true,
          },
        },
        bots: true,
        integrations: true,
        _count: {
          select: { conversations: true, contacts: true, automations: true },
        },
      },
    });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    return this.serialize(company);
  }

  async provision(actor: AuthUser, dto: ProvisionCompanyDto) {
    if (!dto.name?.trim()) throw new BadRequestException('Falta el nombre');
    const slug = slugify(dto.slug || dto.name);
    const exists = await this.prisma.company.findUnique({ where: { slug } });
    if (exists) throw new BadRequestException(`El slug "${slug}" ya está en uso`);

    const trialDays = dto.trialDays ?? 14;
    const status = dto.status ?? 'TRIAL';

    const company = await this.prisma.company.create({
      data: {
        name: dto.name.trim(),
        slug,
        legalName: dto.legalName,
        industry: dto.industry,
        country: dto.country,
        city: dto.city,
        website: dto.website,
        contactEmail: dto.contactEmail,
        contactPhone: dto.contactPhone,
        timezone: dto.timezone ?? 'America/Bogota',
        language: dto.language ?? 'es',
        brandColor: dto.brandColor,
        notes: dto.notes,
        status,
        planId: dto.planId,
        modulesJson: JSON.stringify(
          dto.modules ?? ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team'],
        ),
        limitsJson: JSON.stringify(dto.limits ?? {}),
        trialEndsAt:
          status === 'TRIAL'
            ? new Date(Date.now() + trialDays * 24 * 3600 * 1000)
            : null,
      },
    });

    // Usuario administrador inicial
    if (dto.admin?.email) {
      const emailTaken = await this.prisma.user.findUnique({
        where: { email: dto.admin.email.toLowerCase() },
      });
      if (emailTaken) {
        throw new BadRequestException(
          `El correo ${dto.admin.email} ya está registrado`,
        );
      }
      await this.prisma.user.create({
        data: {
          email: dto.admin.email.toLowerCase(),
          name: dto.admin.name,
          jobTitle: dto.admin.jobTitle ?? 'Administrador',
          role: ROLES.COMPANY_ADMIN,
          companyId: company.id,
          passwordHash: AuthService.hashPassword(dto.admin.password),
        },
      });
    }

    // Bot inicial
    let botId: string | undefined;
    if (dto.bot?.name) {
      const bot = await this.prisma.bot.create({
        data: {
          companyId: company.id,
          name: dto.bot.name,
          description: dto.bot.description,
          systemPrompt: dto.bot.systemPrompt ?? '',
          model: dto.bot.model ?? 'claude-sonnet-5',
          welcomeMessage: dto.bot.welcomeMessage,
          status: 'DRAFT',
        },
      });
      botId = bot.id;
    }

    // Canales preparados (desconectados, con link de conexión listo)
    const channels = dto.channels ?? ['WHATSAPP'];
    for (const type of channels) {
      await this.prisma.integration.create({
        data: {
          companyId: company.id,
          botId,
          type,
          name: CHANNEL_LABELS[type] ?? type,
          status: 'DISCONNECTED',
          connectUrl: buildConnectUrl(type, slug),
          webhookUrl: `http://localhost:4001/api/webhooks/${slug}/${type.toLowerCase()}`,
        },
      });
    }

    await this.audit.log({
      actor,
      companyId: company.id,
      action: 'company.provision',
      entity: 'Company',
      entityId: company.id,
      detail: `${company.name} aprovisionada (${channels.length} canales)`,
    });

    return this.detail(actor, company.id);
  }

  async update(actor: AuthUser, id: string, dto: any) {
    if (!isPlatformRole(actor.role) && actor.companyId !== id) {
      throw new ForbiddenException();
    }
    // Campos que un admin de empresa puede tocar vs. plataforma
    const platformOnly = ['planId', 'status', 'modules', 'limits', 'slug'];
    if (!isPlatformRole(actor.role)) {
      for (const key of platformOnly) {
        if (key in dto) throw new ForbiddenException(`Solo plataforma puede cambiar ${key}`);
      }
    }
    const company = await this.prisma.company.update({
      where: { id },
      data: {
        name: dto.name,
        legalName: dto.legalName,
        industry: dto.industry,
        country: dto.country,
        city: dto.city,
        website: dto.website,
        contactEmail: dto.contactEmail,
        contactPhone: dto.contactPhone,
        timezone: dto.timezone,
        language: dto.language,
        brandColor: dto.brandColor,
        notes: dto.notes,
        planId: dto.planId,
        status: dto.status,
        // BYOK: la empresa configura su propia llave de DeepInfra
        ...(dto.deepinfraApiKey !== undefined
          ? { deepinfraApiKey: dto.deepinfraApiKey || null }
          : {}),
        ...(dto.modules ? { modulesJson: JSON.stringify(dto.modules) } : {}),
        ...(dto.limits ? { limitsJson: JSON.stringify(dto.limits) } : {}),
      },
    });
    await this.audit.log({
      actor,
      companyId: id,
      action: 'company.update',
      entity: 'Company',
      entityId: id,
      detail: company.name,
    });
    return this.serialize(company);
  }

  async remove(actor: AuthUser, id: string) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    await this.prisma.company.delete({ where: { id } });
    await this.audit.log({
      actor,
      action: 'company.delete',
      entity: 'Company',
      entityId: id,
      detail: company.name,
    });
    return { ok: true };
  }
}

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.companies.list(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.companies.detail(user, id);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  provision(@CurrentUser() user: AuthUser, @Body() dto: ProvisionCompanyDto) {
    return this.companies.provision(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.companies.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.companies.remove(user, id);
  }
}

@Module({
  controllers: [CompaniesController],
  providers: [CompaniesService],
})
export class CompaniesModule {}
