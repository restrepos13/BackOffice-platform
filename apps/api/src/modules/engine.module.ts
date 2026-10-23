import {
  Body,
  Controller,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
  Post,
} from '@nestjs/common';
import { ensureFile } from '../common/file-store';
import { entryStageFor } from '../common/pipelines';
import { Queue, Worker } from 'bullmq';
import { WA_OUTBOUND_QUEUE, redisConnection } from '../queue/queue.module';
import { OrdersModule, OrdersService } from './orders.module';
import { PaymentsModule } from './payments.module';
import { KnowledgeModule, KnowledgeService } from './knowledge.module';
import { validateDelivery } from '../common/agenda';
import { isLatLng } from '../common/geo';
import { applyConsent } from '../common/customer-notify';
import { VISION_MODEL, analyzeImage, messageForModel, receiptMatches } from '../ai/vision';
// Reexport para compatibilidad (tests y consumidores existentes)
export { validateDelivery };
import { join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { reportIncident } from '../common/incidents';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
  NOT_DELETED,
} from '../common/constants';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { AiBilling, AiSession, recordAiUsage, resolveAiAccess } from '../ai/ai-access';
import { AgentService } from '../ai/agent/agent.service';
import { BookingsModule } from './bookings.module';
import { buildSystemPrompt, PromptContext } from '../ai/prompt';
import {
  AI_PROVIDER,
  AiProvider,
  ChatMessage,
  DraftOrder,
  EngineOutput,
  extractJson,
  validateEngineOutput,
} from '../ai/types';
import { Products } from '../auth/products.guard';
import { hasProduct } from '../common/products';

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

/* ─── Utilidades puras (exportadas para tests) ───────────────────────── */

/** Config efectiva de la línea: CUSTOM pisa al bot, campo a campo. */
export function resolveEffective(bot: any, line: any) {
  const custom = line?.promptMode === 'CUSTOM';
  const linePersonality = parseJson<Record<string, string>>(line?.overridePersonalityJson, {});
  const lineSales = parseJson<Record<string, string>>(line?.overrideSalesJson, {});
  return {
    systemPrompt: (custom && line?.overridePrompt) || bot?.systemPrompt || '',
    personality: custom && Object.keys(linePersonality).length
      ? linePersonality
      : parseJson<Record<string, string>>(bot?.personalityJson, {}),
    sales: custom && Object.keys(lineSales).length
      ? lineSales
      : parseJson<Record<string, string>>(bot?.salesJson, {}),
    welcomeMessage: (custom && line?.overrideWelcome) || bot?.welcomeMessage || null,
    handoffKeywords: (custom && line?.overrideHandoff) || bot?.handoffKeywords || '',
    model: (custom && line?.overrideModel) || bot?.model || 'meta-llama/Llama-3.3-70B-Instruct',
    temperature: (custom && line?.overrideTemperature != null)
      ? line.overrideTemperature
      : (bot?.temperature ?? 0.7),
    delayMinSec: (custom && line?.overrideReplyDelayMinSec != null)
      ? line.overrideReplyDelayMinSec
      : (bot?.replyDelayMinSec ?? 3),
    delayMaxSec: (custom && line?.overrideReplyDelayMaxSec != null)
      ? line.overrideReplyDelayMaxSec
      : (bot?.replyDelayMaxSec ?? 12),
    typing: bot?.typingSimulation ?? true,
  };
}

/**
 * Humanización de salida: delay variable y proporcional al largo del mensaje,
 * acotado por los tiempos configurados. Una respuesta instantánea delata al bot.
 */
export function humanizeDelays(
  parts: string[],
  delayMinSec: number,
  delayMaxSec: number,
): Array<{ content: string; delayMs: number; typingMs: number }> {
  const minMs = Math.max(delayMinSec, 1) * 1000;
  const maxMs = Math.max(delayMaxSec, delayMinSec + 1) * 1000;
  return parts.map((content, index) => {
    // "leer" el mensaje entrante solo la primera vez; después solo "escribir"
    const reading = index === 0 ? 1500 : 400;
    const writing = content.length * 55; // ~velocidad de tipeo humano
    const jitter = 0.8 + Math.random() * 0.5;
    const delayMs = Math.round(
      Math.min(Math.max((reading + writing) * jitter, minMs), maxMs),
    );
    return { content, delayMs, typingMs: Math.min(writing, 9000) };
  });
}

