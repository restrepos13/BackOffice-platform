import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ensureFile } from '../common/file-store';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { basename, join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  NOT_DELETED,
  ROLES,
  isPlatformRole,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import { TwilioModule, TwilioService } from './twilio.module';
import { Products } from '../auth/products.guard';

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

const MIME_BY_EXT: Record<string, string> = {
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
};

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly twilio?: TwilioService,
  ) {}

  private assertNotArea(user: AuthUser) {
    // COMPANY_AREA solo ve su vista de área, nunca la bandeja
    if (user.role === ROLES.COMPANY_AREA) throw new ForbiddenException();
  }

  private async assertAccess(user: AuthUser, id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    if (!isPlatformRole(user.role) && conversation.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return conversation;
  }

  /** Ficha de rastreo del chat: de dónde llegó, por qué línea, quién atiende y qué ha comprado. */
  async insights(user: AuthUser, id: string) {
    this.assertNotArea(user);
    const conversation: any = await this.assertAccess(user, id);
    const [contact, line, messages, orders, receivables, touches, otherChats]: any[] = await Promise.all([
      this.prisma.contact.findUnique({ where: { id: conversation.contactId }, include: { assignedTo: { select: { name: true } } } }),
      conversation.integrationId ? this.prisma.integration.findUnique({ where: { id: conversation.integrationId } }) : null,
      this.prisma.message.findMany({ where: { conversationId: id }, select: { direction: true, author: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 2000 }),
      this.prisma.order.findMany({ where: { companyId: conversation.companyId, contactId: conversation.contactId, ...NOT_DELETED }, select: { status: true, total: true, createdAt: true, paymentStatus: true }, orderBy: { createdAt: 'desc' }, take: 200 }),
      this.prisma.receivable.findMany({ where: { companyId: conversation.companyId, contactId: conversation.contactId, status: 'PENDING' }, select: { amount: true } }),
      this.prisma.addonTouch.findMany({ where: { companyId: conversation.companyId, contactId: conversation.contactId }, orderBy: { createdAt: 'desc' }, take: 1 }),
      this.prisma.conversation.count({ where: { companyId: conversation.companyId, contactId: conversation.contactId } }),
    ]);
    const parse = (raw: string | null | undefined) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
    const firstIn = messages.find((m: any) => m.direction === 'IN');
    const firstReply = firstIn ? messages.find((m: any) => m.direction === 'OUT' && new Date(m.createdAt) > new Date(firstIn.createdAt)) : null;
    const sales = orders.filter((o: any) => !['borrador', 'cancelado'].includes(o.status));
    const lineCfg = parse(line?.configJson) ?? {};
    const origin = parse(conversation.originJson);
    const firstOrigin = parse(contact?.originJson);
    const ORIGIN_LABEL: Record<string, string> = { AD: 'Anuncio de Meta', POST: 'Publicación de Meta', DIRECT: 'Escribió directo' };
    return {
      origin: origin ? { ...origin, label: ORIGIN_LABEL[origin.kind] ?? 'Directo' } : { kind: 'UNKNOWN', label: 'Sin dato (chat anterior al rastreo)' },
      firstOrigin: firstOrigin ? { ...firstOrigin, label: ORIGIN_LABEL[firstOrigin.kind] ?? 'Directo' } : null,
      line: line ? { id: line.id, name: line.name, phone: lineCfg.displayPhone ?? lineCfg.fromNumber ?? null, channel: line.type } : null,
      channel: conversation.channel,
      startedAt: conversation.createdAt,
      lastMessageAt: conversation.lastMessageAt,
      status: conversation.status,
      attendedBy: conversation.botPaused ? { kind: 'HUMAN', name: conversation.attendedByName ?? 'Una persona del equipo' } : { kind: 'BOT', name: 'Asistente IA' },
      needsAttention: !!conversation.needsAttention,
      messages: {
        total: messages.length,
        fromClient: messages.filter((m: any) => m.direction === 'IN').length,
        fromBot: messages.filter((m: any) => m.direction === 'OUT' && m.author === 'BOT').length,
        fromTeam: messages.filter((m: any) => m.direction === 'OUT' && m.author === 'AGENT').length,
        firstReplyMin: firstIn && firstReply ? Math.max(0, Math.round((+new Date(firstReply.createdAt) - +new Date(firstIn.createdAt)) / 60000)) : null,
      },
      contact: contact ? {
        id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, stage: contact.stage,
        tags: parse(contact.tagsJson) ?? [], assignedTo: contact.assignedTo?.name ?? null, since: contact.createdAt,
        optOut: !!contact.optOut, conversations: otherChats,
      } : null,
      purchases: {
        count: sales.length,
        total: sales.reduce((n: number, o: any) => n + (o.total ?? 0), 0),
        last: sales[0] ? { at: sales[0].createdAt, status: sales[0].status, total: sales[0].total ?? 0 } : null,
        unpaid: sales.filter((o: any) => ['NONE', 'PENDING', 'FAILED'].includes(o.paymentStatus ?? 'NONE')).length,
      },
      owed: receivables.reduce((n: number, r: any) => n + (r.amount ?? 0), 0),
      lastAutomation: touches[0] ? { addon: touches[0].addon, status: touches[0].status, at: touches[0].createdAt } : null,
    };
  }

  async list(
    user: AuthUser,
    filters: {
      companyId?: string;
      status?: string;
      needsAttention?: string;
      integrationId?: string;
      q?: string;
      from?: string;
      to?: string;
    },
  ) {
    this.assertNotArea(user);
    const scoped = scopeCompanyId(user, filters.companyId);
    const q = filters.q?.trim();
    return this.prisma.conversation.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.needsAttention === 'true' ? { needsAttention: true } : {}),
        ...(filters.integrationId ? { integrationId: filters.integrationId } : {}),
        ...(filters.from || filters.to
          ? {
              lastMessageAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(`${filters.to}T23:59:59.999Z`) } : {}),
              },
            }
          : {}),
        // Búsqueda: nombre/teléfono del contacto o contenido de mensajes
        ...(q
          ? {
              OR: [
                { contact: { name: { contains: q, mode: 'insensitive' as const } } },
                { contact: { phone: { contains: q } } },
                { messages: { some: { content: { contains: q, mode: 'insensitive' as const } } } },
              ],
            }
          : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        contact: {
          select: {
            id: true, name: true, phone: true, stage: true,
            customer: { select: { id: true, name: true } },
          },
        },
        bot: { select: { id: true, name: true } },
        integration: { select: { id: true, name: true } },
        company: { select: { name: true, slug: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      take: 200,
    });
  }

  async detail(user: AuthUser, id: string) {
    this.assertNotArea(user);
    await this.assertAccess(user, id);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: { include: { customer: { select: { id: true, name: true } } } },
        bot: { select: { id: true, name: true, model: true } },
        integration: { select: { id: true, name: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            mediaAsset: { select: { id: true, name: true, priceUsd: true, mimeType: true } },
          },
        },
      },
    });
    // marcar como leída
    await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });
    return conversation;
  }

  /**
   * Modo humano explícito: HUMAN pausa la IA y deja constancia de quién
   * atiende; BOT le devuelve el control a la IA y limpia la alerta.
   */
  async setMode(user: AuthUser, id: string, mode: 'HUMAN' | 'BOT') {
    const conversation = await this.assertAccess(user, id);
    const human = mode === 'HUMAN';
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        botPaused: human,
        attendedByName: human ? user.name : null,
        ...(human ? {} : { needsAttention: false }),
      },
    });
    await this.audit.log({
      actor: user,
      companyId: conversation.companyId,
      action: human ? 'conversation.human_mode' : 'conversation.bot_mode',
      entity: 'Conversation',
      entityId: id,
      detail: human ? `Atiende ${user.name}` : 'Control devuelto a la IA',
    });
    this.events?.emit(conversation.companyId, {
      type: 'conversation.updated',
      conversationId: id,
      botPaused: human,
      attendedByName: updated.attendedByName,
    });
    return updated;
  }

  async sendMessage(
    user: AuthUser,
    id: string,
    content: string,
    mediaAssetId?: string,
  ) {
    const conversation = await this.assertAccess(user, id);
    // La foto debe existir, estar activa y pertenecer al MISMO tenant
    if (mediaAssetId) {
      const asset = await this.prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
      });
      if (!asset || asset.companyId !== conversation.companyId || !asset.active) {
        throw new ForbiddenException('Foto inválida para esta conversación');
      }
      await this.prisma.mediaAsset.update({
        where: { id: mediaAssetId },
        data: { timesSent: { increment: 1 } },
      });
    }
    if (!content?.trim() && !mediaAssetId) {
      throw new ForbiddenException('Mensaje vacío');
    }
    // Respuesta humana por el canal real: WhatsApp, Instagram o Messenger
    const viaWhatsApp =
      ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(conversation.channel) && !!conversation.integrationId;
    const message = await this.prisma.message.create({
      data: {
        conversationId: id,
        direction: 'OUT',
        author: 'AGENT',
        authorName: user.name,
        content: content?.trim() ?? '',
        mediaAssetId: mediaAssetId ?? null,
        deliveryStatus: viaWhatsApp ? 'QUEUED' : null,
      },
      include: {
        mediaAsset: { select: { id: true, name: true, priceUsd: true, mimeType: true } },
      },
    });
    // Escribir a mano = tomar la conversación (la IA queda en pausa)
    await this.prisma.conversation.update({
      where: { id },
      data: {
        lastMessageAt: new Date(),
        status: 'HANDOFF',
        needsAttention: false,
        botPaused: true,
        attendedByName: user.name,
      },
    });
    // El mensaje sale de verdad por la línea (sandbox si la línea lo está)
    if (viaWhatsApp && this.twilio) {
      await this.twilio.enqueueOutbound({ messageId: message.id });
    }
    this.events?.emit(conversation.companyId, {
      type: 'message.new',
      conversationId: id,
      direction: 'OUT',
    });
    return message;
  }

  async updateStatus(user: AuthUser, id: string, dto: any) {
    const conversation = await this.assertAccess(user, id);
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        status: dto.status,
        needsAttention: dto.needsAttention,
      },
    });
    this.events?.emit(conversation.companyId, {
      type: 'conversation.updated',
      conversationId: id,
      status: updated.status,
      needsAttention: updated.needsAttention,
    });
    return updated;
  }

  /** Sirve el archivo (audio/imagen/documento) de un mensaje, tenant-scoped. */
  async messageFile(user: AuthUser, messageId: string, res: Response) {
    this.assertNotArea(user);
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true },
    });
    if (!message?.fileName) throw new NotFoundException('Archivo no encontrado');
    const companyId = (message.conversation as any).companyId as string;
    if (!isPlatformRole(user.role) && companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    const safeName = basename(message.fileName); // sin traversal
    const filePath = await ensureFile(this.prisma, companyId, safeName);
    if (!filePath) throw new NotFoundException('Archivo no disponible');
    const ext = safeName.split('.').pop() ?? '';
    res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    createReadStream(filePath).pipe(res);
  }
}

