import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Cron } from '@nestjs/schedule';
import { buildOrderPdf } from '../common/pdf';
import twilio from 'twilio';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
  scopeCompanyId,
  NOT_DELETED,
} from '../common/constants';
import { decryptSecret, isEncrypted } from '../common/crypto';
import { AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';
import { validateDelivery } from '../common/agenda';
import type { Queue } from 'bullmq';
import { WA_OUTBOUND_QUEUE } from '../queue/queue.module';
import { EventsService } from './events.module';
import { notifyOrderDispatched } from '../common/customer-notify';
import { newTrackingToken, orderCode, publicWebUrl, trackingUrl } from '../common/tracking';
import { isLatLng, pickCourier } from '../common/geo';
import { Products } from '../auth/products.guard';

/* ═══ Utilidades puras (exportadas para tests) ═══════════════════════ */

/**
 * Transiciones válidas del pedido — explícitas y en un solo lugar.
 * NO se puede saltar de "confirmado" a "despachado".
 * El seguimiento del domiciliario en ruta (GPS, link público con la marca)
 * vive en el módulo de domicilios (delivery.module.ts).
 */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  borrador: ['confirmado', 'cancelado', 'requiere_atencion'],
  confirmado: ['programado', 'cancelado', 'requiere_atencion'],
  programado: ['en_produccion', 'cancelado', 'requiere_atencion'],
  en_produccion: ['listo', 'cancelado', 'requiere_atencion'],
  listo: ['empacado', 'requiere_atencion'],
  empacado: ['despachado', 'requiere_atencion'],
  despachado: ['entregado'],
  entregado: [], // terminal
  cancelado: [], // terminal
  requiere_atencion: ['borrador', 'confirmado', 'cancelado'],
};

export function canTransition(from: string, to: string): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export interface DistributionRule {
  /** Condiciones (todas las presentes deben cumplirse) */
  productId?: string;
  category?: string;
  minQuantity?: number;
  maxQuantity?: number;
  /** Área destino */
  areaId: string;
  priority?: number; // menor = gana primero
}

/**
 * Motor de reglas de distribución: decide el área responsable de un ítem.
 * Reglas por producto, categoría, cantidad o combinación — viven en
 * Company.orderConfigJson.distributionRules (se editan desde el panel).
 * Fallback: el área por defecto del producto.
 */
export function resolveArea(
  rules: DistributionRule[],
  item: { productId?: string | null; quantity: number },
  product?: { category?: string | null; productionAreaId?: string | null } | null,
): string | null {
  const sorted = [...(rules ?? [])].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
  );
  for (const rule of sorted) {
    if (rule.productId && rule.productId !== item.productId) continue;
    if (rule.category && rule.category !== (product?.category ?? '')) continue;
    if (rule.minQuantity != null && item.quantity < rule.minQuantity) continue;
    if (rule.maxQuantity != null && item.quantity > rule.maxQuantity) continue;
    if (!rule.areaId) continue;
    return rule.areaId;
  }
  return product?.productionAreaId ?? null;
}

/** Corte de pedidos: "hasta las HH:MM del día anterior a la entrega". */
export function violatesCutoff(
  orderCutoff: string | undefined,
  deliveryAt: Date,
  now = new Date(),
): boolean {
  if (!orderCutoff) return false;
  const [hours, minutes] = String(orderCutoff).split(':').map(Number);
  const deadline = new Date(deliveryAt);
  deadline.setDate(deadline.getDate() - 1);
  deadline.setHours(hours, minutes || 0, 0, 0);
  return now > deadline;
}

/** Render simple de plantillas: {{variable}} → valor. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

const DEFAULT_REMINDER_TEMPLATES: Record<string, string> = {
  nuevo_pedido:
    'Nuevo pedido de {{cliente}}: {{items}}. Entrega {{fecha}} a las {{hora}}.',
  recordatorio_area:
    'Recordatorio: {{items}} para {{cliente}} — entrega {{fecha}} a las {{hora}}.',
  recordatorio_despacho:
    'Despacho {{fecha}} {{hora}} — {{cliente}}: {{items}}. Dirección: {{direccion}}.',
  recordatorio_cliente:
    'Hola {{contacto}}, te confirmamos tu entrega de hoy a las {{hora}}: {{items}}. ¡Quedamos atentos!',
  feedback_cliente:
    'Hola {{contacto}}, ¿cómo estuvo tu pedido de hoy ({{items}})? Califícanos de 1 a 5 y cuéntanos cualquier detalle. ¡Gracias!',
};

/* ═══ Recordatorios ══════════════════════════════════════════════════ */