/* ─── Motor ──────────────────────────────────────────────────────────── */

export interface EngineResult {
  conversationId: string;
  replies: Array<{ content: string; delayMs: number; typingMs: number }>;
  state: string;
  escalated: boolean;
  escalationReason?: string | null;
  draftOrderId?: string | null;
  orderStatus?: string | null;
}

@Injectable()
export class EngineService {
  private readonly logger = new Logger('Engine');
  /** Agrupación de mensajes consecutivos (debounce por conversación).
   *  En Fase 3 esto migra a jobs demorados de BullMQ (multi-instancia). */
  private pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly audit: AuditService,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly outboundQueue?: Queue,
    @Optional() private readonly orders?: OrdersService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly agent?: AgentService,
    @Optional() private readonly knowledge?: KnowledgeService,
  ) {}

  /** Encola el envío real (Twilio) de las respuestas para canales reales,
   *  respetando los delays humanizados. El simulador no envía nada. */
  private async dispatchReplies(
    conversation: any,
    parts: Array<{ messageId: string; delayMs: number }>,
  ) {
    if (!['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(conversation.channel) || !this.outboundQueue) return;
    let accumulated = 0;
    for (const part of parts) {
      accumulated += part.delayMs;
      await this.outboundQueue.add(
        'outbound',
        { messageId: part.messageId, metaCategory: 'SERVICIO' },
        { delay: accumulated, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
      );
    }
  }

  /** Entrada estándar: llega un mensaje → se agrupa y se procesa junto. */
  notifyInbound(conversationId: string, graceSeconds = 6) {
    const existing = this.pending.get(conversationId);
    if (existing) clearTimeout(existing);
    this.pending.set(
      conversationId,
      setTimeout(() => {
        this.pending.delete(conversationId);
        this.processConversation(conversationId).catch((err) =>
          this.logger.error(`processConversation(${conversationId}): ${err.message}`),
        );
      }, graceSeconds * 1000),
    );
  }

  /** Pipeline completo sobre una conversación. */
  async processConversation(
    conversationId: string,
    opts: { allowDraftBot?: boolean } = {},
  ): Promise<EngineResult | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        contact: { include: { customer: true } },
        integration: true,
        company: true,
      },
    });
    if (!conversation) return null;
    const { company, contact, integration } = conversation as any;

    // Modo humano: la IA no toca la conversación
    if (conversation.botPaused) return null;

    // Sin BackOffice Automation activo la IA no atiende: pasa a una persona (nunca se queda sin respuesta)
    if (company && !hasProduct(company, 'AUTOMATION')) {
      return this.escalate(conversation, null, 'BackOffice Automation no está activo para esta empresa');
    }

    const bot = conversation.botId
      ? await this.prisma.bot.findUnique({ where: { id: conversation.botId } })
      : integration?.botId
        ? await this.prisma.bot.findUnique({ where: { id: integration.botId } })
        : null;

    if (!bot || (bot.status !== 'ACTIVE' && !opts.allowDraftBot)) {
      return this.escalate(conversation, null, 'Sin bot activo para esta línea');
    }
    const access = await resolveAiAccess(this.prisma, company, bot, { conversationId });
    if (!access.ok) {
      if (['CAP_REACHED', 'NO_AI', 'NO_CREDITS'].includes(access.code)) {
        await this.audit.log({
          actor: null, companyId: company.id, action: 'ai.cap_reached',
          entity: 'Conversation', entityId: conversationId, detail: access.reason,
        });
      }
      return this.escalate(conversation, null, access.reason);
    }
    // Híbrido: si DeepInfra rechaza la llave principal, sigue con la de respaldo
    const session = new AiSession(access);

    const effective = resolveEffective(bot, integration);
    const orderConfig = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const threshold = Number(orderConfig.aiConfidenceThreshold ?? 0.8);

    // Mensajes y transcripción de audios pendientes
    let messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: 40,
    });
    for (const message of messages) {
      if (message.direction === 'IN' && message.type === 'AUDIO' && !message.transcription && message.fileName) {
        try {
          await ensureFile(this.prisma, company.id, message.fileName); // disco efímero: se restaura desde la base
          const { result: { text }, billedTo } = await session.run((apiKey) =>
            this.ai.transcribe({
              apiKey,
              filePath: join(UPLOADS_DIR, company.id, message.fileName!),
              mimeType: 'audio/ogg',
              language: 'es',
            }),
          );
          await this.prisma.message.update({
            where: { id: message.id },
            data: { transcription: text },
          });
          (message as any).transcription = text;
          await this.recordUsage(company.id, integration?.id, bot.id, 'openai/whisper-large-v3-turbo', 0, 0, { billedTo, conversationId });
        } catch (err: any) {
          this.logger.warn(`transcripción falló: ${err.message}`);
        }
      }
      // Imágenes: comprobantes de pago (Nequi, transferencias) y fotos
      if (message.direction === 'IN' && message.type === 'IMAGE' && message.fileName && !(message as any).analysisJson) {
        try {
          const ext = message.fileName.split('.').pop()?.toLowerCase();
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          await ensureFile(this.prisma, company.id, message.fileName);
          const vision = await analyzeImage(this.ai, session, join(UPLOADS_DIR, company.id, message.fileName), mime);
          const analysisJson = JSON.stringify(vision.analysis);
          await this.prisma.message.update({ where: { id: message.id }, data: { analysisJson } });
          (message as any).analysisJson = analysisJson;
          await this.recordUsage(company.id, integration?.id, bot.id, VISION_MODEL, vision.inputTokens, vision.outputTokens, {
            billedTo: vision.billedTo, conversationId,
          });
          if (vision.analysis.kind === 'RECEIPT') {
            await this.attachReceipt(company.id, contact, message.id, vision.analysis);
          }
        } catch (err: any) {
          this.logger.warn(`lectura de imagen falló: ${err.message}`);
        }
      }
    }

    const lastInbound = [...messages].reverse().find((m) => m.direction === 'IN');
    if (!lastInbound) return null;

    // Handoff por palabra clave (efectivo línea→bot)
    const keywords = (effective.handoffKeywords || '')
      .split(',')
      .map((k: string) => k.trim().toLowerCase())
      .filter(Boolean);
    const lastText = (lastInbound.transcription ?? lastInbound.content).toLowerCase();
    const hit = keywords.find((k: string) => lastText.includes(k));
    if (hit) {
      return this.escalate(conversation, null, `Palabra clave de handoff: "${hit}"`, [
        'Claro, dame un momento que ya te contacto con el equipo.',
      ]);
    }

    // Modo AGENTE: la IA decide qué consultar y qué hacer con herramientas
    if (bot.engineMode === 'AGENT' && this.agent) {
      let run: Awaited<ReturnType<AgentService['run']>>;
      try {
        run = await this.agent.run({
          conversation, company, contact, integration, bot, effective,
          messages, session, conversationId,
        });
      } catch (err: any) {
        // Proveedor caído (o ambas llaves rechazadas): la conversación NUNCA se pierde
        this.logger.error(`agente sin proveedor [co=${company.id} conv=${conversationId}]: ${err.message}`);
        await reportIncident(this.prisma, { companyId: company.id, kind: 'AI_DOWN', detail: `Modo agente: ${err.message}` });
        run = {
          reply: ['Dame un momento, ya reviso con el equipo y te confirmo.'],
          state: 'escalado', escalate: true, toolTrace: [],
          reason: `Proveedor de IA no disponible: ${err.message}`,
        };
      }
      await this.auditFallback(session, company.id, conversationId);
      if (run.escalate) {
        const openDraft = await this.prisma.order.findFirst({
          where: { conversationId, status: 'borrador', ...NOT_DELETED },
          orderBy: { createdAt: 'desc' },
        });
        return this.escalate(conversation, openDraft, run.reason ?? 'El agente pidió ayuda humana', run.reply);
      }
      return this.deliverReplies(conversation, company, effective, run.reply, {
        state: run.state, draftOrderId: run.draftOrderId ?? null,
      });
    }

    // Contexto: borrador vigente + pedidos anteriores + catálogo
    const draft = await this.prisma.order.findFirst({
      where: { conversationId, status: 'borrador', ...NOT_DELETED },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    const previousOrders = contact?.customerId
      ? await this.prisma.order.findMany({
          where: {
            companyId: company.id,
            customerId: contact.customerId,
            status: { in: ['confirmado', 'programado', 'despachado', 'entregado'] },
            ...NOT_DELETED,
          },
          include: { items: true },
          orderBy: { deliveryAt: 'desc' },
          take: 3,
        })
      : [];
    const products = await this.prisma.product.findMany({
      where: { companyId: company.id, active: true, ...NOT_DELETED },
      take: 100,
    });

    const ctx: PromptContext = {
      companyName: company.name,
      timezone: company.timezone,
      now: new Date(),
      systemPrompt: effective.systemPrompt,
      personality: effective.personality,
      sales: effective.sales,
      welcomeMessage: effective.welcomeMessage,
      orderConfig,
      products: products.map((p) => ({
        name: p.name,
        category: p.category,
        unit: p.unit,
        description: p.description,
        presentations: parseJson<any[]>(p.presentationsJson, [])
          .map((x) => (typeof x === 'string' ? x : x?.name))
          .filter(Boolean),
      })),
      customer: contact?.customer
        ? {
            name: contact.customer.name,
            notes: contact.customer.notes,
            addresses: parseJson<any[]>(contact.customer.addressesJson, []),
          }
        : null,
      contactName: contact?.name,
      previousOrders: previousOrders.map((o) => ({
        deliveryAt: o.deliveryAt,
        status: o.status,
        addressLabel: parseJson<any>(o.deliveryAddressJson, {}).label,
        items: o.items.map((i) => ({
          productName: i.productName,
          quantity: i.quantity,
          presentation: i.presentation,
        })),
      })),
      draft: draft
        ? {
            deliveryAt: draft.deliveryAt,
            address: parseJson<any>(draft.deliveryAddressJson, {}).address,
            observations: draft.observations,
            items: draft.items.map((i) => ({
              productName: i.productName,
              quantity: i.quantity,
              presentation: i.presentation,
              specifications: i.specifications,
            })),
          }
        : null,
      confidenceThreshold: threshold,
    };
    // Base de conocimiento: los fragmentos más relevantes para el último mensaje
    if (this.knowledge) {
      const hits = await this.knowledge.search(company.id, lastText, 2).catch(() => []);
      if (hits.length) {
        ctx.orderConfig = {
          ...orderConfig,
          knowledgeBase: [
            ...(Array.isArray(orderConfig.knowledgeBase) ? orderConfig.knowledgeBase : []),
            ...hits.map((h) => `${h.doc}: ${h.text.slice(0, 700)}`),
          ],
        };
      }
    }

    const history: ChatMessage[] = messages.slice(-24).map((m) => ({
      role: m.direction === 'IN' ? ('user' as const) : ('assistant' as const),
      content: messageForModel(m as any),
    }));

    // Llamada al modelo con validación estricta + un reintento.
    // Caída del proveedor (red/4xx/5xx) → NUNCA se pierde la conversación:
    // escala a una persona con el motivo registrado.
    let output: Awaited<ReturnType<typeof this.callModel>>;
    try {
      output = await this.callModel(company, integration, bot, effective, ctx, history, session, conversationId);
      await this.auditFallback(session, company.id, conversationId);
    } catch (err: any) {
      this.logger.error(`proveedor de IA caído [co=${company.id} conv=${conversationId}]: ${err.message}`);
      await reportIncident(this.prisma, { companyId: company.id, kind: 'AI_DOWN', detail: err.message });
      output = { ok: false, reason: `Proveedor de IA no disponible: ${err.message}` };
    }
    if (!output.ok) {
      return this.escalate(conversation, draft, output.reason, [
        'Dame un momento, ya reviso con el equipo y te confirmo.',
      ]);
    }
    const result = output.output;

    // Umbral de confianza explícito
    if (result.action === 'escalate' || result.confidence < threshold) {
      return this.escalate(
        conversation,
        draft,
        result.escalationReason ??
          `Confianza ${result.confidence.toFixed(2)} por debajo del umbral ${threshold}`,
        result.reply,
      );
    }

    // Aplicar acción sobre el borrador
    let draftOrderId = draft?.id ?? null;
    let orderStatus = draft?.status ?? null;
    if (result.order && ['update_draft', 'request_confirmation', 'confirm_order'].includes(result.action)) {
      const updated = await this.upsertDraft(conversation, contact, products, draft, result.order, result.confidence);
      draftOrderId = updated.id;
      orderStatus = updated.status;
    }

    if (result.action === 'confirm_order' && draftOrderId) {
      const confirmation = await this.confirmDraft(conversation, draftOrderId, orderConfig, result.confidence);
      orderStatus = confirmation.status;
      if (!confirmation.ok) {
        // El motor bloquea confirmaciones inválidas aunque el modelo se apure
        await this.audit.log({
          actor: null, companyId: company.id, action: 'engine.confirm_blocked',
          entity: 'Order', entityId: draftOrderId, detail: confirmation.reason,
        });
      }
    }

    // Persistir respuestas (humanizadas) y estado de la conversación
    return this.deliverReplies(conversation, company, effective, result.reply, {
      state: result.state,
      missingFields: result.missingFields,
      draftOrderId,
      orderStatus,
    });
  }

  /** Guarda las respuestas humanizadas, las encola al canal y actualiza el estado. */
  private async deliverReplies(
    conversation: any,
    company: any,
    effective: ReturnType<typeof resolveEffective>,
    replies: string[],
    state: { state: string; missingFields?: string[]; draftOrderId?: string | null; orderStatus?: string | null },
  ): Promise<EngineResult> {
    const conversationId = conversation.id;
    const plan = humanizeDelays(replies, effective.delayMinSec, effective.delayMaxSec);
    const dispatch: Array<{ messageId: string; delayMs: number }> = [];
    for (const part of plan) {
      const created = await this.prisma.message.create({
        data: {
          conversationId,
          direction: 'OUT',
          author: 'BOT',
          content: part.content,
          type: 'TEXT',
          deliveryStatus: ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(conversation.channel) ? 'QUEUED' : null,
        },
      });
      dispatch.push({ messageId: created.id, delayMs: part.delayMs });
    }
    await this.dispatchReplies(conversation, dispatch);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        status: 'OPEN',
        aiStateJson: JSON.stringify({
          state: state.state,
          missingFields: state.missingFields ?? [],
          draftOrderId: state.draftOrderId ?? null,
        }),
      },
    });
    this.events?.emit(company.id, {
      type: 'message.new',
      conversationId,
      direction: 'OUT',
    });

    return {
      conversationId,
      replies: plan,
      state: state.state,
      escalated: false,
      draftOrderId: state.draftOrderId ?? null,
      orderStatus: state.orderStatus ?? null,
    };
  }

  /* ── Modelo: llamada + validación + reintento ── */
  private async callModel(
    company: any,
    integration: any,
    bot: any,
    effective: ReturnType<typeof resolveEffective>,
    ctx: PromptContext,
    history: ChatMessage[],
    session: AiSession,
    conversationId: string,
  ): Promise<{ ok: true; output: EngineOutput } | { ok: false; reason: string }> {
    const base: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(ctx) },
      ...history,
    ];
    let lastErrors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages: ChatMessage[] =
        attempt === 0
          ? base
          : [
              ...base,
              {
                role: 'system',
                content: `Tu respuesta anterior no cumplió el formato: ${lastErrors.join('; ')}. Devuelve SOLO el objeto JSON válido.`,
              },
            ];
      const { result: completion, billedTo } = await session.run((apiKey) =>
        this.ai.chat({
          apiKey,
          model: effective.model,
          temperature: effective.temperature,
          maxTokens: 1024,
          messages,
          jsonMode: true,
        }),
      );
      await this.recordUsage(
        company.id, integration?.id ?? null, bot.id,
        effective.model, completion.inputTokens, completion.outputTokens,
        { billedTo, conversationId },
      );
      const parsed = extractJson(completion.content);
      const validated = validateEngineOutput(parsed);
      if (validated.ok) return validated;
      lastErrors = validated.errors;
      this.logger.warn(`salida inválida (intento ${attempt + 1}): ${lastErrors.join('; ')}`);
    }
    return { ok: false, reason: `La IA no devolvió el formato esperado: ${lastErrors.join('; ')}` };
  }

  /* ── Borrador: crear/actualizar con mapeo a catálogo y áreas ── */
  private async upsertDraft(
    conversation: any,
    contact: any,
    products: any[],
    existing: any,
    order: DraftOrder,
    confidence: number,
  ) {
    const companyId = conversation.companyId;
    const match = (name: string) => {
      const n = name.toLowerCase();
      return (
        products.find((p) => p.name.toLowerCase() === n) ??
        products.find((p) => p.name.toLowerCase().includes(n) || n.includes(p.name.toLowerCase())) ??
        null
      );
    };
    const addresses = parseJson<any[]>(contact?.customer?.addressesJson ?? '[]', []);
    const knownAddress = order.addressLabel
      ? addresses.find((a) => a.label?.toLowerCase() === order.addressLabel!.toLowerCase())
      : null;
    const addressJson = knownAddress
      ? JSON.stringify(knownAddress)
      : order.address
        ? JSON.stringify({ label: 'Indicada en la conversación', address: order.address })
        : (existing?.deliveryAddressJson ?? '{}');

    const data = {
      deliveryAt: order.deliveryAtISO
        ? new Date(order.deliveryAtISO)
        : (existing?.deliveryAt ?? new Date(Date.now() + 48 * 3600 * 1000)),
      deliveryAddressJson: addressJson,
      observations: order.observations ?? existing?.observations,
      aiConfidence: confidence,
    };
    const items = order.items.map((item) => {
      const product = match(item.productName);
      return {
        companyId,
        productId: product?.id ?? null,
        productName: product?.name ?? item.productName,
        quantity: item.quantity,
        unit: item.unit ?? product?.unit ?? 'unidad',
        presentation: item.presentation ?? null,
        specifications: item.specifications ?? null,
        productionAreaId: product?.productionAreaId ?? null,
      };
    });

    if (existing) {
      await this.prisma.orderItem.deleteMany({ where: { orderId: existing.id } });
      const updated = await this.prisma.order.update({
        where: { id: existing.id },
        data: { ...data, items: { create: items } },
      });
      return updated;
    }
    if (!contact?.customerId) {
      // Cliente sin empresa registrada: se crea Customer mínimo con el nombre del contacto
      const customer = await this.prisma.customer.create({
        data: {
          companyId,
          name: contact?.name ?? 'Cliente por identificar',
          notes: 'Creado automáticamente desde la conversación — completar ficha.',
        },
      });
      await this.prisma.contact.update({
        where: { id: contact.id },
        data: { customerId: customer.id },
      });
      contact.customerId = customer.id;
    }
    const created = await this.prisma.order.create({
      data: {
        companyId,
        customerId: contact.customerId,
        contactId: contact.id,
        conversationId: conversation.id,
        status: 'borrador',
        takenByType: 'IA',
        ...data,
        items: { create: items },
      },
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        companyId, orderId: created.id, fromStatus: null, toStatus: 'borrador',
        authorType: 'IA', authorName: 'Asistente IA',
      },
    });
    return created;
  }

  /* ── Confirmación: guardas del motor + trazabilidad ── */
  private async confirmDraft(
    conversation: any,
    orderId: string,
    orderConfig: Record<string, any>,
    confidence: number,
  ): Promise<{ ok: boolean; status: string; reason?: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order || order.status !== 'borrador') {
      return { ok: false, status: order?.status ?? 'borrador', reason: 'No hay borrador confirmable' };
    }
    if (order.items.length === 0) {
      return { ok: false, status: 'borrador', reason: 'Borrador sin ítems' };
    }
    const address = parseJson<any>(order.deliveryAddressJson, {});
    if (!address.address) {
      return { ok: false, status: 'borrador', reason: 'Falta la dirección de entrega' };
    }
    // Agenda completa (corte y capacidad incluidos) cuando OrdersService está
    // disponible; reglas base como respaldo (tests unitarios del motor).
    if (this.orders) {
      const agenda = await this.orders.validateAgenda(
        order.companyId, order.deliveryAt, order.id,
      );
      if (!agenda.ok) {
        return { ok: false, status: 'borrador', reason: agenda.reason };
      }
    } else {
      const validity = validateDelivery(orderConfig, order.deliveryAt);
      if (!validity.ok) {
        return { ok: false, status: 'borrador', reason: validity.reason };
      }
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'confirmado', aiConfidence: confidence },
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        companyId: order.companyId, orderId, fromStatus: 'borrador', toStatus: 'confirmado',
        authorType: 'IA', authorName: 'Asistente IA',
        reason: 'Cliente confirmó el resumen completo por chat',
      },
    });
    // Fase 4: distribución a áreas + recordatorios + paso automático a "programado"
    if (this.orders) {
      const pipeline = await this.orders.runConfirmationPipeline(orderId, {
        type: 'IA', name: 'Asistente IA',
      });
      return {
        ok: true,
        status: pipeline.scheduled ? 'programado' : 'requiere_atencion',
      };
    }
    return { ok: true, status: 'confirmado' };
  }

  /* ── Escalamiento: registrado SIEMPRE con su motivo ── */
  private async escalate(
    conversation: any,
    draft: any,
    reason: string,
    replies: string[] = [],
  ): Promise<EngineResult> {
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        needsAttention: true,
        botPaused: true, // la IA se detiene hasta que una persona retome
        aiStateJson: JSON.stringify({ state: 'escalado', reason }),
        lastMessageAt: new Date(),
      },
    });
    if (draft?.id) {
      await this.prisma.order.update({
        where: { id: draft.id },
        data: { status: 'requiere_atencion' },
      });
      await this.prisma.orderStatusHistory.create({
        data: {
          companyId: conversation.companyId, orderId: draft.id,
          fromStatus: draft.status, toStatus: 'requiere_atencion',
          authorType: 'IA', authorName: 'Asistente IA', reason,
        },
      });
    }
    await this.audit.log({
      actor: null,
      companyId: conversation.companyId,
      action: 'engine.escalate',
      entity: 'Conversation',
      entityId: conversation.id,
      detail: reason,
    });
    const plan = humanizeDelays(
      replies.length ? replies : ['Dame un momento y te confirmo, estoy revisando con el equipo.'],
      3, 10,
    );
    const dispatch: Array<{ messageId: string; delayMs: number }> = [];
    for (const part of plan) {
      const created = await this.prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: 'OUT', author: 'BOT', content: part.content, type: 'TEXT',
          deliveryStatus: ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(conversation.channel) ? 'QUEUED' : null,
        },
      });
      dispatch.push({ messageId: created.id, delayMs: part.delayMs });
    }
    await this.dispatchReplies(conversation, dispatch);
    this.events?.emit(conversation.companyId, {
      type: 'conversation.updated',
      conversationId: conversation.id,
      needsAttention: true,
      botPaused: true,
    });
    return {
      conversationId: conversation.id,
      replies: plan,
      state: 'escalado',
      escalated: true,
      escalationReason: reason,
      draftOrderId: draft?.id ?? null,
      orderStatus: draft ? 'requiere_atencion' : null,
    };
  }

  /**
   * Comprobante leído por la IA → el pedido abierto más reciente del cliente
   * queda "comprobante recibido" (por verificar). Jamás se marca PAGADO solo.
   */
  private async attachReceipt(companyId: string, contact: any, messageId: string, analysis: any) {
    if (!contact?.id) return;
    const order = await this.prisma.order.findFirst({
      where: {
        companyId,
        AND: [
          { OR: [{ contactId: contact.id }, ...(contact.customerId ? [{ customerId: contact.customerId }] : [])] },
          NOT_DELETED,
        ],
        status: { notIn: ['cancelado', 'borrador'] },
        paymentStatus: { not: 'PAID' },
        createdAt: { gte: new Date(Date.now() - 7 * 86400e3) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!order) return;
    const matches = receiptMatches(analysis.amount, order.total);
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'REPORTED',
        receiptMessageId: messageId,
        receiptJson: JSON.stringify({ ...analysis, matches, orderTotal: order.total }),
        paymentMethod: analysis.bank ? String(analysis.bank).toUpperCase().slice(0, 20) : 'TRANSFERENCIA',
      },
    });
    await this.audit.log({
      actor: null, companyId, action: 'order.receipt', entity: 'Order', entityId: order.id,
      detail: `Comprobante ${analysis.bank ?? ''} por ${analysis.amount ?? '¿?'}${matches ? ' (cubre el total)' : ' (NO cubre el total)'}`,
    });
    this.events?.emit(companyId, { type: 'order.payment', orderId: order.id, status: 'REPORTED', matches });
  }

  /** Deja constancia cuando el modo híbrido tuvo que pasar a la llave de respaldo. */
  private async auditFallback(session: AiSession, companyId: string, conversationId: string) {
    if (!session.switched) return;
    await this.audit.log({
      actor: null, companyId, action: 'ai.fallback',
      entity: 'Conversation', entityId: conversationId,
      detail: `DeepInfra rechazó la llave principal; se respondió con la ${session.billedTo === 'PLATFORM' ? 'IA de BackOffice' : 'llave propia de la empresa'}`,
    });
  }

  /* ── Registro de consumo (UsageLog de IA) ── */
  private async recordUsage(
    companyId: string,
    integrationId: string | null,
    botId: string | null,
    model: string,
    inputTokens: number,
    outputTokens: number,
    usage: { billedTo: AiBilling; conversationId: string },
  ) {
    const { alert } = await recordAiUsage(this.prisma, {
      companyId, integrationId, botId, model, inputTokens, outputTokens,
      billedTo: usage.billedTo, conversationId: usage.conversationId,
    });
    if (alert) this.events?.emit(companyId, { type: 'ai.credits', level: alert });
  }

  /* ── Simulador interno (sandbox de conversación, sin canal real) ── */
  async simulate(user: AuthUser, dto: {
    companyId?: string; integrationId?: string; phone: string; name?: string;
    content: string; reset?: boolean;
    /** Simula "compartir ubicación" de WhatsApp. */
    latitude?: number; longitude?: number;
  }): Promise<EngineResult & { transcript: Array<{ author: string; content: string }> }> {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');

    const integration = dto.integrationId
      ? await this.prisma.integration.findFirst({
          where: { id: dto.integrationId, companyId },
        })
      : await this.prisma.integration.findFirst({
          where: { companyId, type: 'WHATSAPP' },
        });
    if (!integration) throw new NotFoundException('La empresa no tiene línea de WhatsApp');

    let contact = await this.prisma.contact.findFirst({
      where: { companyId, phone: dto.phone },
    });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          companyId,
          name: dto.name ?? `Simulador ${dto.phone}`,
          phone: dto.phone,
          channel: 'SIMULATOR',
          ...(await entryStageFor(this.prisma, companyId)),
        },
      });
    }

    let conversation = await this.prisma.conversation.findFirst({
      where: {
        companyId, contactId: contact.id, integrationId: integration.id,
        channel: 'SIMULATOR', status: { in: ['OPEN', 'PENDING', 'HANDOFF'] },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    if (dto.reset && conversation) {
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'RESOLVED' },
      });
      conversation = null;
    }
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          companyId, contactId: contact.id, integrationId: integration.id,
          botId: integration.botId, channel: 'SIMULATOR', status: 'OPEN',
        },
      });
    }

    const location = isLatLng({ lat: dto.latitude, lng: dto.longitude })
      ? { lat: Number(dto.latitude), lng: Number(dto.longitude) }
      : null;
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'IN', author: 'CONTACT',
        content: location
          ? `[ubicación] ${dto.content?.trim() || `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}`
          : dto.content,
        type: location ? 'LOCATION' : 'TEXT',
        ...(location ? { latitude: location.lat, longitude: location.lng } : {}),
      },
    });

    // Baja / re-alta igual que por WhatsApp (sin pasar por la IA)
    const consent = location ? null : await applyConsent(this.prisma, this.outboundQueue, contact, conversation, dto.content ?? '');

    // En el simulador el bot en borrador también responde (para probar antes de activar)
    const result = consent ? null : await this.processConversation(conversation.id, { allowDraftBot: true });
    const transcript = await this.prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      select: { author: true, content: true },
      take: 60,
    });
    return {
      ...(result ?? {
        conversationId: conversation.id,
        replies: [], state: 'pausado', escalated: false,
      }),
      transcript,
    } as any;
  }
}

@Products('AUTOMATION')
@Controller('engine')
export class EngineController {
  constructor(private readonly engine: EngineService) {}

  /** Sandbox: conversar con la IA de una línea sin canal real. */
  @Post('simulate')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  simulate(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.engine.simulate(user, dto);
  }
}

/** Worker de la cola 'engine': procesa conversaciones agrupadas (debounce
 *  con jobs demorados deduplicados por conversación — multi-instancia). */
@Injectable()
export class EngineQueueWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('EngineWorker');
  private worker?: Worker;

  constructor(private readonly engine: EngineService) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return;
    this.worker = new Worker(
      'engine',
      async (job) => this.engine.processConversation(job.data.conversationId),
      { connection: redisConnection() },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`engine job ${job?.id}: ${err.message}`),
    );
    this.logger.log('Worker del motor arriba (engine)');
  }

  async onApplicationShutdown() {
    await this.worker?.close().catch(() => undefined);
  }
}

@Module({
  imports: [OrdersModule, PaymentsModule, KnowledgeModule, BookingsModule],
  controllers: [EngineController],
  providers: [
    EngineService,
    EngineQueueWorker,
    AgentService,
    { provide: AI_PROVIDER, useClass: DeepInfraProvider },
  ],
  exports: [EngineService],
})
export class EngineModule {}