const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;

@Products('AUTOMATION')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('needsAttention') needsAttention?: string,
    @Query('integrationId') integrationId?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.conversations.list(user, {
      companyId, status, needsAttention, integrationId, q, from, to,
    });
  }

  @Get('messages/:messageId/file')
  messageFile(
    @CurrentUser() user: AuthUser,
    @Param('messageId') messageId: string,
    @Res() res: Response,
  ) {
    return this.conversations.messageFile(user, messageId, res);
  }

  @Get(':id/insights')
  insights(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.insights(user, id);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.detail(user, id);
  }

  @Post(':id/messages')
  @Roles(...WRITE_ROLES)
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body('content') content: string,
    @Body('mediaAssetId') mediaAssetId?: string,
  ) {
    return this.conversations.sendMessage(user, id, content, mediaAssetId);
  }

  @Patch(':id/mode')
  @Roles(...WRITE_ROLES)
  setMode(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body('mode') mode: 'HUMAN' | 'BOT',
  ) {
    if (mode !== 'HUMAN' && mode !== 'BOT') {
      throw new ForbiddenException('mode debe ser HUMAN o BOT');
    }
    return this.conversations.setMode(user, id, mode);
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.conversations.updateStatus(user, id, dto);
  }
}

@Module({
  imports: [TwilioModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
