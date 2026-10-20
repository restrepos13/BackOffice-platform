import { originFromTwilio, originUpdates } from '../common/chat-origin';
import {
  Body,
  Controller,
  Headers,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { mirrorFile } from '../common/file-store';
import { entryStageFor } from '../common/pipelines';
import { Queue, Worker } from 'bullmq';
import type { Request, Response } from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import twilio from 'twilio';
import { isLatLng } from '../common/geo';
import { applyConsent, queueBotText } from '../common/customer-notify';
import { MetaLineConfig, metaLineConfig, sendMetaText } from '../common/meta';
import { PrismaService } from '../prisma/prisma.service';
import { reportIncident } from '../common/incidents';
import { Public } from '../auth/decorators';
import { SkipThrottle } from '@nestjs/throttler';
import { parseJson } from '../common/constants';
import { decryptSecret, isEncrypted } from '../common/crypto';
import { inferSentiment, isDissatisfied, parseRating } from '../common/feedback';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import {
  ENGINE_QUEUE,
  WA_INBOUND_QUEUE,
  WA_OUTBOUND_QUEUE,
  redisConnection,
} from '../queue/queue.module';

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

/** Tarifas estimadas de Meta por categoría (USD/mensaje) — configurables por
 *  organización en orderConfigJson.metaRatesUsd. La categoría SERVICIO
 *  (respuestas dentro de la ventana de 24 h) no tiene costo por mensaje. */
const DEFAULT_META_RATES: Record<string, number> = {
  SERVICIO: 0,
  UTILIDAD: 0.008,
  MARKETING: 0.0325,
};

const DELIVERY_MAP: Record<string, string> = {
  queued: 'QUEUED',
  accepted: 'QUEUED',
  sending: 'SENT',
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
  undelivered: 'FAILED',
};

export interface TwilioLineConfig {
  provider: string;
  accountSid: string;
  authToken: string; // ya descifrado
  fromNumber: string; // +57…
  sandbox: boolean;
}

/** Ventana de servicio de 24 h de WhatsApp: dentro → mensaje libre; fuera →
 *  solo plantilla aprobada. Se calcula con el último mensaje ENTRANTE. */
export function isWithinServiceWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < 24 * 3600 * 1000;
}

/** Ubicación compartida por WhatsApp (Twilio: Latitude/Longitude/Address/Label). */
export function parseSharedLocation(
  payload: Record<string, any>,
): { lat: number; lng: number; content: string } | null {
  if (payload.Latitude == null || payload.Longitude == null) return null;
  const lat = Number(payload.Latitude);
  const lng = Number(payload.Longitude);
  if (!isLatLng({ lat, lng })) return null;
  const place = [payload.Label, payload.Address].filter(Boolean).join(' — ');
  return { lat, lng, content: `[ubicación] ${place || `${lat.toFixed(5)}, ${lng.toFixed(5)}`}` };
}

export function mapMediaType(contentType: string | undefined): {
  type: string;
  ext: string;
} {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('audio/')) return { type: 'AUDIO', ext: ct.includes('ogg') ? 'ogg' : 'mp3' };
  if (ct.startsWith('image/')) return { type: 'IMAGE', ext: ct.includes('png') ? 'png' : 'jpg' };
  if (ct.startsWith('video/')) return { type: 'DOCUMENT', ext: 'mp4' };
  return { type: 'DOCUMENT', ext: ct.includes('pdf') ? 'pdf' : 'bin' };
}

