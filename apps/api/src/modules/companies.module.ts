import { hasPlan, modulesWithAddons, readAddonStates } from '../common/addons';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
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
  NOT_DELETED,
  ROLES,
  isPlatformRole,
  parseJson,
} from '../common/constants';
import { maskCompanyKey, normalizeAiMode, storeCompanyKey } from '../ai/ai-access';
import { serializePaymentConfig } from './payments.module';
import { serializeEinvoiceConfig } from '../common/einvoice';
import { deleteCompanyLooseData } from '../common/company-cleanup';
import { PERIOD_RE, earlyExitFee, periodOf } from '../common/billing-engine';
import { AGENT_PRESETS } from '../ai/agent/tools';
import { AuditService } from './audit.module';
import { COMPANY_TEMPLATES, findTemplate } from './company-templates';
import { DEMO_COMPANY_SLUG } from '../demo/demo-company';
import { activeProducts } from '../common/products';
import { ProductKey, initialProducts } from '../common/products';
import { SetupProfile, SetupValidationError, alignModules, modulesForCapabilities, normalizeSetup, validateProducts, withSelectedProducts } from '../common/setup-profile';
import { agentPresetFor, applyBlueprintExtras, revalidateBlueprint } from '../common/blueprint';
import { isRubro } from '../common/rubros';
import { applySetupProposal, normalizeProposal } from './ai-setup.module';

import { productsView } from './products.module';

