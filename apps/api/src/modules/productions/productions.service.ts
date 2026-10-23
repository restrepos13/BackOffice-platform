import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, forwardRef } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthUser, isPlatformRole, parseJson } from '../../common/constants';
import { AuditService } from '../audit.module';
import {
  BRIEF_FIELDS, NEEDS_REASON, OPS_PROFILES, OpsProfile, PERMISSIONS, PERMISSION_LABEL, PROFILE_LABEL, PROFILE_PERMISSIONS, Permission,
  ProductionConfig, ProductionStatus, QUOTE_DRIVEN, QuoteLine, STATUSES, STATUS_LABEL, TERMINAL, confirmedHoldHours, effectiveProfile,
  hourSlots, isStatus, manualTargets, mergeConfig, missingFields, permissionsOf, quoteDiff, quoteTotals, redactLines, sanitizeBrief, sanitizeLines,
} from '../../common/productions';
import { WorkflowService } from './workflow.service';

/**
 * Producciones: la solicitud de un cliente desde que llega hasta que se cierra.
 * Toda operación se limita a la empresa de la sesión (nunca a un companyId del
 * navegador, salvo roles de plataforma) y a los permisos del perfil del usuario.
 * Nada sale de BackOffice: no se envían mensajes, cotizaciones ni confirmaciones.
 */

export interface Ctx {
  companyId: string;
  user: AuthUser;
  profile: OpsProfile;
  perms: Set<Permission>;
  actorName: string;
}

const CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'REFERRAL', 'EMAIL', 'WEB', 'OTHER'] as const;
const RESOURCE_KINDS = ['MODEL', 'LOCATION', 'PHOTOGRAPHER', 'CREATIVE_DIRECTION', 'STYLING', 'ASSISTANT', 'CATERING', 'OTHER'] as const;
const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'] as const;
const OPEN_TASK = ['TODO', 'IN_PROGRESS', 'BLOCKED'];
const ACTIVE_RESERVATION = ['HOLD', 'PENDING_CONFIRMATION', 'CONFIRMED'];

