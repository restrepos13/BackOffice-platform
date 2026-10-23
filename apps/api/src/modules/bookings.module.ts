import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Injectable, Logger, Module,
  NotFoundException, Optional, Param, Post, Put, Query,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { hasProduct } from '../common/products';
import { WA_OUTBOUND_QUEUE } from '../queue/queue.module';
import { withinServiceWindow } from '../common/customer-notify';
import {
  BookingConfig, BookingConfigError, BookingService as Svc, PROBLEM_TEXT, addDaysLocal, bookingCode, bookingConfigOf,
  candidateStarts, localParts, localToUtc, normalizeBookingConfig, resourcesFor, slotProblem, unitsOf,
} from '../common/bookings';
import { AuditModule, AuditService } from './audit.module';

/**
 * Reservas reales: disponibilidad, reserva, cancelación, reprogramación y
 * avisos al cliente. Reutiliza Appointment (la agenda del panel).
 *
 *  - Nada se decide con datos del navegador o de la IA: la empresa sale de la
 *    sesión o de la conversación, el cliente es el contacto de esa conversación
 *    y la disponibilidad se revisa aquí justo antes de reservar.
 *  - Doble reserva imposible: cada tramo de un recurso es un BookingLock con
 *    índice único; dos pedidos simultáneos por el mismo tramo → solo uno entra.
 *  - Avisos (BookingNotice) por el canal ya integrado (cola de salida de
 *    WhatsApp/Instagram/Messenger): respetan la ventana de 24 h de Meta (fuera
 *    de ella solo con la plantilla aprobada «recordatorio_reserva»), la baja del
 *    cliente y la configuración. Lo que no se puede enviar queda con su motivo.
 */

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;
const ACTIVE = ['SCHEDULED', 'CONFIRMED'];
const MAX_NOTICE_ATTEMPTS = 5;
/** Un bloqueo sin reserva viva (proceso caído a mitad) se libera pasado este tiempo */
const STALE_LOCK_MS = 2 * 60_000;

export type BookingFail = { ok: false; code: string; message: string; alternatives?: Array<{ start: string; local: string; resource: string }> };
export type BookingOk = { ok: true; appointment: any; already?: boolean };

const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

