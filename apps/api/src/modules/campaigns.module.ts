import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson, scopeCompanyId } from '../common/constants';
import { WA_OUTBOUND_QUEUE } from '../queue/queue.module';
import { queueBotText, renderCampaignText, withinServiceWindow } from '../common/customer-notify';
import { AuditService } from './audit.module';

/**
 * Campañas por WhatsApp (envío masivo segmentado) + seguimiento automático.
 *
 * Campañas: segmento → vista previa con costo estimado (Meta cobra MARKETING
 * fuera de la ventana de 24 h, y ahí solo se permite plantilla aprobada) →
 * envío escalonado por la cola de salida (sandbox-aware) → métricas reales
 * (entregados, leídos, respuestas, pedidos y ventas atribuidas en 72 h) →
 * reenvío a quienes no respondieron. Nunca se escribe a quien pidió la baja.
 *
 * Seguimiento automático (orderConfig.followUps): si el cliente dejó de
 * responder tras un mensaje del bot (o dejó un pedido a medias), se le
 * escribe una vez por regla dentro de la ventana de 24 h.
 */

export interface Segment {
  stages?: string[];
  tags?: string[];
  /** Clientes que NO piden hace N días (o nunca han pedido) */
  inactiveDays?: number;
  /** Contactos con actividad en los últimos N días */
  activeWithinDays?: number;
  /** Han pedido alguno de estos productos */
  productIds?: string[];
  /** Solo quienes ya compraron alguna vez */
  customersOnly?: boolean;
  /** Reenvío: destinatarios de otra campaña (todos o solo los que no respondieron) */
  fromBroadcastId?: string;
  fromBroadcastFilter?: 'all' | 'no_reply';
}

const MAX_RECIPIENTS = 5000;
const SEND_SPACING_MS = 1200; // ~50 mensajes por minuto: no dispara el control de spam de Meta
const DEFAULT_MARKETING_USD = 0.0125; // tarifa de referencia Colombia (configurable en metaRatesUsd)