const str = (v: unknown, max = 200): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
};
const date = (v: unknown, field: string): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field}: fecha inválida`);
  return d;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], field: string, fallback?: T): T => {
  if ((v === undefined || v === null || v === '') && fallback) return fallback;
  if (!(list as readonly string[]).includes(String(v))) throw new BadRequestException(`${field}: valor no permitido`);
  return v as T;
};

@Injectable()
export class ProductionsService {
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(forwardRef(() => WorkflowService)) private readonly workflow?: WorkflowService,
  ) {}

  /* ── Acceso ── */

  /** Empresa de la sesión + perfil efectivo; exige el permiso pedido. */
  async ctx(user: AuthUser, requestedCompanyId: string | undefined, perm: Permission): Promise<Ctx> {
    const companyId = isPlatformRole(user.role) ? requestedCompanyId : user.companyId;
    if (!companyId) throw new ForbiddenException(isPlatformRole(user.role) ? 'Elige una empresa' : 'Tu usuario no tiene empresa');
    const row: any = await this.prisma.user.findUnique({ where: { id: user.id }, select: { opsProfile: true, name: true } });
    const profile = effectiveProfile({ role: user.role, opsProfile: row?.opsProfile ?? null });
    if (!profile) throw new ForbiddenException('Tu rol no tiene acceso a Producciones');
    const perms = permissionsOf(profile);
    if (!perms.has(perm)) throw new ForbiddenException(`No tienes permiso para: ${PERMISSION_LABEL[perm].toLowerCase()}`);
    return { companyId, user, profile, perms, actorName: row?.name ?? user.name };
  }

  private need(c: Ctx, perm: Permission) {
    if (!c.perms.has(perm)) throw new ForbiddenException(`No tienes permiso para: ${PERMISSION_LABEL[perm].toLowerCase()}`);
  }

  async config(companyId: string): Promise<ProductionConfig> {
    const row = await this.prisma.productionSettings.findUnique({ where: { companyId } });
    return mergeConfig(parseJson(row?.configJson, {}));
  }

  private async production(c: Ctx, id: string) {
    const p = await this.prisma.production.findFirst({ where: { id, companyId: c.companyId } });
    if (!p) throw new NotFoundException('Producción no encontrada');
    return p;
  }

  private async companyUser(companyId: string, userId: string | null | undefined, field: string) {
    if (!userId) return null;
    const u = await this.prisma.user.findFirst({ where: { id: userId, companyId, active: true } });
    if (!u) throw new BadRequestException(`${field}: el usuario no es de esta empresa`);
    return u;
  }

  /** Historial de solo lectura. */
  async event(companyId: string, productionId: string, actor: { type: 'USER' | 'SYSTEM' | 'AI' | 'INTEGRATION'; id?: string | null; name: string }, type: string, summary: string, data?: unknown) {
    await this.prisma.productionEvent.create({
      data: {
        companyId, productionId, type, actorType: actor.type, actorId: actor.id ?? null, actorName: actor.name,
        summary: summary.slice(0, 500), dataJson: data === undefined ? null : JSON.stringify(data).slice(0, 4000),
      },
    });
  }
  private actor(c: Ctx) {
    return { type: 'USER' as const, id: c.user.id, name: c.actorName };
  }

  private async nextCode(companyId: string): Promise<string> {
    const existing = await this.prisma.productionCounter.findUnique({ where: { companyId } });
    if (!existing) {
      await this.prisma.productionCounter.create({ data: { companyId, seq: 0 } }).catch((e: any) => {
        if (e?.code !== 'P2002') throw e; // otra petición lo creó a la vez
      });
    }
    const row = await this.prisma.productionCounter.update({ where: { companyId }, data: { seq: { increment: 1 } } });
    return `PR-${String(row.seq).padStart(4, '0')}`;
  }

  /* ── Crear ── */

  async create(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    return this.createIn(c, dto);
  }

  private async createIn(c: Ctx, dto: any, sourceKey?: string) {
    const clientName = str(dto?.clientName, 120);
    if (!clientName) throw new BadRequestException('Escribe el nombre del cliente o la marca');
    const cfg = await this.config(c.companyId);
    if (dto?.ownerId && !c.perms.has('assign')) throw new ForbiddenException('No tienes permiso para asignar responsables');
    await this.companyUser(c.companyId, dto?.ownerId, 'Responsable');
    if (dto?.customerId && !(await this.prisma.customer.findFirst({ where: { id: dto.customerId, companyId: c.companyId } }))) {
      throw new BadRequestException('Cliente no encontrado en esta empresa');
    }
    if (dto?.contactId && !(await this.prisma.contact.findFirst({ where: { id: dto.contactId, companyId: c.companyId } }))) {
      throw new BadRequestException('Contacto no encontrado en esta empresa');
    }
    // Idempotencia: la misma entrada (conversación) nunca crea dos producciones
    if (sourceKey) {
      const known = await this.prisma.productionSourceKey.findFirst({ where: { companyId: c.companyId, key: sourceKey } });
      if (known) return { ...(await this.detail(c, known.productionId)), created: false };
    }
    const code = await this.nextCode(c.companyId);
    const brief = sanitizeBrief(dto?.brief);
    const p = await this.prisma.production.create({
      data: {
        companyId: c.companyId, code,
        title: str(dto?.title, 160) ?? `${clientName}${brief.contentType ? ` · ${brief.contentType}` : ''}`,
        customerId: dto?.customerId ?? null, clientName, brand: str(dto?.brand, 120),
        contactId: dto?.contactId ?? null, contactName: str(dto?.contactName, 120), contactPhone: str(dto?.contactPhone, 40), contactEmail: str(dto?.contactEmail, 160),
        channel: oneOf(dto?.channel, CHANNELS, 'Canal', 'OTHER'), referredBy: str(dto?.referredBy, 120),
        conversationId: dto?.conversationId ?? null, ownerId: dto?.ownerId ?? null,
        status: 'NUEVA', priority: oneOf(dto?.priority, cfg.priorities, 'Prioridad', 'NORMAL'),
        requestedDate: date(dto?.requestedDate, 'Fecha solicitada'), requestedDateNote: str(dto?.requestedDateNote, 200),
        notes: str(dto?.notes, 4000), briefJson: JSON.stringify(brief), isTest: dto?.isTest === true,
        createdById: c.user.id, updatedAt: this.now(),
      },
    });
    if (sourceKey) {
      try {
        await this.prisma.productionSourceKey.create({ data: { companyId: c.companyId, key: sourceKey, productionId: p.id } });
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
        // Otra petición ganó: se descarta esta y se devuelve la existente
        await this.prisma.production.delete({ where: { id: p.id } });
        const winner = await this.prisma.productionSourceKey.findFirst({ where: { companyId: c.companyId, key: sourceKey } });
        return { ...(await this.detail(c, winner!.productionId)), created: false };
      }
    }
    await this.event(c.companyId, p.id, this.actor(c), 'created', `Solicitud ${code} creada (canal: ${p.channel})`, { sourceKey: sourceKey ?? null, isTest: p.isTest });
    await this.audit.log({ actor: c.user, companyId: c.companyId, action: 'production.create', entity: 'Production', entityId: p.id, detail: code });
    await this.workflow?.schedule(c.companyId, 'production.status', `status:${p.id}:NUEVA:1`, { status: 'NUEVA' }, p.id);
    return { ...(await this.detail(c, p.id)), created: true };
  }

  /** Desde una conversación existente (WhatsApp, Instagram, Messenger). */
  async createFromConversation(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const conv: any = await this.prisma.conversation.findFirst({ where: { id: String(dto?.conversationId ?? ''), companyId: c.companyId }, include: { contact: true } });
    if (!conv) throw new NotFoundException('Conversación no encontrada');
    const channel = conv.channel === 'MESSENGER' ? 'FACEBOOK' : CHANNELS.includes(conv.channel) ? conv.channel : 'OTHER';
    return this.createIn(c, {
      ...dto, clientName: dto?.clientName || conv.contact?.name || 'Cliente sin nombre', contactId: conv.contactId,
      contactName: conv.contact?.name, contactPhone: conv.contact?.phone, contactEmail: conv.contact?.email, channel, conversationId: conv.id,
    }, `conversation:${conv.id}`);
  }

  /* ── Consultar ── */

  async list(user: AuthUser, q: any) {
    const c = await this.ctx(user, q?.companyId, 'view');
    let rows: any[] = await this.prisma.production.findMany({ where: { companyId: c.companyId }, orderBy: { updatedAt: 'desc' }, take: 5000 });
    if (q?.includeTest !== 'true') rows = rows.filter((r) => !r.isTest);
    const text = String(q?.q ?? '').trim().toLowerCase();
    if (text) rows = rows.filter((r) => [r.code, r.title, r.clientName, r.brand, r.contactName, r.contactPhone].some((v) => v && String(v).toLowerCase().includes(text)));
    if (q?.status) {
      const set = String(q.status).split(',');
      rows = rows.filter((r) => set.includes(r.status) || (set.includes('OPEN') && !TERMINAL.includes(r.status)));
    }
    if (q?.ownerId) rows = rows.filter((r) => (q.ownerId === 'none' ? !r.ownerId : r.ownerId === q.ownerId));
    if (q?.channel) rows = rows.filter((r) => r.channel === q.channel);
    const from = q?.from ? date(q.from, 'Desde') : null;
    const to = q?.to ? date(q.to, 'Hasta') : null;
    if (from) rows = rows.filter((r) => r.requestedDate && new Date(r.requestedDate) >= from);
    if (to) rows = rows.filter((r) => r.requestedDate && new Date(r.requestedDate) <= to);
    if (q?.sort === 'nextAction') {
      rows.sort((a, b) => (a.nextActionDueAt ? new Date(a.nextActionDueAt).getTime() : Infinity) - (b.nextActionDueAt ? new Date(b.nextActionDueAt).getTime() : Infinity));
    } else if (q?.sort === 'requestedDate') {
      rows.sort((a, b) => (a.requestedDate ? new Date(a.requestedDate).getTime() : Infinity) - (b.requestedDate ? new Date(b.requestedDate).getTime() : Infinity));
    }
    const pageSize = Math.min(100, Math.max(5, Number(q?.pageSize) || 25));
    const page = Math.max(1, Number(q?.page) || 1);
    const users = await this.userNames(c.companyId);
    return {
      total: rows.length, page, pageSize,
      items: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => this.summary(r, users)),
    };
  }

  private summary(r: any, users: Map<string, string>) {
    return {
      id: r.id, code: r.code, title: r.title, clientName: r.clientName, brand: r.brand, contactName: r.contactName, channel: r.channel,
      status: r.status, statusLabel: STATUS_LABEL[r.status as ProductionStatus] ?? r.status, priority: r.priority,
      ownerId: r.ownerId, ownerName: r.ownerId ? users.get(r.ownerId) ?? null : null, requestedDate: r.requestedDate,
      nextAction: r.nextAction, nextActionDueAt: r.nextActionDueAt, updatedAt: r.updatedAt, createdAt: r.createdAt, isTest: r.isTest,
    };
  }

  private async userNames(companyId: string) {
    const users: any[] = await this.prisma.user.findMany({ where: { companyId }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** Inicio de Automation: solo conteos reales; los registros de prueba van aparte. */
  async overview(user: AuthUser, companyId?: string) {
    const c = await this.ctx(user, companyId, 'view');
    const all: any[] = await this.prisma.production.findMany({ where: { companyId: c.companyId }, take: 5000 });
    const real = all.filter((p) => !p.isTest);
    const open = real.filter((p) => !TERMINAL.includes(p.status));
    const now = this.now();
    const openIds = new Set(open.map((p) => p.id));
    const tasks: any[] = await this.prisma.productionTask.findMany({ where: { companyId: c.companyId, status: { in: OPEN_TASK } }, take: 5000 });
    const overdue = tasks.filter((t) => openIds.has(t.productionId) && t.dueAt && new Date(t.dueAt) < now);
    const issues: any[] = await this.prisma.productionIssue.findMany({ where: { companyId: c.companyId, status: 'OPEN' }, take: 1000 });
    const users = await this.userNames(c.companyId);
    const soon = new Date(now.getTime() + 14 * 86400e3);
    const byId = new Map(real.map((p) => [p.id, p]));
    return {
      counts: {
        open: open.length,
        unassigned: open.filter((p) => !p.ownerId).length,
        briefIncomplete: open.filter((p) => ['NUEVA', 'BRIEF_INCOMPLETO'].includes(p.status)).length,
        quotesPendingApproval: open.filter((p) => p.status === 'COTIZACION_PENDIENTE_APROBACION').length,
        overdueTasks: overdue.length,
        upcoming: open.filter((p) => p.requestedDate && new Date(p.requestedDate) >= now && new Date(p.requestedDate) <= soon).length,
        openIssues: issues.filter((i) => openIds.has(i.productionId)).length,
        testRecords: all.length - real.length,
      },
      byStatus: STATUSES.map((s) => ({ status: s, label: STATUS_LABEL[s], count: open.filter((p) => p.status === s).length })).filter((x) => x.count),
      upcoming: open
        .filter((p) => p.requestedDate && new Date(p.requestedDate) >= now && new Date(p.requestedDate) <= soon)
        .sort((a, b) => new Date(a.requestedDate).getTime() - new Date(b.requestedDate).getTime())
        .slice(0, 8).map((p) => this.summary(p, users)),
      overdueTasks: overdue.slice(0, 8).map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, productionId: t.productionId, productionCode: byId.get(t.productionId)?.code, assigneeName: t.assigneeId ? users.get(t.assigneeId) ?? null : null })),
      openIssues: issues.filter((i) => openIds.has(i.productionId)).slice(0, 8).map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, description: i.description, productionId: i.productionId, productionCode: byId.get(i.productionId)?.code })),
    };
  }

  async get(user: AuthUser, id: string, companyId?: string) {
    const c = await this.ctx(user, companyId, 'view');
    return this.detail(c, id);
  }

  async detail(c: Ctx, id: string) {
    const p: any = await this.production(c, id);
    const cfg = await this.config(c.companyId);
    const brief = parseJson<Record<string, unknown>>(p.briefJson, {});
    const [tasks, issues, assignments, quotes, events, users] = await Promise.all([
      this.prisma.productionTask.findMany({ where: { companyId: c.companyId, productionId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.productionIssue.findMany({ where: { companyId: c.companyId, productionId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.productionAssignment.findMany({ where: { companyId: c.companyId, productionId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.productionQuote.findMany({ where: { companyId: c.companyId, productionId: id }, orderBy: { version: 'desc' } }),
      this.prisma.productionEvent.findMany({ where: { companyId: c.companyId, productionId: id }, orderBy: { createdAt: 'desc' }, take: 300 }),
      this.userNames(c.companyId),
    ]);
    const resourceIds = [...new Set((assignments as any[]).map((a) => a.resourceId).filter(Boolean))];
    const resources: any[] = resourceIds.length ? await this.prisma.productionResource.findMany({ where: { companyId: c.companyId, id: { in: resourceIds } } }) : [];
    const resName = new Map(resources.map((r) => [r.id, r]));
    // Costo de IA de la conversación ligada (trazabilidad sin cambiar el esquema de uso)
    let ai: { calls: number; costUsd: number } | null = null;
    if (p.conversationId) {
      const usage: any[] = await this.prisma.aiUsageEvent.findMany({ where: { companyId: c.companyId, conversationId: p.conversationId } });
      ai = { calls: usage.length, costUsd: Math.round(usage.reduce((s, u) => s + (u.costUsd ?? 0), 0) * 10000) / 10000 };
    }
    const finance = c.perms.has('finance');
    const now = this.now();
    return {
      production: { ...this.summary(p, users), customerId: p.customerId, contactId: p.contactId, contactPhone: p.contactPhone, contactEmail: p.contactEmail, referredBy: p.referredBy, conversationId: p.conversationId, notes: p.notes, version: p.version, closeReason: p.closeReason, pausedFrom: p.pausedFrom, requestedDateNote: p.requestedDateNote, nextActionOwnerId: p.nextActionOwnerId, nextActionOwnerName: p.nextActionOwnerId ? users.get(p.nextActionOwnerId) ?? null : null, approvedQuoteId: p.approvedQuoteId },
      brief, briefFields: BRIEF_FIELDS, durations: cfg.durations,
      missing: { toComplete: missingFields(brief, cfg.brief.requiredToComplete), toQuote: missingFields(brief, cfg.brief.requiredToQuote), configStatus: cfg.brief.status },
      transitions: manualTargets(p.status, p.pausedFrom).map((s) => ({ status: s, label: STATUS_LABEL[s], needsReason: NEEDS_REASON.includes(s), needsEvidence: s === 'ACEPTADA_POR_CLIENTE' })),
      tasks: (tasks as any[]).map((t) => ({ ...t, dependsOn: parseJson<string[]>(t.dependsOnJson, []), assigneeName: t.assigneeId ? users.get(t.assigneeId) ?? null : null, overdue: OPEN_TASK.includes(t.status) && !!t.dueAt && new Date(t.dueAt) < now })),
      issues,
      assignments: (assignments as any[]).map((a) => ({ ...a, resourceName: a.resourceId ? resName.get(a.resourceId)?.name ?? null : null, resourceKind: a.resourceId ? resName.get(a.resourceId)?.kind ?? null : null, holdExpired: a.reservation === 'HOLD' && !!a.holdExpiresAt && new Date(a.holdExpiresAt) < now })),
      quotes: (quotes as any[]).map((q) => this.quoteView(q, finance, users)),
      events: (events as any[]).map((e) => ({ id: e.id, type: e.type, actorType: e.actorType, actorName: e.actorName, summary: e.summary, data: parseJson(e.dataJson, null), createdAt: e.createdAt })),
      ai,
      permissions: [...c.perms], profile: c.profile,
      serviceTypes: cfg.serviceTypes.filter((s) => s.enabled),
      holdHours: confirmedHoldHours(cfg),
    };
  }

  private quoteView(q: any, finance: boolean, users: Map<string, string>) {
    const lines = parseJson<QuoteLine[]>(q.linesJson, []);
    const totals = parseJson<any>(q.totalsJson, {});
    return {
      id: q.id, version: q.version, status: q.status, currency: q.currency, notes: q.notes, basedOnId: q.basedOnId,
      diff: parseJson(q.diffJson, null), createdAt: q.createdAt, submittedAt: q.submittedAt, decidedAt: q.decidedAt, decidedByName: q.decidedByName,
      decisionNote: q.decisionNote, sentManuallyAt: q.sentManuallyAt, sentManuallyNote: q.sentManuallyNote,
      submittedByName: q.submittedById ? users.get(q.submittedById) ?? null : null,
      lines: finance ? lines : redactLines(lines),
      totals: finance ? totals : { complete: totals.complete, pendingCount: (totals.pending ?? []).length },
      redacted: !finance,
    };
  }

  /* ── Editar ── */

  async update(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const p: any = await this.production(c, id);
    if (TERMINAL.includes(p.status)) throw new BadRequestException('La producción está cerrada; no se puede editar');
    const cfg = await this.config(c.companyId);
    const data: Record<string, unknown> = {};
    const changes: string[] = [];
    const set = (key: string, value: unknown, label: string) => {
      if (value === undefined) return;
      const before = p[key] instanceof Date ? p[key].toISOString() : p[key] ?? null;
      const after = value instanceof Date ? value.toISOString() : value ?? null;
      if (before === after) return;
      data[key] = value;
      changes.push(label);
    };
    if ('title' in dto) set('title', str(dto.title, 160) ?? p.title, 'título');
    if ('clientName' in dto) { const v = str(dto.clientName, 120); if (!v) throw new BadRequestException('El cliente no puede quedar vacío'); set('clientName', v, 'cliente'); }
    for (const [k, label, max] of [['brand', 'marca', 120], ['contactName', 'contacto', 120], ['contactPhone', 'teléfono', 40], ['contactEmail', 'correo', 160], ['referredBy', 'referido por', 120], ['notes', 'notas internas', 4000], ['nextAction', 'próxima acción', 300], ['requestedDateNote', 'nota de fecha', 200]] as const) {
      if (k in dto) set(k, str(dto[k], max), label);
    }
    if ('channel' in dto) set('channel', oneOf(dto.channel, CHANNELS, 'Canal'), 'canal');
    if ('priority' in dto) set('priority', oneOf(dto.priority, cfg.priorities, 'Prioridad'), 'prioridad');
    if ('requestedDate' in dto) set('requestedDate', date(dto.requestedDate, 'Fecha solicitada'), 'fecha solicitada');
    if ('nextActionDueAt' in dto) set('nextActionDueAt', date(dto.nextActionDueAt, 'Fecha límite'), 'fecha límite');
    if ('ownerId' in dto || 'nextActionOwnerId' in dto) {
      this.need(c, 'assign');
      if ('ownerId' in dto) { await this.companyUser(c.companyId, dto.ownerId, 'Responsable'); set('ownerId', dto.ownerId || null, 'responsable'); }
      if ('nextActionOwnerId' in dto) { await this.companyUser(c.companyId, dto.nextActionOwnerId, 'Responsable de la acción'); set('nextActionOwnerId', dto.nextActionOwnerId || null, 'responsable de la próxima acción'); }
    }
    if (!changes.length) return this.detail(c, id);
    const res = await this.prisma.production.updateMany({ where: { id, companyId: c.companyId, version: p.version }, data: { ...data, version: { increment: 1 }, updatedAt: this.now() } });
    if (!res.count) throw new ConflictException('Otra persona cambió esta producción. Recarga y vuelve a intentarlo.');
    const users = await this.userNames(c.companyId);
    const ownerNote = 'ownerId' in data ? ` (responsable: ${data.ownerId ? users.get(String(data.ownerId)) : 'sin asignar'})` : '';
    await this.event(c.companyId, id, this.actor(c), 'ownerId' in data ? 'assigned' : 'updated', `Cambió ${changes.join(', ')}${ownerNote}`);
    return this.detail(c, id);
  }

  async updateBrief(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const p: any = await this.production(c, id);
    if (TERMINAL.includes(p.status)) throw new BadRequestException('La producción está cerrada; no se puede editar el brief');
    const before = parseJson<Record<string, unknown>>(p.briefJson, {});
    const after = sanitizeBrief(dto?.brief, before);
    const changed = Object.keys(after).filter((k) => JSON.stringify(after[k] ?? null) !== JSON.stringify(before[k] ?? null));
    if (!changed.length) return this.detail(c, id);
    const res = await this.prisma.production.updateMany({ where: { id, companyId: c.companyId, version: p.version }, data: { briefJson: JSON.stringify(after), version: { increment: 1 }, updatedAt: this.now() } });
    if (!res.count) throw new ConflictException('Otra persona cambió esta producción. Recarga y vuelve a intentarlo.');
    const labels = changed.map((k) => BRIEF_FIELDS.find((f) => f.key === k)?.label ?? k);
    await this.event(c.companyId, id, this.actor(c), 'brief', `Actualizó el brief: ${labels.join(', ')}`, { fields: changed });
    return this.detail(c, id);
  }

  /* ── Estados ── */

  async transition(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const p: any = await this.production(c, id);
    const to = dto?.to;
    if (!isStatus(to)) throw new BadRequestException('Estado de destino inválido');
    if (p.status === to) return { ...(await this.detail(c, id)), unchanged: true }; // repetir no duplica nada
    if (QUOTE_DRIVEN.includes(to)) throw new BadRequestException('Ese estado se alcanza desde la cotización (enviar a aprobación, aprobar o registrar envío)');
    if (!manualTargets(p.status, p.pausedFrom).includes(to)) {
      throw new BadRequestException(`No se puede pasar de «${STATUS_LABEL[p.status as ProductionStatus]}» a «${STATUS_LABEL[to]}»`);
    }
    const reason = str(dto?.reason, 500);
    if (NEEDS_REASON.includes(to) && !reason) throw new BadRequestException('Escribe el motivo');
    const cfg = await this.config(c.companyId);
    const brief = parseJson<Record<string, unknown>>(p.briefJson, {});
    const extra: Record<string, unknown> = {};
    if (to === 'BRIEF_COMPLETO') {
      const miss = missingFields(brief, cfg.brief.requiredToComplete);
      if (miss.length) throw new BadRequestException(`Falta en el brief: ${miss.map((m) => m.label).join(', ')}`);
    }
    if (to === 'PROPUESTA_EN_PREPARACION' && p.status === 'BUSCANDO_RECURSOS') {
      const n = await this.prisma.productionAssignment.count({ where: { companyId: c.companyId, productionId: id } });
      if (!n) throw new BadRequestException('Registra al menos un recurso antes de preparar la propuesta');
    }
    if (to === 'ACEPTADA_POR_CLIENTE') {
      if (!p.approvedQuoteId) throw new BadRequestException('No hay una cotización aprobada');
      if (!str(dto?.evidence, 500)) throw new BadRequestException('Indica cómo y cuándo aceptó el cliente (evidencia)');
    }
    if (to === 'CONFIRMADA') {
      this.need(c, 'confirm');
      const selected: any[] = await this.prisma.productionAssignment.findMany({ where: { companyId: c.companyId, productionId: id, role: 'SELECTED' } });
      const live = selected.filter((a) => a.reservation !== 'RELEASED' && a.reservation !== 'CANCELLED');
      if (!live.length) throw new BadRequestException('No hay recursos seleccionados');
      const notConfirmed = live.filter((a) => a.reservation !== 'CONFIRMED');
      if (notConfirmed.length) throw new BadRequestException(`Faltan ${notConfirmed.length} recurso(s) por confirmar`);
    }
    if (to === 'CERRADA') {
      const openTasks = await this.prisma.productionTask.count({ where: { companyId: c.companyId, productionId: id, status: { in: OPEN_TASK } } });
      const openIssues = await this.prisma.productionIssue.count({ where: { companyId: c.companyId, productionId: id, status: 'OPEN' } });
      if (openTasks || openIssues) throw new BadRequestException(`Antes de cerrar: ${openTasks} tarea(s) y ${openIssues} incidencia(s) abiertas`);
    }
    if (to === 'EN_PAUSA') extra.pausedFrom = p.status;
    if (p.status === 'EN_PAUSA') extra.pausedFrom = null;
    if (['PERDIDA', 'CANCELADA'].includes(to)) extra.closeReason = reason;
    await this.setStatus(c, p, to, { reason, evidence: str(dto?.evidence, 500), extra, expectedVersion: dto?.expectedVersion });
    if (to === 'CANCELADA' || to === 'PERDIDA') await this.releaseAll(c, id, to);
    return this.detail(c, id);
  }

  /** Cambio de estado con control de versión, historial y ejecución del motor. */
  private async setStatus(c: Ctx, p: any, to: ProductionStatus, o: { reason?: string | null; evidence?: string | null; extra?: Record<string, unknown>; expectedVersion?: unknown; system?: string }) {
    const version = Number.isInteger(o.expectedVersion) ? Number(o.expectedVersion) : p.version;
    const res = await this.prisma.production.updateMany({
      where: { id: p.id, companyId: c.companyId, version, status: p.status },
      data: { status: to, ...(o.extra ?? {}), version: { increment: 1 }, updatedAt: this.now() },
    });
    if (!res.count) throw new ConflictException('Otra persona cambió esta producción. Recarga y vuelve a intentarlo.');
    await this.event(c.companyId, p.id, this.actor(c), 'status', `${STATUS_LABEL[p.status as ProductionStatus]} → ${STATUS_LABEL[to]}${o.reason ? `: ${o.reason}` : ''}${o.system ? ` (${o.system})` : ''}`, { from: p.status, to, reason: o.reason ?? null, evidence: o.evidence ?? null });
    await this.workflow?.schedule(c.companyId, 'production.status', `status:${p.id}:${to}:${version + 1}`, { status: to }, p.id);
  }

  /** Cancelada o perdida: se liberan las retenciones internas (no se avisa a nadie desde BackOffice). */
  private async releaseAll(c: Ctx, productionId: string, why: string) {
    const live: any[] = await this.prisma.productionAssignment.findMany({ where: { companyId: c.companyId, productionId, reservation: { in: ACTIVE_RESERVATION } } });
    for (const a of live) {
      await this.prisma.productionSlotLock.deleteMany({ where: { companyId: c.companyId, assignmentId: a.id } });
      await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { reservation: a.reservation === 'CONFIRMED' ? 'CANCELLED' : 'RELEASED', holdExpiresAt: null, version: { increment: 1 }, updatedAt: this.now() } });
    }
    if (live.length) await this.event(c.companyId, productionId, this.actor(c), 'resource', `Se liberaron ${live.length} reserva(s) internas por ${why === 'CANCELADA' ? 'cancelación' : 'pérdida'}. Avisar a los proveedores es manual.`);
    const open: any[] = await this.prisma.productionTask.findMany({ where: { companyId: c.companyId, productionId, status: { in: OPEN_TASK } } });
    for (const t of open) await this.prisma.productionTask.update({ where: { id: t.id }, data: { status: 'CANCELLED', updatedAt: this.now() } });
  }

  /* ── Tareas ── */

  async createTask(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const p: any = await this.production(c, id);
    if (TERMINAL.includes(p.status)) throw new BadRequestException('La producción está cerrada');
    const title = str(dto?.title, 200);
    if (!title) throw new BadRequestException('Escribe el título de la tarea');
    if (dto?.assigneeId) { this.need(c, 'assign'); await this.companyUser(c.companyId, dto.assigneeId, 'Responsable'); }
    const deps = Array.isArray(dto?.dependsOn) ? dto.dependsOn.filter((x: unknown) => typeof x === 'string').slice(0, 20) : [];
    if (deps.length) {
      const found = await this.prisma.productionTask.count({ where: { companyId: c.companyId, productionId: id, id: { in: deps } } });
      if (found !== deps.length) throw new BadRequestException('Una dependencia no es una tarea de esta producción');
    }
    const t = await this.prisma.productionTask.create({
      data: {
        companyId: c.companyId, productionId: id, title, description: str(dto?.description, 2000), assigneeId: dto?.assigneeId || null,
        dueAt: date(dto?.dueAt, 'Fecha límite'), priority: oneOf(dto?.priority, (await this.config(c.companyId)).priorities, 'Prioridad', 'NORMAL'),
        dependsOnJson: JSON.stringify(deps), origin: 'MANUAL', idempotencyKey: `manual:${randomBytes(8).toString('hex')}`,
        createdById: c.user.id, updatedAt: this.now(),
      },
    });
    await this.event(c.companyId, id, this.actor(c), 'task', `Creó la tarea «${title}»`, { taskId: t.id });
    return t;
  }

  async updateTask(user: AuthUser, taskId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const t: any = await this.prisma.productionTask.findFirst({ where: { id: taskId, companyId: c.companyId } });
    if (!t) throw new NotFoundException('Tarea no encontrada');
    const data: Record<string, unknown> = {};
    const notes: string[] = [];
    if ('status' in dto && dto.status !== t.status) {
      const status = oneOf(dto.status, TASK_STATUSES, 'Estado');
      if (['IN_PROGRESS', 'DONE'].includes(status)) {
        const deps = parseJson<string[]>(t.dependsOnJson, []);
        if (deps.length) {
          const pendingDeps: any[] = await this.prisma.productionTask.findMany({ where: { companyId: c.companyId, id: { in: deps }, status: { notIn: ['DONE', 'CANCELLED'] } } });
          if (pendingDeps.length) throw new BadRequestException(`Bloqueada: falta terminar ${pendingDeps.map((d) => `«${d.title}»`).join(', ')}`);
        }
      }
      data.status = status;
      if (status === 'DONE') { data.completedAt = this.now(); data.completedById = c.user.id; }
      notes.push(`estado → ${status}`);
    }
    if ('assigneeId' in dto && (dto.assigneeId || null) !== t.assigneeId) {
      this.need(c, 'assign');
      await this.companyUser(c.companyId, dto.assigneeId, 'Responsable');
      data.assigneeId = dto.assigneeId || null;
      notes.push('responsable');
    }
    if ('dueAt' in dto) { data.dueAt = date(dto.dueAt, 'Fecha límite'); notes.push('fecha límite'); }
    if ('title' in dto) { const v = str(dto.title, 200); if (v) { data.title = v; notes.push('título'); } }
    if ('description' in dto) { data.description = str(dto.description, 2000); notes.push('descripción'); }
    if (!notes.length) return t;
    const updated = await this.prisma.productionTask.update({ where: { id: t.id }, data: { ...data, updatedAt: this.now() } });
    await this.event(c.companyId, t.productionId, this.actor(c), 'task', `Tarea «${t.title}»: ${notes.join(', ')}`, { taskId: t.id });
    return updated;
  }

  /* ── Incidencias ── */

  async createIssue(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    await this.production(c, id);
    const description = str(dto?.description, 2000);
    if (!description) throw new BadRequestException('Describe la incidencia');
    const issue = await this.prisma.productionIssue.create({
      data: { companyId: c.companyId, productionId: id, kind: str(dto?.kind, 60) ?? 'OTRA', severity: oneOf(dto?.severity, ['LOW', 'MEDIUM', 'HIGH'] as const, 'Severidad', 'MEDIUM'), description, createdById: c.user.id },
    });
    await this.event(c.companyId, id, this.actor(c), 'issue', `Incidencia abierta (${issue.severity}): ${description.slice(0, 120)}`, { issueId: issue.id });
    return issue;
  }

  async resolveIssue(user: AuthUser, issueId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'edit');
    const issue: any = await this.prisma.productionIssue.findFirst({ where: { id: issueId, companyId: c.companyId } });
    if (!issue) throw new NotFoundException('Incidencia no encontrada');
    if (issue.status === 'RESOLVED') return issue;
    const resolution = str(dto?.resolution, 1000);
    if (!resolution) throw new BadRequestException('Escribe cómo se resolvió');
    const updated = await this.prisma.productionIssue.update({ where: { id: issue.id }, data: { status: 'RESOLVED', resolution, resolvedById: c.user.id, resolvedAt: this.now() } });
    await this.event(c.companyId, issue.productionId, this.actor(c), 'issue', `Incidencia resuelta: ${resolution.slice(0, 120)}`, { issueId: issue.id });
    return updated;
  }

  /* ── Recursos asignados, disponibilidad y reservas ── */

  async addAssignment(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const p: any = await this.production(c, id);
    if (TERMINAL.includes(p.status)) throw new BadRequestException('La producción está cerrada');
    const cfg = await this.config(c.companyId);
    const serviceType = oneOf(dto?.serviceType, cfg.serviceTypes.filter((s) => s.enabled).map((s) => s.key), 'Tipo de servicio');
    if (dto?.resourceId && !(await this.prisma.productionResource.findFirst({ where: { id: dto.resourceId, companyId: c.companyId } }))) {
      throw new BadRequestException('Recurso no encontrado en esta empresa');
    }
    const startsAt = date(dto?.startsAt, 'Inicio');
    const endsAt = date(dto?.endsAt, 'Fin');
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('El fin debe ser posterior al inicio');
    const a = await this.prisma.productionAssignment.create({
      data: {
        companyId: c.companyId, productionId: id, resourceId: dto?.resourceId || null, serviceType, label: str(dto?.label, 120),
        role: oneOf(dto?.role, ['CANDIDATE', 'SELECTED'] as const, 'Rol', 'CANDIDATE'), startsAt, endsAt, notes: str(dto?.notes, 1000), updatedAt: this.now(),
      },
    });
    const name = dto?.resourceId ? (await this.prisma.productionResource.findFirst({ where: { id: dto.resourceId } }))?.name : a.label;
    await this.event(c.companyId, id, this.actor(c), 'resource', `Agregó ${serviceType} ${name ? `«${name}» ` : ''}como ${a.role === 'SELECTED' ? 'seleccionado' : 'candidato'}`, { assignmentId: a.id });
    return a;
  }

  private async assignment(c: Ctx, assignmentId: string) {
    const a: any = await this.prisma.productionAssignment.findFirst({ where: { id: assignmentId, companyId: c.companyId } });
    if (!a) throw new NotFoundException('Recurso de la producción no encontrado');
    return a;
  }

  async updateAssignment(user: AuthUser, assignmentId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const a = await this.assignment(c, assignmentId);
    const data: Record<string, unknown> = {};
    if ('role' in dto) data.role = oneOf(dto.role, ['CANDIDATE', 'SELECTED'] as const, 'Rol');
    if ('label' in dto) data.label = str(dto.label, 120);
    if ('notes' in dto) data.notes = str(dto.notes, 1000);
    if ('startsAt' in dto || 'endsAt' in dto) {
      if (ACTIVE_RESERVATION.includes(a.reservation)) throw new BadRequestException('Libera la reserva antes de cambiar el horario');
      const s = 'startsAt' in dto ? date(dto.startsAt, 'Inicio') : a.startsAt;
      const e = 'endsAt' in dto ? date(dto.endsAt, 'Fin') : a.endsAt;
      if (s && e && e <= s) throw new BadRequestException('El fin debe ser posterior al inicio');
      data.startsAt = s;
      data.endsAt = e;
    }
    const updated = await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { ...data, version: { increment: 1 }, updatedAt: this.now() } });
    await this.event(c.companyId, a.productionId, this.actor(c), 'resource', `Actualizó un recurso (${Object.keys(data).join(', ')})`, { assignmentId: a.id });
    return updated;
  }

  /** Disponibilidad registrada por una persona: nunca se presenta como verificada por un sistema externo. */
  async setAvailability(user: AuthUser, assignmentId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const a = await this.assignment(c, assignmentId);
    const availability = oneOf(dto?.availability, ['NOT_CHECKED', 'ASKED', 'AVAILABLE', 'UNAVAILABLE'] as const, 'Disponibilidad');
    const note = str(dto?.note, 500);
    if (['AVAILABLE', 'UNAVAILABLE'].includes(availability) && !note) throw new BadRequestException('Anota cómo se consultó (quién respondió y por dónde)');
    await this.prisma.productionAssignment.update({
      where: { id: a.id },
      data: { availability, availabilitySource: 'MANUAL', availabilityNote: note, availabilityAt: this.now(), availabilityById: c.user.id, version: { increment: 1 }, updatedAt: this.now() },
    });
    const labels = { NOT_CHECKED: 'sin consultar', ASKED: 'consultada, sin respuesta', AVAILABLE: 'disponible', UNAVAILABLE: 'no disponible' };
    await this.event(c.companyId, a.productionId, this.actor(c), 'availability', `Disponibilidad ${labels[availability]} (registro manual)${note ? `: ${note}` : ''}`, { assignmentId: a.id });
    return this.assignment(c, a.id);
  }

  /** Toma (o renueva) los candados por hora del recurso. Si otra producción ocupa el tramo, nada queda tomado. */
  private async lockSlots(c: Ctx, a: any, kind: string, expiresAt: Date | null) {
    if (!a.resourceId) throw new BadRequestException('Elige un recurso concreto del catálogo para reservar');
    if (!a.startsAt || !a.endsAt) throw new BadRequestException('Indica inicio y fin para reservar');
    const slots = hourSlots(new Date(a.startsAt), new Date(a.endsAt));
    if (slots.length > 24 * 14) throw new BadRequestException('Una reserva no puede superar 14 días');
    const taken: string[] = [];
    for (const slotStart of slots) {
      const mine = await this.prisma.productionSlotLock.findFirst({ where: { companyId: c.companyId, resourceId: a.resourceId, slotStart, assignmentId: a.id } });
      if (mine) {
        await this.prisma.productionSlotLock.update({ where: { id: mine.id }, data: { kind, expiresAt } });
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const lock = await this.prisma.productionSlotLock.create({ data: { companyId: c.companyId, resourceId: a.resourceId, slotStart, assignmentId: a.id, productionId: a.productionId, kind, expiresAt } });
          taken.push(lock.id);
          break;
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e;
          const other: any = await this.prisma.productionSlotLock.findFirst({ where: { companyId: c.companyId, resourceId: a.resourceId, slotStart } });
          // Retención vencida de otra producción: se libera y se reintenta una vez
          if (attempt === 0 && other && other.kind === 'HOLD' && other.expiresAt && new Date(other.expiresAt) < this.now()) {
            await this.expireHold(c.companyId, other.assignmentId, 'tomada por otra producción');
            continue;
          }
          for (const id of taken) await this.prisma.productionSlotLock.delete({ where: { id } }).catch(() => undefined);
          const otherProd: any = other ? await this.prisma.production.findFirst({ where: { id: other.productionId, companyId: c.companyId } }) : null;
          throw new ConflictException(`El recurso ya está ${other?.kind === 'CONFIRMED' ? 'confirmado' : 'retenido'} en ${otherProd?.code ?? 'otra producción'} para ese horario`);
        }
      }
    }
  }

  /** Libera una retención vencida (la usan el barrido del motor y el candado). */
  async expireHold(companyId: string, assignmentId: string, why = 'venció') {
    const a: any = await this.prisma.productionAssignment.findFirst({ where: { id: assignmentId, companyId } });
    if (!a || a.reservation !== 'HOLD' || !a.holdExpiresAt || new Date(a.holdExpiresAt) > this.now()) return false;
    await this.prisma.productionSlotLock.deleteMany({ where: { companyId, assignmentId } });
    await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { reservation: 'RELEASED', holdExpiresAt: null, version: { increment: 1 }, updatedAt: this.now() } });
    await this.event(companyId, a.productionId, { type: 'SYSTEM', name: 'Motor de Automation' }, 'reservation', `Retención liberada: ${why}`, { assignmentId: a.id });
    return true;
  }

  async hold(user: AuthUser, assignmentId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const a = await this.assignment(c, assignmentId);
    if (!['NONE', 'RELEASED', 'CANCELLED', 'HOLD'].includes(a.reservation)) throw new BadRequestException('Este recurso ya tiene una reserva en curso');
    const cfg = await this.config(c.companyId);
    const hours = confirmedHoldHours(cfg);
    let expires = date(dto?.holdExpiresAt, 'Vence');
    if (!expires && hours) expires = new Date(this.now().getTime() + hours * 3600e3);
    // Sin regla confirmada no se inventa un plazo: se exige la fecha
    if (!expires) throw new BadRequestException('La duración de las retenciones está pendiente de configurar: indica hasta cuándo se retiene');
    if (expires <= this.now()) throw new BadRequestException('El vencimiento debe ser futuro');
    await this.lockSlots(c, a, 'HOLD', expires);
    await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { reservation: 'HOLD', holdExpiresAt: expires, version: { increment: 1 }, updatedAt: this.now() } });
    await this.event(c.companyId, a.productionId, this.actor(c), 'reservation', `Retención temporal hasta ${expires.toISOString()} (no es una confirmación)`, { assignmentId: a.id });
    return this.assignment(c, a.id);
  }

  async requestConfirmation(user: AuthUser, assignmentId: string, _dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const a = await this.assignment(c, assignmentId);
    if (!['NONE', 'HOLD', 'RELEASED'].includes(a.reservation)) throw new BadRequestException('Estado de reserva no válido para pedir confirmación');
    await this.lockSlots(c, a, 'PENDING_CONFIRMATION', null);
    await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { reservation: 'PENDING_CONFIRMATION', holdExpiresAt: null, version: { increment: 1 }, updatedAt: this.now() } });
    await this.event(c.companyId, a.productionId, this.actor(c), 'reservation', 'Reserva pendiente de confirmación (BackOffice no contactó a nadie)', { assignmentId: a.id });
    return this.assignment(c, a.id);
  }

  async confirm(user: AuthUser, assignmentId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'confirm');
    const a = await this.assignment(c, assignmentId);
    const p: any = await this.production(c, a.productionId);
    if (!['ACEPTADA_POR_CLIENTE', 'CONFIRMACION_DE_RECURSOS_PENDIENTE', 'CONFIRMADA', 'EN_PRODUCCION'].includes(p.status)) {
      throw new BadRequestException('Solo se confirman recursos después de que el cliente acepta la cotización');
    }
    if (!['HOLD', 'PENDING_CONFIRMATION'].includes(a.reservation)) throw new BadRequestException('Primero retén o pide confirmación del recurso');
    const evidence = str(dto?.evidence, 500);
    if (!evidence) throw new BadRequestException('Indica quién confirmó y por dónde');
    await this.lockSlots(c, a, 'CONFIRMED', null);
    await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { reservation: 'CONFIRMED', role: 'SELECTED', holdExpiresAt: null, confirmedById: c.user.id, confirmedAt: this.now(), version: { increment: 1 }, updatedAt: this.now() } });
    await this.event(c.companyId, a.productionId, this.actor(c), 'reservation', `Reserva confirmada: ${evidence}`, { assignmentId: a.id });
    return this.assignment(c, a.id);
  }

  async release(user: AuthUser, assignmentId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const a = await this.assignment(c, assignmentId);
    if (!ACTIVE_RESERVATION.includes(a.reservation)) return a;
    if (a.reservation === 'CONFIRMED') this.need(c, 'confirm');
    const reason = str(dto?.reason, 300);
    if (a.reservation === 'CONFIRMED' && !reason) throw new BadRequestException('Escribe por qué se cancela una reserva confirmada');
    await this.prisma.productionSlotLock.deleteMany({ where: { companyId: c.companyId, assignmentId: a.id } });
    await this.prisma.productionAssignment.update({ where: { id: a.id }, data: { reservation: a.reservation === 'CONFIRMED' ? 'CANCELLED' : 'RELEASED', holdExpiresAt: null, version: { increment: 1 }, updatedAt: this.now() } });
    await this.event(c.companyId, a.productionId, this.actor(c), 'reservation', `Reserva ${a.reservation === 'CONFIRMED' ? 'cancelada' : 'liberada'}${reason ? `: ${reason}` : ''} (avisar al proveedor es manual)`, { assignmentId: a.id });
    return this.assignment(c, a.id);
  }

  /* ── Cotizaciones ── */

  private async quote(c: Ctx, quoteId: string) {
    const q: any = await this.prisma.productionQuote.findFirst({ where: { id: quoteId, companyId: c.companyId } });
    if (!q) throw new NotFoundException('Cotización no encontrada');
    return q;
  }

  async createQuote(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'quotes');
    const p: any = await this.production(c, id);
    const open = await this.prisma.productionQuote.findFirst({ where: { companyId: c.companyId, productionId: id, status: { in: ['DRAFT', 'PENDING_APPROVAL'] } } });
    if (open) throw new BadRequestException(`Ya hay una versión ${open.status === 'DRAFT' ? 'en borrador' : 'por aprobar'} (v${open.version})`);
    const reopen = ['COTIZACION_APROBADA', 'COTIZACION_ENVIADA', 'PENDIENTE_RESPUESTA_CLIENTE'].includes(p.status);
    if (p.status !== 'PROPUESTA_EN_PREPARACION' && !reopen) {
      throw new BadRequestException('Las cotizaciones se preparan en «Propuesta en preparación»');
    }
    const last: any = await this.prisma.productionQuote.findFirst({ where: { companyId: c.companyId, productionId: id }, orderBy: { version: 'desc' } });
    const base: any = dto?.fromQuoteId ? await this.quote(c, dto.fromQuoteId) : last;
    if (base && base.productionId !== id) throw new BadRequestException('Esa cotización es de otra producción');
    const lines = dto?.lines ? sanitizeLines(dto.lines) : parseJson<QuoteLine[]>(base?.linesJson, []);
    const version = (last?.version ?? 0) + 1;
    const q = await this.prisma.productionQuote.create({
      data: {
        companyId: c.companyId, productionId: id, version, status: 'DRAFT', currency: str(dto?.currency, 3) ?? base?.currency ?? 'COP',
        linesJson: JSON.stringify(lines), totalsJson: JSON.stringify(quoteTotals(lines)), basedOnId: base?.id ?? null,
        diffJson: base ? JSON.stringify(quoteDiff(parseJson(base.linesJson, []), lines)) : null, notes: str(dto?.notes, 2000), createdById: c.user.id, updatedAt: this.now(),
      },
    });
    await this.event(c.companyId, id, this.actor(c), 'quote', `Cotización v${version} creada en borrador${base ? ` a partir de v${base.version}` : ''}`, { quoteId: q.id });
    if (reopen) await this.setStatus(c, await this.production(c, id), 'PROPUESTA_EN_PREPARACION', { reason: `nueva versión v${version}`, system: 'cotización' });
    return this.detail(c, id);
  }

  async updateQuote(user: AuthUser, quoteId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'quotes');
    const q = await this.quote(c, quoteId);
    if (q.status !== 'DRAFT') throw new BadRequestException('Solo se edita un borrador. Crea una nueva versión para cambiar una cotización enviada a aprobación o aprobada.');
    const lines = sanitizeLines(dto?.lines ?? parseJson(q.linesJson, []));
    const base: any = q.basedOnId ? await this.prisma.productionQuote.findFirst({ where: { id: q.basedOnId, companyId: c.companyId } }) : null;
    await this.prisma.productionQuote.update({
      where: { id: q.id },
      data: {
        linesJson: JSON.stringify(lines), totalsJson: JSON.stringify(quoteTotals(lines)), notes: 'notes' in (dto ?? {}) ? str(dto.notes, 2000) : q.notes,
        currency: str(dto?.currency, 3) ?? q.currency, diffJson: base ? JSON.stringify(quoteDiff(parseJson(base.linesJson, []), lines)) : null, updatedAt: this.now(),
      },
    });
    await this.event(c.companyId, q.productionId, this.actor(c), 'quote', `Editó la cotización v${q.version} (${lines.length} línea(s))`, { quoteId: q.id });
    return this.detail(c, q.productionId);
  }

  async submitQuote(user: AuthUser, quoteId: string, _dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'quotes');
    const q = await this.quote(c, quoteId);
    if (q.status !== 'DRAFT') throw new BadRequestException('Solo un borrador se envía a aprobación');
    const p: any = await this.production(c, q.productionId);
    if (p.status !== 'PROPUESTA_EN_PREPARACION') throw new BadRequestException('La producción debe estar en «Propuesta en preparación»');
    const cfg = await this.config(c.companyId);
    const miss = missingFields(parseJson(p.briefJson, {}), cfg.brief.requiredToQuote);
    if (miss.length) throw new BadRequestException(`Para cotizar falta en el brief: ${miss.map((m) => m.label).join(', ')}`);
    if (!parseJson<QuoteLine[]>(q.linesJson, []).length) throw new BadRequestException('La cotización no tiene líneas');
    const res = await this.prisma.productionQuote.updateMany({ where: { id: q.id, companyId: c.companyId, status: 'DRAFT' }, data: { status: 'PENDING_APPROVAL', submittedById: c.user.id, submittedAt: this.now(), updatedAt: this.now() } });
    if (!res.count) throw new ConflictException('La cotización cambió; recarga');
    await this.event(c.companyId, q.productionId, this.actor(c), 'quote', `Cotización v${q.version} enviada a aprobación interna`, { quoteId: q.id });
    await this.setStatus(c, p, 'COTIZACION_PENDIENTE_APROBACION', { system: `cotización v${q.version}` });
    return this.detail(c, q.productionId);
  }

  async decideQuote(user: AuthUser, quoteId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'approve');
    const q = await this.quote(c, quoteId);
    if (q.status !== 'PENDING_APPROVAL') throw new BadRequestException('La cotización no está pendiente de aprobación');
    const approve = dto?.decision === 'APPROVE';
    if (!approve && dto?.decision !== 'REJECT') throw new BadRequestException('Decisión inválida');
    const note = str(dto?.note, 1000);
    if (!approve && !note) throw new BadRequestException('Escribe por qué se rechaza');
    const totals = quoteTotals(parseJson<QuoteLine[]>(q.linesJson, []));
    if (approve && !totals.complete) throw new BadRequestException(`No se puede aprobar con valores pendientes: ${totals.pending.map((x) => x.what).slice(0, 3).join('; ')}`);
    const res = await this.prisma.productionQuote.updateMany({
      where: { id: q.id, companyId: c.companyId, status: 'PENDING_APPROVAL' },
      data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: c.user.id, decidedByName: c.actorName, decidedAt: this.now(), decisionNote: note, updatedAt: this.now() },
    });
    if (!res.count) throw new ConflictException('Otra persona ya decidió esta cotización');
    const p: any = await this.production(c, q.productionId);
    if (approve) {
      await this.prisma.productionQuote.updateMany({ where: { companyId: c.companyId, productionId: q.productionId, status: 'APPROVED', id: { not: q.id } }, data: { status: 'SUPERSEDED', updatedAt: this.now() } });
      await this.event(c.companyId, q.productionId, this.actor(c), 'approval', `Cotización v${q.version} APROBADA por ${c.actorName}${note ? `: ${note}` : ''}`, { quoteId: q.id });
      await this.setStatus(c, p, 'COTIZACION_APROBADA', { extra: { approvedQuoteId: q.id }, system: `aprobación v${q.version}` });
    } else {
      await this.event(c.companyId, q.productionId, this.actor(c), 'approval', `Cotización v${q.version} RECHAZADA por ${c.actorName}: ${note}`, { quoteId: q.id });
      await this.setStatus(c, p, 'PROPUESTA_EN_PREPARACION', { reason: 'cotización rechazada', system: `rechazo v${q.version}` });
    }
    // La tarea de aprobación de esta versión se cierra con el motivo
    const t: any = await this.prisma.productionTask.findFirst({ where: { companyId: c.companyId, idempotencyKey: `rule:APPROVE:${q.productionId}:v${q.version}` } });
    if (t && OPEN_TASK.includes(t.status)) await this.prisma.productionTask.update({ where: { id: t.id }, data: { status: 'DONE', completedAt: this.now(), completedById: c.user.id, reason: approve ? 'Cotización aprobada' : 'Cotización rechazada', updatedAt: this.now() } });
    await this.audit.log({ actor: c.user, companyId: c.companyId, action: approve ? 'production.quote.approve' : 'production.quote.reject', entity: 'ProductionQuote', entityId: q.id, detail: `${p.code} v${q.version}` });
    return this.detail(c, q.productionId);
  }

  /** BackOffice no envía cotizaciones: esto registra que el booker la envió por su cuenta. */
  async markQuoteSent(user: AuthUser, quoteId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'quotes');
    const q = await this.quote(c, quoteId);
    const p: any = await this.production(c, q.productionId);
    if (q.status !== 'APPROVED' || p.approvedQuoteId !== q.id) throw new BadRequestException('Solo se registra el envío de la versión aprobada vigente');
    if (p.status !== 'COTIZACION_APROBADA') throw new BadRequestException('La producción debe estar en «Cotización aprobada»');
    const note = str(dto?.note, 500);
    if (!note) throw new BadRequestException('Indica cómo y cuándo se envió (por ejemplo: «PDF por WhatsApp a las 3 p. m.»)');
    await this.prisma.productionQuote.update({ where: { id: q.id }, data: { sentManuallyAt: this.now(), sentManuallyNote: note, updatedAt: this.now() } });
    await this.setStatus(c, p, 'COTIZACION_ENVIADA', { reason: `enviada por fuera de BackOffice: ${note}`, system: `v${q.version}` });
    return this.detail(c, q.productionId);
  }

  /* ── Catálogo de recursos ── */

  async listResources(user: AuthUser, q: any) {
    const c = await this.ctx(user, q?.companyId, 'view');
    let rows: any[] = await this.prisma.productionResource.findMany({ where: { companyId: c.companyId }, orderBy: { name: 'asc' }, take: 5000 });
    if (q?.kind) rows = rows.filter((r) => r.kind === q.kind);
    if (q?.active === 'true') rows = rows.filter((r) => r.active);
    const text = String(q?.q ?? '').trim().toLowerCase();
    if (text) rows = rows.filter((r) => [r.name, r.contactName, r.phone, r.email].some((v) => v && String(v).toLowerCase().includes(text)));
    const finance = c.perms.has('finance');
    const rates: any[] = finance && rows.length ? await this.prisma.productionRate.findMany({ where: { companyId: c.companyId, resourceId: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: 'desc' } }) : [];
    return rows.map((r) => ({
      ...r, attrs: parseJson(r.attrsJson, {}), fileRefs: parseJson(r.fileRefsJson, []),
      rates: finance ? rates.filter((x) => x.resourceId === r.id) : undefined, ratesHidden: !finance,
    }));
  }

  async saveResource(user: AuthUser, id: string | null, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'resources');
    const existing: any = id ? await this.prisma.productionResource.findFirst({ where: { id, companyId: c.companyId } }) : null;
    if (id && !existing) throw new NotFoundException('Recurso no encontrado');
    const name = 'name' in (dto ?? {}) || !existing ? str(dto?.name, 120) : existing.name;
    if (!name) throw new BadRequestException('Escribe el nombre');
    const attrs = dto?.attrs && typeof dto.attrs === 'object' ? Object.fromEntries(Object.entries(dto.attrs).slice(0, 30).map(([k, v]) => [String(k).slice(0, 40), str(v, 300)])) : undefined;
    const fileRefs = Array.isArray(dto?.fileRefs) ? dto.fileRefs.slice(0, 50).map((f: any) => {
      const provider = oneOf(f?.provider, ['DROPBOX', 'URL', 'OTHER'] as const, 'Origen del archivo', 'OTHER');
      const ref = str(f?.ref, 500);
      if (!ref) throw new BadRequestException('Cada archivo necesita una ruta o enlace');
      if (provider === 'URL' && !/^https:\/\//i.test(ref)) throw new BadRequestException('Los enlaces deben empezar por https://');
      // Solo una referencia: BackOffice no descarga ni verifica el archivo
      return { provider, ref, label: str(f?.label, 120), verified: false };
    }) : undefined;
    const data: any = {
      name, kind: existing && !('kind' in (dto ?? {})) ? existing.kind : oneOf(dto?.kind, RESOURCE_KINDS, 'Tipo'),
      ...('contactName' in (dto ?? {}) || !existing ? { contactName: str(dto?.contactName, 120) } : {}),
      ...('phone' in (dto ?? {}) || !existing ? { phone: str(dto?.phone, 40) } : {}),
      ...('email' in (dto ?? {}) || !existing ? { email: str(dto?.email, 160) } : {}),
      ...('notes' in (dto ?? {}) || !existing ? { notes: str(dto?.notes, 2000) } : {}),
      ...('active' in (dto ?? {}) ? { active: dto.active !== false } : {}),
      ...('owned' in (dto ?? {}) ? { owned: dto.owned === true } : {}),
      ...(attrs ? { attrsJson: JSON.stringify(attrs) } : {}),
      ...(fileRefs ? { fileRefsJson: JSON.stringify(fileRefs) } : {}),
      updatedAt: this.now(),
    };
    const saved = existing
      ? await this.prisma.productionResource.update({ where: { id: existing.id }, data })
      : await this.prisma.productionResource.create({ data: { ...data, companyId: c.companyId } });
    await this.audit.log({ actor: c.user, companyId: c.companyId, action: existing ? 'production.resource.update' : 'production.resource.create', entity: 'ProductionResource', entityId: saved.id, detail: `${saved.kind}: ${saved.name}` });
    return { ...saved, attrs: parseJson(saved.attrsJson, {}), fileRefs: parseJson(saved.fileRefsJson, []) };
  }

  async addRate(user: AuthUser, resourceId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'rates');
    const r = await this.prisma.productionResource.findFirst({ where: { id: resourceId, companyId: c.companyId } });
    if (!r) throw new NotFoundException('Recurso no encontrado');
    const amountRaw = dto?.amount;
    const amount = amountRaw === null || amountRaw === undefined || amountRaw === '' ? null : Number(amountRaw);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new BadRequestException('Valor inválido');
    const rate = await this.prisma.productionRate.create({
      data: {
        companyId: c.companyId, resourceId, kind: oneOf(dto?.kind, ['COST', 'PRICE'] as const, 'Tipo de tarifa'),
        unit: oneOf(dto?.unit, ['HOUR', 'HALF_DAY', 'FULL_DAY', 'DAY', 'PROJECT', 'OTHER'] as const, 'Unidad'), amount,
        currency: str(dto?.currency, 3) ?? 'COP', status: amount === null ? 'PENDING' : oneOf(dto?.status, ['PENDING', 'CONFIRMED', 'HISTORICAL'] as const, 'Estado', 'PENDING'),
        validFrom: date(dto?.validFrom, 'Vigente desde'), notes: str(dto?.notes, 500), createdById: c.user.id,
      },
    });
    await this.audit.log({ actor: c.user, companyId: c.companyId, action: 'production.rate.create', entity: 'ProductionRate', entityId: rate.id, detail: `${r.name}: ${rate.kind} ${rate.unit}` });
    return rate;
  }

  /* ── Equipo y configuración ── */

  async team(user: AuthUser, companyId?: string) {
    const c = await this.ctx(user, companyId, 'view');
    const users: any[] = await this.prisma.user.findMany({ where: { companyId: c.companyId, active: true }, select: { id: true, name: true, email: true, role: true, opsProfile: true } });
    const canSee = c.perms.has('settings');
    return {
      profiles: OPS_PROFILES.map((k) => ({ key: k, label: PROFILE_LABEL[k], permissions: PROFILE_PERMISSIONS[k] })),
      permissionLabels: PERMISSION_LABEL,
      users: users.filter((u) => !isPlatformRole(u.role)).map((u) => {
        const profile = effectiveProfile(u);
        return { id: u.id, name: u.name, ...(canSee ? { email: u.email } : {}), role: u.role, opsProfile: u.opsProfile ?? null, effectiveProfile: profile, permissions: profile ? PROFILE_PERMISSIONS[profile] : [] };
      }),
      me: { profile: c.profile, permissions: [...c.perms] },
    };
  }

  async setProfile(user: AuthUser, userId: string, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'settings');
    const target: any = await this.prisma.user.findFirst({ where: { id: userId, companyId: c.companyId } });
    if (!target) throw new NotFoundException('Usuario no encontrado en esta empresa');
    if (target.role !== 'COMPANY_VIEWER') throw new BadRequestException(target.role === 'COMPANY_ADMIN' ? 'Un administrador de la empresa ya tiene acceso total' : 'Este rol no usa Producciones');
    const profile = dto?.profile === null || dto?.profile === '' ? null : oneOf(dto?.profile, OPS_PROFILES, 'Perfil');
    if (profile === 'ADMIN') throw new BadRequestException('Para administración, cambia el rol del usuario a administrador de la empresa');
    await this.prisma.user.update({ where: { id: target.id }, data: { opsProfile: profile } });
    await this.audit.log({ actor: c.user, companyId: c.companyId, action: 'production.profile', entity: 'User', entityId: target.id, detail: `${target.name}: ${target.opsProfile ?? 'VIEWER'} → ${profile ?? 'VIEWER'}` });
    return this.team(user, companyId);
  }

  async getSettings(user: AuthUser, companyId?: string) {
    const c = await this.ctx(user, companyId, 'view');
    const company: any = await this.prisma.company.findUnique({ where: { id: c.companyId }, select: { id: true, name: true, city: true, contactEmail: true, contactPhone: true, timezone: true, currency: true } });
    return { company, config: await this.config(c.companyId), briefFields: BRIEF_FIELDS, permissions: PERMISSIONS, canEdit: c.perms.has('settings') };
  }

  async saveSettings(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.ctx(user, companyId, 'settings');
    const merged = mergeConfig({ ...(await this.config(c.companyId)), ...(dto?.config ?? {}) });
    await this.prisma.productionSettings.upsert({
      where: { companyId: c.companyId },
      create: { companyId: c.companyId, configJson: JSON.stringify(merged), updatedBy: c.actorName },
      update: { configJson: JSON.stringify(merged), updatedBy: c.actorName, updatedAt: this.now() },
    });
    await this.audit.log({ actor: c.user, companyId: c.companyId, action: 'production.settings', entity: 'ProductionSettings', entityId: c.companyId, detail: Object.keys(dto?.config ?? {}).join(', ').slice(0, 200) });
    return this.getSettings(user, companyId);
  }

  /** Ejecuciones del motor (errores y reintentos visibles). */
  async runs(user: AuthUser, q: any) {
    const c = await this.ctx(user, q?.companyId, 'view');
    const rows: any[] = await this.prisma.workflowRun.findMany({ where: { companyId: c.companyId, ...(q?.productionId ? { productionId: String(q.productionId) } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => ({ ...r, payload: parseJson(r.payloadJson, {}), error: parseJson(r.errorJson, null), result: parseJson(r.resultJson, null) }));
  }
}
