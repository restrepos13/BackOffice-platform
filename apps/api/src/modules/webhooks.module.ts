import {
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../auth/decorators';
import { parseJson } from '../common/constants';

/**
 * Receptor de webhooks de WhatsApp (Meta Cloud API), por empresa:
 *   GET  /api/webhooks/:slug/whatsapp → verificación de Meta (hub.challenge)
 *   POST /api/webhooks/:slug/whatsapp → mensajes entrantes
 *
 * La ingestión ya funciona: crea contacto + conversación + mensaje y marca la
 * conversación con atención (hasta que el motor de IA responda solo, fase 2).
 * El token de verificación se configura en Dev Tools (META_VERIFY_TOKEN).
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger('Webhooks');

  constructor(private readonly prisma: PrismaService) {}

  private async setting(key: string): Promise<string> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    return row?.value ?? '';
  }

  async verify(mode: string, token: string, challenge: string): Promise<string> {
    const expected = await this.setting('META_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token === expected) {
      return challenge;
    }
    throw new UnauthorizedException('Token de verificación inválido');
  }

  /** Normaliza el payload de la Cloud API y guarda los mensajes entrantes. */
  async ingestWhatsapp(slug: string, body: any) {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    if (!company) {
      this.logger.warn(`Webhook para empresa desconocida: ${slug}`);
      return { ok: false };
    }
    const lines = await this.prisma.integration.findMany({
      where: { companyId: company.id, type: 'WHATSAPP' },
    });

    let stored = 0;
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (!value?.messages?.length) continue;

        // Línea por phone_number_id; si no coincide, la primera de la empresa
        const phoneNumberId = value?.metadata?.phone_number_id;
        const line =
          lines.find(
            (l) =>
              parseJson<Record<string, string>>(l.configJson, {})
                .phoneNumberId === phoneNumberId,
          ) ?? lines[0] ?? null;

        for (const message of value.messages) {
          const waId: string = message.from ?? 'desconocido';
          const phone = waId.startsWith('+') ? waId : `+${waId}`;
          const profileName: string =
            value?.contacts?.find((c: any) => c.wa_id === message.from)?.profile
              ?.name ?? phone;
          const content: string =
            message.type === 'text'
              ? (message.text?.body ?? '')
              : `[${message.type ?? 'contenido'} recibido]`;

          // Contacto por teléfono (crea si no existe)
          let contact = await this.prisma.contact.findFirst({
            where: { companyId: company.id, phone },
          });
          if (!contact) {
            contact = await this.prisma.contact.create({
              data: {
                companyId: company.id,
                name: profileName,
                phone,
                channel: 'WHATSAPP',
                stage: 'CURIOSO',
              },
            });
          }

          // Conversación abierta con ese contacto en esa línea (o nueva)
          let conversation = await this.prisma.conversation.findFirst({
            where: {
              companyId: company.id,
              contactId: contact.id,
              ...(line ? { integrationId: line.id } : {}),
              status: { in: ['OPEN', 'PENDING', 'HANDOFF'] },
            },
            orderBy: { lastMessageAt: 'desc' },
          });
          if (!conversation) {
            conversation = await this.prisma.conversation.create({
              data: {
                companyId: company.id,
                contactId: contact.id,
                integrationId: line?.id ?? null,
                botId: line?.botId ?? null,
                channel: 'WHATSAPP',
                status: 'OPEN',
              },
            });
          }

          await this.prisma.message.create({
            data: {
              conversationId: conversation.id,
              direction: 'IN',
              author: 'CONTACT',
              content,
            },
          });
          // Sin motor de IA todavía: se marca para atención humana
          await this.prisma.conversation.update({
            where: { id: conversation.id },
            data: {
              lastMessageAt: new Date(),
              unreadCount: { increment: 1 },
              needsAttention: true,
              status: 'OPEN',
            },
          });
          await this.prisma.contact.update({
            where: { id: contact.id },
            data: { lastActivityAt: new Date() },
          });
          stored++;
        }
      }
    }
    if (stored > 0) {
      this.logger.log(`${slug}: ${stored} mensaje(s) entrante(s) guardado(s)`);
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
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const result = await this.webhooks.verify(mode, token, challenge);
    res.status(200).send(result);
  }

  @Post(':slug/whatsapp')
  ingest(@Param('slug') slug: string, @Body() body: any) {
    // Meta espera 200 siempre; los errores internos no deben provocar reintentos
    return this.webhooks.ingestWhatsapp(slug, body).catch(() => ({ ok: false }));
  }
}

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