export function sanitizeSegment(raw: any): Segment {
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 60)).filter(Boolean).slice(0, 50) : undefined);
  const days = (v: unknown) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 && n <= 3650 ? n : undefined;
  };
  return {
    ...(arr(raw?.stages)?.length ? { stages: arr(raw?.stages) } : {}),
    ...(arr(raw?.tags)?.length ? { tags: arr(raw?.tags) } : {}),
    ...(days(raw?.inactiveDays) ? { inactiveDays: days(raw?.inactiveDays) } : {}),
    ...(days(raw?.activeWithinDays) ? { activeWithinDays: days(raw?.activeWithinDays) } : {}),
    ...(arr(raw?.productIds)?.length ? { productIds: arr(raw?.productIds) } : {}),
    ...(raw?.customersOnly ? { customersOnly: true } : {}),
    ...(raw?.fromBroadcastId ? {
      fromBroadcastId: String(raw.fromBroadcastId),
      fromBroadcastFilter: raw?.fromBroadcastFilter === 'no_reply' ? 'no_reply' : 'all',
    } : {}),
  };
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger('Campaigns');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly outboundQueue?: Queue,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  /* ── Audiencia ───────────────────────────────────────────────────── */

  async resolveAudience(companyId: string, segment: Segment, now = new Date()) {
    let contacts = await this.prisma.contact.findMany({
      where: {
        companyId,
        phone: { not: null },
        channel: { in: ['WHATSAPP', 'SIMULATOR'] },
        // $ne: true también incluye contactos viejos sin el campo (Mongo)
        optOut: { not: true },
        ...(segment.stages?.length ? { stage: { in: segment.stages } } : {}),
        ...(segment.activeWithinDays
          ? { lastActivityAt: { gte: new Date(now.getTime() - segment.activeWithinDays * 86400e3) } }
          : {}),
      },
      take: MAX_RECIPIENTS * 2,
    });
    if (segment.tags?.length) {
      const wanted = segment.tags.map((t) => t.toLowerCase());
      contacts = contacts.filter((c) => parseJson<string[]>(c.tagsJson, []).some((t) => wanted.includes(String(t).toLowerCase())));
    }
    if (segment.customersOnly || segment.inactiveDays || segment.productIds?.length) {
      const orders = await this.prisma.order.findMany({
        where: {
          companyId,
          contactId: { in: contacts.map((c) => c.id) },
          status: { notIn: ['borrador', 'cancelado'] },
          ...NOT_DELETED,
        },
        select: { contactId: true, createdAt: true, items: { select: { productId: true } } },
      });
      const lastOrder = new Map<string, Date>();
      const products = new Map<string, Set<string>>();
      for (const o of orders) {
        if (!o.contactId) continue;
        const prev = lastOrder.get(o.contactId);
        if (!prev || o.createdAt > prev) lastOrder.set(o.contactId, o.createdAt);
        const set = products.get(o.contactId) ?? new Set<string>();
        for (const i of o.items ?? []) if (i.productId) set.add(i.productId);
        products.set(o.contactId, set);
      }
      if (segment.customersOnly) contacts = contacts.filter((c) => lastOrder.has(c.id));
      if (segment.inactiveDays) {
        const limit = now.getTime() - segment.inactiveDays * 86400e3;
        contacts = contacts.filter((c) => {
          const last = lastOrder.get(c.id);
          return !last || last.getTime() < limit;
        });
      }
      if (segment.productIds?.length) {
        contacts = contacts.filter((c) => segment.productIds!.some((p) => products.get(c.id)?.has(p)));
      }
    }
    if (segment.fromBroadcastId) {
      const source = await this.prisma.broadcast.findFirst({ where: { id: segment.fromBroadcastId, companyId } });
      if (!source) throw new BadRequestException('La campaña de origen no existe');
      const recipients = await this.prisma.broadcastRecipient.findMany({
        where: { broadcastId: source.id, status: 'QUEUED' },
        select: { contactId: true, conversationId: true },
      });
      let ids = new Set(recipients.map((r) => r.contactId));
      if (segment.fromBroadcastFilter === 'no_reply') {
        const replied = await this.repliedContacts(source, recipients);
        ids = new Set([...ids].filter((id) => !replied.has(id)));
      }
      contacts = contacts.filter((c) => ids.has(c.id));
    }
    return contacts.slice(0, MAX_RECIPIENTS);
  }

  private async repliedContacts(broadcast: any, recipients: Array<{ contactId: string; conversationId: string | null }>) {
    const since = broadcast.startedAt ?? broadcast.createdAt;
    const conversationIds = recipients.map((r) => r.conversationId).filter(Boolean) as string[];
    if (!conversationIds.length) return new Set<string>();
    const inbound = await this.prisma.message.findMany({
      where: { conversationId: { in: conversationIds }, direction: 'IN', createdAt: { gt: since } },
      select: { conversationId: true },
    });
    const repliedConversations = new Set(inbound.map((m) => m.conversationId));
    return new Set(recipients.filter((r) => r.conversationId && repliedConversations.has(r.conversationId)).map((r) => r.contactId));
  }

  /** Vista previa: cuántos, cuántos fuera de 24 h y costo estimado de Meta. */
  async preview(user: AuthUser, dto: { segment?: any; integrationId?: string; templateKey?: string }, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const segment = sanitizeSegment(dto?.segment);
    const audience = await this.resolveAudience(scoped, segment);
    let inWindow = 0;
    const now = Date.now();
    if (audience.length) {
      const conversations = await this.prisma.conversation.findMany({
        where: {
          companyId: scoped,
          contactId: { in: audience.map((c) => c.id) },
          ...(dto?.integrationId ? { integrationId: dto.integrationId } : {}),
        },
        select: { id: true, contactId: true },
      });
      const recentIn = conversations.length
        ? await this.prisma.message.findMany({
            where: {
              conversationId: { in: conversations.map((c) => c.id) },
              direction: 'IN',
              createdAt: { gte: new Date(now - 24 * 3600e3) },
            },
            select: { conversationId: true },
          })
        : [];
      const hot = new Set(recentIn.map((m) => conversations.find((c) => c.id === m.conversationId)?.contactId));
      inWindow = audience.filter((c) => hot.has(c.id)).length;
    }
    const outWindow = audience.length - inWindow;
    const rates = parseJson<Record<string, any>>(company.orderConfigJson, {}).metaRatesUsd ?? {};
    const marketingUsd = Number(rates.MARKETING ?? DEFAULT_MARKETING_USD);
    const templates = parseJson<any[]>(company.waTemplatesJson, []);
    const hasTemplate = !!dto?.templateKey && templates.some((t) => t?.key === dto.templateKey && t?.contentSid);
    return {
      count: audience.length,
      inWindow,
      outWindow,
      // Sin plantilla, los de fuera de la ventana se omiten (Meta no lo permite)
      willSkip: hasTemplate ? 0 : outWindow,
      estimatedCostUsd: Math.round((hasTemplate ? outWindow : 0) * marketingUsd * 10000) / 10000,
      sample: audience.slice(0, 6).map((c) => c.name),
      templates: templates.filter((t) => t?.contentSid && (t.category ?? 'MARKETING') === 'MARKETING').map((t) => ({ key: t.key, name: t.name ?? t.key })),
    };
  }

  /* ── CRUD y envío ────────────────────────────────────────────────── */

  async list(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const rows = await this.prisma.broadcast.findMany({
      where: { companyId: scoped },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((b) => ({ ...b, segment: parseJson(b.segmentJson, {}) }));
  }

  async create(user: AuthUser, dto: any, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const name = String(dto?.name ?? '').trim().slice(0, 100);
    const message = String(dto?.message ?? '').trim();
    if (!name) throw new BadRequestException('Ponle un nombre a la campaña');
    if (message.length < 3 || message.length > 1000) throw new BadRequestException('El mensaje debe tener entre 3 y 1.000 caracteres');
    const line = await this.prisma.integration.findFirst({
      where: { id: dto?.integrationId, companyId: scoped, type: 'WHATSAPP' },
    });
    if (!line) throw new BadRequestException('Elige la línea de WhatsApp que envía');
    const scheduledAt = dto?.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (scheduledAt && (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60e3)) {
      throw new BadRequestException('La fecha programada debe ser futura');
    }
    const segment = sanitizeSegment(dto?.segment);
    const preview = await this.preview(user, { segment, integrationId: line.id, templateKey: dto?.templateKey }, scoped);
    const broadcast = await this.prisma.broadcast.create({
      data: {
        companyId: scoped, name, integrationId: line.id, segmentJson: JSON.stringify(segment), message,
        templateKey: dto?.templateKey || null, status: scheduledAt ? 'SCHEDULED' : 'DRAFT', scheduledAt,
        recipientsCount: preview.count, estimatedCostUsd: preview.estimatedCostUsd, createdBy: user.name,
      },
    });
    await this.audit.log({
      actor: user, companyId: scoped, action: 'campaign.create', entity: 'Broadcast', entityId: broadcast.id,
      detail: `${name} · ${preview.count} contactos${scheduledAt ? ` · programada ${scheduledAt.toISOString()}` : ''}`,
    });
    return { ...broadcast, segment, preview };
  }

  private async assertBroadcast(user: AuthUser, id: string) {
    const b = await this.prisma.broadcast.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Campaña no encontrada');
    if (!isPlatformRole(user.role) && b.companyId !== user.companyId) throw new ForbiddenException();
    return b;
  }

  async send(user: AuthUser | null, id: string) {
    const b = user ? await this.assertBroadcast(user, id) : await this.prisma.broadcast.findUniqueOrThrow({ where: { id } });
    if (!['DRAFT', 'SCHEDULED'].includes(b.status)) throw new BadRequestException('Esta campaña ya se envió o se canceló');
    // Claim atómico: dos clics (o el cron y un clic) no la envían dos veces
    const claim = await this.prisma.broadcast.updateMany({
      where: { id: b.id, status: { in: ['DRAFT', 'SCHEDULED'] } },
      data: { status: 'SENDING', startedAt: new Date() },
    });
    if (claim.count === 0) throw new BadRequestException('La campaña ya se está enviando');

    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: b.companyId } });
    const templates = parseJson<any[]>(company.waTemplatesJson, []);
    const template = b.templateKey ? templates.find((t) => t?.key === b.templateKey && t?.contentSid) : null;
    const audience = await this.resolveAudience(b.companyId, parseJson<Segment>(b.segmentJson, {}));
    let queued = 0;
    let skipped = 0;
    for (const contact of audience) {
      let conversation = await this.prisma.conversation.findFirst({
        where: { companyId: b.companyId, contactId: contact.id, integrationId: b.integrationId, status: { in: ['OPEN', 'PENDING', 'HANDOFF'] } },
        orderBy: { lastMessageAt: 'desc' },
      });
      if (!conversation) {
        conversation = await this.prisma.conversation.create({
          data: {
            companyId: b.companyId, contactId: contact.id, integrationId: b.integrationId,
            channel: contact.channel === 'SIMULATOR' ? 'SIMULATOR' : 'WHATSAPP', status: 'OPEN',
          },
        });
      }
      const inWindow = await withinServiceWindow(this.prisma, conversation.id);
      if (!inWindow && !template) {
        await this.prisma.broadcastRecipient.create({
          data: {
            broadcastId: b.id, companyId: b.companyId, contactId: contact.id, conversationId: conversation.id,
            status: 'SKIPPED', skipReason: 'Fuera de la ventana de 24 h y sin plantilla aprobada',
          },
        });
        skipped++;
        continue;
      }
      const text = renderCampaignText(b.message, { nombre: contact.name, empresa: company.name });
      const messageId = await queueBotText(this.prisma, this.outboundQueue, conversation, text, {
        authorName: `Campaña: ${b.name}`.slice(0, 80),
        metaCategory: inWindow ? 'SERVICIO' : 'MARKETING',
        delayMs: queued * SEND_SPACING_MS,
        ...(!inWindow && template
          ? { contentSid: template.contentSid, contentVariables: { '1': String(contact.name ?? '').split(' ')[0] } }
          : {}),
      });
      await this.prisma.broadcastRecipient.create({
        data: { broadcastId: b.id, companyId: b.companyId, contactId: contact.id, conversationId: conversation.id, messageId, status: 'QUEUED' },
      });
      queued++;
    }
    const done = await this.prisma.broadcast.update({
      where: { id: b.id },
      data: { status: 'SENT', finishedAt: new Date(), recipientsCount: queued + skipped },
    });
    await this.audit.log({
      actor: user, companyId: b.companyId, action: 'campaign.send', entity: 'Broadcast', entityId: b.id,
      detail: `${b.name}: ${queued} en cola, ${skipped} omitidos`,
    });
    return { ...done, queued, skipped };
  }

  async cancel(user: AuthUser, id: string) {
    const b = await this.assertBroadcast(user, id);
    if (!['DRAFT', 'SCHEDULED'].includes(b.status)) throw new BadRequestException('Solo se cancela una campaña sin enviar');
    await this.prisma.broadcast.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.log({ actor: user, companyId: b.companyId, action: 'campaign.cancel', entity: 'Broadcast', entityId: id, detail: b.name });
    return { ok: true };
  }

  /** Métricas reales: entrega, lectura, respuestas y ventas atribuidas (72 h). */
  async detail(user: AuthUser, id: string) {
    const b = await this.assertBroadcast(user, id);
    const recipients = await this.prisma.broadcastRecipient.findMany({ where: { broadcastId: id } });
    const messageIds = recipients.map((r) => r.messageId).filter(Boolean) as string[];
    const messages = messageIds.length
      ? await this.prisma.message.findMany({ where: { id: { in: messageIds } }, select: { id: true, deliveryStatus: true } })
      : [];
    const statusOf = new Map(messages.map((m) => [m.id, m.deliveryStatus]));
    const count = (pred: (s?: string | null) => boolean) =>
      recipients.filter((r) => r.messageId && pred(statusOf.get(r.messageId))).length;
    const replied = await this.repliedContacts(b, recipients);
    const since = b.startedAt ?? b.createdAt;
    const orders = recipients.length
      ? await this.prisma.order.findMany({
          where: {
            companyId: b.companyId,
            contactId: { in: recipients.map((r) => r.contactId) },
            createdAt: { gt: since, lt: new Date(since.getTime() + 72 * 3600e3) },
            status: { notIn: ['borrador', 'cancelado'] },
            ...NOT_DELETED,
          },
          select: { id: true, total: true },
        })
      : [];
    return {
      ...b,
      segment: parseJson(b.segmentJson, {}),
      stats: {
        recipients: recipients.length,
        queued: recipients.filter((r) => r.status === 'QUEUED').length,
        skipped: recipients.filter((r) => r.status === 'SKIPPED').length,
        sent: count((s) => ['SENT', 'DELIVERED', 'READ'].includes(s ?? '')),
        delivered: count((s) => ['DELIVERED', 'READ'].includes(s ?? '')),
        read: count((s) => s === 'READ'),
        failed: count((s) => s === 'FAILED'),
        replied: replied.size,
        orders: orders.length,
        revenue: orders.reduce((sum, o) => sum + (o.total ?? 0), 0),
      },
      skipReasons: recipients.filter((r) => r.status === 'SKIPPED').slice(0, 5).map((r) => r.skipReason),
    };
  }

  /** Reenvío: nueva campaña (borrador) a quienes no respondieron. */
  async retarget(user: AuthUser, id: string, dto: { message?: string; name?: string }) {
    const b = await this.assertBroadcast(user, id);
    if (b.status !== 'SENT') throw new BadRequestException('Primero envía la campaña original');
    return this.create(user, {
      name: dto?.name ?? `${b.name} · recordatorio`,
      integrationId: b.integrationId,
      message: dto?.message ?? b.message,
      templateKey: b.templateKey,
      segment: { fromBroadcastId: b.id, fromBroadcastFilter: 'no_reply' },
    }, b.companyId);
  }

  /* ── Cron: campañas programadas + seguimiento automático ─────────── */

  @Cron('*/1 * * * *')
  async dispatchScheduled() {
    if (process.env.JEST_WORKER_ID) return;
    try {
      const due = await this.prisma.broadcast.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
        take: 5,
      });
      for (const b of due) {
        await this.send(null, b.id).catch((err) => this.logger.warn(`campaña ${b.id}: ${err.message}`));
      }
    } catch (err: any) {
      this.logger.warn(`cron de campañas: ${err.message}`);
    }
  }

  @Cron('*/10 * * * *')
  async followUpsCron() {
    if (process.env.JEST_WORKER_ID) return;
    try {
      await this.runFollowUps();
    } catch (err: any) {
      this.logger.warn(`seguimiento automático: ${err.message}`);
    }
  }

  /**
   * Seguimiento automático: por cada regla activa (orderConfig.followUps =
   * [{id, enabled, afterHours, message, when: 'no_reply'|'draft_open'}]) se
   * escribe UNA vez a las conversaciones donde el último mensaje fue del bot
   * hace más de afterHours y el cliente no respondió. Solo dentro de 24 h.
   */
  async runFollowUps(now = new Date()) {
    const companies = await this.prisma.company.findMany({
      where: { status: { in: ['ACTIVE', 'TRIAL'] }, orderConfigJson: { contains: 'followUps' } },
    });
    let sent = 0;
    for (const company of companies) {
      const rules = (parseJson<Record<string, any>>(company.orderConfigJson, {}).followUps ?? [])
        .filter((r: any) => r?.enabled && r?.id && r?.message && Number(r.afterHours) >= 1 && Number(r.afterHours) <= 23);
      if (!rules.length) continue;
      const conversations = await this.prisma.conversation.findMany({
        where: {
          companyId: company.id, status: 'OPEN', botPaused: false, needsAttention: false,
          channel: { in: ['WHATSAPP', 'SIMULATOR'] },
          lastMessageAt: { gte: new Date(now.getTime() - 24 * 3600e3) },
        },
        include: { contact: true },
        take: 500,
      });
      for (const conversation of conversations) {
        if ((conversation as any).contact?.optOut) continue;
        const last = await this.prisma.message.findFirst({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
        });
        if (!last || last.direction !== 'OUT' || last.author !== 'BOT') continue;
        const lastIn = await this.prisma.message.findFirst({
          where: { conversationId: conversation.id, direction: 'IN' },
          orderBy: { createdAt: 'desc' },
        });
        if (!lastIn || now.getTime() - lastIn.createdAt.getTime() >= 24 * 3600e3) continue; // fuera de ventana
        const state = parseJson<Record<string, any>>(conversation.aiStateJson, {});
        const done: Record<string, string> = state.followUps ?? {};
        const hoursIdle = (now.getTime() - last.createdAt.getTime()) / 3600e3;
        for (const rule of rules) {
          // Ya se envió esta regla después del último mensaje del cliente
          if (done[rule.id] && new Date(done[rule.id]) > lastIn.createdAt) continue;
          if (hoursIdle < Number(rule.afterHours)) continue;
          if (rule.when === 'draft_open') {
            const draft = await this.prisma.order.findFirst({
              where: { conversationId: conversation.id, status: 'borrador', ...NOT_DELETED },
            });
            if (!draft) continue;
          }
          await queueBotText(this.prisma, this.outboundQueue, conversation,
            renderCampaignText(rule.message, { nombre: (conversation as any).contact?.name, empresa: company.name }),
            { authorName: 'Seguimiento automático' });
          done[rule.id] = now.toISOString();
          await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: { aiStateJson: JSON.stringify({ ...state, followUps: done }) },
          });
          sent++;
          break; // una regla por pasada y conversación
        }
      }
    }
    return { sent };
  }
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.campaigns.list(user, companyId);
  }

  @Post('preview')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  preview(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.campaigns.preview(user, dto, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.campaigns.create(user, dto, companyId);
  }

  @Get(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.detail(user, id);
  }

  @Post(':id/send')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  send(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.send(user, id);
  }

  @Post(':id/cancel')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.campaigns.cancel(user, id);
  }

  @Post(':id/retarget')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  retarget(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.campaigns.retarget(user, id, dto);
  }
}

@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
