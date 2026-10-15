import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  Optional,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { AiSession, recordAiUsage, resolveAiAccess } from '../ai/ai-access';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { AGENT_PRESETS } from '../ai/agent/tools';
import { AuditService } from './audit.module';

/**
 * "Arma tu negocio con IA": el dueño describe su negocio (o pega su menú) y la
 * IA propone catálogo con precios, horario, domicilios, preguntas frecuentes y
 * la personalidad del asistente. Se revisa en el panel y se aplica con un clic
 * (no pisa productos existentes ni el punto de despacho).
 */

export interface SetupProposal {
  products: Array<{ name: string; category: string | null; price: number | null; description: string | null; presentations: string[] }>;
  schedule: { days: number[]; open: string; close: string } | null;
  delivery: { enabled: boolean; baseFee: number | null; perKm: number | null; maxKm: number | null; prepMinutes: number | null } | null;
  faqs: Array<{ question: string; answer: string }>;
  assistant: { name: string; tone: string; style: string; welcome: string; instructions: string } | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Valida y recorta TODO lo que propone el modelo (jamás se aplica a ciegas). */
export function normalizeProposal(raw: unknown): SetupProposal {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const num = (v: unknown, max: number) => {
    const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n) : null;
  };
  const seen = new Set<string>();
  const products = (Array.isArray(o.productos) ? o.productos : [])
    .map((p: any) => ({
      name: str(p?.nombre, 80),
      category: str(p?.categoria, 40),
      price: num(p?.precio, 50_000_000),
      description: str(p?.descripcion, 200),
      presentations: Array.isArray(p?.presentaciones) ? p.presentaciones.map((x: any) => str(x, 40)).filter(Boolean).slice(0, 6) : [],
    }))
    .filter((p: any) => {
      if (!p.name) return false;
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 80) as SetupProposal['products'];
  const h = o.horario ?? {};
  const days = Array.isArray(h.dias) ? [...new Set(h.dias.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : [];
  const schedule = days.length && HHMM.test(h.abre) && HHMM.test(h.cierra) && h.abre < h.cierra
    ? { days, open: h.abre, close: h.cierra }
    : null;
  const d = o.domicilios ?? null;
  const delivery = d && typeof d === 'object'
    ? {
        enabled: d.activo === true,
        baseFee: num(d.tarifa_base, 1_000_000),
        perKm: num(d.por_km, 100_000),
        maxKm: num(d.cobertura_km, 100),
        prepMinutes: num(d.tiempo_preparacion_min, 240),
      }
    : null;
  const faqs = (Array.isArray(o.preguntas) ? o.preguntas : [])
    .map((f: any) => ({ question: str(f?.pregunta, 200), answer: str(f?.respuesta, 600) }))
    .filter((f: any) => f.question && f.answer)
    .slice(0, 20) as SetupProposal['faqs'];
  const a = o.asistente ?? null;
  const assistant = a && str(a.nombre, 40)
    ? {
        name: str(a.nombre, 40)!,
        tone: str(a.tono, 120) ?? 'Cercano y amable',
        style: str(a.estilo, 120) ?? 'Mensajes cortos',
        welcome: str(a.bienvenida, 200) ?? '¡Hola! ¿En qué te ayudo?',
        instructions: str(a.instrucciones, 1500) ?? '',
      }
    : null;
  return { products, schedule, delivery, faqs, assistant };
}

@Injectable()
export class AiSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  private companyIdFor(user: AuthUser, companyId?: string): string {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  async preview(user: AuthUser, dto: { description?: string }, companyId?: string) {
    const id = this.companyIdFor(user, companyId);
    const description = String(dto?.description ?? '').trim();
    if (description.length < 30) throw new BadRequestException('Cuéntale un poco más a la IA (mínimo 30 caracteres): qué vendes, precios, horario, si haces domicilios…');
    if (!this.ai) throw new BadRequestException('Motor de IA no disponible');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const access = await resolveAiAccess(this.prisma, company);
    if (!access.ok) throw new BadRequestException(access.reason);
    const ai = this.ai;
    const { result, billedTo } = await new AiSession(access).run((apiKey) =>
      ai.chat({
        apiKey,
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0.2,
        maxTokens: 2500,
        jsonMode: true,
        messages: [
          {
            role: 'system',
            content:
              `Configuras el negocio "${company.name}" (${company.city ?? 'Colombia'}) en una plataforma de pedidos por WhatsApp. ` +
              'A partir de la descripción del dueño devuelve SOLO un JSON:\n' +
              '{"productos":[{"nombre":"","categoria":"","precio":number|null,"descripcion":"","presentaciones":[]}],' +
              '"horario":{"dias":[0-6, 0=domingo],"abre":"HH:mm","cierra":"HH:mm"}|null,' +
              '"domicilios":{"activo":bool,"tarifa_base":number|null,"por_km":number|null,"cobertura_km":number|null,"tiempo_preparacion_min":number|null}|null,' +
              '"preguntas":[{"pregunta":"","respuesta":""}],' +
              '"asistente":{"nombre":"","tono":"","estilo":"","bienvenida":"","instrucciones":"cómo atiende, qué ofrece, qué nunca hace"}}\n' +
              'Reglas: precios en pesos colombianos sin puntos (18000). NO inventes precios ni productos que no estén en la descripción: usa null. ' +
              'Las preguntas frecuentes salen SOLO de lo que dijo el dueño (pagos, cobertura, horarios, políticas). Español colombiano.',
          },
          { role: 'user', content: description.slice(0, 8000) },
        ],
      }),
    );
    await recordAiUsage(this.prisma, {
      companyId: id, model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      billedTo, purpose: 'SETUP',
    });
    const proposal = normalizeProposal(extractJson(result.content));
    if (!proposal.products.length && !proposal.faqs.length && !proposal.schedule) {
      throw new BadRequestException('La IA no pudo sacar información útil: describe productos, precios y horario');
    }
    return proposal;
  }

  /** Aplica la propuesta revisada (también validada aquí: puede venir editada). */
  async apply(user: AuthUser, dto: { proposal?: any; createAssistant?: boolean }, companyId?: string) {
    const id = this.companyIdFor(user, companyId);
    const raw = dto?.proposal ?? {};
    // La propuesta editada en el panel llega en el formato normalizado
    const p = normalizeProposal({
      productos: (raw.products ?? []).map((x: any) => ({ nombre: x.name, categoria: x.category, precio: x.price, descripcion: x.description, presentaciones: x.presentations })),
      horario: raw.schedule ? { dias: raw.schedule.days, abre: raw.schedule.open, cierra: raw.schedule.close } : null,
      domicilios: raw.delivery ? { activo: raw.delivery.enabled, tarifa_base: raw.delivery.baseFee, por_km: raw.delivery.perKm, cobertura_km: raw.delivery.maxKm, tiempo_preparacion_min: raw.delivery.prepMinutes } : null,
      preguntas: (raw.faqs ?? []).map((f: any) => ({ pregunta: f.question, respuesta: f.answer })),
      asistente: raw.assistant ? { nombre: raw.assistant.name, tono: raw.assistant.tone, estilo: raw.assistant.style, bienvenida: raw.assistant.welcome, instrucciones: raw.assistant.instructions } : null,
    });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const existing = await this.prisma.product.findMany({ where: { companyId: id, ...NOT_DELETED }, select: { name: true } });
    const names = new Set(existing.map((e) => e.name.toLowerCase()));
    let created = 0;
    for (const product of p.products) {
      if (names.has(product.name.toLowerCase())) continue;
      await this.prisma.product.create({
        data: {
          companyId: id, name: product.name, category: product.category, price: product.price,
          description: product.description, presentationsJson: JSON.stringify(product.presentations),
        },
      });
      created++;
    }
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const kb = Array.isArray(cfg.knowledgeBase) ? cfg.knowledgeBase : [];
    const kbQuestions = new Set(kb.map((f: any) => String(f?.question ?? f).toLowerCase()));
    const next = {
      ...cfg,
      ...(p.schedule ? { schedule: p.schedule } : {}),
      ...(p.delivery
        ? {
            delivery: {
              ...(cfg.delivery ?? {}),
              // se activa solo cuando hay punto de despacho (no se inventa ubicación)
              enabled: p.delivery.enabled && !!cfg.delivery?.origin,
              ...(p.delivery.baseFee != null ? { baseFee: p.delivery.baseFee } : {}),
              ...(p.delivery.perKm != null ? { perKm: p.delivery.perKm } : {}),
              ...(p.delivery.maxKm != null ? { maxKm: p.delivery.maxKm } : {}),
              ...(p.delivery.prepMinutes != null ? { prepMinutes: p.delivery.prepMinutes } : {}),
            },
          }
        : {}),
      knowledgeBase: [...kb, ...p.faqs.filter((f) => !kbQuestions.has(f.question.toLowerCase()))].slice(0, 60),
    };
    await this.prisma.company.update({ where: { id }, data: { orderConfigJson: JSON.stringify(next) } });

    let botId: string | null = null;
    if (p.assistant && dto?.createAssistant !== false) {
      const preset = p.delivery?.enabled ? 'domicilios' : 'pedidos_programados';
      const bot = await this.prisma.bot.create({
        data: {
          companyId: id, name: p.assistant.name, status: 'DRAFT', provider: 'deepinfra',
          model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.4,
          systemPrompt: p.assistant.instructions || `Atiendes el WhatsApp de ${company.name}.`,
          personalityJson: JSON.stringify({ tone: p.assistant.tone, style: p.assistant.style, language: 'es-CO' }),
          welcomeMessage: p.assistant.welcome,
          engineMode: 'AGENT', toolsJson: JSON.stringify(AGENT_PRESETS[preset].tools),
          replyDelayMinSec: 2, replyDelayMaxSec: 12,
        },
      });
      botId = bot.id;
    }
    await this.audit.log({
      actor: user, companyId: id, action: 'ai_setup.apply', entity: 'Company', entityId: id,
      detail: `${created} productos, ${p.faqs.length} preguntas${p.schedule ? ', horario' : ''}${botId ? ', asistente' : ''}`,
    });
    return {
      productsCreated: created,
      productsSkipped: p.products.length - created,
      faqsAdded: p.faqs.length,
      scheduleSet: !!p.schedule,
      deliveryNeedsOrigin: !!p.delivery?.enabled && !cfg.delivery?.origin,
      botId,
    };
  }
}

@Controller('ai-setup')
export class AiSetupController {
  constructor(private readonly setup: AiSetupService) {}

  @Post('preview')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  preview(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.setup.preview(user, dto, companyId);
  }

  @Post('apply')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  apply(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.setup.apply(user, dto, companyId);
  }
}

@Module({
  controllers: [AiSetupController],
  providers: [AiSetupService, { provide: AI_PROVIDER, useClass: DeepInfraProvider }],
})
export class AiSetupModule {}