@Injectable()
export class RemindersService {
  private readonly logger = new Logger('Reminders');
  private static readonly MAX_ATTEMPTS = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
  ) {}

  /**
   * Programa los recordatorios de un pedido confirmado. IDEMPOTENTE: si el
   * pedido ya tiene recordatorios, no crea duplicados.
   * - Cada área involucrada: notificación inmediata de trabajo nuevo + su
   *   recordatorio con SU anticipación configurada.
   * - Cliente: la mañana de la entrega (hora configurable), vía WhatsApp con
   *   plantilla aprobada (categoría UTILIDAD) si está fuera de la ventana.
   */
  async createForOrder(orderId: string) {
    const existing = await this.prisma.reminder.count({ where: { orderId } });
    if (existing > 0) return { created: 0, skipped: 'ya programados' };

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, customer: true, contact: true },
    });
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: order.companyId },
    });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const templates = { ...DEFAULT_REMINDER_TEMPLATES, ...(cfg.reminderTemplates ?? {}) };
    const now = new Date();
    const notBefore = (date: Date) => (date < now ? new Date(now.getTime() + 60e3) : date);

    const fecha = new Intl.DateTimeFormat('es-CO', {
      timeZone: company.timezone, weekday: 'long', day: 'numeric', month: 'long',
    }).format(order.deliveryAt);
    const hora = new Intl.DateTimeFormat('es-CO', {
      timeZone: company.timezone, hour: '2-digit', minute: '2-digit',
    }).format(order.deliveryAt);
    const address = parseJson<any>(order.deliveryAddressJson, {});

    const areaIds = [...new Set(order.items.map((i) => i.productionAreaId).filter(Boolean))] as string[];
    const areas = await this.prisma.productionArea.findMany({
      where: { id: { in: areaIds } },
    });

    let created = 0;
    for (const area of areas) {
      const areaItems = order.items
        .filter((i) => i.productionAreaId === area.id)
        .map((i) => `${i.quantity} × ${i.productName}${i.specifications ? ` (${i.specifications})` : ''}`)
        .join(', ');
      const isDispatch = /despacho|log[ií]stica/i.test(area.name);
      const vars = {
        cliente: order.customer.name, items: areaItems, fecha, hora,
        direccion: isDispatch ? `${address.address ?? ''}${address.instructions ? ` (${address.instructions})` : ''}` : '',
      };
      const responsible = parseJson<any[]>(area.responsiblesJson, [])[0] ?? { name: area.name };
      const recipient = JSON.stringify({
        name: responsible.name ?? area.name,
        phone: area.notifyTarget ?? responsible.phone,
        email: area.notifyChannel === 'EMAIL' ? area.notifyTarget : responsible.email,
        productionAreaId: area.id,
      });

      // Notificación inmediata: le cayó trabajo
      await this.prisma.reminder.create({
        data: {
          companyId: order.companyId, orderId, kind: isDispatch ? 'DESPACHO' : 'AREA',
          recipientJson: recipient, channel: area.notifyChannel,
          scheduledAt: notBefore(now), templateKey: 'nuevo_pedido',
          bodyRendered: renderTemplate(templates.nuevo_pedido, vars),
        },
      });
      // Recordatorio con la anticipación del área
      await this.prisma.reminder.create({
        data: {
          companyId: order.companyId, orderId, kind: isDispatch ? 'DESPACHO' : 'AREA',
          recipientJson: recipient, channel: area.notifyChannel,
          scheduledAt: notBefore(
            new Date(order.deliveryAt.getTime() - (area.reminderHoursBefore ?? 24) * 3600e3),
          ),
          templateKey: isDispatch ? 'recordatorio_despacho' : 'recordatorio_area',
          bodyRendered: renderTemplate(
            isDispatch ? templates.recordatorio_despacho : templates.recordatorio_area,
            vars,
          ),
        },
      });
      created += 2;
    }

    // Cliente: la mañana de la entrega
    if (order.contact?.phone) {
      const clientHour = Number(cfg.reminderDefaults?.clientSameDayHour ?? 7);
      const clientAt = new Date(order.deliveryAt);
      clientAt.setHours(clientHour, 0, 0, 0);
      const allItems = order.items
        .map((i) => `${i.quantity} × ${i.productName}`)
        .join(', ');
      await this.prisma.reminder.create({
        data: {
          companyId: order.companyId, orderId, kind: 'CLIENTE',
          recipientJson: JSON.stringify({
            name: order.contact.name, phone: order.contact.phone,
            contactId: order.contactId,
          }),
          channel: 'WHATSAPP',
          scheduledAt: notBefore(clientAt),
          templateKey: 'recordatorio_cliente',
          bodyRendered: renderTemplate(templates.recordatorio_cliente, {
            contacto: order.contact.name.split(' ')[0],
            cliente: order.customer.name,
            items: allItems, fecha, hora,
          }),
        },
      });
      created += 1;
    }
    this.logger.log(`Pedido ${orderId}: ${created} recordatorios programados`);
    return { created };
  }

  async cancelForOrder(orderId: string) {
    await this.prisma.reminder.updateMany({
      where: { orderId, status: 'PENDIENTE' },
      data: { status: 'CANCELADO' },
    });
  }

  /**
   * Feedback post-entrega (Fase 6): al marcar "entregado" se programa el
   * mensaje al cliente con la anticipación configurada
   * (orderConfig.feedbackDelayHours, default 3) y se abre el registro
   * Feedback ligado al pedido. IDEMPOTENTE: un pedido pregunta una sola vez.
   */
  async scheduleFeedback(orderId: string) {
    const existing = await this.prisma.feedback.findUnique({ where: { orderId } });
    if (existing) return { skipped: 'ya solicitado' };

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, customer: true, contact: true },
    });
    if (!order.contact?.phone) return { skipped: 'pedido sin contacto con teléfono' };

    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: order.companyId },
    });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const templates = { ...DEFAULT_REMINDER_TEMPLATES, ...(cfg.reminderTemplates ?? {}) };
    const delayHours = Number(cfg.feedbackDelayHours ?? 3);
    const askAt = new Date(Date.now() + delayHours * 3600e3);
    const items = order.items.map((i) => `${i.quantity} × ${i.productName}`).join(', ');

    await this.prisma.feedback.create({
      data: {
        companyId: order.companyId,
        orderId,
        customerId: order.customerId,
        contactId: order.contactId,
        requestedAt: askAt, // la respuesta solo cuenta después de preguntar
        status: 'PENDIENTE',
      },
    });
    await this.prisma.reminder.create({
      data: {
        companyId: order.companyId,
        orderId,
        kind: 'FEEDBACK',
        recipientJson: JSON.stringify({
          name: order.contact.name,
          phone: order.contact.phone,
          contactId: order.contactId,
        }),
        channel: 'WHATSAPP',
        scheduledAt: askAt,
        templateKey: 'feedback_cliente',
        bodyRendered: renderTemplate(templates.feedback_cliente, {
          contacto: order.contact.name.split(' ')[0],
          cliente: order.customer.name,
          items,
        }),
      },
    });
    this.logger.log(`Pedido ${orderId}: feedback programado en ${delayHours} h`);
    return { scheduledAt: askAt };
  }

  /**
   * Despacho de recordatorios vencidos. IDEMPOTENTE: cada recordatorio se
   * "reclama" con una actualización condicional — correr el job dos veces
   * (o en dos instancias) no envía dos mensajes.
   */
  async dispatchDue(): Promise<{ sent: number; failed: number }> {
    const due = await this.prisma.reminder.findMany({
      where: { status: 'PENDIENTE', scheduledAt: { lte: new Date() } },
      take: 100,
    });
    let sent = 0;
    let failed = 0;
    for (const reminder of due) {
      const claimed = await this.prisma.reminder.updateMany({
        where: { id: reminder.id, status: 'PENDIENTE' },
        data: { status: 'PROCESANDO' },
      });
      if (claimed.count !== 1) continue; // otro proceso lo tomó

      try {
        await this.deliver(reminder);
        await this.prisma.reminder.update({
          where: { id: reminder.id },
          data: { status: 'ENVIADO', sentAt: new Date(), lastError: null },
        });
        sent++;
      } catch (err: any) {
        const attempts = (reminder.attempts ?? 0) + 1;
        const exhausted = attempts >= RemindersService.MAX_ATTEMPTS;
        await this.prisma.reminder.update({
          where: { id: reminder.id },
          data: {
            status: exhausted ? 'FALLIDO' : 'PENDIENTE', // vuelve a intentarse
            attempts,
            lastError: err.message,
          },
        });
        if (exhausted) {
          failed++;
          // Alerta: nunca falla en silencio
          await this.audit.log({
            actor: null, companyId: reminder.companyId, action: 'reminder.failed',
            entity: 'Reminder', entityId: reminder.id,
            detail: `${reminder.kind} · ${err.message}`,
          });
        }
      }
    }
    if (sent || failed) this.logger.log(`Recordatorios: ${sent} enviados, ${failed} fallidos`);
    return { sent, failed };
  }

  private async deliver(reminder: any) {
    const recipient = parseJson<Record<string, any>>(reminder.recipientJson, {});
    const body = reminder.bodyRendered ?? '';

    if (reminder.channel === 'PANEL') {
      await this.audit.log({
        actor: null, companyId: reminder.companyId, action: 'reminder.panel',
        entity: 'Reminder', entityId: reminder.id,
        detail: `${recipient.name ?? 'Área'}: ${body.slice(0, 120)}`,
      });
      return;
    }
    if (reminder.channel === 'EMAIL') {
      if (!recipient.email) throw new Error('Destinatario sin correo');
      await this.emails.systemSend({
        companyId: reminder.companyId,
        toEmail: recipient.email,
        subject: `Recordatorio de entrega — ${recipient.name ?? ''}`,
        body: `<p>${body}</p>`,
      });
      return;
    }
    if (reminder.channel === 'WHATSAPP') {
      if (!recipient.phone) throw new Error('Destinatario sin teléfono');
      const line = await this.prisma.integration.findFirst({
        where: { companyId: reminder.companyId, type: 'WHATSAPP' },
      });
      const cfg = parseJson<Record<string, any>>(line?.configJson ?? '{}', {});
      if (cfg.sandbox === true || !cfg.accountSid) {
        // SANDBOX: no sale nada real; queda registrado como enviado simulado
        this.logger.log(`[sandbox] recordatorio → ${recipient.phone}: ${body.slice(0, 60)}`);
        return;
      }
      const authToken = isEncrypted(cfg.authTokenEnc) ? decryptSecret(cfg.authTokenEnc) : '';
      if (!authToken || !cfg.fromNumber) throw new Error('Línea sin credenciales Twilio');
      // Mensaje proactivo (fuera de conversación) → SIEMPRE plantilla aprobada
      const company = await this.prisma.company.findUniqueOrThrow({
        where: { id: reminder.companyId },
      });
      const waTemplates = parseJson<any[]>(company.waTemplatesJson, []);
      const template = waTemplates.find((t) => t.key === reminder.templateKey);
      if (!template?.contentSid) {
        throw new Error(
          `Sin plantilla aprobada de Meta para "${reminder.templateKey}" — configúrala en la organización`,
        );
      }
      const client = twilio(cfg.accountSid, authToken);
      await client.messages.create({
        from: `whatsapp:${cfg.fromNumber}`,
        to: `whatsapp:${recipient.phone}`,
        contentSid: template.contentSid,
        contentVariables: JSON.stringify({ 1: body }),
      });
      // Consumo Meta: los recordatorios proactivos son categoría UTILIDAD
      return;
    }
    throw new Error(`Canal desconocido: ${reminder.channel}`);
  }

  // Job programado: corre cada minuto; es idempotente por el claim condicional
  @Cron('* * * * *')
  async cronDispatch() {
    if (process.env.JEST_WORKER_ID) return;
    await this.dispatchDue().catch((err) =>
      this.logger.error(`dispatchDue: ${err.message}`),
    );
  }
}