/** Payload del wizard de aprovisionamiento (crear empresa sin tocar código). */
interface ProvisionCompanyDto {
  /** Plantilla de vertical (catering/webcam/servicios) — todo preconfigurado */
  templateId?: string;
  /** O clonar la configuración de una empresa existente (sin sus datos) */
  cloneFromCompanyId?: string;
  /** Moneda de la empresa (COP/USD/…) — pisa la de la plantilla */
  currency?: string;
  /** Ajustes de agenda encima de la plantilla (horarios/corte/franjas editados en el wizard) */
  orderConfigOverrides?: Record<string, any>;
  /** Áreas personalizadas en el wizard (reemplazan las de la plantilla) */
  areas?: Array<{ name: string; description?: string; notifyChannel?: string; reminderHoursBefore?: number }>;
  /** Personalidad de la biblioteca aplicada al bot inicial */
  personaTemplateId?: string;
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
  /** MONTHLY | ANNUAL (anual: 2 meses gratis) */
  billingCycle?: string;
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
  /** Productos contratados (AUTOMATION | CREATIVE | ADS). Sin esto y sin perfil: regla anterior. */
  products?: string[];
  /** Perfil de incorporación (common/setup-profile.ts): se valida y recalcula aquí */
  setup?: unknown;
  /** Plano y propuesta generados en la reunión (configuración asistida): mismo formato que el autoservicio */
  blueprint?: unknown;
  proposal?: unknown;
  rubro?: string;
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
  private readonly logger = new Logger('Companies');
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(company: any) {
    const { deepinfraApiKey, paymentConfigJson, einvoiceConfigJson, ...rest } = company;
    return {
      ...rest,
      // Pagos y facturación electrónica: solo el estado, jamás los secretos
      paymentConfig: serializePaymentConfig(paymentConfigJson),
      einvoiceConfig: serializeEinvoiceConfig(einvoiceConfigJson),
      // Reactivación, cobranza y auditor vienen con cualquier plan
      modules: modulesWithAddons(parseJson<string[]>(company.modulesJson, []), readAddonStates(company), hasPlan(company)),
      limits: parseJson<Record<string, number>>(company.limitsJson, {}),
      // Productos activos (Automation, Creative, Ads Intelligence) — el servidor también los exige
      products: activeProducts(company),
      productStates: productsView(company).products,
      productsExplicit: productsView(company).explicit,
      // La llave de DeepInfra jamás sale completa del API
      hasDeepinfraKey: !!deepinfraApiKey,
      deepinfraKeyMasked: maskCompanyKey(deepinfraApiKey),
      orderConfig: parseJson<Record<string, any>>(company.orderConfigJson, {}),
      waTemplates: parseJson<any[]>(company.waTemplatesJson, []),
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

    // Aprovisionamiento SIN código: plantilla de vertical o clon de una
    // empresa existente (solo configuración — jamás datos ni credenciales)
    const template = findTemplate(dto.templateId);
    if (dto.templateId && !template) {
      throw new BadRequestException(`Plantilla desconocida: ${dto.templateId}`);
    }
    const source = dto.cloneFromCompanyId
      ? await this.prisma.company.findUnique({ where: { id: dto.cloneFromCompanyId } })
      : null;
    if (dto.cloneFromCompanyId && !source) {
      throw new BadRequestException('La empresa a clonar no existe');
    }

    // ── Todo se valida ANTES de crear nada: un error nunca deja una empresa huérfana ──
    const adminEmail = dto.admin ? String(dto.admin.email ?? '').trim().toLowerCase() : null;
    if (dto.admin) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(adminEmail ?? '')) throw new BadRequestException({ statusCode: 400, field: 'adminEmail', message: 'El correo del administrador no es válido' });
      if (!dto.admin.name?.trim()) throw new BadRequestException({ statusCode: 400, field: 'adminName', message: 'Falta el nombre del administrador' });
      if (!dto.admin.password) throw new BadRequestException({ statusCode: 400, field: 'adminPassword', message: 'Falta la contraseña del administrador' });
      if (await this.prisma.user.findUnique({ where: { email: adminEmail! } })) {
        throw new BadRequestException(`El correo ${adminEmail} ya está registrado`);
      }
    }
    if (dto.personaTemplateId && !(await this.prisma.personaTemplate.findUnique({ where: { id: dto.personaTemplateId } }))) {
      throw new BadRequestException('La personalidad elegida no existe');
    }
    const selfService = actor.id === 'registro-web';
    let setup: SetupProfile | null = null;
    let products: ProductKey[] | null = null;
    try {
      if (dto.setup) {
        setup = normalizeSetup(dto.setup, { source: selfService ? 'SELF_SERVICE' : 'ASSISTED', by: actor.name, allowOverride: !selfService && isPlatformRole(actor.role) });
      }
      products = dto.products !== undefined ? validateProducts(dto.products) : setup?.products.selected ?? null;
      if (setup && products) setup = withSelectedProducts(setup, products);
    } catch (err) {
      if (err instanceof SetupValidationError) throw new BadRequestException({ statusCode: 400, field: err.field, message: err.message });
      throw err;
    }
    // Sin Automation no se preparan WhatsApp ni asistente (no los usaría)
    const automation = !products || products.includes('AUTOMATION');