function historyAdd(raw: string | null | undefined, entry: Record<string, unknown>): string {
  const list = parseJson<any[]>(raw, []);
  return JSON.stringify([...list, { at: new Date().toISOString(), ...entry }].slice(-50));
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger('Bookings');
  now: () => Date = () => new Date();
  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) readonly queue?: Pick<Queue, 'add'> | null,
  ) {}

  /* ── Cambios (para quien necesite reflejarlos, como Google Calendar) ── */

  private listeners: Array<(appointmentId: string) => void> = [];

  onAppointmentChange(fn: (appointmentId: string) => void) {
    this.listeners.push(fn);
  }

  /** Aviso sin esperar: lo que falle afuera (Google) nunca deshace ni frena la reserva. */
  changed(appointmentId: string) {
    for (const fn of this.listeners) {
      try {
        fn(appointmentId);
      } catch {
        /* el oyente maneja sus errores */
      }
    }
  }

  /* ── Ocupado en el calendario externo (Google) ── */

  /**
   * Tramos ocupados por eventos de Google en los espacios que esa conexión bloquea.
   * Suma ocupación: la disponibilidad sigue mandada por los bloqueos de BackOffice.
   */
  private async externalBusy(companyId: string, cfg: BookingConfig, from: Date, to: Date): Promise<Array<{ start: number; end: number; resourceIds: string[] }>> {
    const conn = await this.prisma.calendarConnection?.findUnique({ where: { companyId } }).catch(() => null);
    if (!conn || conn.status !== 'CONNECTED' || conn.direction === 'PUSH') return [];
    const chosen = parseJson<string[]>(conn.blockResourceIdsJson, []);
    const resourceIds = chosen.length ? chosen : cfg.resources.filter((r) => r.active).map((r) => r.id);
    if (!resourceIds.length) return [];
    const blocks = await this.prisma.calendarEventLink.findMany({
      where: { connectionId: conn.id, origin: 'GOOGLE', busy: true, status: { in: ['ACTIVE', 'CONFLICT'] }, startsAt: { lt: to }, endsAt: { gt: from } },
      select: { startsAt: true, endsAt: true },
      take: 2000,
    });
    return blocks.map((b: any) => ({ start: new Date(b.startsAt).getTime(), end: new Date(b.endsAt).getTime(), resourceIds }));
  }

  private externallyBusy(busy: Array<{ start: number; end: number; resourceIds: string[] }>, resourceId: string, start: Date, durationMin: number) {
    const s = start.getTime();
    const e = s + durationMin * 60000;
    return busy.some((b) => b.resourceIds.includes(resourceId) && b.start < e && b.end > s);
  }

  /* ── Configuración ── */

  private async company(companyId: string) {
    const c = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!c) throw new NotFoundException('Empresa no encontrada');
    return c;
  }

  private tz(company: any) {
    return company.timezone || 'America/Bogota';
  }

  configOf(company: any): { cfg: BookingConfig; orderConfig: Record<string, any> } {
    const orderConfig = parseJson<Record<string, any>>(company.orderConfigJson, {});
    return { cfg: bookingConfigOf(orderConfig), orderConfig };
  }

  private companyIdOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  async getConfig(user: AuthUser, companyId?: string) {
    const c = await this.company(this.companyIdOf(user, companyId));
    const { cfg } = this.configOf(c);
    return { config: cfg, timezone: this.tz(c), templateReady: this.reminderTemplate(c) !== null };
  }

  async saveConfig(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.company(this.companyIdOf(user, companyId));
    let cfg: BookingConfig;
    try {
      cfg = normalizeBookingConfig(dto?.config ?? dto);
    } catch (err) {
      if (err instanceof BookingConfigError) throw new BadRequestException({ statusCode: 400, field: err.field, message: err.message });
      throw err;
    }
    // Un recurso con reservas futuras no se puede borrar (se puede desactivar)
    const { cfg: before, orderConfig } = this.configOf(c);
    const removed = before.resources.filter((r) => !cfg.resources.some((x) => x.id === r.id)).map((r) => r.id);
    if (removed.length) {
      const future = await this.prisma.appointment.count({ where: { companyId: c.id, resourceId: { in: removed }, status: { in: ACTIVE }, startsAt: { gte: this.now() } } });
      if (future) throw new ConflictException(`Ese espacio tiene ${future} reservas futuras: desactívalo en vez de borrarlo, o muévelas primero.`);
    }
    await this.prisma.company.update({ where: { id: c.id }, data: { orderConfigJson: JSON.stringify({ ...orderConfig, bookings: cfg }) } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'bookings.config', entity: 'Company', entityId: c.id, detail: `${cfg.enabled ? 'activas' : 'apagadas'} · ${cfg.resources.length} recursos · ${cfg.services.length} servicios` });
    return { config: cfg };
  }

  /* ── Disponibilidad ── */

  private pickService(cfg: BookingConfig, key?: string | null): Svc | null {
    if (key) {
      const k = String(key).toLowerCase();
      return cfg.services.find((s) => s.key === k || s.name.toLowerCase() === k) ?? null;
    }
    return cfg.services.length === 1 ? cfg.services[0] : null;
  }

  private pickResource(cfg: BookingConfig, service: Svc, ref?: string | null) {
    const options = resourcesFor(cfg, service);
    if (!ref) return { options, chosen: null as null | (typeof options)[number] };
    const r = String(ref).toLowerCase();
    return { options, chosen: options.find((x) => x.id === ref || x.name.toLowerCase() === r) ?? null };
  }

  /** Tramos ocupados de esos recursos en un rango. */
  private async takenUnits(companyId: string, resourceIds: string[], from: Date, to: Date): Promise<Set<string>> {
    const locks = await this.prisma.bookingLock.findMany({ where: { companyId, resourceId: { in: resourceIds }, slotStart: { gte: from, lt: to } } });
    return new Set(locks.map((l: any) => `${l.resourceId}|${new Date(l.slotStart).toISOString()}`));
  }

  /**
   * Turnos libres de un día para un servicio. Cada turno lista los recursos
   * libres (en el caso de dos canchas: a qué hora y en cuál).
   */
  async availability(companyId: string, q: { date?: string; serviceKey?: string | null; resourceRef?: string | null }) {
    const c = await this.company(companyId);
    const { cfg, orderConfig } = this.configOf(c);
    const tz = this.tz(c);
    const now = this.now();
    if (!cfg.enabled) return { ok: false as const, code: 'DISABLED', message: PROBLEM_TEXT.DISABLED };
    const service = this.pickService(cfg, q.serviceKey);
    if (!service) {
      return { ok: false as const, code: 'NO_SERVICE', message: cfg.services.length > 1 ? `¿Qué servicio? Opciones: ${cfg.services.map((s) => s.name).join(', ')}` : PROBLEM_TEXT.NO_SERVICE, services: cfg.services.map((s) => ({ key: s.key, name: s.name, minutos: s.durationMin })) };
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date! : localParts(now, tz).date;
    const { options, chosen } = this.pickResource(cfg, service, q.resourceRef);
    if (q.resourceRef && !chosen) return { ok: false as const, code: 'NO_RESOURCE', message: `No encontré ese espacio. Opciones: ${options.map((r) => r.name).join(', ')}` };
    const resources = chosen ? [chosen] : options;
    const starts = candidateStarts(cfg, orderConfig, service, date, tz, now);
    if (!starts.length) return { ok: true as const, date, service: service.name, slots: [], note: 'Ese día no hay turnos disponibles (cerrado, ya pasó o fuera del rango).' };
    const from = starts[0];
    const to = new Date(starts[starts.length - 1].getTime() + service.durationMin * 60000);
    const taken = await this.takenUnits(c.id, resources.map((r) => r.id), from, to);
    const external = await this.externalBusy(c.id, cfg, from, to);
    const slots = starts.map((start) => {
      const free = resources.filter((r) => unitsOf(start, service.durationMin, cfg.slotMinutes).every((u) => !taken.has(`${r.id}|${u.toISOString()}`))
        && !this.externallyBusy(external, r.id, start, service.durationMin));
      return { start: start.toISOString(), local: localParts(start, tz).time, resources: free.map((r) => ({ id: r.id, name: r.name })) };
    }).filter((s) => s.resources.length);
    return { ok: true as const, date, service: service.name, durationMin: service.durationMin, price: service.price, slots };
  }

  /* ── Bloqueos (la garantía contra dobles reservas) ── */

  /** Toma todos los tramos o ninguno. Un tramo ya tomado por la misma reserva cuenta como suyo. */
  private async acquire(companyId: string, resourceId: string, units: Date[], appointmentId: string): Promise<boolean> {
    const created: string[] = [];
    for (const slotStart of units) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const row = await this.prisma.bookingLock.create({ data: { companyId, resourceId, slotStart, appointmentId } });
          // Segunda defensa (si el índice único aún no existe en la base): insertar y luego
          // verificar. Si hay dos bloqueos del mismo tramo gana el más antiguo, con la misma
          // regla en los dos pedidos, y el otro se retira.
          const same = await this.prisma.bookingLock.findMany({ where: { companyId, resourceId, slotStart } });
          if (same.length > 1) {
            const winner = [...same].sort((x: any, y: any) => new Date(x.createdAt).getTime() - new Date(y.createdAt).getTime() || String(x.id).localeCompare(String(y.id)))[0];
            if (winner.id !== row.id) {
              await this.prisma.bookingLock.deleteMany({ where: { id: row.id } });
              if (winner.appointmentId === appointmentId) break; // ya era nuestro
              await this.prisma.bookingLock.deleteMany({ where: { id: { in: created } } });
              return false;
            }
          }
          created.push(row.id);
          break;
        } catch (err: any) {
          if (err?.code !== 'P2002') {
            await this.prisma.bookingLock.deleteMany({ where: { id: { in: created } } });
            throw err;
          }
          const holder = await this.prisma.bookingLock.findFirst({ where: { companyId, resourceId, slotStart } });
          if (holder?.appointmentId === appointmentId) break; // ya era de esta reserva (reprogramación)
          // Bloqueo huérfano (la reserva no existe o se canceló y quedó colgado): se libera y se reintenta
          const owner = holder ? await this.prisma.appointment.findUnique({ where: { id: holder.appointmentId } }) : null;
          // Mismo reloj que estampó el bloqueo (el real), no el «ahora» del negocio
          const stale = holder && (!owner || !ACTIVE.includes(owner.status)) && Date.now() - new Date(holder.createdAt).getTime() > STALE_LOCK_MS;
          if (stale && attempt === 0) {
            await this.prisma.bookingLock.deleteMany({ where: { id: holder.id } });
            continue;
          }
          await this.prisma.bookingLock.deleteMany({ where: { id: { in: created } } });
          return false;
        }
      }
    }
    return true;
  }

  private async release(appointmentId: string, keep: Date[] = [], resourceId?: string) {
    const locks = await this.prisma.bookingLock.findMany({ where: { appointmentId } });
    const keepSet = new Set(keep.map((d) => `${resourceId}|${d.toISOString()}`));
    const drop = locks.filter((l: any) => !keepSet.has(`${l.resourceId}|${new Date(l.slotStart).toISOString()}`)).map((l: any) => l.id);
    if (drop.length) await this.prisma.bookingLock.deleteMany({ where: { id: { in: drop } } });
  }

  /** Alternativas cercanas el mismo día (para ofrecer cuando la hora pedida no está). */
  private async alternatives(companyId: string, date: string, serviceKey: string, near: Date, max = 4) {
    const av = await this.availability(companyId, { date, serviceKey });
    if (!av.ok) return [];
    return [...av.slots]
      .sort((a, b) => Math.abs(new Date(a.start).getTime() - near.getTime()) - Math.abs(new Date(b.start).getTime() - near.getTime()))
      .slice(0, max)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((s) => ({ start: s.start, local: s.local, resource: s.resources.map((r) => r.name).join(' o ') }));
  }

  /* ── Reservar ── */

  /**
   * Crea una reserva validando TODO aquí: servicio, recurso, horario, anticipación,
   * límite por cliente y ocupación (bloqueos). Devuelve un resultado, no lanza:
   * el agente lo lee y actúa (ofrece alternativas o pasa a una persona).
   */
  async book(companyId: string, input: {
    contactId: string; serviceKey?: string | null; resourceRef?: string | null; start: Date; notes?: string | null;
    source: 'IA' | 'MANUAL'; by: string; conversationId?: string | null; idempotencyKey?: string | null; notify?: boolean;
  }): Promise<BookingOk | BookingFail> {
    const c = await this.company(companyId);
    const { cfg, orderConfig } = this.configOf(c);
    const tz = this.tz(c);
    const now = this.now();
    const contact = await this.prisma.contact.findUnique({ where: { id: input.contactId } });
    if (!contact || contact.companyId !== c.id) return { ok: false, code: 'NO_CONTACT', message: 'Cliente no encontrado' };
    if (input.idempotencyKey) {
      const same = await this.prisma.appointment.findFirst({ where: { companyId: c.id, idempotencyKey: input.idempotencyKey, status: { in: ACTIVE } } });
      if (same) return { ok: true, appointment: same, already: true };
    }
    const service = this.pickService(cfg, input.serviceKey);
    if (!service) return { ok: false, code: cfg.enabled ? 'NO_SERVICE' : 'DISABLED', message: cfg.enabled ? `¿Qué servicio? Opciones: ${cfg.services.map((s) => s.name).join(', ')}` : PROBLEM_TEXT.DISABLED };
    if (Number.isNaN(input.start.getTime())) return { ok: false, code: 'BAD_TIME', message: 'Fecha u hora no válida' };
    const problem = slotProblem(cfg, orderConfig, service, input.start, tz, now);
    if (problem) return { ok: false, code: problem, message: PROBLEM_TEXT[problem] };
    if (input.source === 'IA') {
      const active = await this.prisma.appointment.count({ where: { companyId: c.id, contactId: contact.id, status: { in: ACTIVE }, startsAt: { gte: now } } });
      if (active >= cfg.maxActivePerContact) {
        return { ok: false, code: 'LIMIT', message: `Este cliente ya tiene ${active} reservas activas: una persona del equipo debe revisar antes de agregar otra.` };
      }
    }
    const { options, chosen } = this.pickResource(cfg, service, input.resourceRef);
    if (input.resourceRef && !chosen) return { ok: false, code: 'NO_RESOURCE', message: `No encontré ese espacio. Opciones: ${options.map((r) => r.name).join(', ')}` };
    const candidates = chosen ? [chosen] : options;
    const units = unitsOf(input.start, service.durationMin, cfg.slotMinutes);
    const id = randomBytes(12).toString('hex'); // id propio: los bloqueos se toman ANTES de crear la reserva
    const date = localParts(input.start, tz).date;
    // Se revisa de nuevo justo antes de reservar (también lo ocupado en el calendario del negocio)
    const external = await this.externalBusy(c.id, cfg, input.start, new Date(input.start.getTime() + service.durationMin * 60000));
    let externalHit = false;
    for (const resource of candidates) {
      if (this.externallyBusy(external, resource.id, input.start, service.durationMin)) {
        externalHit = true;
        continue;
      }
      if (!(await this.acquire(c.id, resource.id, units, id))) continue;
      try {
        const lp = localParts(input.start, tz);
        const appointment = await this.prisma.appointment.create({
          data: {
            id, companyId: c.id, contactId: contact.id,
            title: `${service.name} · ${resource.name}`,
            notes: clip(input.notes, 500) || null,
            location: resource.name,
            startsAt: input.start,
            endsAt: new Date(input.start.getTime() + service.durationMin * 60000),
            durationMin: service.durationMin,
            status: 'SCHEDULED',
            source: input.source,
            createdBy: input.by,
            resourceId: resource.id,
            serviceKey: service.key,
            conversationId: input.conversationId ?? null,
            idempotencyKey: input.idempotencyKey ?? null,
            historyJson: historyAdd(null, { by: input.by, action: 'CREATED', to: `${lp.date} ${lp.time} · ${resource.name}`, source: input.source }),
          },
        });
        await this.scheduleReminder(c, appointment, cfg);
        if (input.notify && cfg.notifyOnStaffChanges) await this.enqueueNotice(c.id, appointment.id, 'CONFIRMATION', now);
        await this.audit.log({
          actor: null, companyId: c.id, action: 'booking.create', entity: 'Appointment', entityId: appointment.id,
          detail: `${service.name} · ${resource.name} · ${lp.date} ${lp.time} · ${input.source === 'IA' ? 'asistente IA' : input.by}`,
        });
        this.changed(appointment.id);
        return { ok: true, appointment };
      } catch (err) {
        await this.release(id);
        throw err;
      }
    }
    return {
      ok: false, code: 'TAKEN',
      message: externalHit && candidates.every((r) => this.externallyBusy(external, r.id, input.start, service.durationMin))
        ? 'Ese horario está ocupado en el calendario del negocio.'
        : chosen ? `${chosen.name} ya está reservado a esa hora.` : 'Esa hora ya está reservada en todos los espacios.',
      alternatives: await this.alternatives(c.id, date, service.key, input.start),
    };
  }

  /* ── Cancelar y reprogramar ── */

  private async appointmentOf(companyId: string, id: string) {
    const a = await this.prisma.appointment.findUnique({ where: { id } });
    if (!a || a.companyId !== companyId) return null;
    return a;
  }

  async cancel(companyId: string, appointmentId: string, opts: { by: string; reason?: string; actor: 'IA' | 'STAFF'; notify?: boolean }): Promise<BookingOk | BookingFail> {
    const c = await this.company(companyId);
    const { cfg } = this.configOf(c);
    const a = await this.appointmentOf(c.id, appointmentId);
    if (!a) return { ok: false, code: 'NOT_FOUND', message: 'Reserva no encontrada' };
    if (!ACTIVE.includes(a.status)) return { ok: false, code: 'NOT_ACTIVE', message: 'Esa reserva ya no está activa' };
    if (opts.actor === 'IA' && new Date(a.startsAt).getTime() - this.now().getTime() < cfg.cancelUntilHours * 3600e3) {
      return { ok: false, code: 'TOO_LATE', message: `Faltan menos de ${cfg.cancelUntilHours} h: la cancelación la revisa una persona del equipo.` };
    }
    const updated = await this.prisma.appointment.update({
      where: { id: a.id },
      data: { status: 'CANCELLED', historyJson: historyAdd(a.historyJson, { by: opts.by, action: 'CANCELLED', note: clip(opts.reason, 200) || undefined, source: opts.actor }) },
    });
    await this.release(a.id);
    await this.prisma.bookingNotice.updateMany({ where: { appointmentId: a.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    if (opts.notify && cfg.notifyOnStaffChanges) await this.enqueueNotice(c.id, a.id, 'CANCELLATION', this.now());
    await this.audit.log({ actor: null, companyId: c.id, action: 'booking.cancel', entity: 'Appointment', entityId: a.id, detail: `${a.title} · ${opts.actor} · ${opts.by}` });
    this.changed(a.id);
    return { ok: true, appointment: updated };
  }

  async reschedule(companyId: string, appointmentId: string, opts: { start: Date; resourceRef?: string | null; by: string; actor: 'IA' | 'STAFF'; notify?: boolean }): Promise<BookingOk | BookingFail> {
    const c = await this.company(companyId);
    const { cfg, orderConfig } = this.configOf(c);
    const tz = this.tz(c);
    const a = await this.appointmentOf(c.id, appointmentId);
    if (!a) return { ok: false, code: 'NOT_FOUND', message: 'Reserva no encontrada' };
    if (!ACTIVE.includes(a.status)) return { ok: false, code: 'NOT_ACTIVE', message: 'Esa reserva ya no está activa' };
    if (!a.resourceId || !a.serviceKey) return { ok: false, code: 'NOT_BOOKING', message: 'Esta cita no es una reserva en línea: cámbiala desde la agenda' };
    if (opts.actor === 'IA' && new Date(a.startsAt).getTime() - this.now().getTime() < cfg.cancelUntilHours * 3600e3) {
      return { ok: false, code: 'TOO_LATE', message: `Faltan menos de ${cfg.cancelUntilHours} h: el cambio lo revisa una persona del equipo.` };
    }
    const service = this.pickService(cfg, a.serviceKey);
    if (!service) return { ok: false, code: 'NO_SERVICE', message: 'El servicio de esta reserva ya no existe: lo revisa una persona.' };
    const problem = slotProblem(cfg, orderConfig, service, opts.start, tz, this.now());
    if (problem) return { ok: false, code: problem, message: PROBLEM_TEXT[problem] };
    const { options, chosen } = this.pickResource(cfg, service, opts.resourceRef);
    if (opts.resourceRef && !chosen) return { ok: false, code: 'NO_RESOURCE', message: `No encontré ese espacio. Opciones: ${options.map((r) => r.name).join(', ')}` };
    // Primero el mismo recurso, después los demás; los tramos nuevos se toman ANTES de soltar los viejos
    const ordered = chosen ? [chosen] : [...options.filter((r) => r.id === a.resourceId), ...options.filter((r) => r.id !== a.resourceId)];
    const units = unitsOf(opts.start, service.durationMin, cfg.slotMinutes);
    const external = await this.externalBusy(c.id, cfg, opts.start, new Date(opts.start.getTime() + service.durationMin * 60000));
    for (const resource of ordered) {
      if (this.externallyBusy(external, resource.id, opts.start, service.durationMin)) continue;
      if (!(await this.acquire(c.id, resource.id, units, a.id))) continue;
      await this.release(a.id, units, resource.id);
      const before = localParts(new Date(a.startsAt), tz);
      const after = localParts(opts.start, tz);
      const updated = await this.prisma.appointment.update({
        where: { id: a.id },
        data: {
          startsAt: opts.start, endsAt: new Date(opts.start.getTime() + service.durationMin * 60000), resourceId: resource.id, location: resource.name,
          title: `${service.name} · ${resource.name}`,
          historyJson: historyAdd(a.historyJson, { by: opts.by, action: 'RESCHEDULED', from: `${before.date} ${before.time} · ${a.location ?? ''}`.trim(), to: `${after.date} ${after.time} · ${resource.name}`, source: opts.actor }),
        },
      });
      await this.prisma.bookingNotice.updateMany({ where: { appointmentId: a.id, status: 'PENDING', kind: 'REMINDER' }, data: { status: 'CANCELLED' } });
      await this.scheduleReminder(c, updated, cfg);
      if (opts.notify && cfg.notifyOnStaffChanges) await this.enqueueNotice(c.id, a.id, 'RESCHEDULE', this.now());
      await this.audit.log({ actor: null, companyId: c.id, action: 'booking.reschedule', entity: 'Appointment', entityId: a.id, detail: `${before.date} ${before.time} → ${after.date} ${after.time} · ${resource.name} · ${opts.actor}` });
      this.changed(a.id);
      return { ok: true, appointment: updated };
    }
    return { ok: false, code: 'TAKEN', message: 'Esa hora ya está reservada.', alternatives: await this.alternatives(c.id, localParts(opts.start, tz).date, service.key, opts.start) };
  }

  /** Reservas futuras activas de un contacto (para "mis reservas"). */
  async upcomingFor(companyId: string, contactId: string) {
    return this.prisma.appointment.findMany({
      where: { companyId, contactId, status: { in: ACTIVE }, startsAt: { gte: this.now() } },
      orderBy: { startsAt: 'asc' },
      take: 10,
    });
  }

  /** Una cita cambiada desde la agenda clásica: los bloqueos siguen a la reserva. */
  async afterStatusChange(appointment: any, status: string) {
    if (status === 'CANCELLED') {
      await this.release(appointment.id);
      await this.prisma.bookingNotice.updateMany({ where: { appointmentId: appointment.id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    }
    this.changed(appointment.id);
  }

  async afterDelete(appointmentId: string) {
    await this.release(appointmentId);
    await this.prisma.bookingNotice.updateMany({ where: { appointmentId, status: 'PENDING' }, data: { status: 'CANCELLED' } });
    this.changed(appointmentId);
  }

  /* ── Avisos al cliente ── */

  private reminderTemplate(company: any): { contentSid: string } | null {
    const t = parseJson<any[]>(company.waTemplatesJson, []).find((x) => x?.key === 'recordatorio_reserva' && x?.contentSid);
    return t ? { contentSid: t.contentSid } : null;
  }

  private async scheduleReminder(company: any, appointment: any, cfg: BookingConfig) {
    if (!cfg.reminders.enabled) return;
    const at = new Date(new Date(appointment.startsAt).getTime() - cfg.reminders.hoursBefore * 3600e3);
    if (at.getTime() <= this.now().getTime() + 5 * 60_000) return; // demasiado cerca: el cliente acaba de reservar
    await this.enqueueNotice(company.id, appointment.id, 'REMINDER', at);
  }

  private async enqueueNotice(companyId: string, appointmentId: string, kind: string, scheduledAt: Date) {
    try {
      await this.prisma.bookingNotice.create({ data: { companyId, appointmentId, kind, scheduledAt } });
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // ya existía: no se duplica
    }
  }

  private noticeText(kind: string, a: any, company: any): string {
    const lp = localParts(new Date(a.startsAt), this.tz(company));
    const when = new Intl.DateTimeFormat('es-CO', { timeZone: this.tz(company), weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(new Date(a.startsAt));
    const what = a.title ?? 'tu reserva';
    const code = bookingCode(a.id);
    switch (kind) {
      case 'REMINDER': return `Te recordamos tu reserva en ${company.name}: ${what}, ${when}. Código ${code}. Si no puedes asistir, respóndenos por aquí.`;
      case 'CONFIRMATION': return `Tu reserva en ${company.name} quedó confirmada: ${what}, ${when}. Código ${code}.`;
      case 'RESCHEDULE': return `Tu reserva en ${company.name} cambió: ahora es ${what}, ${when} (${lp.date}). Código ${code}.`;
      case 'CANCELLATION': return `Tu reserva en ${company.name} (${what}, ${when}) fue cancelada. Si quieres otra hora, escríbenos.`;
      default: return `Novedad sobre tu reserva en ${company.name}: ${what}, ${when}.`;
    }
  }

  /** Envía los avisos que tocan. Idempotente: cada aviso se toma con un cambio de estado condicional. */
  async dispatchDue(now = this.now()) {
    const due = await this.prisma.bookingNotice.findMany({ where: { status: 'PENDING', scheduledAt: { lte: now } }, orderBy: { scheduledAt: 'asc' }, take: 50 });
    const out = { sent: 0, skipped: 0, failed: 0, retried: 0 };
    for (const n of due) {
      const claim = await this.prisma.bookingNotice.updateMany({ where: { id: n.id, status: 'PENDING' }, data: { status: 'SENDING', updatedAt: now } });
      if (!claim.count) continue;
      const r = await this.deliver(n, now);
      out[r]++;
    }
    return out;
  }

  private async finish(id: string, data: Record<string, any>) {
    await this.prisma.bookingNotice.update({ where: { id }, data: { ...data, updatedAt: this.now() } });
  }

  private async deliver(n: any, now: Date): Promise<'sent' | 'skipped' | 'failed' | 'retried'> {
    const skip = async (reason: string) => {
      await this.finish(n.id, { status: 'SKIPPED', skipReason: reason });
      return 'skipped' as const;
    };
    const a = await this.prisma.appointment.findUnique({ where: { id: n.appointmentId } });
    if (!a) return skip('la reserva ya no existe');
    if (n.kind === 'REMINDER' && !ACTIVE.includes(a.status)) return skip('la reserva ya no está activa');
    const company = await this.prisma.company.findUnique({ where: { id: a.companyId } });
    if (!company || !hasProduct(company, 'AUTOMATION')) return skip('la empresa no tiene BackOffice Automation activo');
    const { cfg } = this.configOf(company);
    if (n.kind === 'REMINDER' && !cfg.reminders.enabled) return skip('los recordatorios están apagados');
    const contact = await this.prisma.contact.findUnique({ where: { id: a.contactId } });
    if (!contact || contact.optOut) return skip('el cliente pidió no recibir mensajes');
    const conversation = (a.conversationId ? await this.prisma.conversation.findUnique({ where: { id: a.conversationId } }) : null)
      ?? await this.prisma.conversation.findFirst({ where: { companyId: a.companyId, contactId: a.contactId, channel: { in: ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'SIMULATOR'] } }, orderBy: { lastMessageAt: 'desc' } });
    if (!conversation) return skip('el cliente no tiene un chat con el negocio');
    const realChannel = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER'].includes(conversation.channel);
    let contentSid: string | undefined;
    if (realChannel && !(await withinServiceWindow(this.prisma, conversation.id, now))) {
      // Fuera de 24 h Meta solo deja escribir con plantilla aprobada (y solo en WhatsApp)
      const template = conversation.channel === 'WHATSAPP' ? this.reminderTemplate(company) : null;
      if (!template) return skip(conversation.channel === 'WHATSAPP' ? 'fuera de la ventana de 24 h y sin la plantilla aprobada «recordatorio_reserva»' : 'fuera de la ventana de 24 h (Instagram/Messenger no permiten escribir después)');
      contentSid = template.contentSid;
    }
    if (realChannel && !this.queue) {
      return this.retry(n, now, 'la cola de envío no está disponible');
    }
    try {
      // El mensaje se crea una sola vez; los reintentos solo lo vuelven a encolar
      let messageId: string = n.messageId;
      if (!messageId) {
        const msg = await this.prisma.message.create({
          data: {
            conversationId: conversation.id, direction: 'OUT', author: 'BOT', authorName: 'Reservas', type: 'TEXT',
            content: this.noticeText(n.kind, a, company), deliveryStatus: realChannel ? 'QUEUED' : null,
          },
        });
        messageId = msg.id;
        await this.prisma.bookingNotice.update({ where: { id: n.id }, data: { messageId } });
        await this.prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } });
      }
      if (realChannel) {
        const lp = localParts(new Date(a.startsAt), this.tz(company));
        await this.queue!.add(
          'outbound',
          { messageId, metaCategory: 'UTILIDAD', ...(contentSid ? { contentSid, contentVariables: { '1': a.title ?? 'tu reserva', '2': `${lp.date} ${lp.time}` } } : {}) },
          { jobId: `booking-notice-${n.id}-${n.attempts + 1}`, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
        );
      }
      await this.finish(n.id, { status: 'SENT', sentAt: now, messageId, attempts: n.attempts + 1, lastError: null });
      return 'sent';
    } catch (err: any) {
      return this.retry(n, now, err?.message ?? 'error al encolar');
    }
  }

  /** Error del envío: reintento con espera creciente; al quinto, falla y queda a la vista del equipo. */
  private async retry(n: any, now: Date, error: string): Promise<'failed' | 'retried'> {
    const attempts = n.attempts + 1;
    if (attempts >= MAX_NOTICE_ATTEMPTS) {
      await this.finish(n.id, { status: 'FAILED', attempts, lastError: error.slice(0, 300) });
      const a = await this.prisma.appointment.findUnique({ where: { id: n.appointmentId } });
      if (a) await this.prisma.appointment.update({ where: { id: a.id }, data: { historyJson: historyAdd(a.historyJson, { by: 'Sistema', action: 'NOTICE_FAILED', note: `${n.kind}: ${error.slice(0, 120)}` }) } });
      return 'failed';
    }
    await this.finish(n.id, { status: 'PENDING', attempts, lastError: error.slice(0, 300), scheduledAt: new Date(now.getTime() + 2 ** attempts * 60_000) });
    return 'retried';
  }

  @Cron('* * * * *')
  async tick() {
    if (process.env.JEST_WORKER_ID || process.env.BOOKINGS_CRON_DISABLED === '1' || this.busy) return;
    this.busy = true;
    try {
      await this.dispatchDue();
    } catch (err: any) {
      this.logger.warn(`avisos de reservas: ${err.message}`);
    } finally {
      this.busy = false;
    }
  }

  /* ── Panel ── */

  private async staffCompany(user: AuthUser, companyId?: string) {
    return this.companyIdOf(user, companyId);
  }

  async staffBook(user: AuthUser, dto: any, companyId?: string) {
    const id = await this.staffCompany(user, companyId);
    let contactId = String(dto?.contactId ?? '');
    let createdContact: string | null = null;
    if (!contactId && dto?.phone) {
      // Cliente que llama o llega en persona: se busca por teléfono o se crea
      const phone = String(dto.phone).replace(/[^\d+]/g, '').slice(0, 20);
      if (phone.replace(/\D/g, '').length < 7) throw new BadRequestException('Teléfono no válido');
      const existing = await this.prisma.contact.findFirst({ where: { companyId: id, phone } });
      if (existing) contactId = existing.id;
      else {
        contactId = (await this.prisma.contact.create({ data: { companyId: id, phone, name: clip(dto.name, 80) || phone, channel: 'WHATSAPP' } })).id;
        createdContact = contactId;
      }
    }
    if (!contactId) throw new BadRequestException('Elige o escribe el cliente');
    const start = new Date(String(dto?.start ?? ''));
    const r = await this.book(id, {
      contactId, serviceKey: dto?.serviceKey, resourceRef: dto?.resourceId, start, notes: dto?.notes,
      source: 'MANUAL', by: user.name, notify: dto?.notify !== false,
    });
    if (!r.ok) {
      // El turno no se pudo: no queda un contacto creado solo para este intento
      if (createdContact) await this.prisma.contact.delete({ where: { id: createdContact } }).catch(() => undefined);
      throw new ConflictException({ statusCode: 409, code: r.code, message: r.message, alternatives: r.alternatives ?? [] });
    }
    return r.appointment;
  }

  async staffCancel(user: AuthUser, appointmentId: string, dto: any, companyId?: string) {
    const id = await this.staffCompany(user, companyId);
    const r = await this.cancel(id, appointmentId, { by: user.name, reason: dto?.reason, actor: 'STAFF', notify: dto?.notify !== false });
    if (!r.ok) throw r.code === 'NOT_FOUND' ? new NotFoundException(r.message) : new ConflictException({ statusCode: 409, code: r.code, message: r.message });
    return r.appointment;
  }

  async staffReschedule(user: AuthUser, appointmentId: string, dto: any, companyId?: string) {
    const id = await this.staffCompany(user, companyId);
    const r = await this.reschedule(id, appointmentId, { start: new Date(String(dto?.start ?? '')), resourceRef: dto?.resourceId, by: user.name, actor: 'STAFF', notify: dto?.notify !== false });
    if (!r.ok) throw r.code === 'NOT_FOUND' ? new NotFoundException(r.message) : new ConflictException({ statusCode: 409, code: r.code, message: r.message, alternatives: r.alternatives ?? [] });
    return r.appointment;
  }

  async staffAvailability(user: AuthUser, q: any) {
    return this.availability(await this.staffCompany(user, q.companyId), { date: q.date, serviceKey: q.service, resourceRef: q.resource });
  }

  async detail(user: AuthUser, appointmentId: string, companyId?: string) {
    const id = await this.staffCompany(user, companyId);
    const a = await this.appointmentOf(id, appointmentId);
    if (!a) throw new NotFoundException('Reserva no encontrada');
    const notices = await this.prisma.bookingNotice.findMany({ where: { appointmentId: a.id }, orderBy: { scheduledAt: 'asc' } });
    return {
      id: a.id, code: bookingCode(a.id), history: parseJson<any[]>(a.historyJson, []),
      notices: notices.map((x: any) => ({ id: x.id, kind: x.kind, status: x.status, scheduledAt: x.scheduledAt, sentAt: x.sentAt, attempts: x.attempts, skipReason: x.skipReason, lastError: x.lastError })),
    };
  }
}

@Products('AUTOMATION')
@Controller('bookings')
export class BookingsController {
  constructor(private readonly s: BookingsService) {}

  @Get('config') @Roles(...READ)
  config(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.getConfig(u, c); }

  @Put('config') @Roles(...WRITE)
  saveConfig(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.saveConfig(u, dto, c); }

  @Get('availability') @Roles(...READ)
  availability(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.staffAvailability(u, q); }

  @Post() @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 60 } })
  create(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.staffBook(u, dto, c); }

  @Post(':id/cancel') @Roles(...WRITE)
  cancel(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.staffCancel(u, id, dto, c); }

  @Post(':id/reschedule') @Roles(...WRITE)
  reschedule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.staffReschedule(u, id, dto, c); }

  @Get(':id') @Roles(...READ)
  detail(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.detail(u, id, c); }
}

@Module({
  imports: [AuditModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}

export { addDaysLocal, localToUtc };