/* ═══ Servicio de pedidos ════════════════════════════════════════════ */

@Injectable()
export class OrdersService {
  private readonly logger = new Logger('Orders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reminders: RemindersService,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly outboundQueue?: Queue,
    @Optional() private readonly events?: EventsService,
  ) {}

  private async assertOrder(user: AuthUser, id: string) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order || order.deletedAt) throw new NotFoundException('Pedido no encontrado');
    if (!isPlatformRole(user.role) && order.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return order;
  }

  companyOf(companyId: string) {
    return this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  }

  /**
   * Creación MANUAL de un pedido desde el panel (pedidos por teléfono,
   * presenciales o correcciones). Mismo pipeline que la IA: si se confirma,
   * distribuye, valida agenda y programa recordatorios.
   */
  async createManual(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new BadRequestException('Falta companyId');
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, companyId, ...NOT_DELETED },
    });
    if (!customer) throw new NotFoundException('Cliente no encontrado');
    if (!dto.deliveryAt || Number.isNaN(new Date(dto.deliveryAt).getTime())) {
      throw new BadRequestException('Falta la fecha de entrega');
    }
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('El pedido necesita al menos un ítem');
    }
    const products = await this.prisma.product.findMany({
      where: { companyId, ...NOT_DELETED },
    });

    const order = await this.prisma.order.create({
      data: {
        companyId,
        customerId: customer.id,
        contactId: dto.contactId ?? null,
        status: 'borrador',
        deliveryAt: new Date(dto.deliveryAt),
        deliveryAddressJson: JSON.stringify(dto.deliveryAddress ?? {}),
        observations: dto.observations ?? null,
        takenByType: 'HUMANO',
        takenByName: user.name,
      },
    });
    for (const item of dto.items) {
      const product = products.find((p) => p.id === item.productId) ?? null;
      if (!product && !item.productName) {
        throw new BadRequestException('Cada ítem necesita producto o nombre');
      }
      await this.prisma.orderItem.create({
        data: {
          companyId, orderId: order.id,
          productId: product?.id ?? null,
          productName: product?.name ?? item.productName,
          quantity: Number(item.quantity) || 1,
          unit: item.unit ?? product?.unit ?? 'unidad',
          presentation: item.presentation ?? null,
          specifications: item.specifications ?? null,
          productionAreaId: item.productionAreaId ?? product?.productionAreaId ?? null,
        },
      });
    }
    await this.prisma.orderStatusHistory.create({
      data: {
        companyId, orderId: order.id,
        fromStatus: null, toStatus: 'borrador',
        authorType: 'USUARIO', authorName: user.name,
        reason: 'Creado manualmente desde el panel',
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'order.create_manual',
      entity: 'Order', entityId: order.id, detail: customer.name,
    });

    // Confirmación directa: mismo pipeline que la IA (distribuye + agenda + recordatorios)
    if (dto.confirm) {
      await this.changeStatus(order.id, 'confirmado', { type: 'USUARIO', name: user.name });
    }
    return this.detail(user, order.id);
  }

  async list(user: AuthUser, q: {
    companyId?: string; status?: string; customerId?: string;
    areaId?: string; from?: string; to?: string;
  }) {
    const scoped = scopeCompanyId(user, q.companyId);
    return this.prisma.order.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.areaId ? { items: undefined } : {}), // el filtro por área usa area-view
        ...NOT_DELETED,
        deliveryAt: {
          gte: q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86400e3),
          lte: q.to ? new Date(q.to) : new Date(Date.now() + 60 * 86400e3),
        },
      },
      orderBy: { deliveryAt: 'asc' },
      include: {
        customer: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true, phone: true } },
        items: { include: { productionArea: { select: { id: true, name: true } } } },
      },
      take: 500,
    });
  }

  async detail(user: AuthUser, id: string) {
    await this.assertOrder(user, id);
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: true,
        contact: { select: { id: true, name: true, phone: true } },
        items: { include: { productionArea: { select: { id: true, name: true } } } },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        reminders: { orderBy: { scheduledAt: 'asc' } },
        conversation: { select: { id: true, channel: true } },
        feedback: true,
      },
    });
    if (!order) return order;
    // Domicilio: link público de seguimiento + domiciliario asignado
    const courier = order.courierId
      ? await this.prisma.user.findUnique({
          where: { id: order.courierId },
          select: { id: true, name: true, phone: true, onShift: true, lastLat: true, lastLng: true, lastLocAt: true },
        })
      : null;
    const { trackingToken, deliveryProofFile, ...rest } = order as any;
    return {
      ...rest,
      code: orderCode(order.id),
      trackingUrl: trackingToken ? trackingUrl(await publicWebUrl(this.prisma), trackingToken) : null,
      hasDeliveryProof: !!deliveryProofFile,
      courier,
    };
  }

  /** Vista de calendario: entregas agrupadas por día con carga por franja. */
  async calendar(user: AuthUser, companyId?: string, from?: string, to?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    const start = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
    const end = to ? new Date(to) : new Date(start.getTime() + 14 * 86400e3);
    const [orders, company] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          companyId: scoped, ...NOT_DELETED,
          status: { notIn: ['cancelado'] },
          deliveryAt: { gte: start, lte: end },
        },
        orderBy: { deliveryAt: 'asc' },
        include: {
          customer: { select: { name: true } },
          items: { select: { productName: true, quantity: true } },
        },
      }),
      this.prisma.company.findUniqueOrThrow({ where: { id: scoped } }),
    ]);
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const byDay = new Map<string, any[]>();
    for (const order of orders) {
      const key = order.deliveryAt.toISOString().slice(0, 10);
      byDay.set(key, [...(byDay.get(key) ?? []), order]);
    }
    return {
      maxPerSlot: cfg.maxPerSlot ?? null,
      slots: cfg.slots ?? [],
      days: [...byDay.entries()].map(([date, dayOrders]) => ({
        date,
        total: dayOrders.length,
        orders: dayOrders,
      })),
    };
  }

  /**
   * Validación de agenda completa: reglas puras (día/horario/anticipación/
   * festivos) + corte de pedidos + capacidad por franja. Devuelve alternativas.
   */
  async validateAgenda(
    companyId: string,
    deliveryAt: Date,
    excludeOrderId?: string,
  ): Promise<{ ok: boolean; reason?: string; alternatives: Date[] }> {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});

    const check = async (candidate: Date): Promise<string | null> => {
      const base = validateDelivery(cfg, candidate);
      if (!base.ok) return base.reason ?? 'Fuera de reglas';
      if (violatesCutoff(cfg.orderCutoff, candidate)) {
        return `El corte de pedidos es a las ${cfg.orderCutoff} del día anterior`;
      }
      if (cfg.maxPerSlot && Array.isArray(cfg.slots) && cfg.slots.length) {
        const hhmm = (v: string) => {
          const [h, m] = String(v).split(':').map(Number);
          return h * 60 + (m || 0);
        };
        const minutes = candidate.getHours() * 60 + candidate.getMinutes();
        const slot = cfg.slots.find(
          (s: any) => minutes >= hhmm(s.from) && minutes <= hhmm(s.to),
        );
        if (slot) {
          const dayStart = new Date(candidate); dayStart.setHours(0, 0, 0, 0);
          const dayEnd = new Date(dayStart.getTime() + 86400e3);
          const sameSlot = await this.prisma.order.findMany({
            where: {
              companyId, ...NOT_DELETED,
              status: { in: ['confirmado', 'programado', 'en_produccion', 'listo', 'empacado', 'despachado'] },
              deliveryAt: { gte: dayStart, lt: dayEnd },
              ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
            },
            select: { deliveryAt: true },
          });
          const count = sameSlot.filter((o) => {
            const m = o.deliveryAt.getHours() * 60 + o.deliveryAt.getMinutes();
            return m >= hhmm(slot.from) && m <= hhmm(slot.to);
          }).length;
          if (count >= Number(cfg.maxPerSlot)) {
            return `La franja "${slot.label ?? slot.key}" de ese día ya está llena (${count}/${cfg.maxPerSlot})`;
          }
        }
      }
      return null;
    };

    const reason = await check(deliveryAt);
    if (!reason) return { ok: true, alternatives: [] };

    // Propuesta de alternativas: mismas horas, próximos días válidos
    const alternatives: Date[] = [];
    for (let offset = 1; offset <= 14 && alternatives.length < 3; offset++) {
      const candidate = new Date(deliveryAt.getTime() + offset * 86400e3);
      if (!(await check(candidate))) alternatives.push(candidate);
    }
    return { ok: false, reason, alternatives };
  }

  /** Cambio de estado con transiciones explícitas + trazabilidad. */
  async changeStatus(
    orderId: string,
    to: string,
    author: { type: 'IA' | 'USUARIO' | 'SISTEMA'; name: string },
    reason?: string,
  ) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!canTransition(order.status, to)) {
      throw new BadRequestException(
        `Transición inválida: ${order.status} → ${to}. Válidas: ${(ORDER_TRANSITIONS[order.status] ?? []).join(', ') || 'ninguna (estado terminal)'}`,
      );
    }
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: to,
        ...(to === 'despachado' ? { dispatchedAt: new Date() } : {}),
        ...(to === 'entregado' ? { deliveredAt: new Date() } : {}),
      },
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        companyId: order.companyId, orderId,
        fromStatus: order.status, toStatus: to,
        authorType: author.type, authorName: author.name, reason,
      },
    });
    // Reglas automáticas colgadas de estados
    if (to === 'confirmado') await this.runConfirmationPipeline(orderId, author);
    if (to === 'cancelado') await this.reminders.cancelForOrder(orderId);
    if (to === 'entregado') await this.reminders.scheduleFeedback(orderId);
    if (to === 'listo' && !order.courierId) {
      await this.autoAssignCourier(orderId).catch((err) =>
        this.logger.warn(`asignación automática falló (${orderId}): ${err.message}`),
      );
    }
    if (to === 'despachado') {
      // Aviso "va en camino" con el link de seguimiento (nunca rompe el flujo)
      try {
        const notice = await notifyOrderDispatched(this.prisma, this.outboundQueue, orderId);
        if (!notice.sent) {
          await this.audit.log({
            actor: null, companyId: order.companyId, action: 'delivery.notify_skipped',
            entity: 'Order', entityId: orderId, detail: notice.reason,
          });
        }
      } catch (err: any) {
        this.logger.warn(`aviso de despacho falló (${orderId}): ${err.message}`);
      }
    }
    this.events?.emit(order.companyId, { type: 'order.status', orderId, status: to });
    return updated;
  }

  /**
   * Domicilios con asignación automática (orderConfig.delivery.autoAssign):
   * al quedar "listo", se asigna el domiciliario en turno con menos pedidos
   * activos y más cerca del punto de despacho (o de la sucursal del pedido).
   */
  async autoAssignCourier(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: order.companyId } });
    const delivery = parseJson<Record<string, any>>(company.orderConfigJson, {}).delivery ?? {};
    if (!delivery.enabled || !delivery.autoAssign || order.courierId) return null;
    const [couriers, active, branch] = await Promise.all([
      this.prisma.user.findMany({ where: { companyId: order.companyId, role: ROLES.COMPANY_COURIER, active: true, onShift: true } }),
      this.prisma.order.findMany({
        where: { companyId: order.companyId, status: { in: ['listo', 'empacado', 'despachado'] }, courierId: { not: null }, ...NOT_DELETED },
        select: { courierId: true },
      }),
      order.branchId ? this.prisma.branch.findUnique({ where: { id: order.branchId } }) : null,
    ]);
    const loads = new Map<string, number>();
    for (const o of active) if (o.courierId) loads.set(o.courierId, (loads.get(o.courierId) ?? 0) + 1);
    const origin = branch ?? (isLatLng(delivery.origin) ? delivery.origin : null);
    const courier = pickCourier(couriers, loads, origin);
    if (!courier) return null;
    // Condicional: si alguien lo asignó a mano en el mismo instante, se respeta
    const claim = await this.prisma.order.updateMany({ where: { id: orderId, courierId: null }, data: { courierId: courier.id } });
    if (claim.count === 0) return null;
    await this.audit.log({
      actor: null, companyId: order.companyId, action: 'delivery.auto_assign', entity: 'Order', entityId: orderId,
      detail: `#${orderCode(orderId)} → ${courier.name} (${loads.get(courier.id) ?? 0} activos)`,
    });
    this.events?.emit(order.companyId, { type: 'delivery.updated', orderId });
    return courier;
  }

  /**
   * Pipeline de confirmación — lo que convierte la conversación en operación:
   * 1) distribuye cada ítem a su área (motor de reglas),
   * 2) valida agenda (si falla → requiere_atencion, nunca "acepta y después falla"),
   * 3) programa recordatorios para áreas, despacho y cliente,
   * 4) notifica a las áreas que les cayó trabajo,
   * 5) pasa el pedido a "programado".
   */
  async runConfirmationPipeline(
    orderId: string,
    author: { type: 'IA' | 'USUARIO' | 'SISTEMA'; name: string },
  ) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true, customer: true, contact: true },
    });

    // 1) Distribución a áreas por reglas configurables
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: order.companyId },
    });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const rules: DistributionRule[] = Array.isArray(cfg.distributionRules)
      ? cfg.distributionRules
      : [];
    const products = await this.prisma.product.findMany({
      where: { companyId: order.companyId },
    });
    for (const item of order.items) {
      const product = products.find((p) => p.id === item.productId) ?? null;
      const areaId = resolveArea(rules, item, product);
      if (areaId && areaId !== item.productionAreaId) {
        await this.prisma.orderItem.update({
          where: { id: item.id },
          data: { productionAreaId: areaId },
        });
        item.productionAreaId = areaId;
      }
    }

    // 2) Agenda (capacidad + corte + reglas base)
    const agenda = await this.validateAgenda(order.companyId, order.deliveryAt, order.id);
    if (!agenda.ok) {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'requiere_atencion' },
      });
      await this.prisma.orderStatusHistory.create({
        data: {
          companyId: order.companyId, orderId,
          fromStatus: 'confirmado', toStatus: 'requiere_atencion',
          authorType: 'SISTEMA', authorName: 'Agenda automática',
          reason: agenda.reason,
        },
      });
      await this.audit.log({
        actor: null, companyId: order.companyId, action: 'order.agenda_conflict',
        entity: 'Order', entityId: orderId, detail: agenda.reason,
      });
      return { scheduled: false, reason: agenda.reason };
    }

    // 3 + 4) Recordatorios (idempotente) y notificación inmediata a áreas
    await this.reminders.createForOrder(orderId);

    // 5) confirmado → programado (automático) + link público de seguimiento
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'programado', ...(order.trackingToken ? {} : { trackingToken: newTrackingToken() }) },
    });
    await this.prisma.orderStatusHistory.create({
      data: {
        companyId: order.companyId, orderId,
        fromStatus: 'confirmado', toStatus: 'programado',
        authorType: 'SISTEMA', authorName: 'Agenda automática',
      },
    });
    return { scheduled: true };
  }

  /** Edición manual con registro de quién cambió qué. */
  async edit(user: AuthUser, orderId: string, dto: any) {
    const order = await this.assertOrder(user, orderId);
    const changes: string[] = [];
    const data: Record<string, any> = {};
    if (dto.deliveryAt && new Date(dto.deliveryAt).getTime() !== order.deliveryAt.getTime()) {
      data.deliveryAt = new Date(dto.deliveryAt);
      changes.push(`entrega → ${new Date(dto.deliveryAt).toLocaleString('es-CO')}`);
    }
    if (dto.deliveryAddress) {
      data.deliveryAddressJson = JSON.stringify(dto.deliveryAddress);
      changes.push('dirección de entrega');
    }
    if (dto.observations !== undefined && dto.observations !== order.observations) {
      data.observations = dto.observations;
      changes.push('observaciones');
    }
    if (dto.correctedAfterAi === true && !order.correctedAfterAi) {
      data.correctedAfterAi = true; // alimenta el indicador de precisión de la IA
      changes.push('marcado como corregido tras la IA');
    }
    if (Array.isArray(dto.items)) {
      await this.prisma.orderItem.deleteMany({ where: { orderId } });
      const products = await this.prisma.product.findMany({
        where: { companyId: order.companyId },
      });
      for (const item of dto.items) {
        const product = products.find((p) => p.id === item.productId) ?? null;
        await this.prisma.orderItem.create({
          data: {
            companyId: order.companyId, orderId,
            productId: product?.id ?? null,
            productName: product?.name ?? item.productName,
            quantity: Number(item.quantity),
            unit: item.unit ?? product?.unit ?? 'unidad',
            presentation: item.presentation ?? null,
            specifications: item.specifications ?? null,
            productionAreaId: item.productionAreaId ?? product?.productionAreaId ?? null,
          },
        });
      }
      changes.push('ítems del pedido');
    }
    if (Object.keys(data).length) {
      await this.prisma.order.update({ where: { id: orderId }, data });
    }
    if (changes.length) {
      await this.prisma.orderStatusHistory.create({
        data: {
          companyId: order.companyId, orderId,
          fromStatus: order.status, toStatus: order.status,
          authorType: 'USUARIO', authorName: user.name,
          reason: `Edición manual: ${changes.join(', ')}`,
        },
      });
      await this.audit.log({
        actor: user, companyId: order.companyId, action: 'order.edit',
        entity: 'Order', entityId: orderId, detail: changes.join(', '),
      });
    }
    return this.detail(user, orderId);
  }

  /** Vista por área: SOLO sus ítems y solo la información que necesita. */
  async areaView(user: AuthUser, companyId?: string, areaId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    // Un usuario de área queda clavado a SU área
    const effectiveAreaId = user.role === ROLES.COMPANY_AREA
      ? (await this.prisma.user.findUnique({ where: { id: user.id } }))?.productionAreaId
      : areaId;
    if (!effectiveAreaId) throw new BadRequestException('Falta el área');

    const area = await this.prisma.productionArea.findFirst({
      where: { id: effectiveAreaId, companyId: scoped },
    });
    if (!area) throw new NotFoundException('Área no encontrada');
    const includeAddress = /despacho|log[ií]stica/i.test(area.name);

    const items = await this.prisma.orderItem.findMany({
      where: {
        companyId: scoped,
        productionAreaId: effectiveAreaId,
        order: {
          ...NOT_DELETED,
          status: { in: ['programado', 'en_produccion', 'listo', 'empacado'] },
        },
      },
      include: {
        order: {
          select: {
            id: true, status: true, deliveryAt: true, observations: true,
            deliveryAddressJson: true,
            customer: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 300,
    });

    return {
      area: { id: area.id, name: area.name },
      items: items
        .sort((a, b) => a.order.deliveryAt.getTime() - b.order.deliveryAt.getTime())
        .map((item) => ({
          id: item.id,
          orderId: item.order.id,
          orderStatus: item.order.status,
          deliveryAt: item.order.deliveryAt,
          customer: item.order.customer.name,
          productName: item.productName,
          quantity: item.quantity,
          unit: item.unit,
          presentation: item.presentation,
          specifications: item.specifications,
          observations: item.observations,
          areaStatus: item.areaStatus,
          // La dirección SOLO la ven despacho/logística
          ...(includeAddress
            ? { deliveryAddress: parseJson<any>(item.order.deliveryAddressJson, {}) }
            : {}),
        })),
    };
  }

  /** El área marca su parte como lista; si todas están listas → pedido "listo". */
  async markItemReady(user: AuthUser, itemId: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: true },
    });
    if (!item) throw new NotFoundException('Ítem no encontrado');
    if (!isPlatformRole(user.role) && item.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    if (user.role === ROLES.COMPANY_AREA) {
      const dbUser = await this.prisma.user.findUnique({ where: { id: user.id } });
      if (dbUser?.productionAreaId !== item.productionAreaId) {
        throw new ForbiddenException('Este ítem no pertenece a tu área');
      }
    }
    await this.prisma.orderItem.update({
      where: { id: itemId },
      data: { areaStatus: 'lista', areaReadyAt: new Date() },
    });
    // Regla automática: todas las áreas listas → pedido "listo"
    const siblings = await this.prisma.orderItem.findMany({
      where: { orderId: item.orderId },
    });
    const allReady = siblings.every(
      (s) => s.id === itemId || s.areaStatus === 'lista',
    );
    if (allReady && item.order.status === 'en_produccion') {
      await this.changeStatus(item.orderId, 'listo', {
        type: 'SISTEMA', name: 'Todas las áreas reportaron listo',
      });
    }
    return { ok: true, allReady };
  }
}

