import { isProductionHost } from '../common/team-notify';
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
import { SendError, classifySendError, sanitizeError, shouldApplyStatus } from '../common/inbox/delivery';
import { claimInbound, releaseInbound } from '../common/inbox/dedupe';
import { PrismaService } from '../prisma/prisma.service';
import { contactCreated } from '../common/domain-events';
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
  queuePrefix,
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

/** ¿La URL del archivo es de Twilio? (https y dominio twilio.com / twiliocdn.com) */
export function isTwilioMediaUrl(raw: unknown): boolean {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' && !u.username && !u.password && /(^|\.)(twilio\.com|twiliocdn\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
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
      { connection, ...queuePrefix() },
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
        { connection, ...queuePrefix() },
      ),
    );
    const outboundWorker = this.workers[1];
    outboundWorker.on('failed', async (job, err) => {
      if (!job || (job.attemptsMade ?? 0) < (job.opts.attempts ?? 1)) return;
      await this.onOutboundExhausted(job.data.messageId, err.message);
    });
    this.logger.log('Workers de WhatsApp arriba (wa-inbound, wa-outbound)');
  }

  async onApplicationShutdown() {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
  }

  /* ── Entrante: idempotente por MessageSid, multimedia, dispara el motor ── */

  async processInbound(data: { companyId: string; lineId: string | null; payload: Record<string, any> }): Promise<Record<string, any>> {
    const sid: string | undefined = data.payload.MessageSid ?? data.payload.SmsMessageSid;
    if (!sid) return { skipped: 'sin MessageSid' };
    // Idempotencia: los reintentos de Twilio no duplican nada (ni dos webhooks simultáneos)
    const existing = await this.prisma.message.findFirst({ where: { providerId: sid } });
    if (existing) return { skipped: 'duplicado', messageId: existing.id };
    if (!(await claimInbound(this.prisma, data.companyId, 'TWILIO', sid))) return { skipped: 'duplicado' };
    try {
      return await this.handleInbound(data, sid);
    } catch (err) {
      // Falló a mitad: se suelta el recibo para que el reintento sí lo procese
      await releaseInbound(this.prisma, 'TWILIO', sid);
      throw err;
    }
  }

  private async handleInbound(data: { companyId: string; lineId: string | null; payload: Record<string, any> }, sid: string) {
    const { companyId, lineId, payload } = data;

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
      await contactCreated(companyId, contact.id);
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
      // Las credenciales de Twilio SOLO viajan a servidores de Twilio (nunca a una URL cualquiera del mensaje)
      if (creds?.accountSid && creds.authToken && isTwilioMediaUrl(payload.MediaUrl0)) {
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
    const status = message.deliveryStatus ?? '';
    if (['SENT', 'DELIVERED', 'READ', 'SIMULATED', 'CANCELLED', 'FAILED', 'UNCERTAIN'].includes(status)) {
      return { skipped: status === 'UNCERTAIN' ? 'resultado incierto: decide una persona' : ['SENT', 'DELIVERED', 'READ', 'SIMULATED'].includes(status) ? 'ya enviado' : 'ya procesado' }; // idempotencia del worker
    }
    if (status === 'SENDING') {
      // Un intento anterior empezó y no terminó: pudo haber salido. No se reenvía solo.
      const started = message.sendStartedAt ? new Date(message.sendStartedAt).getTime() : 0;
      // Otro proceso lo tiene en curso: se reintenta más tarde (el job vuelve con espera)
      if (Date.now() - started < 2 * 60e3) throw new Error('Envío en curso en otro proceso');
      await this.markUncertain(message, 'El intento anterior se interrumpió sin confirmación del proveedor: pudo haber salido.');
      return { uncertain: true };
    }
    const conversation: any = message.conversation;
    // Respuesta del bot preparada ANTES de que una persona tomara la conversación: se retira
    if (message.author === 'BOT' && conversation.botPaused && conversation.modeChangedAt && new Date(conversation.modeChangedAt) > new Date(message.createdAt)) {
      await this.prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: 'CANCELLED', deliveryError: 'Un agente tomó la conversación antes de que saliera esta respuesta del bot.' } });
      this.events?.emit(conversation.companyId, { type: 'message.status', conversationId: conversation.id, messageId: message.id, deliveryStatus: 'CANCELLED' });
      return { cancelled: 'modo humano' };
    }
    // Instagram / Messenger / WhatsApp Cloud API: salen por la Graph API de Meta
    const meta = metaLineConfig(conversation.integration);
    if (meta || ['INSTAGRAM', 'MESSENGER'].includes(conversation.channel)) {
      return this.processMetaOutbound(message, conversation, meta, data);
    }
    const creds = this.lineConfig(conversation.integration);
    if (!creds) {
      await this.markSendFailed(message.id, 'La línea no tiene configuración de Twilio', false);
      return { failed: 'sin configuración' };
    }
    if (!creds.sandbox && !creds.fromNumber) {
      await this.markSendFailed(message.id, 'La línea no tiene número de Twilio configurado', false);
      return { failed: 'sin número' };
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

    if (!(await this.claimSend(message.id))) return { skipped: 'otro proceso lo está enviando' };
    if (creds.sandbox || !creds.accountSid || !creds.authToken) {
      // SANDBOX: jamás sale un mensaje real. Queda SIMULATED (no "enviado") para no engañar a nadie
      const providerId = `SANDBOX_${randomBytes(8).toString('hex')}`;
      this.logger.log(`[sandbox] ${conversation.company.slug} → mensaje ${message.id} (no enviado)`);
      await this.finishSend(conversation, message.id, { providerId, deliveryStatus: 'SIMULATED', metaCategory: category, metaCostUsd });
      return { sid: providerId, category, simulated: true };
    }
    let providerId: string;
    try {
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
      if (!sent?.sid) throw new SendError('UNCERTAIN', 'Twilio respondió sin el identificador del mensaje');
      providerId = sent.sid;
    } catch (err) {
      return this.handleSendError(message, conversation, err);
    }
    await this.finishSend(conversation, message.id, { providerId, deliveryStatus: 'SENT', metaCategory: category, metaCostUsd });
    return { sid: providerId, category };
  }

  /** Envío por Meta (ventana de 24 h; en sandbox o sin token no sale nada real). */
  private async processMetaOutbound(message: any, conversation: any, meta: MetaLineConfig | null, data: { metaCategory?: string; contentSid?: string }) {
    if (data.contentSid) {
      await this.markSendFailed(message.id, 'Las plantillas por WhatsApp Cloud API de Meta aún no están disponibles en BackOffice', false);
      return { failed: 'plantilla no soportada' };
    }
    const within = isWithinServiceWindow(
      (await this.prisma.message.findFirst({ where: { conversationId: conversation.id, direction: 'IN' }, orderBy: { createdAt: 'desc' } }))?.createdAt ?? null,
    );
    if (!within) {
      await this.markSendFailed(message.id, 'Fuera de la ventana de 24 h (Meta no permite escribir primero por este canal)', false);
      return { failed: 'fuera de ventana' };
    }
    if (!(await this.claimSend(message.id))) return { skipped: 'otro proceso lo está enviando' };
    if (!meta || meta.sandbox) {
      const providerId = `SANDBOX_${randomBytes(8).toString('hex')}`;
      this.logger.log(`[sandbox ${conversation.channel}] ${conversation.company.slug}: mensaje ${message.id} (no enviado)`);
      await this.finishSend(conversation, message.id, { providerId, deliveryStatus: 'SIMULATED', metaCategory: data.metaCategory ?? 'SERVICIO', metaCostUsd: 0 });
      return { sid: providerId, channel: conversation.channel, simulated: true };
    }
    let providerId: string;
    try {
      const recipient = conversation.channel === 'WHATSAPP'
        ? conversation.contact.phone
        : String(conversation.contact.externalId ?? '').split(':').pop();
      providerId = (await this.sendMeta({ channel: conversation.channel, config: meta, recipient, text: message.content })).id;
    } catch (err) {
      return this.handleSendError(message, conversation, err);
    }
    await this.finishSend(conversation, message.id, { providerId, deliveryStatus: 'SENT', metaCategory: data.metaCategory ?? 'SERVICIO', metaCostUsd: 0 });
    return { sid: providerId, channel: conversation.channel };
  }

  /** Reemplazable en pruebas: envío real por la Graph API de Meta. */
  sendMeta: typeof sendMetaText = (input) => sendMetaText(input);

  /** Toma el mensaje para enviarlo (QUEUED → SENDING): dos workers no lo envían dos veces. */
  private async claimSend(messageId: string) {
    const r = await this.prisma.message.updateMany({ where: { id: messageId, deliveryStatus: 'QUEUED' }, data: { deliveryStatus: 'SENDING', sendStartedAt: new Date() } });
    return r.count === 1;
  }

  private async finishSend(conversation: any, messageId: string, data: { providerId: string; deliveryStatus: string; metaCategory: string; metaCostUsd: number }) {
    await this.prisma.message.update({ where: { id: messageId }, data: { ...data, deliveryError: data.deliveryStatus === 'SIMULATED' ? 'Modo prueba: el mensaje no salió a ningún cliente' : null } });
    this.events?.emit(conversation.companyId, { type: 'message.status', conversationId: conversation.id, messageId, deliveryStatus: data.deliveryStatus });
  }

  /** Decide según el resultado: reintentar (429), fallido (rechazo), incierto (sin respuesta). */
  private async handleSendError(message: any, conversation: any, err: unknown): Promise<Record<string, any>> {
    const e = classifySendError(err);
    if (e.outcome === 'RETRYABLE') {
      // El proveedor lo rechazó por límite: es seguro reintentar (BullMQ con espera creciente)
      await this.prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: 'QUEUED', deliveryError: e.message } });
      throw e;
    }
    if (e.outcome === 'UNCERTAIN') {
      await this.markUncertain(message, e.message);
      return { uncertain: true };
    }
    if (e.outcome === 'AUTH' && conversation.integration) {
      // Las credenciales dejaron de servir: el canal lo muestra (sin tocar las credenciales)
      const cfg = parseJson<Record<string, any>>(conversation.integration.configJson, {});
      await this.prisma.integration.update({
        where: { id: conversation.integration.id },
        data: { configJson: JSON.stringify({ ...cfg, verification: { ok: false, at: new Date().toISOString(), kind: 'AUTH', message: e.message } }) },
      });
    }
    await this.markSendFailed(message.id, e.message, false);
    return { failed: e.outcome };
  }

  /**
   * Reintentos agotados: el mensaje NO se pierde en silencio. Si nunca se
   * empezó a enviar (QUEUED) es un fallo; si quedó a medio enviar (SENDING),
   * es incierto: pudo haber salido.
   */
  async onOutboundExhausted(messageId: string, reason: string) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, include: { conversation: true } });
    if (!m) return;
    if (m.deliveryStatus === 'QUEUED') await this.markSendFailed(messageId, reason);
    else if (m.deliveryStatus === 'SENDING') await this.markUncertain(m, `Reintentos agotados con el envío a medias: ${sanitizeError(reason)}`);
  }

  /** No se sabe si salió: no se reintenta solo (podría duplicarse). Una persona decide. */
  private async markUncertain(message: any, reason: string) {
    const companyId = (message.conversation as any).companyId;
    await this.prisma.message.update({ where: { id: message.id }, data: { deliveryStatus: 'UNCERTAIN', deliveryError: reason } });
    await this.prisma.conversation.update({ where: { id: message.conversationId }, data: { needsAttention: true } });
    await this.audit.log({ actor: null, companyId, action: 'message.send_uncertain', entity: 'Message', entityId: message.id, detail: reason });
    this.events?.emit(companyId, { type: 'message.status', conversationId: message.conversationId, messageId: message.id, deliveryStatus: 'UNCERTAIN' });
  }

  private async markSendFailed(messageId: string, reason: string, retryable = true) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (!message) return;
    const clean = sanitizeError(reason);
    await this.prisma.message.update({
      where: { id: messageId },
      data: { deliveryStatus: 'FAILED', deliveryError: clean },
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
      detail: `${retryable ? 'Reintentos agotados' : 'Rechazado'}: ${clean}`,
    });
    this.logger.error(`Envío fallido (${messageId}): ${clean}`);
    await reportIncident(this.prisma, { companyId: (message.conversation as any).companyId, kind: 'WA_SEND_FAILED', detail: clean });
    this.events?.emit((message.conversation as any).companyId, {
      type: 'message.status',
      conversationId: message.conversationId,
      messageId,
      deliveryStatus: 'FAILED',
    });
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
    // READ no se degrada a DELIVERED por callbacks fuera de orden (ni se repite el mismo)
    if (!shouldApplyStatus(message.deliveryStatus, status)) {
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
    // Sin firma válida no entra nada. La excepción "sandbox" solo existe en un
    // computador de pruebas: en producción permitiría inyectar mensajes falsos.
    if (!valid && !(creds?.sandbox && !isProductionHost())) {
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
    if (!valid && !(creds?.sandbox && !isProductionHost())) {
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
