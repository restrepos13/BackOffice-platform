import {
  BadRequestException,
  Body,
  ConflictException,
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
import { Throttle } from '@nestjs/throttler';
import twilio from 'twilio';
import { parseJson } from '../common/constants';
import { decryptSecret, isEncrypted } from '../common/crypto';
import { messagingWindow } from '../common/inbox/window';
import { CHANNEL_STATE_LABEL, channelState } from '../common/inbox/channel-status';
import { classifySendError, sanitizeError } from '../common/inbox/delivery';
import { GRAPH } from '../common/meta';
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

/** Estados de conversación que existen en el modelo (antes se aceptaba cualquier texto). */
export const CONVERSATION_STATUSES = ['OPEN', 'PENDING', 'HANDOFF', 'RESOLVED'] as const;
const PAGE = 30;
const MESSAGES_PAGE = 50;
/** Roles que pueden atender (responder) una conversación de su empresa. */
const AGENT_ROLES: string[] = [ROLES.COMPANY_ADMIN];
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

  /** Detalle. Con withoutMessages la bandeja pide el historial aparte, por páginas. */
  async detail(user: AuthUser, id: string, withoutMessages = false) {
    this.assertNotArea(user);
    await this.assertAccess(user, id);
    const conversation: any = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: { include: { customer: { select: { id: true, name: true } } } },
        bot: { select: { id: true, name: true, model: true } },
        integration: { select: { id: true, name: true } },
        ...(withoutMessages ? {} : {
          messages: {
            orderBy: { createdAt: 'asc' as const },
            include: {
              mediaAsset: { select: { id: true, name: true, priceUsd: true, mimeType: true } },
            },
          },
        }),
      },
    });
    if (conversation?.assignedToId) {
      conversation.assignedToName = (await this.prisma.user.findUnique({ where: { id: conversation.assignedToId }, select: { name: true } }))?.name ?? null;
    }
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
        // Las respuestas del bot preparadas antes de este momento no salen
        modeChangedAt: new Date(),
        modeChangedBy: user.name,
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
    if (human) await this.cancelPendingBotReplies(conversation.companyId, id);
    return updated;
  }

  /** Respuestas del bot que aún esperaban su turno (demora humanizada): se retiran al tomar la conversación. */
  private async cancelPendingBotReplies(companyId: string, conversationId: string) {
    const pending = await this.prisma.message.findMany({ where: { conversationId, direction: 'OUT', author: 'BOT', deliveryStatus: 'QUEUED' }, select: { id: true } });
    for (const m of pending) {
      const r = await this.prisma.message.updateMany({ where: { id: m.id, deliveryStatus: 'QUEUED' }, data: { deliveryStatus: 'CANCELLED', deliveryError: 'Un agente tomó la conversación antes de que saliera esta respuesta del bot.' } });
      if (r.count) this.events?.emit(companyId, { type: 'message.status', conversationId, messageId: m.id, deliveryStatus: 'CANCELLED' });
    }
  }

  async sendMessage(
    user: AuthUser,
    id: string,
    content: string,
    mediaAssetId?: string,
    template?: { key?: string; variables?: string[] },
  ) {
    const conversation = await this.assertAccess(user, id);
    if (conversation.status === 'RESOLVED') throw new BadRequestException('La conversación está resuelta: reábrela para escribir');
    // Lo que permite el canal AHORA (ventana de 24 h, plantillas): se valida antes de crear nada
    const win = await this.windowFor(conversation);
    let contentSid: string | undefined;
    let contentVariables: Record<string, string> | undefined;
    let templateKey: string | undefined;
    if (template?.key) {
      if (win.mode !== 'TEMPLATE_ONLY' && !(win.withinWindow && win.provider === 'TWILIO')) throw new BadRequestException(win.reason ?? 'Este canal no admite plantillas');
      const company = await this.prisma.company.findUnique({ where: { id: conversation.companyId }, select: { waTemplatesJson: true } });
      const t = parseJson<any[]>(company?.waTemplatesJson, []).find((x) => x?.key === template.key && x?.contentSid);
      if (!t) throw new BadRequestException('Esa plantilla no está registrada (con su contentSid) en la empresa');
      const vars = (template.variables ?? []).map((v) => String(v ?? '').trim().slice(0, 300));
      const needed = win.templates.find((x) => x.key === template.key)?.variables ?? 0;
      if (vars.length < needed || vars.slice(0, needed).some((v) => !v)) throw new BadRequestException(`La plantilla necesita ${needed} variables`);
      contentSid = String(t.contentSid);
      contentVariables = Object.fromEntries(vars.slice(0, needed).map((v, i) => [String(i + 1), v]));
      templateKey = String(t.key);
      content = String(t.body ?? t.name ?? t.key).replace(/\{\{\s*(\d+)\s*\}\}/g, (_m: string, n: string) => contentVariables![n] ?? '');
      mediaAssetId = undefined;
    } else if (win.mode !== 'FREE_TEXT') {
      throw new BadRequestException(win.reason ?? 'No se puede escribir en este canal ahora');
    }
    if ((content?.trim().length ?? 0) > 4000) throw new BadRequestException('El mensaje es demasiado largo (máximo 4.000 caracteres)');
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
        templateKey: templateKey ?? null,
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
        ...(conversation.botPaused ? {} : { modeChangedAt: new Date(), modeChangedBy: user.name }),
      },
    });
    if (!conversation.botPaused) await this.cancelPendingBotReplies(conversation.companyId, id);
    // El mensaje sale de verdad por la línea (sandbox si la línea lo está)
    if (viaWhatsApp && this.twilio) {
      await this.twilio.enqueueOutbound({ messageId: message.id, ...(contentSid ? { contentSid, contentVariables, metaCategory: 'UTILIDAD' } : {}) });
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
    if (dto?.status !== undefined && !(CONVERSATION_STATUSES as readonly string[]).includes(dto.status)) throw new BadRequestException('Estado inválido');
    if (dto?.needsAttention !== undefined && typeof dto.needsAttention !== 'boolean') throw new BadRequestException('needsAttention debe ser verdadero o falso');
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        status: dto.status,
        needsAttention: dto.needsAttention,
      },
    });
    if (dto?.status && dto.status !== conversation.status) {
      await this.audit.log({ actor: user, companyId: conversation.companyId, action: 'conversation.status', entity: 'Conversation', entityId: id, detail: `${conversation.status} → ${dto.status}` });
    }
    this.events?.emit(conversation.companyId, {
      type: 'conversation.updated',
      conversationId: id,
      status: updated.status,
      needsAttention: updated.needsAttention,
    });
    return updated;
  }

  /* ───────────────────────── Bandeja (fase 4) ───────────────────────── */

  /** Filtro común de la bandeja (empresa siempre desde la sesión). */
  private inboxWhere(user: AuthUser, f: Record<string, string | undefined>) {
    const scoped = scopeCompanyId(user, f.companyId);
    const q = f.q?.trim().slice(0, 80);
    const and: any[] = [];
    if (scoped) and.push({ companyId: scoped });
    if (f.status) {
      if (!(CONVERSATION_STATUSES as readonly string[]).includes(f.status)) throw new BadRequestException('Estado inválido');
      and.push({ status: f.status });
    }
    if (f.channel) and.push({ channel: String(f.channel).toUpperCase() });
    if (f.integrationId) and.push({ integrationId: f.integrationId });
    if (f.mode === 'HUMAN') and.push({ botPaused: true });
    if (f.mode === 'BOT') and.push({ botPaused: false });
    if (f.needsAttention === 'true') and.push({ needsAttention: true });
    if (f.unread === 'true') and.push({ unreadCount: { gt: 0 } });
    if (f.assignee === 'me') and.push({ assignedToId: user.id });
    else if (f.assignee === 'none') and.push({ OR: [{ assignedToId: null }, { assignedToId: { isSet: false } }] });
    else if (f.assignee) and.push({ assignedToId: f.assignee });
    if (f.from || f.to) {
      and.push({ lastMessageAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(`${f.to}T23:59:59.999Z`) } : {}) } });
    }
    if (q) {
      and.push({
        OR: [
          { contact: { name: { contains: q, mode: 'insensitive' as const } } },
          { contact: { phone: { contains: q } } },
          { contact: { email: { contains: q, mode: 'insensitive' as const } } },
          { contact: { externalId: { contains: q } } },
          { messages: { some: { content: { contains: q, mode: 'insensitive' as const } } } },
        ],
      });
    }
    return { scoped, where: and.length ? { AND: and } : {} };
  }

  /**
   * Lista paginada (cursor por última actividad + id) con filtros por canal,
   * estado, responsable y modo. Los contadores salen de la base, con el
   * mismo alcance de empresa.
   */
  async inbox(user: AuthUser, f: Record<string, string | undefined>) {
    this.assertNotArea(user);
    const { scoped, where } = this.inboxWhere(user, f);
    const limit = Math.min(Math.max(Number(f.limit) || PAGE, 1), 100);
    const cursor = f.cursor ? String(f.cursor).split('|') : null;
    const before = cursor ? new Date(cursor[0]) : null;
    if (before && Number.isNaN(before.getTime())) throw new BadRequestException('Cursor inválido');
    const rows = await this.prisma.conversation.findMany({
      where: before ? { AND: [where, { OR: [{ lastMessageAt: { lt: before } }, { lastMessageAt: before, id: { lt: cursor![1] ?? '' } }] }] } : where,
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      include: {
        contact: { select: { id: true, name: true, phone: true, stage: true, externalId: true, customer: { select: { id: true, name: true } } } },
        integration: { select: { id: true, name: true, type: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const ids = [...new Set(page.map((c: any) => c.assignedToId).filter(Boolean))] as string[];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    const base = scoped ? { companyId: scoped } : {};
    const [unread, mine, unassigned, attention] = await Promise.all([
      this.prisma.conversation.count({ where: { ...base, unreadCount: { gt: 0 }, status: { not: 'RESOLVED' } } }),
      this.prisma.conversation.count({ where: { ...base, assignedToId: user.id, status: { not: 'RESOLVED' } } }),
      this.prisma.conversation.count({ where: { ...base, status: { not: 'RESOLVED' }, OR: [{ assignedToId: null }, { assignedToId: { isSet: false } }] } }),
      this.prisma.conversation.count({ where: { ...base, needsAttention: true } }),
    ]);
    const last = page[page.length - 1] as any;
    return {
      items: page.map((c: any) => ({ ...c, assignedToName: c.assignedToId ? names.get(c.assignedToId) ?? null : null, aiStateJson: undefined })),
      nextCursor: rows.length > limit && last ? `${new Date(last.lastMessageAt).toISOString()}|${last.id}` : null,
      counts: { unread, mine, unassigned, attention },
    };
  }

  /** Historial por páginas (los más recientes primero en la consulta; se devuelven en orden cronológico). */
  async messagesPage(user: AuthUser, id: string, q: { before?: string; limit?: string }) {
    this.assertNotArea(user);
    await this.assertAccess(user, id);
    const limit = Math.min(Math.max(Number(q.limit) || MESSAGES_PAGE, 1), 200);
    const before = q.before ? new Date(q.before) : null;
    if (before && Number.isNaN(before.getTime())) throw new BadRequestException('Fecha inválida');
    const rows = await this.prisma.message.findMany({
      where: { conversationId: id, ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { mediaAsset: { select: { id: true, name: true, priceUsd: true, mimeType: true } } },
      take: limit + 1,
    });
    const page = rows.slice(0, limit).reverse();
    return { items: page, hasOlder: rows.length > limit, oldest: page[0]?.createdAt ?? null };
  }

  /** Miembros a los que se puede asignar: misma empresa, activos y con rol para atender. */
  async assignees(user: AuthUser, companyId?: string) {
    this.assertNotArea(user);
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped) throw new BadRequestException('Falta la empresa');
    return this.prisma.user.findMany({ where: { companyId: scoped, active: true, role: { in: AGENT_ROLES } }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } });
  }

  /**
   * Asigna o quita el responsable de la conversación. Solo a un miembro
   * ACTIVO de la MISMA empresa con rol para atender. Queda en la auditoría.
   */
  async assign(user: AuthUser, id: string, assigneeId: string | null) {
    const conversation: any = await this.assertAccess(user, id);
    let assignee: { id: string; name: string } | null = null;
    if (assigneeId) {
      const u = await this.prisma.user.findUnique({ where: { id: String(assigneeId) }, select: { id: true, name: true, companyId: true, active: true, role: true } });
      if (!u || u.companyId !== conversation.companyId) throw new BadRequestException('Ese usuario no pertenece a la empresa de la conversación');
      if (!u.active) throw new BadRequestException('Ese usuario está inactivo');
      if (!AGENT_ROLES.includes(u.role)) throw new BadRequestException('Ese usuario no tiene permiso para atender conversaciones');
      assignee = { id: u.id, name: u.name };
    }
    if ((conversation.assignedToId ?? null) === (assignee?.id ?? null)) return { ok: true, unchanged: true, assignedToId: assignee?.id ?? null };
    const before = conversation.assignedToId
      ? (await this.prisma.user.findUnique({ where: { id: conversation.assignedToId }, select: { name: true } }))?.name ?? conversation.assignedToId
      : 'sin responsable';
    await this.prisma.conversation.update({
      where: { id },
      data: { assignedToId: assignee?.id ?? null, assignedAt: assignee ? new Date() : null, assignedById: user.id },
    });
    await this.audit.log({
      actor: user, companyId: conversation.companyId, action: assignee ? 'conversation.assign' : 'conversation.unassign',
      entity: 'Conversation', entityId: id, detail: `${before} → ${assignee?.name ?? 'sin responsable'}`,
    });
    this.events?.emit(conversation.companyId, { type: 'conversation.updated', conversationId: id, assignedToId: assignee?.id ?? null });
    return { ok: true, assignedToId: assignee?.id ?? null, assignedToName: assignee?.name ?? null };
  }

  /** Notas internas: solo el equipo de la empresa las ve; nunca salen a ningún canal. */
  async notes(user: AuthUser, id: string, q: { before?: string }) {
    this.assertNotArea(user);
    await this.assertAccess(user, id);
    const before = q.before ? new Date(q.before) : null;
    const rows = await this.prisma.conversationNote.findMany({
      where: { conversationId: id, ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: 'desc' }, take: 51,
    });
    return { items: rows.slice(0, 50).reverse(), hasOlder: rows.length > 50 };
  }

  async addNote(user: AuthUser, id: string, body: string) {
    const conversation: any = await this.assertAccess(user, id);
    const text = String(body ?? '').trim();
    if (!text) throw new BadRequestException('La nota está vacía');
    if (text.length > 2000) throw new BadRequestException('La nota admite hasta 2.000 caracteres');
    const note = await this.prisma.conversationNote.create({
      data: { companyId: conversation.companyId, conversationId: id, authorId: user.id, authorName: user.name, body: text },
    });
    // El evento lleva solo ids: el texto se pide con permisos
    this.events?.emit(conversation.companyId, { type: 'note.new', conversationId: id });
    return note;
  }

  private async windowFor(conversation: any) {
    const [integration, lastIn, company] = await Promise.all([
      conversation.integrationId ? this.prisma.integration.findUnique({ where: { id: conversation.integrationId } }) : null,
      this.prisma.message.findFirst({ where: { conversationId: conversation.id, direction: 'IN' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.company.findUnique({ where: { id: conversation.companyId }, select: { waTemplatesJson: true } }),
    ]);
    return messagingWindow({ channel: conversation.channel, integration, lastInboundAt: lastIn?.createdAt ?? null, waTemplatesJson: company?.waTemplatesJson });
  }

  /** Qué se puede enviar ahora en la conversación (texto libre, solo plantilla o nada) y por qué. */
  async window(user: AuthUser, id: string) {
    this.assertNotArea(user);
    const conversation: any = await this.assertAccess(user, id);
    const integration = conversation.integrationId ? await this.prisma.integration.findUnique({ where: { id: conversation.integrationId } }) : null;
    const win = await this.windowFor(conversation);
    return { ...win, channelState: integration ? { ...channelState(integration), label: CHANNEL_STATE_LABEL[channelState(integration).state] } : null };
  }

  /**
   * Reenvío explícito de un mensaje que falló o cuyo resultado es incierto.
   * Si es incierto (pudo haber salido) exige confirmar el riesgo de duplicado.
   */
  async resend(user: AuthUser, id: string, messageId: string, confirm?: boolean) {
    const conversation: any = await this.assertAccess(user, id);
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m || m.conversationId !== id || m.direction !== 'OUT') throw new NotFoundException('Mensaje no encontrado');
    if (!['FAILED', 'UNCERTAIN'].includes(m.deliveryStatus ?? '')) throw new BadRequestException('Solo se reenvía un mensaje que falló o cuyo envío quedó sin confirmar');
    if (m.deliveryStatus === 'UNCERTAIN' && confirm !== true) throw new BadRequestException('No sabemos si el primer intento salió: reenviar puede duplicarlo. Confirma para continuar.');
    if (m.templateKey) throw new BadRequestException('Para reenviar una plantilla, envíala de nuevo desde el compositor');
    const win = await this.windowFor(conversation);
    if (win.mode !== 'FREE_TEXT') throw new BadRequestException(win.reason ?? 'No se puede escribir en este canal ahora');
    const r = await this.prisma.message.updateMany({ where: { id: messageId, deliveryStatus: m.deliveryStatus }, data: { deliveryStatus: 'QUEUED', deliveryError: null, sendStartedAt: null } });
    if (r.count !== 1) throw new ConflictException('El mensaje cambió de estado: recarga la conversación');
    await this.audit.log({ actor: user, companyId: conversation.companyId, action: 'message.resend', entity: 'Message', entityId: messageId, detail: `Reenvío manual (estaba ${m.deliveryStatus})` });
    if (this.twilio) await this.twilio.enqueueOutbound({ messageId });
    this.events?.emit(conversation.companyId, { type: 'message.status', conversationId: id, messageId, deliveryStatus: 'QUEUED' });
    return { ok: true, deliveryStatus: 'QUEUED' };
  }

  /** Canales de la empresa con su estado VERIFICABLE (no el que alguien marcó a mano). */
  async channels(user: AuthUser, companyId?: string) {
    this.assertNotArea(user);
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped) throw new BadRequestException('Falta la empresa');
    const rows = await this.prisma.integration.findMany({ where: { companyId: scoped, type: { in: ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'] } } });
    return rows.map((i) => {
      const st = channelState(i);
      return { id: i.id, name: i.name, type: i.type, ...st, label: CHANNEL_STATE_LABEL[st.state] };
    });
  }

  /** Reemplazable en pruebas: verificación de solo lectura (no envía nada). */
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }> = (u, i) => fetch(u, i) as any;
  twilioClient: (sid: string, token: string) => any = (sid, token) => twilio(sid, token);

  /**
   * Verifica las credenciales de una línea con una consulta de SOLO LECTURA
   * (Twilio: datos de la cuenta; Meta: el número o la página). No envía
   * mensajes ni cambia nada en el proveedor. Guarda el resultado.
   */
  async verifyChannel(user: AuthUser, integrationId: string) {
    const i = await this.prisma.integration.findUnique({ where: { id: integrationId } });
    if (!i || (!isPlatformRole(user.role) && i.companyId !== user.companyId)) throw new NotFoundException('Canal no encontrado');
    const cfg = parseJson<Record<string, any>>(i.configJson, {});
    const st = channelState(i);
    if (st.state === 'SANDBOX' || st.state === 'NOT_CONFIGURED') return { ...st, label: CHANNEL_STATE_LABEL[st.state] };
    let verification: { ok: boolean; at: string; kind?: 'AUTH' | 'ERROR'; message?: string };
    try {
      if (st.provider === 'TWILIO') {
        const token = decryptSecret(cfg.authTokenEnc);
        await this.twilioClient(cfg.accountSid, token).api.v2010.accounts(cfg.accountSid).fetch();
      } else {
        const token = isEncrypted(cfg.accessTokenEnc) ? decryptSecret(cfg.accessTokenEnc) : '';
        const node = cfg.phoneNumberId ?? cfg.pageId ?? cfg.igUserId;
        const res = await this.fetchImpl(`${GRAPH}/${encodeURIComponent(node)}?fields=id`, { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data?.error?.message ?? `Meta respondió ${res.status}`), { status: res.status, code: data?.error?.code });
      }
      verification = { ok: true, at: new Date().toISOString() };
    } catch (err) {
      const e = classifySendError(err);
      verification = { ok: false, at: new Date().toISOString(), kind: e.outcome === 'AUTH' ? 'AUTH' : 'ERROR', message: sanitizeError(e.message) };
    }
    const fresh = parseJson<Record<string, any>>((await this.prisma.integration.findUnique({ where: { id: i.id } }))?.configJson, {});
    await this.prisma.integration.update({ where: { id: i.id }, data: { configJson: JSON.stringify({ ...fresh, verification }) } });
    await this.audit.log({ actor: user, companyId: i.companyId, action: 'channel.verify', entity: 'Integration', entityId: i.id, detail: verification.ok ? 'Verificado' : `Falló: ${verification.message}` });
    const next = channelState({ ...i, configJson: JSON.stringify({ ...fresh, verification }) });
    return { ...next, label: CHANNEL_STATE_LABEL[next.state] };
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

  /** Bandeja paginada con filtros y contadores (la lista de arriba se conserva por compatibilidad). */
  @Get('inbox')
  inbox(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    return this.conversations.inbox(user, q);
  }

  @Get('channels')
  channels(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.conversations.channels(user, companyId);
  }

  @Post('channels/:integrationId/verify')
  @Roles(...WRITE_ROLES)
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  verifyChannel(@CurrentUser() user: AuthUser, @Param('integrationId') integrationId: string) {
    return this.conversations.verifyChannel(user, integrationId);
  }

  @Get('assignees')
  assignees(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.conversations.assignees(user, companyId);
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

  @Get(':id/messages')
  messagesPage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: { before?: string; limit?: string }) {
    return this.conversations.messagesPage(user, id, q);
  }

  @Get(':id/window')
  window(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.window(user, id);
  }

  @Get(':id/notes')
  notes(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: { before?: string }) {
    return this.conversations.notes(user, id, q);
  }

  @Post(':id/notes')
  @Roles(...WRITE_ROLES)
  addNote(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('body') body: string) {
    return this.conversations.addNote(user, id, body);
  }

  @Patch(':id/assign')
  @Roles(...WRITE_ROLES)
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body('assigneeId') assigneeId: string | null) {
    return this.conversations.assign(user, id, assigneeId ?? null);
  }

  @Post(':id/messages/:messageId/resend')
  @Roles(...WRITE_ROLES)
  resend(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('messageId') messageId: string, @Body('confirm') confirm?: boolean) {
    return this.conversations.resend(user, id, messageId, confirm === true);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('messages') messages?: string) {
    return this.conversations.detail(user, id, messages === 'none');
  }

  @Post(':id/messages')
  @Roles(...WRITE_ROLES)
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body('content') content: string,
    @Body('mediaAssetId') mediaAssetId?: string,
    @Body('template') template?: { key?: string; variables?: string[] },
  ) {
    return this.conversations.sendMessage(user, id, content, mediaAssetId, template);
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