/* ═══ Controllers ════════════════════════════════════════════════════ */

@Products('AUTOMATION')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('customerId') customerId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.orders.list(user, { companyId, status, customerId, from, to });
  }

  @Get('calendar')
  calendar(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.orders.calendar(user, companyId, from, to);
  }

  @Get('area-view')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER, ROLES.COMPANY_AREA)
  areaView(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('areaId') areaId?: string,
  ) {
    return this.orders.areaView(user, companyId, areaId);
  }

  /** Creación manual desde el panel (teléfono/presencial). */
  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  createManual(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.orders.createManual(user, dto);
  }

  /** Orden de pedido en PDF con la identidad de la marca. */
  @Get(':id/pdf')
  async pdf(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const order = await this.orders.detail(user, id); // valida tenant
    const company = await this.orders.companyOf(order!.companyId);
    const buffer = await buildOrderPdf(company, order);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="pedido-${String(id).slice(-6)}.pdf"`,
    );
    res.send(buffer);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.detail(user, id);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  edit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.orders.edit(user, id, dto);
  }

  @Post(':id/status')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: { status: string; reason?: string },
  ) {
    await this.orders.detail(user, id); // valida tenant
    return this.orders.changeStatus(id, dto.status, { type: 'USUARIO', name: user.name }, dto.reason);
  }

  @Post('items/:itemId/ready')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_AREA)
  markReady(@CurrentUser() user: AuthUser, @Param('itemId') itemId: string) {
    return this.orders.markItemReady(user, itemId);
  }
}

@Products('AUTOMATION')
@Controller('reminders')
export class RemindersController {
  constructor(
    private readonly reminders: RemindersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
  ) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.reminder.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { scheduledAt: 'asc' },
      include: { order: { select: { id: true, customer: { select: { name: true } } } } },
      take: 300,
    });
  }

  /** Disparo manual del job (también corre solo cada minuto). */
  @Post('dispatch')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  dispatch() {
    return this.reminders.dispatchDue();
  }
}

@Module({
  imports: [EmailsModule],
  controllers: [OrdersController, RemindersController],
  providers: [OrdersService, RemindersService],
  exports: [OrdersService, RemindersService],
})
export class OrdersModule {}