    // Sin prueba gratis: las empresas nacen activas (montaje gratis con permanencia)
    const trialDays = dto.trialDays ?? 0;
    const status = dto.status ?? 'ACTIVE';

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
        modulesJson: JSON.stringify((() => {
          const base = dto.modules
            ?? template?.modules
            ?? (source ? parseJson<string[]>(source.modulesJson, []) : null)
            ?? ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team'];
          if (!setup) return base;
          // Autoservicio: las que piden sus capacidades, sin las de pedidos que su perfil no usa.
          // Asistido: lo que eligió el administrador manda; solo se suman las que piden las capacidades.
          return selfService || !dto.modules
            ? alignModules(base, setup)
            : [...new Set([...base, ...modulesForCapabilities(setup.capabilities, setup.products.selected)])];
        })()),
        currency: dto.currency ?? template?.currency ?? source?.currency ?? 'COP',
        // Config de agenda: plantilla o clon como base + lo editado en el wizard
        ...(template?.orderConfig || source || dto.orderConfigOverrides
          ? {
              orderConfigJson: JSON.stringify({
                ...(template?.orderConfig ??
                  (source ? parseJson<Record<string, any>>(source.orderConfigJson, {}) : {})),
                ...(dto.orderConfigOverrides ?? {}),
              }),
            }
          : {}),
        ...(source
          ? {
              waTemplatesJson: source.waTemplatesJson,
              savingsSalaryUsd: source.savingsSalaryUsd,
              agentCapacityPerMonth: source.agentCapacityPerMonth,
            }
          : {}),
        limitsJson: JSON.stringify(dto.limits ?? {}),
        // Productos elegidos: explícitos desde el día uno (null = regla anterior, solo para llamadas viejas)
        ...(products ? { productsJson: initialProducts(products) } : {}),
        ...(setup ? { onboardingJson: JSON.stringify({ source: selfService ? 'SIGNUP' : 'ASSISTED', setup, createdAt: new Date().toISOString() }) } : {}),
        ...(dto.billingCycle === 'ANNUAL' ? { billingCycle: 'ANNUAL', annualStartPeriod: periodOf() } : {}),
        contractStartAt: dto.planId ? new Date() : null,
        trialEndsAt:
          status === 'TRIAL' && trialDays > 0
            ? new Date(Date.now() + trialDays * 24 * 3600 * 1000)
            : null,
      },
    });

    let channels: string[] = [];
    try {
    // Usuario administrador inicial
    if (dto.admin && adminEmail) {
      await this.prisma.user.create({
        data: {
          email: adminEmail,
          name: dto.admin.name,
          jobTitle: dto.admin.jobTitle ?? 'Administrador',
          role: ROLES.COMPANY_ADMIN,
          companyId: company.id,
          passwordHash: AuthService.hashPassword(dto.admin.password),
        },
      });
    }

    // Personalidad elegida de la biblioteca (opcional, aplica al bot inicial)
    const persona = dto.personaTemplateId
      ? await this.prisma.personaTemplate.findUnique({ where: { id: dto.personaTemplateId } })
      : null;

    // Bot inicial: el del wizard, el de la plantilla, o los clonados.
    // Si la plantilla trae agente con herramientas, el bot nace en ese modo.
    const engine = template?.bot?.engineMode === 'AGENT'
      ? {
          engineMode: 'AGENT',
          toolsJson: JSON.stringify(AGENT_PRESETS[template.bot.agentPreset ?? 'domicilios']?.tools ?? []),
        }
      : {};
    let botId: string | undefined;
    if (!automation) {
      // Sin Automation: ni asistente ni canales de WhatsApp
    } else if (dto.bot?.name) {
      const bot = await this.prisma.bot.create({
        data: {
          companyId: company.id,
          name: dto.bot.name,
          description: dto.bot.description,
          systemPrompt: dto.bot.systemPrompt || persona?.systemPrompt || '',
          personalityJson: persona?.personalityJson ?? '{}',
          welcomeMessage: dto.bot.welcomeMessage ?? persona?.welcomeMessage,
          handoffKeywords: persona?.handoffKeywords ?? '',
          model: dto.bot.model ?? 'meta-llama/Llama-3.3-70B-Instruct', // siempre DeepInfra
          status: 'DRAFT',
          ...engine,
        },
      });
      botId = bot.id;
    } else if (persona) {
      const bot = await this.prisma.bot.create({
        data: {
          companyId: company.id,
          name: persona.name,
          description: persona.description,
          systemPrompt: persona.systemPrompt,
          personalityJson: persona.personalityJson,
          welcomeMessage: persona.welcomeMessage,
          handoffKeywords: persona.handoffKeywords ?? '',
          model: 'meta-llama/Llama-3.3-70B-Instruct',
          status: 'DRAFT',
          ...engine,
        },
      });
      botId = bot.id;
    } else if (template?.bot) {
      const bot = await this.prisma.bot.create({
        data: {
          companyId: company.id,
          name: template.bot.name,
          description: template.bot.description,
          systemPrompt: template.bot.systemPrompt,
          personalityJson: JSON.stringify(template.bot.personality),
          salesJson: JSON.stringify(template.bot.sales),
          welcomeMessage: template.bot.welcomeMessage,
          replyDelayMinSec: template.bot.replyDelayMinSec ?? 4,
          replyDelayMaxSec: template.bot.replyDelayMaxSec ?? 30,
          typingSimulation: true,
          handoffKeywords: template.bot.handoffKeywords ?? '',
          model: 'meta-llama/Llama-3.3-70B-Instruct',
          status: 'DRAFT', // se activa cuando la empresa conecte su llave
          ...engine,
        },
      });
      botId = bot.id;
    } else if (source) {
      const sourceBots = await this.prisma.bot.findMany({
        where: { companyId: source.id },
      });
      for (const b of sourceBots) {
        const created = await this.prisma.bot.create({
          data: {
            companyId: company.id,
            name: b.name, description: b.description,
            systemPrompt: b.systemPrompt, personalityJson: b.personalityJson,
            salesJson: b.salesJson, welcomeMessage: b.welcomeMessage,
            replyDelayMinSec: b.replyDelayMinSec, replyDelayMaxSec: b.replyDelayMaxSec,
            typingSimulation: b.typingSimulation, handoffKeywords: b.handoffKeywords,
            model: b.model, temperature: b.temperature,
            engineMode: b.engineMode, toolsJson: b.toolsJson,
            status: 'DRAFT',
          },
        });
        botId = botId ?? created.id;
      }
    }

    // Áreas de producción: las editadas en el wizard mandan sobre la plantilla
    const areasToCreate = Array.isArray(dto.areas) && dto.areas.length
      ? dto.areas.filter((a) => a?.name?.trim())
      : (template?.areas ?? []);
    for (const area of areasToCreate) {
      await this.prisma.productionArea.create({
        data: {
          companyId: company.id,
          name: area.name.trim(),
          description: area.description,
          notifyChannel: ['PANEL', 'EMAIL', 'WHATSAPP'].includes(area.notifyChannel as string)
            ? area.notifyChannel
            : 'PANEL',
          reminderHoursBefore: Number(area.reminderHoursBefore) || 24,
          responsiblesJson: '[]',
        },
      });
    }
    if (source) {
      const sourceAreas = await this.prisma.productionArea.findMany({
        where: { companyId: source.id, active: true },
      });
      for (const a of sourceAreas) {
        await this.prisma.productionArea.create({
          data: {
            companyId: company.id,
            name: a.name, description: a.description,
            notifyChannel: a.notifyChannel, notifyTarget: a.notifyTarget,
            reminderHoursBefore: a.reminderHoursBefore,
            responsiblesJson: a.responsiblesJson,
          },
        });
      }
      // Catálogo completo (productos apuntando al área homónima nueva)
      const newAreas = await this.prisma.productionArea.findMany({
        where: { companyId: company.id },
      });
      const areaByName = new Map(sourceAreas.map((a) => {
        const twin = newAreas.find((n) => n.name === a.name);
        return [a.id, twin?.id ?? null] as const;
      }));
      const sourceProducts = await this.prisma.product.findMany({
        where: { companyId: source.id, ...NOT_DELETED },
      });
      for (const p of sourceProducts) {
        await this.prisma.product.create({
          data: {
            companyId: company.id,
            name: p.name, description: p.description, category: p.category,
            unit: p.unit, presentationsJson: p.presentationsJson,
            productionAreaId: p.productionAreaId
              ? (areaByName.get(p.productionAreaId) ?? null)
              : null,
            active: p.active,
          },
        });
      }
    }

    // Canales preparados (desconectados, con link de conexión listo).
    // Con plantilla de pedidos la línea de WhatsApp nace como Twilio EN
    // SANDBOX: jamás sale un mensaje real hasta cargar credenciales y quitarlo.
    channels = automation ? (dto.channels ?? template?.channels ?? ['WHATSAPP']) : [];
    const twilioSandbox = !!template?.orderConfig;
    for (const type of channels) {
      await this.prisma.integration.create({
        data: {
          companyId: company.id,
          botId,
          type,
          name: CHANNEL_LABELS[type] ?? type,
          status: 'DISCONNECTED',
          promptMode: 'INHERIT',
          ...(type === 'WHATSAPP' && twilioSandbox
            ? { configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }) }
            : {}),
          connectUrl: buildConnectUrl(type, slug),
          webhookUrl: `http://localhost:4001/api/webhooks/${slug}/${type.toLowerCase()}`,
        },
      });
    }
    if (source && automation) {
      // Clon: mismas líneas (nombre/modo/overrides) SIN credenciales, en sandbox
      const sourceLines = await this.prisma.integration.findMany({
        where: { companyId: source.id, type: 'WHATSAPP' },
      });
      for (const line of sourceLines) {
        const cfg = parseJson<Record<string, any>>(line.configJson, {});
        await this.prisma.integration.create({
          data: {
            companyId: company.id,
            botId,
            type: 'WHATSAPP',
            name: line.name,
            status: 'DISCONNECTED',
            promptMode: line.promptMode,
            overridePrompt: line.overridePrompt,
            overridePersonalityJson: line.overridePersonalityJson,
            overrideSalesJson: line.overrideSalesJson,
            overrideWelcome: line.overrideWelcome,
            overrideHandoff: line.overrideHandoff,
            overrideModel: line.overrideModel,
            configJson: JSON.stringify({
              provider: cfg.provider ?? 'TWILIO',
              sandbox: true, // SIEMPRE: las credenciales jamás se clonan
            }),
            webhookUrl: `http://localhost:4001/api/webhooks/${slug}/whatsapp`,
          },
        });
      }
    }

    // Configuración asistida con propuesta de la reunión: mismo efecto que el autoservicio
    if (dto.proposal && typeof dto.proposal === 'object') {
      await applySetupProposal(this.prisma, this.audit, actor, company.id, normalizeProposal(dto.proposal), {
        createAssistant: automation && !botId,
        agentPreset: agentPresetFor(parseJson<string[]>(company.modulesJson, [])),
      });
    }
    if (dto.blueprint && typeof dto.blueprint === 'object' && automation) {
      await applyBlueprintExtras(this.prisma, company.id, revalidateBlueprint(dto.blueprint, isRubro(dto.rubro) ? dto.rubro : 'SERVICIOS'));
    }
    } catch (err) {
      // Algo falló a mitad: se deshace lo creado (empresa, usuario y datos sueltos)
      await this.discardProvisioned(company.id);
      throw err;
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

  /** Deshace una provisión a medias (no deja empresas ni usuarios huérfanos). */
  async discardProvisioned(companyId: string) {
    try {
      await this.prisma.user.deleteMany({ where: { companyId } });
      await deleteCompanyLooseData(this.prisma, companyId);
      await this.prisma.company.delete({ where: { id: companyId } });
    } catch (err: any) {
      this.logger.error(`No se pudo deshacer la empresa ${companyId}: ${err?.message}`);
    }
  }

  private cleanUrl(value: unknown): string | null {
    const url = String(value ?? '').trim();
    if (!url) return null;
    if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 300) {
      throw new BadRequestException('El link debe empezar por https://');
    }
    return url;
  }

  async update(actor: AuthUser, id: string, dto: any) {
    if (!isPlatformRole(actor.role) && actor.companyId !== id) {
      throw new ForbiddenException();
    }
    const before = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    // Campos que un admin de empresa puede tocar vs. plataforma
    const platformOnly = [
      'planId', 'status', 'modules', 'limits', 'slug',
      // Quién paga la IA y cuánto se permite gastar lo decide BackOffice
      'aiBillingMode', 'aiHybridPrimary', 'aiSpendCapUsd', 'aiIncludedOverride',
      // Lo que se le cobra a la empresa y su permanencia también
      'customPriceMonthly', 'contractStartAt', 'minTermMonths', 'setupFeeValue',
      'billingCycle', 'annualStartPeriod', 'addons',
    ];
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
          ? { deepinfraApiKey: storeCompanyKey(dto.deepinfraApiKey) }
          : {}),
        ...(dto.aiBillingMode !== undefined
          ? { aiBillingMode: normalizeAiMode(dto.aiBillingMode) }
          : {}),
        ...(dto.aiHybridPrimary !== undefined
          ? { aiHybridPrimary: dto.aiHybridPrimary === 'PLATFORM' ? 'PLATFORM' : 'BYOK' }
          : {}),
        ...(dto.aiSpendCapUsd !== undefined
          ? { aiSpendCapUsd: dto.aiSpendCapUsd === null || dto.aiSpendCapUsd === '' ? null : Math.max(0, Number(dto.aiSpendCapUsd)) }
          : {}),
        ...(dto.aiIncludedOverride !== undefined
          ? { aiIncludedOverride: dto.aiIncludedOverride === null || dto.aiIncludedOverride === '' ? null : Math.max(0, Math.round(Number(dto.aiIncludedOverride))) }
          : {}),
        // Parámetros del Reporte a Gerencia (ahorro estimado)
        ...(dto.savingsSalaryUsd != null
          ? { savingsSalaryUsd: Number(dto.savingsSalaryUsd) }
          : {}),
        ...(dto.agentCapacityPerMonth != null
          ? { agentCapacityPerMonth: Number(dto.agentCapacityPerMonth) }
          : {}),
        ...(dto.modules ? { modulesJson: JSON.stringify(dto.modules) } : {}),
        ...(dto.limits ? { limitsJson: JSON.stringify(dto.limits) } : {}),
        // Configuración del módulo de pedidos y plantillas de Meta (editable desde el panel)
        ...(dto.orderConfig ? { orderConfigJson: JSON.stringify(dto.orderConfig) } : {}),
        ...(dto.waTemplates ? { waTemplatesJson: JSON.stringify(dto.waTemplates) } : {}),
        ...(dto.currency ? { currency: dto.currency } : {}),
        ...(dto.googleReviewUrl !== undefined ? { googleReviewUrl: this.cleanUrl(dto.googleReviewUrl) } : {}),
        ...(dto.customPriceMonthly !== undefined
          ? { customPriceMonthly: dto.customPriceMonthly === null || dto.customPriceMonthly === '' ? null : Math.max(0, Number(dto.customPriceMonthly)) }
          : {}),
        ...(dto.contractStartAt !== undefined
          ? { contractStartAt: dto.contractStartAt ? new Date(dto.contractStartAt) : null }
          : {}),
        ...(dto.minTermMonths !== undefined
          ? { minTermMonths: dto.minTermMonths === null || dto.minTermMonths === '' ? null : Math.max(0, Math.round(Number(dto.minTermMonths))) }
          : {}),
        ...(dto.setupFeeValue !== undefined
          ? { setupFeeValue: dto.setupFeeValue === null || dto.setupFeeValue === '' ? null : Math.max(0, Number(dto.setupFeeValue)) }
          : {}),
        ...(dto.addons && typeof dto.addons === 'object' ? this.addonsUpdate(before, dto.addons) : {}),
        ...(dto.billingCycle !== undefined
          ? {
              billingCycle: dto.billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY',
              // El anual arranca el mes indicado (o el actual)
              annualStartPeriod: dto.billingCycle === 'ANNUAL'
                ? (typeof dto.annualStartPeriod === 'string' && PERIOD_RE.test(dto.annualStartPeriod) ? dto.annualStartPeriod : before.annualStartPeriod ?? periodOf())
                : null,
            }
          : dto.annualStartPeriod !== undefined && before.billingCycle === 'ANNUAL' && PERIOD_RE.test(String(dto.annualStartPeriod))
            ? { annualStartPeriod: String(dto.annualStartPeriod) }
            : {}),
        // Al asignar plan por primera vez arranca la permanencia
        ...(dto.planId && !before.contractStartAt ? { contractStartAt: new Date() } : {}),
      },
      include: { plan: true },
    });
    // Salida anticipada: si se cancela antes de cumplir la permanencia, se cobra
    // la parte proporcional del montaje (que fue gratis con permanencia)
    if (dto.status === 'CANCELLED' && before.status !== 'CANCELLED') {
      const fee = earlyExitFee({
        contractStartAt: company.contractStartAt,
        minTermMonths: company.minTermMonths ?? company.plan?.minTermMonths ?? 0,
        setupFeeValue: company.setupFeeValue ?? company.plan?.setupFeeValue ?? 0,
      });
      if (fee.amount > 0 && !dto.waiveSetupFee) {
        const adj = await this.prisma.billingAdjustment.create({
          data: {
            companyId: id, kind: 'SETUP', startPeriod: periodOf(),
            concept: `Montaje — salida anticipada (${fee.remainingMonths} meses de permanencia pendientes)`,
            amount: Math.round(fee.amount), createdBy: actor.name,
          },
        });
        await this.audit.log({
          actor, companyId: id, action: 'billing.early_exit_fee', entity: 'BillingAdjustment',
          entityId: adj.id, detail: `${Math.round(fee.amount)} · ${fee.remainingMonths} meses`,
        });
      }
    }
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

  /** Extras por empresa (solo plataforma). Prender Redes sociales habilita el módulo marketing. */
  private addonsUpdate(before: any, incoming: any) {
    const current = parseJson<Record<string, any>>(before.addonsJson, {});
    const next = { ...current };
    if (incoming.social && typeof incoming.social === 'object') {
      const s = incoming.social;
      const num = (v: unknown, min: number, max: number) => (v === undefined || v === null || v === '' ? undefined : Math.min(max, Math.max(min, Number(v))));
      next.social = {
        ...(current.social ?? {}),
        ...(s.enabled !== undefined ? { enabled: !!s.enabled } : {}),
        ...(num(s.price, 0, 50_000_000) !== undefined ? { price: Math.round(num(s.price, 0, 50_000_000)!) } : {}),
        ...(num(s.credits, 0, 10_000) !== undefined ? { credits: Math.round(num(s.credits, 0, 10_000)!) } : {}),
      };
    }
    const modules = parseJson<string[]>(before.modulesJson, []);
    const withMarketing = next.social?.enabled && !modules.includes('marketing') ? [...modules, 'marketing'] : null;
    return { addonsJson: JSON.stringify(next), ...(withMarketing ? { modulesJson: JSON.stringify(withMarketing) } : {}) };
  }

  async remove(actor: AuthUser, id: string) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    // La empresa DEMO de ventas es permanente: jamás se borra desde el panel
    if (company.slug === DEMO_COMPANY_SLUG) {
      throw new BadRequestException(
        'Esta es la empresa DEMO de ventas y está protegida. Para regenerarla con datos frescos usa Dev Tools → Operación → "Restaurar empresa demo".',
      );
    }
    await deleteCompanyLooseData(this.prisma, id); // modelos sin relación: aparte
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

  /** Plantillas de aprovisionamiento para el wizard (crear empresa sin código).
   *  Incluye la base editable (agenda y áreas) para personalizarla ANTES de crear. */
  @Get('templates')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  templates() {
    return COMPANY_TEMPLATES.map(
      ({ id, name, description, includes, modules, currency, orderConfig, areas, bot }) => ({
        id, name, description, includes, modules, currency,
        orderConfig: orderConfig ?? null,
        areas: areas ?? [],
        botName: bot?.name ?? null,
        botSummary: bot ? `${bot.name} — ${bot.description}` : null,
      }),
    );
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
  exports: [CompaniesService],
})
export class CompaniesModule {}