@Injectable()
export class TwilioService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Twilio');
  private workers: Worker[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(WA_INBOUND_QUEUE) private readonly inboundQueue: Queue,
    @Inject(WA_OUTBOUND_QUEUE) private readonly outboundQueue: Queue,
    @Inject(ENGINE_QUEUE) private readonly engineQueue: Queue,
    @Optional() private readonly events?: EventsService,
  ) {}

  /* ── Resolución de línea y credenciales (cifradas por organización) ── */

  lineConfig(integration: any): TwilioLineConfig | null {
    const config = parseJson<Record<string, any>>(integration?.configJson, {});
    if (config.provider !== 'TWILIO') return null;
    let authToken = '';
    if (isEncrypted(config.authTokenEnc)) {
      try {
        authToken = decryptSecret(config.authTokenEnc);
      } catch {
        this.logger.error(`No se pudo descifrar el token de la línea ${integration.id}`);
      }
    }
    return {
      provider: 'TWILIO',
      accountSid: config.accountSid ?? '',
      authToken,
      fromNumber: config.fromNumber ?? '',
      sandbox: config.sandbox === true,
    };
  }

  async resolveLine(slug: string, toOrFrom: string | undefined) {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    if (!company) return { company: null, line: null };
    const lines = await this.prisma.integration.findMany({
      where: { companyId: company.id, type: 'WHATSAPP' },
    });
    const phone = (toOrFrom ?? '').replace('whatsapp:', '').replace(/\s/g, '');
    const line =
      lines.find((l) => {
        const cfg = parseJson<Record<string, any>>(l.configJson, {});
        return cfg.fromNumber && phone.includes(String(cfg.fromNumber).replace(/\s/g, ''));
      }) ??
      lines.find((l) => parseJson<Record<string, any>>(l.configJson, {}).provider === 'TWILIO') ??
      lines[0] ??
      null;
    return { company, line };
  }

  /** Valida la firma X-Twilio-Signature contra la URL pública configurada. */
  async validateSignature(
    authToken: string,
    signature: string | undefined,
    path: string,
    params: Record<string, any>,
  ): Promise<boolean> {
    if (!authToken || !signature) return false;
    const base = await this.publicBaseUrl();
    return twilio.validateRequest(authToken, signature, `${base}${path}`, params ?? {});
  }

  private async publicBaseUrl(): Promise<string> {
    const row = await this.prisma.platformSetting.findUnique({
      where: { key: 'WEBHOOK_BASE_URL' },
    });
    return (row?.value || 'http://localhost:4001').replace(/\/$/, '');
  }

  /* ── Encolar trabajo (el webhook responde 200 de inmediato) ── */

  async enqueueInbound(companyId: string, lineId: string | null, payload: Record<string, any>) {
    await this.inboundQueue.add(
      'inbound',
      { companyId, lineId, payload },
      { attempts: 3, backoff: { type: 'exponential', delay: 3000 } },
    );
  }

  /** Encola el envío de un mensaje ya persistido (con reintentos y backoff). */
  async enqueueOutbound(job: {
    messageId: string;
    delayMs?: number;
    metaCategory?: string;
    contentSid?: string;
    contentVariables?: Record<string, string>;
  }) {
    await this.outboundQueue.add('outbound', job, {
      delay: job.delayMs ?? 0,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
    });
  }

  /* ── Workers ── */

  onModuleInit() {
    if (process.env.JEST_WORKER_ID) return; // en tests no se levantan workers
    const connection = redisConnection();

    const inboundWorker = new Worker(
      'wa-inbound',
      async (job) => this.processInbound(job.data),
      { connection },
    );
    inboundWorker.on('failed', (job, err) => {
      this.logger.error(`wa-inbound job ${job?.id}: ${err.message}`);
      void reportIncident(this.prisma, { companyId: (job?.data as any)?.companyId ?? null, kind: 'INBOUND_FAILED', detail: err.message });
    });
    this.workers.push(
      inboundWorker,
      new Worker(
        'wa-outbound',
        async (job) => this.processOutbound(job.data),
        { connection },
      ),
    );
    const outboundWorker = this.workers[1];
    outboundWorker.on('failed', async (job, err) => {
      if (!job || (job.attemptsMade ?? 0) < (job.opts.attempts ?? 1)) return;
      // Reintentos agotados: el mensaje NO se pierde en silencio
      await this.markSendFailed(job.data.messageId, err.message);
    });
    this.logger.log('Workers de WhatsApp arriba (wa-inbound, wa-outbound)');
  }

  async onApplicationShutdown() {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
  }

  /* ── Entrante: idempotente por MessageSid, multimedia, dispara el motor ── */

  async processInbound(data: { companyId: string; lineId: string | null; payload: Record<string, any> }) {
    const { companyId, lineId, payload } = data;
    const sid: string | undefined = payload.MessageSid ?? payload.SmsMessageSid;
    if (!sid) return { skipped: 'sin MessageSid' };

    // Idempotencia: los reintentos de Twilio no duplican nada
    const existing = await this.prisma.message.findFirst({ where: { providerId: sid } });
    if (existing) return { skipped: 'duplicado', messageId: existing.id };

    const line = lineId
      ? await this.prisma.integration.findUnique({ where: { id: lineId } })
      : null;
    const phone = String(payload.From ?? '').replace('whatsapp:', '');
    const profileName = payload.ProfileName || phone;

    let contact = await this.prisma.contact.findFirst({
      where: { companyId, phone },
    });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: { companyId, name: profileName, phone, channel: 'WHATSAPP', ...(await entryStageFor(this.prisma, companyId)) },
      });
    }

    let conversation = await this.prisma.conversation.findFirst({
      where: {
        companyId,
        contactId: contact.id,
        ...(line ? { integrationId: line.id } : {}),
        status: { in: ['OPEN', 'PENDING', 'HANDOFF'] },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          companyId,
          contactId: contact.id,
          integrationId: line?.id ?? null,
          botId: line?.botId ?? null,
          channel: 'WHATSAPP',
          status: 'OPEN',
        },
      });
    }
    // De dónde llegó (anuncio de Meta, publicación o directo)
    const origin = originUpdates(originFromTwilio(payload), conversation, contact, isNewConversation);
    if (origin.conversation) conversation = await this.prisma.conversation.update({ where: { id: conversation.id }, data: origin.conversation });
    if (origin.contact) contact = await this.prisma.contact.update({ where: { id: contact.id }, data: origin.contact });

    // Multimedia: se descarga con las credenciales de la línea y queda en el panel
    let type = 'TEXT';
    let fileName: string | null = null;
    const numMedia = Number(payload.NumMedia ?? 0);
    if (numMedia > 0 && payload.MediaUrl0) {
      const mapped = mapMediaType(payload.MediaContentType0);
      type = mapped.type;
      const creds = line ? this.lineConfig(line) : null;
      if (creds?.accountSid && creds.authToken) {
        try {
          const res = await fetch(payload.MediaUrl0, {
            headers: {
              Authorization:
                'Basic ' + Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64'),
            },
          });
          if (res.ok) {
            const buffer = Buffer.from(await res.arrayBuffer());
            const dir = join(UPLOADS_DIR, companyId);
            mkdirSync(dir, { recursive: true });
            fileName = `${randomBytes(16).toString('hex')}.${mapped.ext}`;
            writeFileSync(join(dir, fileName), buffer);
            await mirrorFile(this.prisma, companyId, fileName, buffer);
          }
        } catch (err: any) {
          this.logger.warn(`descarga de media falló: ${err.message}`);
        }
      }
    }

    // Ubicación compartida (clip > Ubicación): Twilio manda Latitude/Longitude
    const location = parseSharedLocation(payload);
    if (location) type = 'LOCATION';

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'IN',
        author: 'CONTACT',
        content: location
          ? location.content
          : payload.Body ?? (type !== 'TEXT' ? `[${type.toLowerCase()} recibido]` : ''),
        type,
        fileName,
        providerId: sid,
        ...(location ? { latitude: location.lat, longitude: location.lng } : {}),
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        unreadCount: { increment: 1 },
        status: 'OPEN',
      },
    });
    await this.prisma.contact.update({
      where: { id: contact.id },
      data: { lastActivityAt: new Date() },
    });
    this.events?.emit(companyId, {
      type: 'message.new',
      conversationId: conversation.id,
      direction: 'IN',
    });

    // Baja / re-alta de mensajes promocionales: determinista, sin pasar por la IA
    if (type === 'TEXT' && payload.Body) {
      const consent = await this.handleConsent(contact, conversation, String(payload.Body));
      if (consent) return { messageId: message.id, conversationId: conversation.id, consent };
    }

    // Feedback post-entrega (Fase 6): si este contacto tiene una encuesta
    // abierta ya preguntada, el mensaje ES la respuesta — no pasa por el motor
    if (type === 'TEXT') {
      const captured = await this.captureFeedback(
        companyId, contact.id, conversation.id, payload.Body ?? '',
      );
      if (captured) {
        return { messageId: message.id, conversationId: conversation.id, feedback: true };
      }
    }

    // Agrupación de mensajes consecutivos: job demorado deduplicado por conversación
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    const grace = Number(
      parseJson<Record<string, any>>(company?.orderConfigJson ?? '{}', {}).groupingSeconds ?? 6,
    );
    const jobId = `conv-${conversation.id}`; // BullMQ no permite ':' en jobIds
    const pending = await this.engineQueue.getJob(jobId);
    if (pending) await pending.remove().catch(() => undefined);
    await this.engineQueue.add(
      'process',
      { conversationId: conversation.id },
      { jobId, delay: grace * 1000 },
    );

    return { messageId: message.id, conversationId: conversation.id };
  }

  /**
   * "STOP" / "no más mensajes" → el contacto sale de campañas y seguimientos
   * (se le confirma). "ALTA" lo vuelve a incluir. Devuelve qué pasó o null.
   */
  handleConsent(contact: any, conversation: any, body: string) {
    return applyConsent(this.prisma, this.outboundQueue, contact, conversation, body);
  }

  /**
   * Registra la respuesta de una encuesta post-entrega abierta (Fase 6).
   * Solo cuenta si ya se preguntó (requestedAt en el pasado, ventana de 7 días).
   * Insatisfacción (rating ≤ 3 o sentimiento negativo) → alerta inmediata.
   */
  async captureFeedback(
    companyId: string,
    contactId: string,
    conversationId: string,
    body: string,
  ): Promise<boolean> {
    if (!body.trim()) return false;
    const now = new Date();
    const pending = await this.prisma.feedback.findFirst({
      where: {
        companyId,
        contactId,
        // PENDIENTE ya implica sin respuesta (⚠️ Mongo: null no matchea ausentes)
        status: 'PENDIENTE',
        requestedAt: { lte: now, gte: new Date(now.getTime() - 7 * 86400e3) },
      },
      orderBy: { requestedAt: 'desc' },
      include: { order: { select: { id: true } }, customer: { select: { name: true } } },
    });
    if (!pending) return false;

    const rating = parseRating(body);
    const sentiment = inferSentiment(body, rating);
    const dissatisfied = isDissatisfied(rating, sentiment);
    await this.prisma.feedback.update({
      where: { id: pending.id },
      data: {
        respondedAt: now,
        rating,
        comment: body.trim(),
        sentiment,
        status: 'RESPONDIDO',
        alerted: dissatisfied,
      },
    });
    await this.audit.log({
      actor: null, companyId, action: 'feedback.received',
      entity: 'Feedback', entityId: pending.id,
      detail: `${(pending as any).customer?.name ?? 'Cliente'} · ${rating != null ? `${rating}/5` : 'sin rating'} · ${sentiment}`,
    });

    if (dissatisfied) {
      // Cliente insatisfecho: el equipo se entera YA, la IA no interviene
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { needsAttention: true, botPaused: true },
      });
      await this.audit.log({
        actor: null, companyId, action: 'feedback.alert',
        entity: 'Order', entityId: pending.orderId,
        detail: `Insatisfacción reportada (${rating != null ? `${rating}/5` : sentiment}): ${body.slice(0, 120)}`,
      });
      this.events?.emit(companyId, {
        type: 'conversation.updated',
        conversationId,
        needsAttention: true,
        botPaused: true,
      });
    }
    // Cliente feliz (4 o 5) → se le invita a dejar la reseña en Google
    if (!dissatisfied && rating != null && rating >= 4) {
      const company = await this.prisma.company.findUnique({ where: { id: companyId } });
      if (company?.googleReviewUrl) {
        const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
        const text = String(cfg.reviewMessage || '¡Gracias por tu calificación! Nos ayudarías muchísimo con una reseña en Google: {{link}}')
          .replace(/\{\{\s*link\s*\}\}/g, company.googleReviewUrl);
        const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
        if (conversation) {
          await queueBotText(this.prisma, this.outboundQueue, conversation, text.includes(company.googleReviewUrl) ? text : `${text} ${company.googleReviewUrl}`,
            { authorName: 'Reseñas', delayMs: 4000 });
          await this.prisma.feedback.update({ where: { id: pending.id }, data: { reviewRequested: true } }).catch(() => undefined);
        }
      }
    }
    this.events?.emit(companyId, { type: 'feedback.new', orderId: pending.orderId });
    return true;
  }

  /* ── Saliente: ventana 24h, plantillas, sandbox, categoría Meta ── */

  async processOutbound(data: {
    messageId: string;
    metaCategory?: string;
    contentSid?: string;
    contentVariables?: Record<string, string>;
  }): Promise<Record<string, any>> {
    const message = await this.prisma.message.findUnique({
      where: { id: data.messageId },
      include: { conversation: { include: { contact: true, integration: true, company: true } } },
    });
    if (!message || message.direction !== 'OUT') return { skipped: 'mensaje inválido' };
    if (['SENT', 'DELIVERED', 'READ'].includes(message.deliveryStatus ?? '')) {
      return { skipped: 'ya enviado' }; // idempotencia del worker
    }
    const conversation: any = message.conversation;
    // Instagram / Messenger / WhatsApp Cloud API: salen por la Graph API de Meta
    const meta = metaLineConfig(conversation.integration);
    if (meta || ['INSTAGRAM', 'MESSENGER'].includes(conversation.channel)) {
      return this.processMetaOutbound(message, conversation, meta, data);
    }
    const creds = this.lineConfig(conversation.integration);
    if (!creds) {
      throw new Error('La línea no tiene configuración de Twilio');
    }
    if (!creds.sandbox && !creds.fromNumber) {
      throw new Error('La línea no tiene número de Twilio configurado');
    }

    // Ventana de 24 h: fuera de ella SOLO se permite plantilla aprobada
    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId: conversation.id, direction: 'IN' },
      orderBy: { createdAt: 'desc' },
    });
    const within = isWithinServiceWindow(lastInbound?.createdAt ?? null);
    if (!within && !data.contentSid) {
      await this.markSendFailed(
        message.id,
        'Fuera de la ventana de 24 h y sin plantilla aprobada (contentSid)',
        false,
      );
      return { failed: 'fuera de ventana' };
    }

    const category = data.metaCategory ?? (within ? 'SERVICIO' : 'UTILIDAD');
    const rates = {
      ...DEFAULT_META_RATES,
      ...parseJson<Record<string, any>>(conversation.company.orderConfigJson, {}).metaRatesUsd,
    };
    const metaCostUsd = Number(rates[category] ?? 0);

    let providerId: string | null = null;
    if (creds.sandbox || !creds.accountSid || !creds.authToken) {
      // SANDBOX: jamás sale un mensaje real; se marca enviado y se registra
      providerId = `SANDBOX_${randomBytes(8).toString('hex')}`;
      this.logger.log(`[sandbox] ${conversation.company.slug} → ${conversation.contact.phone}: ${message.content.slice(0, 60)}`);
    } else {
      const client = twilio(creds.accountSid, creds.authToken);
      const base = await this.publicBaseUrl();
      const sent = await client.messages.create({
        from: `whatsapp:${creds.fromNumber}`,
        to: `whatsapp:${conversation.contact.phone}`,
        ...(data.contentSid
          ? {
              contentSid: data.contentSid,
              contentVariables: JSON.stringify(data.contentVariables ?? {}),
            }
          : message.mediaAssetId
            ? { body: message.content || undefined, mediaUrl: [] as string[] }
            : { body: message.content }),
        statusCallback: `${base}/api/webhooks/${conversation.company.slug}/twilio/status`,
      });
      providerId = sent.sid;
    }

    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        providerId,
        deliveryStatus: 'SENT',
        metaCategory: category,
        metaCostUsd,
      },
    });
    this.events?.emit(conversation.companyId, {
      type: 'message.status',
      conversationId: conversation.id,
      messageId: message.id,
      deliveryStatus: 'SENT',
    });
    return { sid: providerId, category };
  }

  /** Envío por Meta (ventana de 24 h; en sandbox o sin token no sale nada real). */
  private async processMetaOutbound(message: any, conversation: any, meta: MetaLineConfig | null, data: { metaCategory?: string }) {
    const within = isWithinServiceWindow(
      (await this.prisma.message.findFirst({ where: { conversationId: conversation.id, direction: 'IN' }, orderBy: { createdAt: 'desc' } }))?.createdAt ?? null,
    );
    if (!within) {
      await this.markSendFailed(message.id, 'Fuera de la ventana de 24 h (Meta no permite escribir primero por este canal)', false);
      return { failed: 'fuera de ventana' };
    }
    let providerId: string;
    if (!meta || meta.sandbox) {
      providerId = `SANDBOX_${randomBytes(8).toString('hex')}`;
      this.logger.log(`[sandbox ${conversation.channel}] ${conversation.company.slug}: ${message.content.slice(0, 60)}`);
    } else {
      const recipient = conversation.channel === 'WHATSAPP'
        ? conversation.contact.phone
        : String(conversation.contact.externalId ?? '').split(':').pop();
      const sent = await sendMetaText({ channel: conversation.channel, config: meta, recipient, text: message.content });
      providerId = sent.id;
    }
    await this.prisma.message.update({
      where: { id: message.id },
      data: { providerId, deliveryStatus: 'SENT', metaCategory: data.metaCategory ?? 'SERVICIO', metaCostUsd: 0 },
    });
    this.events?.emit(conversation.companyId, { type: 'message.status', conversationId: conversation.id, messageId: message.id, deliveryStatus: 'SENT' });
    return { sid: providerId, channel: conversation.channel };
  }

  private async markSendFailed(messageId: string, reason: string, retryable = true) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (!message) return;
    await this.prisma.message.update({
      where: { id: messageId },
      data: { deliveryStatus: 'FAILED' },
    });
    // Alerta en el panel: la conversación queda marcada y el hecho auditado
    await this.prisma.conversation.update({
      where: { id: message.conversationId },
      data: { needsAttention: true },
    });
    await this.audit.log({
      actor: null,
      companyId: (message.conversation as any).companyId,
      action: 'twilio.send_failed',
      entity: 'Message',
      entityId: messageId,
      detail: `${retryable ? 'Reintentos agotados' : 'Rechazado'}: ${reason}`,
    });
    this.logger.error(`Envío fallido (${messageId}): ${reason}`);
    await reportIncident(this.prisma, { companyId: (message.conversation as any).companyId, kind: 'WA_SEND_FAILED', detail: reason });
    this.events?.emit((message.conversation as any).companyId, {
      type: 'conversation.updated',
      conversationId: message.conversationId,
      needsAttention: true,
    });
  }

  /* ── Estados de entrega (status callback) ── */

  async processStatus(companyId: string, payload: Record<string, any>) {
    const sid = payload.MessageSid;
    const status = DELIVERY_MAP[String(payload.MessageStatus ?? '').toLowerCase()];
    if (!sid || !status) return { skipped: true };
    const message = await this.prisma.message.findFirst({
      where: { providerId: sid },
      include: { conversation: true },
    });
    if (!message || (message.conversation as any).companyId !== companyId) {
      return { skipped: 'mensaje desconocido' };
    }
    // READ no se degrada a DELIVERED por callbacks fuera de orden
    const order = ['QUEUED', 'SENT', 'DELIVERED', 'READ'];
    const current = order.indexOf(message.deliveryStatus ?? '');
    const incoming = order.indexOf(status);
    if (status !== 'FAILED' && incoming !== -1 && incoming < current) {
      return { skipped: 'estado anterior' };
    }
    await this.prisma.message.update({
      where: { id: message.id },
      data: { deliveryStatus: status },
    });
    this.events?.emit(companyId, {
      type: 'message.status',
      conversationId: message.conversationId,
      messageId: message.id,
      deliveryStatus: status,
    });
    if (status === 'FAILED') {
      await this.markSendFailed(
        message.id,
        `Twilio reportó ${payload.MessageStatus} (${payload.ErrorCode ?? 'sin código'})`,
        false,
      );
    }
    return { ok: true, status };
  }
}

