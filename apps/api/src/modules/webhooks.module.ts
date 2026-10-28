import { isProductionHost } from '../common/team-notify';
import { ChatOrigin, originFromMeta, originUpdates } from '../common/chat-origin';
import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { entryStageFor } from '../common/pipelines';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { contactCreated } from '../common/domain-events';
import { Public } from '../auth/decorators';
import { parseJson } from '../common/constants';
import { ENGINE_QUEUE, WA_OUTBOUND_QUEUE } from '../queue/queue.module';
import { applyConsent } from '../common/customer-notify';
import { parseMessagingEvents, verifyMetaSignature } from '../common/meta';
import { parseLeadgenEvents } from '../common/ads/leads';
import { claimInbound, releaseInbound } from '../common/inbox/dedupe';
import { sanitizeError, shouldApplyStatus } from '../common/inbox/delivery';
import { AdLeadsService } from './ads-leads';
import { AdsModule } from './ads.module';
import { EventsService } from './events.module';

/**
 * Receptores de Meta por empresa (públicos, responden 200 siempre):
 *   GET/POST /api/webhooks/:slug/whatsapp → WhatsApp Cloud API
 *   GET/POST /api/webhooks/:slug/meta     → Instagram y Messenger
 * Verificación: hub.challenge con META_VERIFY_TOKEN; firma X-Hub-Signature-256
 * con META_APP_SECRET (obligatoria si está configurado). Los mensajes entran
 * al MISMO motor que Twilio (cola engine, agrupación, baja "STOP").
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhooks');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ENGINE_QUEUE) private readonly engineQueue?: Queue,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly outboundQueue?: Queue,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly leads?: AdLeadsService,
  ) {}

  private async setting(key: string): Promise<string> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    return row?.value ?? process.env[key] ?? '';
  }

  async verify(mode: string, token: string, challenge: string): Promise<string> {
    const expected = await this.setting('META_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token === expected) return challenge;
    throw new UnauthorizedException('Token de verificación inválido');
  }

  /**
   * La firma de Meta (X-Hub-Signature-256 con META_APP_SECRET) es obligatoria.
   * Sin secret configurado, en producción se rechaza todo: si no, cualquiera
   * podría inyectar mensajes haciéndose pasar por un cliente. Solo un
   * computador de pruebas acepta mensajes sin firma.
   */
  async assertSignature(raw: Buffer | undefined, signature: string | undefined) {
    const secret = await this.setting('META_APP_SECRET');
    if (!secret) {
      if (isProductionHost()) throw new UnauthorizedException('META_APP_SECRET no configurado: webhooks de Meta rechazados');
      return;
    }
    if (!verifyMetaSignature(raw, signature, secret)) {
      throw new UnauthorizedException('Firma de Meta inválida');
    }
  }

  /** Guarda un mensaje entrante y lo pasa al motor (o resuelve la baja). */
  private async store(input: {
    companyId: string; line: any; channel: 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
    providerId: string; contactKey: { phone?: string; externalId?: string }; name: string; text: string; type: string;
    origin?: ChatOrigin | null;
  }) {
    // Idempotencia: los reintentos de Meta no duplican nada (ni dos webhooks simultáneos)
    const dup = await this.prisma.message.findFirst({ where: { providerId: input.providerId } });
    if (dup) return false;
    if (!(await claimInbound(this.prisma, input.companyId, input.channel, input.providerId))) return false;
    try {
      return await this.storeClaimed(input);
    } catch (err) {
      // Falló a mitad: se suelta el recibo para que el reintento de Meta sí entre
      await releaseInbound(this.prisma, input.channel, input.providerId);
      throw err;
    }
  }

  private async storeClaimed(input: {
    companyId: string; line: any; channel: 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
    providerId: string; contactKey: { phone?: string; externalId?: string }; name: string; text: string; type: string;
    origin?: ChatOrigin | null;
  }) {
    let contact = await this.prisma.contact.findFirst({
      where: { companyId: input.companyId, ...(input.contactKey.phone ? { phone: input.contactKey.phone } : { externalId: input.contactKey.externalId }) },
    });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          companyId: input.companyId, name: input.name, channel: input.channel, ...(await entryStageFor(this.prisma, input.companyId)),
          ...(input.contactKey.phone ? { phone: input.contactKey.phone } : { externalId: input.contactKey.externalId }),
        },
      });
      await contactCreated(input.companyId, contact.id);
    }
    let conversation = await this.prisma.conversation.findFirst({
      where: {
        companyId: input.companyId, contactId: contact.id,
        ...(input.line ? { integrationId: input.line.id } : {}),
        status: { in: ['OPEN', 'PENDING', 'HANDOFF'] },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    const isNewConversation = !conversation;
    if (!conversation) {
      conversation = await this.prisma.conversation.create({
        data: {
          companyId: input.companyId, contactId: contact.id, integrationId: input.line?.id ?? null,
          botId: input.line?.botId ?? null, channel: input.channel, status: 'OPEN',
        },
      });
    }
    // De dónde llegó (anuncio de Meta, publicación o directo)
    const origin = originUpdates(input.origin ?? null, conversation, contact, isNewConversation);
    if (origin.conversation) conversation = await this.prisma.conversation.update({ where: { id: conversation.id }, data: origin.conversation });
    if (origin.contact) contact = await this.prisma.contact.update({ where: { id: contact.id }, data: origin.contact });
    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id, direction: 'IN', author: 'CONTACT',
        content: input.text, type: input.type === 'IMAGE' ? 'IMAGE' : 'TEXT', providerId: input.providerId,
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), unreadCount: { increment: 1 }, status: 'OPEN' },
    });
    await this.prisma.contact.update({ where: { id: contact.id }, data: { lastActivityAt: new Date() } });
    this.events?.emit(input.companyId, { type: 'message.new', conversationId: conversation.id, direction: 'IN' });

    if (input.type === 'TEXT' && (await applyConsent(this.prisma, this.outboundQueue, contact, conversation, input.text))) {
      return true;
    }
    if (this.engineQueue) {
      // Agrupación de mensajes seguidos: job demorado deduplicado por conversación
      const jobId = `conv-${conversation.id}`;
      const pending = await this.engineQueue.getJob(jobId);
      if (pending) await pending.remove().catch(() => undefined);
      await this.engineQueue.add('process', { conversationId: conversation.id }, { jobId, delay: 6000 });
    } else {
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: { needsAttention: true } });
    }
    void message;
    return true;
  }

  /** WhatsApp Cloud API. */
  async ingestWhatsapp(slug: string, body: any) {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    if (!company) {
      this.logger.warn(`Webhook para empresa desconocida: ${slug}`);
      return { ok: false };
    }
    const lines = await this.prisma.integration.findMany({ where: { companyId: company.id, type: 'WHATSAPP' } });
    let stored = 0;
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        // Estados de entrega de lo que enviamos (sent → delivered → read, o failed)
        for (const st of value?.statuses ?? []) await this.applyWhatsappStatus(company.id, st);
        if (!value?.messages?.length) continue;
        const phoneNumberId = value?.metadata?.phone_number_id;
        const line = lines.find((l) => parseJson<Record<string, string>>(l.configJson, {}).phoneNumberId === phoneNumberId) ?? lines[0] ?? null;
        for (const message of value.messages) {
          const waId: string = message.from ?? 'desconocido';
          const phone = waId.startsWith('+') ? waId : `+${waId}`;
          const name = value?.contacts?.find((c: any) => c.wa_id === message.from)?.profile?.name ?? phone;
          const text = message.type === 'text' ? (message.text?.body ?? '') : `[${message.type ?? 'contenido'} recibido]`;
          if (await this.store({
            companyId: company.id, line, channel: 'WHATSAPP', providerId: String(message.id ?? `wa_${Date.now()}`),
            contactKey: { phone }, name, text, type: message.type === 'image' ? 'IMAGE' : 'TEXT',
            origin: originFromMeta(message),
          })) stored++;
        }
      }
    }
    return { ok: true, stored };
  }

  /**
   * Estado de un mensaje saliente por WhatsApp Cloud API. Solo cambia mensajes
   * de ESTA empresa, nunca retrocede (un "delivered" tardío no pisa un "read")
   * y un aviso repetido no hace nada.
   */
  async applyWhatsappStatus(companyId: string, st: any) {
    const map: Record<string, string> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
    const status = map[String(st?.status ?? '').toLowerCase()];
    if (!st?.id || !status) return false;
    const message = await this.prisma.message.findFirst({ where: { providerId: String(st.id) }, include: { conversation: true } });
    if (!message || (message.conversation as any).companyId !== companyId) return false;
    if (!shouldApplyStatus(message.deliveryStatus, status)) return false;
    const err = st?.errors?.[0];
    await this.prisma.message.update({
      where: { id: message.id },
      data: { deliveryStatus: status, ...(status === 'FAILED' ? { deliveryError: sanitizeError(`Meta: ${err?.title ?? err?.message ?? 'falló'}${err?.code ? ` (${err.code})` : ''}`) } : {}) },
    });
    if (status === 'FAILED') await this.prisma.conversation.update({ where: { id: message.conversationId }, data: { needsAttention: true } });
    this.events?.emit(companyId, { type: 'message.status', conversationId: message.conversationId, messageId: message.id, deliveryStatus: status });
    return true;
  }

  /** Instagram y Messenger (objeto "instagram" o "page"), y formularios de Lead Ads (campo "leadgen"). */
  async ingestMeta(slug: string, body: any) {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    if (!company) return { ok: false };
    const leadEvents = parseLeadgenEvents(body);
    const leads = leadEvents.length && this.leads ? await this.leads.ingest(company.id, leadEvents) : undefined;
    const events = parseMessagingEvents(body);
    if (!events.length) return { ok: true, stored: 0, ...(leads ? { leads } : {}) };
    const integrations = await this.prisma.integration.findMany({
      where: { companyId: company.id, type: { in: ['INSTAGRAM', 'MESSENGER'] } },
    });
    let stored = 0;
    for (const ev of events) {
      const line = integrations.find((i) => {
        const cfg = parseJson<Record<string, string>>(i.configJson, {});
        return i.type === ev.channel && (cfg.pageId === ev.accountId || cfg.igUserId === ev.accountId);
      }) ?? integrations.find((i) => i.type === ev.channel) ?? null;
      if (!line) continue; // canal no conectado en esta empresa
      if (await this.store({
        companyId: company.id, line, channel: ev.channel, providerId: ev.mid,
        contactKey: { externalId: `${ev.channel}:${ev.senderId}` },
        name: ev.channel === 'INSTAGRAM' ? 'Cliente de Instagram' : 'Cliente de Messenger',
        text: ev.text, type: ev.type,
      })) stored++;
    }
    return { ok: true, stored };
  }
}

@Public()
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get(':slug/whatsapp')
  async verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    res.status(200).send(await this.webhooks.verify(mode, token, challenge));
  }

  @Post(':slug/whatsapp')
  async ingest(@Param('slug') slug: string, @Body() body: any, @Req() req: Request, @Headers('x-hub-signature-256') signature?: string) {
    await this.webhooks.assertSignature((req as any).rawBody, signature);
    // Meta espera 200 siempre; los errores internos no deben provocar reintentos
    return this.webhooks.ingestWhatsapp(slug, body).catch(() => ({ ok: false }));
  }

  @Get(':slug/meta')
  async verifyMeta(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    res.status(200).send(await this.webhooks.verify(mode, token, challenge));
  }

  @Post(':slug/meta')
  async ingestMeta(@Param('slug') slug: string, @Body() body: any, @Req() req: Request, @Headers('x-hub-signature-256') signature?: string) {
    await this.webhooks.assertSignature((req as any).rawBody, signature);
    return this.webhooks.ingestMeta(slug, body).catch(() => ({ ok: false }));
  }
}

@Module({
  imports: [AdsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
