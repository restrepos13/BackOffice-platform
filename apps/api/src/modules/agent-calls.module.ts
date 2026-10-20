import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole } from '../common/constants';
import { AuditModule, AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';

/**
 * Citas con un agente de BackOffice. Todo lo técnico (conectar la IA, el
 * WhatsApp, las plantillas de Meta) lo hace nuestro equipo en una llamada:
 * el cliente elige día y hora con dos toques y el equipo recibe el aviso.
 *
 * Horario de agentes (hora Colombia, UTC-5 fijo): lunes a viernes 8:00-18:00
 * y sábados 9:00-12:00, cada 30 min, con anticipación mínima de 2 horas.
 */

export const CALL_TOPICS: Record<string, string> = {
  SETUP: 'Dejar mi empresa lista',
  AI: 'Conectar la inteligencia artificial',
  WHATSAPP: 'Conectar mi WhatsApp',
  TEMPLATES: 'Plantillas de mensajes de Meta',
  PLAN: 'Elegir mi plan',
  TEAM: 'Organizar mi equipo en BackOffice',
  OTHER: 'Otra cosa',
};

export const CALL_STATUS_LABELS: Record<string, string> = {
  REQUESTED: 'Por confirmar', CONFIRMED: 'Confirmada', DONE: 'Hecha', CANCELLED: 'Cancelada', NO_SHOW: 'No contestó',
};

const OPEN = ['REQUESTED', 'CONFIRMED'];
const BOGOTA_OFFSET_H = 5;
const DAYS_AHEAD = 8;
const MIN_LEAD_MS = 2 * 3600e3;
const SLOT_MIN = 30;
/** Llamadas simultáneas que puede atender el equipo */
const AGENTS_PER_SLOT = 2;
const MAX_OPEN_PER_COMPANY = 3;
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DEFAULT_NOTIFY = 'restrepos591@gmail.com';

/** Fecha/hora local de Bogotá de un instante. */
function bogota(d: Date) {
  const l = new Date(d.getTime() - BOGOTA_OFFSET_H * 3600e3);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth(), d: l.getUTCDate(), dow: l.getUTCDay(), h: l.getUTCHours(), min: l.getUTCMinutes() };
}

/** Instante de una hora local de Bogotá. */
function fromBogota(y: number, m: number, d: number, h: number, min: number) {
  return new Date(Date.UTC(y, m, d, h + BOGOTA_OFFSET_H, min));
}

export function slotLabel(at: Date, now = new Date()): string {
  const b = bogota(at);
  const today = bogota(now);
  const tomorrow = bogota(new Date(now.getTime() + 86400e3));
  const same = (x: typeof b) => x.y === b.y && x.m === b.m && x.d === b.d;
  const day = same(today) ? 'hoy' : same(tomorrow) ? 'mañana' : `el ${WEEKDAYS[b.dow]} ${b.d} de ${MONTHS[b.m]}`;
  const h12 = b.h % 12 === 0 ? 12 : b.h % 12;
  return `${day} a las ${h12}:${String(b.min).padStart(2, '0')} ${b.h < 12 ? 'a. m.' : 'p. m.'}`;
}

/** Ventanas de atención de un día de la semana (horas locales). */
function hoursFor(dow: number): [number, number] | null {
  if (dow === 0) return null;
  if (dow === 6) return [9, 12];
  return [8, 18];
}

/** Todos los turnos posibles de los próximos días (sin descontar ocupados). */
export function candidateSlots(now = new Date()): Date[] {
  const out: Date[] = [];
  const start = bogota(now);
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const base = new Date(Date.UTC(start.y, start.m, start.d + i));
    const hours = hoursFor(base.getUTCDay());
    if (!hours) continue;
    for (let h = hours[0]; h < hours[1]; h++) {
      for (let min = 0; min < 60; min += SLOT_MIN) {
        const at = fromBogota(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, min);
        if (at.getTime() - now.getTime() >= MIN_LEAD_MS) out.push(at);
      }
    }
  }
  return out;
}

function esc(v: unknown) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function digits(phone: string) {
  const d = phone.replace(/\D/g, '');
  return d.length === 10 && d.startsWith('3') ? `57${d}` : d;
}