/* ─── Webhooks públicos de Twilio ────────────────────────────────────── */

@Public()
@SkipThrottle()
@Controller('webhooks')
export class TwilioWebhooksController {
  private readonly logger = new Logger('TwilioWebhook');

  constructor(private readonly twilioService: TwilioService) {}

  /** Mensajes entrantes. Firma validada; 200 inmediato; trabajo a la cola. */
  @Post(':slug/twilio')
  async inbound(
    @Param('slug') slug: string,
    @Body() body: Record<string, any>,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { company, line } = await this.twilioService.resolveLine(slug, body?.To);
    if (!company || !line) {
      res.status(200).send('<Response></Response>'); // sin reintentos de Twilio
      return;
    }
    const creds = this.twilioService.lineConfig(line);
    const valid = await this.twilioService.validateSignature(
      creds?.authToken ?? '',
      signature,
      req.originalUrl,
      body,
    );
    if (!valid && !creds?.sandbox) {
      this.logger.warn(`firma inválida para ${slug}`);
      res.status(403).send('firma inválida');
      return;
    }
    await this.twilioService.enqueueInbound(company.id, line.id, body);
    res.status(200).type('text/xml').send('<Response></Response>');
  }

  /** Estados de entrega (enviado/entregado/leído/fallido). */
  @Post(':slug/twilio/status')
  async status(
    @Param('slug') slug: string,
    @Body() body: Record<string, any>,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const { company, line } = await this.twilioService.resolveLine(slug, body?.From);
    if (!company || !line) {
      res.status(200).send('ok');
      return;
    }
    const creds = this.twilioService.lineConfig(line);
    const valid = await this.twilioService.validateSignature(
      creds?.authToken ?? '',
      signature,
      req.originalUrl,
      body,
    );
    if (!valid && !creds?.sandbox) {
      res.status(403).send('firma inválida');
      return;
    }
    await this.twilioService.processStatus(company.id, body);
    res.status(200).send('ok');
  }
}

@Module({
  controllers: [TwilioWebhooksController],
  providers: [TwilioService],
  exports: [TwilioService],
})
export class TwilioModule {}
