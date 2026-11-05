import { Body, Controller, ForbiddenException, Get, Inject, Injectable, Logger, NotFoundException, Optional, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { profileOfCompany } from '../common/business-profile';
import { Category, readPolicy, reviewDecision } from '../common/creative-policy';
import { GOALS, GOAL_LABEL, Goal } from '../common/creative/art-direction';
import { checkCopy } from '../common/ads/creative-check';
import { COPY_LIMITS, CopyBrief, CopyDestination, CopyVariation, META_CTAS, copyMessages, parseVariations, pieceTextOf } from '../common/ads/copy-variations';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { GeminiPool, isAiUnavailable } from '../ai/gemini-pool';
import { CompanyTextAi, TextAiRoute } from '../ai/company-text-ai';
import { AuditService } from './audit.module';

/**
 * «Sugerir textos»: variaciones de copy para Meta Ads a partir de una pieza de
 * Creative o del anuncio que se está armando en Ads.
 *  - Con la IA propia de la empresa si la tiene (queda en AiUsageEvent); si no,
 *    con la cadena genérica gratis: texto sanitizado, sin cobro y con tope
 *    diario por empresa (Dev Tools → GENERIC_AI_DAILY_PER_COMPANY).
 *  - La IA solo recibe datos del negocio y de la pieza: nunca clientes ni chats.
 *  - Cada variación se valida contra los límites de Meta (si alguna no cumple
 *    se pide UNA corrección; lo que siga sin cumplir se descarta) y pasa por
 *    las reglas de publicación de la marca (creative-policy) y por el chequeo
 *    de políticas de Meta (creative-check) antes de devolverse.
 */

/** Objetivo de la pieza → categoría de las reglas de publicación. */
const GOAL_CATEGORY: Record<Goal, Category> = {
  PRODUCT: 'PRODUCTO', PROMO: 'PROMO', TIP: 'TIPS', NEWS: 'OTRO', EVENT: 'EVENTO', BRAND: 'MARCA',
  TESTIMONIAL: 'MARCA', STEPS: 'TIPS', BENEFITS: 'PRODUCTO', CATALOG: 'PRODUCTO', INFO: 'OTRO',
};

const plain = (t: string) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface SuggestedCopy extends CopyVariation {
  /** Las reglas de la marca piden que una persona lo revise antes de publicar */
  review: { needsReview: boolean; reasons: string[] };
  /** Consejos de redacción del chequeo de Meta (no impiden usarla) */
  warnings: string[];
}

@Injectable()
export class CreativeCopyService {
  private readonly logger = new Logger('CreativeCopy');
  readonly textAi: CompanyTextAi;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(AI_PROVIDER) ai?: AiProvider,
  ) {
    this.textAi = new CompanyTextAi(prisma, ai, new GeminiPool(prisma));
  }

  /** La empresa del usuario (o la elegida por la plataforma); el guard @Products ya revisó Creative o Ads. */
  private async companyOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    return company;
  }

  /** Qué IA se usaría y cuánto cupo gratis queda hoy (para el botón). */
  async status(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const route = await this.textAi.route(company);
    return {
      source: route.kind,
      quota: route.kind === 'GENERICA' ? await this.textAi.genericUsage(company.id) : null,
      limits: COPY_LIMITS,
    };
  }

  private async brief(company: any, dto: any): Promise<{ brief: CopyBrief; goal: Goal; restricted: string[]; policy: ReturnType<typeof readPolicy> }> {
    const goal = (GOALS as readonly string[]).includes(dto?.goal) ? (dto.goal as Goal) : 'PRODUCT';
    const destination: CopyDestination = dto?.destination === 'WEBSITE' ? 'WEBSITE' : 'WHATSAPP';
    const count = Math.min(5, Math.max(1, Math.floor(Number(dto?.count) || 3)));
    let pieceText = typeof dto?.pieceText === 'string' ? dto.pieceText.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    if (typeof dto?.designId === 'string' && dto.designId) {
      const design = await this.prisma.creativeDesign.findFirst({ where: { id: dto.designId, companyId: company.id } });
      if (!design) throw new NotFoundException('Pieza no encontrada');
      pieceText = pieceTextOf(design.docJson) || pieceText;
    }
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    const restrictions = parseJson<string[]>(b?.restrictionsJson, []).map(String).filter(Boolean).slice(0, 20);
    const policy = readPolicy(parseJson(b?.policyJson, {}));
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const profile = profileOfCompany({ ...ob, businessType: ob.businessType ?? company.industry ?? undefined }, ob.rubro);
    return {
      goal,
      policy,
      restricted: [...restrictions, ...policy.restrictedTopics],
      brief: {
        business: String(b?.name || company.name).slice(0, 80),
        sector: profile.label,
        tone: String(b?.tone ?? '').slice(0, 120) || undefined,
        audience: String(b?.audience ?? '').slice(0, 160) || undefined,
        product: typeof dto?.product === 'string' ? dto.product.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined,
        goalLabel: GOAL_LABEL[goal],
        destination,
        pieceText: pieceText || undefined,
        avoid: [...restrictions, ...policy.restrictedTopics].slice(0, 20),
        count,
      },
    };
  }

  /** Pide, valida y (una vez) corrige. Devuelve las válidas y cuántas se descartaron por no cumplir. */
  async generate(company: any, route: TextAiRoute, brief: CopyBrief) {
    const requestId = `copy-${randomUUID()}`;
    const knownNames = route.kind === 'GENERICA' ? await this.textAi.knownNames(company.id) : undefined;
    const ask = async (fix?: string[]) => {
      const r = await this.textAi.complete(company, route, {
        purpose: 'CREATIVE_COPY', requestId, json: true, maxTokens: 4000, temperature: 0.8, messages: copyMessages(brief, fix),
      }, { knownNames });
      return { ...parseVariations(extractJson(r.content), brief.destination), model: r.model, source: r.source };
    };
    const first = await ask();
    let valid = first.valid;
    let invalid = first.errors.length;
    let model = first.model;
    if (valid.length < brief.count && first.errors.length) {
      // Un solo reintento: se le dice exactamente qué no cumplió
      const second = await ask(first.errors).catch((err) => {
        if (isAiUnavailable(err)) return null;
        throw err;
      });
      if (second) {
        const seen = new Set(valid.map((v) => plain(v.headline + v.primaryText)));
        valid = [...valid, ...second.valid.filter((v) => !seen.has(plain(v.headline + v.primaryText)))];
        invalid = second.errors.length;
        model = second.model;
      }
    }
    return { valid, invalid, model, source: first.source };
  }

  /** Reglas de la marca y políticas de Meta: lo que no pasa se descarta; lo demás va con sus avisos. */
  async reviewed(company: any, variations: CopyVariation[], goal: Goal, restricted: string[], policy: ReturnType<typeof readPolicy>, destination: CopyDestination) {
    const approved = await this.prisma.contentPiece.count({ where: { companyId: company.id, approvedAt: { not: null }, autoApproved: false } }).catch(() => 0);
    const kept: SuggestedCopy[] = [];
    let blocked = 0;
    for (const v of variations) {
      const text = plain(`${v.headline} ${v.primaryText} ${v.description}`);
      if (restricted.some((t) => t && text.includes(plain(t)))) { blocked++; continue; }
      const checks = checkCopy({ goal: destination, primaryText: v.primaryText, headline: v.headline, description: v.description });
      if (checks.some((c) => c.area === 'POLITICAS' && c.level === 'BAD')) { blocked++; continue; }
      const decision = reviewDecision({ category: GOAL_CATEGORY[goal], copy: `${v.primaryText} ${v.description}`, title: v.headline }, policy, approved);
      // De la decisión solo importa lo que depende del texto (precios, temas); lo demás es del flujo de publicación
      const reasons = decision.reasons.filter((r) => /precios|tema restringido/i.test(r));
      kept.push({
        ...v,
        review: { needsReview: reasons.length > 0, reasons },
        warnings: checks.filter((c) => c.level !== 'OK' && c.area === 'POLITICAS').map((c) => c.title),
      });
    }
    return { kept, blocked };
  }

  async suggest(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const { brief, goal, restricted, policy } = await this.brief(company, dto);
    const route = await this.textAi.route(company);
    const quota = route.kind === 'GENERICA' ? await this.textAi.reserveGeneric(company.id) : null;
    let out;
    try {
      out = await this.generate(company, route, brief);
    } catch (err) {
      if (isAiUnavailable(err)) throw new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'La IA está ocupada en este momento. Intenta de nuevo en unos minutos o escribe el texto a mano.' });
      throw err;
    }
    const { kept, blocked } = await this.reviewed(company, out.valid, goal, restricted, policy, brief.destination);
    const variations = kept.slice(0, brief.count);
    await this.audit.log({
      actor: user, companyId: company.id, action: 'creative.copy_suggest', entity: 'Company', entityId: company.id,
      detail: `${variations.length} variaciones · ${GOAL_LABEL[goal]} · ${brief.destination} · ${route.kind === 'EMPRESA' ? 'IA de la empresa' : 'IA genérica'}${out.invalid + blocked ? ` · ${out.invalid + blocked} descartadas` : ''}`,
    });
    return {
      variations,
      discarded: { limits: out.invalid, policies: blocked },
      source: route.kind,
      model: out.model,
      quota,
      limits: COPY_LIMITS,
      ctas: Object.entries(META_CTAS[brief.destination]).map(([key, label]) => ({ key, label })),
    };
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;

@Products('CREATIVE', 'ADS')
@Controller('creative/copy')
export class CreativeCopyController {
  constructor(private readonly s: CreativeCopyService) {}

  @Get('status') @Roles(...READ)
  status(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.status(u, c); }

  @Post('suggest') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  suggest(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) {
    return this.s.suggest(u, dto, c ?? (isPlatformRole(u.role) ? dto?.companyId : undefined));
  }
}