@Injectable()
export class AgentCallsService {
  private readonly logger = new Logger('AgentCalls');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
  ) {}

  private companyIdOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  /** Turnos libres agrupados por día, listos para tocar. */
  async slots(now = new Date()) {
    const all = candidateSlots(now);
    if (!all.length) return { days: [] };
    const taken = await this.prisma.agentCall.findMany({
      where: { status: { in: OPEN }, slotAt: { gte: all[0], lte: all[all.length - 1] } },
      select: { slotAt: true },
    });
    const count = new Map<number, number>();
    for (const t of taken) count.set(new Date(t.slotAt).getTime(), (count.get(new Date(t.slotAt).getTime()) ?? 0) + 1);
    const days: Array<{ date: string; label: string; slots: Array<{ at: string; label: string }> }> = [];
    for (const at of all) {
      if ((count.get(at.getTime()) ?? 0) >= AGENTS_PER_SLOT) continue;
      const b = bogota(at);
      const date = `${b.y}-${String(b.m + 1).padStart(2, '0')}-${String(b.d).padStart(2, '0')}`;
      let day = days.find((x) => x.date === date);
      if (!day) {
        const full = slotLabel(at, now);
        day = { date, label: full.slice(0, full.indexOf(' a las')).replace(/^el /, ''), slots: [] };
        days.push(day);
      }
      const h12 = b.h % 12 === 0 ? 12 : b.h % 12;
      day.slots.push({ at: at.toISOString(), label: `${h12}:${String(b.min).padStart(2, '0')} ${b.h < 12 ? 'a. m.' : 'p. m.'}` });
    }
    return { days: days.slice(0, 6) };
  }

  private view(c: any, now = new Date()) {
    return {
      id: c.id, companyId: c.companyId, topic: c.topic, topicLabel: CALL_TOPICS[c.topic] ?? c.topic,
      slotAt: c.slotAt, when: slotLabel(new Date(c.slotAt), now), phone: c.phone, notes: c.notes ?? null,
      status: c.status, statusLabel: CALL_STATUS_LABELS[c.status] ?? c.status, agentName: c.agentName ?? null,
      meetUrl: c.meetUrl ?? null, doneNotes: c.doneNotes ?? null, requestedBy: c.requestedBy, createdAt: c.createdAt,
    };
  }

  async mine(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const rows = await this.prisma.agentCall.findMany({ where: { companyId: id }, orderBy: { slotAt: 'desc' }, take: 20 });
    const now = new Date();
    const list = rows.map((r: any) => this.view(r, now));
    return {
      next: list.filter((c: any) => OPEN.includes(c.status) && new Date(c.slotAt).getTime() > now.getTime() - 3600e3).sort((a: any, b: any) => +new Date(a.slotAt) - +new Date(b.slotAt))[0] ?? null,
      history: list,
      topics: CALL_TOPICS,
    };
  }

  async book(user: AuthUser, dto: { slotAt?: string; topic?: string; phone?: string; notes?: string }, companyId?: string, now = new Date()) {
    const id = this.companyIdOf(user, companyId);
    const topic = dto?.topic && dto.topic in CALL_TOPICS ? dto.topic : 'SETUP';
    const at = new Date(String(dto?.slotAt ?? ''));
    if (Number.isNaN(at.getTime())) throw new BadRequestException('Elige un día y una hora');
    const phone = String(dto?.phone ?? '').replace(/[^\d+ ]/g, '').trim();
    if (phone.replace(/\D/g, '').length < 7) throw new BadRequestException('Escribe un número donde te podamos llamar');
    const { days } = await this.slots(now);
    const free = days.some((d) => d.slots.some((s) => s.at === at.toISOString()));
    if (!free) throw new BadRequestException('Esa hora ya no está disponible. Elige otra, por favor.');
    const open = await this.prisma.agentCall.count({ where: { companyId: id, status: { in: OPEN } } });
    if (open >= MAX_OPEN_PER_COMPANY) throw new BadRequestException('Ya tienes citas pendientes. Si necesitas cambiar una, cancélala y agenda otra.');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const call = await this.prisma.agentCall.create({
      data: {
        companyId: id, userId: user.id, requestedBy: user.name, topic, slotAt: at, phone,
        notes: dto?.notes ? String(dto.notes).slice(0, 500) : null, status: 'REQUESTED', createdAt: now, updatedAt: now,
      },
    });
    await this.audit.log({ actor: user, companyId: id, action: 'agent_call.book', entity: 'AgentCall', entityId: call.id, detail: `${CALL_TOPICS[topic]} · ${slotLabel(at, now)}` });
    const wa = digits(phone);
    await this.notifyTeam(
      `Cita agendada: ${company.name} — ${slotLabel(at, now)}`,
      `<p><b>${esc(company.name)}</b> agendó una llamada con un agente.</p>
       <p><b>Cuándo:</b> ${esc(slotLabel(at, now))} (hora Colombia)</p>
       <p><b>Para:</b> ${esc(CALL_TOPICS[topic])}</p>
       <p><b>Quién:</b> ${esc(user.name)} · ${esc(phone)}${wa ? ` · <a href="https://wa.me/${wa}">escribirle por WhatsApp</a>` : ''}</p>
       ${call.notes ? `<p><b>Nota:</b> ${esc(call.notes)}</p>` : ''}
       <p>Confírmala en Plataforma → Citas.</p>`,
    );
    return this.view(call, now);
  }

  async cancel(user: AuthUser, callId: string, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const call = await this.prisma.agentCall.findUnique({ where: { id: callId } });
    if (!call || call.companyId !== id) throw new NotFoundException('Cita no encontrada');
    if (!OPEN.includes(call.status)) throw new BadRequestException('Esa cita ya no se puede cancelar');
    const updated = await this.prisma.agentCall.update({ where: { id: callId }, data: { status: 'CANCELLED', cancelledBy: user.name, updatedAt: new Date() } });
    await this.audit.log({ actor: user, companyId: id, action: 'agent_call.cancel', entity: 'AgentCall', entityId: callId, detail: slotLabel(new Date(call.slotAt)) });
    return this.view(updated);
  }

  /* ── Equipo de BackOffice ── */

  async list(status?: string) {
    const where: any = status === 'OPEN' ? { status: { in: OPEN } } : status && status in CALL_STATUS_LABELS ? { status } : {};
    const rows = await this.prisma.agentCall.findMany({ where, orderBy: { slotAt: status === 'OPEN' ? 'asc' : 'desc' }, take: 200 });
    const companies = await this.prisma.company.findMany({ where: { id: { in: [...new Set(rows.map((r: any) => r.companyId))] as string[] } }, select: { id: true, name: true, planId: true, status: true } });
    const byId = new Map(companies.map((c: any) => [c.id, c]));
    const now = new Date();
    return rows.map((r: any) => ({ ...this.view(r, now), companyName: byId.get(r.companyId)?.name ?? '—', companyHasPlan: !!byId.get(r.companyId)?.planId }));
  }

  async update(user: AuthUser, callId: string, dto: { status?: string; agentName?: string; meetUrl?: string; doneNotes?: string; slotAt?: string }) {
    const call = await this.prisma.agentCall.findUnique({ where: { id: callId } });
    if (!call) throw new NotFoundException('Cita no encontrada');
    const data: Record<string, any> = { updatedAt: new Date() };
    if (dto.status !== undefined) {
      if (!(dto.status in CALL_STATUS_LABELS)) throw new BadRequestException('Estado inválido');
      data.status = dto.status;
    }
    if (dto.agentName !== undefined) data.agentName = String(dto.agentName).slice(0, 80) || null;
    if (dto.meetUrl !== undefined) {
      const url = String(dto.meetUrl).trim();
      if (url && !/^https:\/\//.test(url)) throw new BadRequestException('El enlace de la videollamada debe empezar con https://');
      data.meetUrl = url || null;
    }
    if (dto.doneNotes !== undefined) data.doneNotes = String(dto.doneNotes).slice(0, 1000) || null;
    if (dto.slotAt !== undefined) {
      const at = new Date(dto.slotAt);
      if (Number.isNaN(at.getTime())) throw new BadRequestException('Fecha inválida');
      data.slotAt = at;
    }
    const updated = await this.prisma.agentCall.update({ where: { id: callId }, data });
    await this.audit.log({ actor: user, companyId: call.companyId, action: 'agent_call.update', entity: 'AgentCall', entityId: callId, detail: Object.keys(data).filter((k) => k !== 'updatedAt').join(', ') });
    return this.view(updated);
  }

  private async notifyTeam(subject: string, body: string) {
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: 'SIGNUP_NOTIFY_EMAIL' } });
      const raw = row?.value?.trim() || process.env.SIGNUP_NOTIFY_EMAIL || DEFAULT_NOTIFY;
      const to = [...new Set(raw.split(',').map((e: string) => e.trim().toLowerCase()).filter((e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))].slice(0, 10);
      for (const toEmail of to) await this.emails.systemSend({ toEmail, subject, body });
    } catch (err) {
      this.logger.warn(`aviso de cita no enviado: ${(err as Error).message}`);
    }
  }
}

@Controller('agent-calls')
export class AgentCallsController {
  constructor(private readonly calls: AgentCallsService) {}

  @Get('slots')
  slots() {
    return this.calls.slots();
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.calls.mine(user, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  book(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.calls.book(user, dto ?? {}, companyId);
  }

  @Post(':id/cancel')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('companyId') companyId?: string) {
    return this.calls.cancel(user, id, companyId);
  }

  @Get('all')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  list(@Query('status') status?: string) {
    return this.calls.list(status);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.calls.update(user, id, dto ?? {});
  }
}

@Module({
  imports: [AuditModule, EmailsModule],
  controllers: [AgentCallsController],
  providers: [AgentCallsService],
  exports: [AgentCallsService],
})
export class AgentCallsModule {}
