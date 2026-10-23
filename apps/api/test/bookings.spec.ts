/**
 * Fase 2 — reservas reales por el chat (caso de validación: dos canchas).
 * Disponibilidad real, reserva con confirmación, nada de dobles reservas (ni
 * con pedidos simultáneos), cancelación y reprogramación del propio cliente,
 * aislamiento entre empresas, permisos, avisos por el canal real con errores y
 * reintentos, y la agenda del panel sin romper los bloqueos.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProductsGuard } from '../src/auth/products.guard';
import { AGENT_PRESETS, AGENT_TOOLS, BOOKING_TOOL_NAMES } from '../src/ai/agent/tools';
import { AgentService } from '../src/ai/agent/agent.service';
import { EngineService } from '../src/modules/engine.module';
import { BookingsController, BookingsService } from '../src/modules/bookings.module';
import { AppointmentsService } from '../src/modules/ops.module';
import { addDaysLocal, bookingCode, localParts, localToUtc, normalizeBookingConfig } from '../src/common/bookings';
import { AiChatOptions, AiChatResult, AiProvider } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);
const audit = { log: jest.fn(async () => undefined) };
const TZ = 'America/Bogota';
const NOW = new Date('2026-10-23T15:00:00Z'); // viernes 10:00 en Bogotá
const TOMORROW = '2026-10-24';
const at = (date: string, time: string) => localToUtc(date, time, TZ);

const BOOKINGS = {
  enabled: true, slotMinutes: 60,
  resources: [{ id: 'r_cancha-1', name: 'Cancha 1', active: true }, { id: 'r_cancha-2', name: 'Cancha 2', active: true }],
  services: [
    { key: 'futbol-1h', name: 'Fútbol 5 · 1 hora', durationMin: 60, price: 90000, resourceIds: [] },
    { key: 'futbol-2h', name: 'Fútbol 5 · 2 horas', durationMin: 120, price: 170000, resourceIds: [] },
  ],
  hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '06:00', close: '23:00' })),
  leadMinutes: 60, maxDaysAhead: 30, cancelUntilHours: 2, maxActivePerContact: 3, requireName: true,
  reminders: { enabled: true, hoursBefore: 24 }, notifyOnStaffChanges: true,
};

function world(opts: { products?: string[]; bookings?: Record<string, unknown>; queue?: any } = {}) {
  const { prisma, db } = createMockPrisma();
  const products = opts.products ?? ['AUTOMATION'];
  const productsJson = JSON.stringify(Object.fromEntries(['AUTOMATION', 'CREATIVE', 'ADS'].map((k) => [k, { enabled: products.includes(k) }])));
  db.company.push(
    { id: 'coA', name: 'Canchas El Golazo', timezone: TZ, currency: 'COP', planId: 'p1', productsJson, waTemplatesJson: '[]', orderConfigJson: JSON.stringify({ bookings: { ...BOOKINGS, ...opts.bookings }, holidays: ['2026-12-25'] }) },
    { id: 'coB', name: 'Otra Cancha', timezone: TZ, currency: 'COP', planId: 'p1', productsJson, waTemplatesJson: '[]', orderConfigJson: JSON.stringify({ bookings: BOOKINGS }) },
  );
  db.contact.push(
    { id: 'laura', companyId: 'coA', name: 'Laura', phone: '+573001112233', optOut: false },
    { id: 'pedro', companyId: 'coA', name: 'Pedro', phone: '+573004445566', optOut: false },
    { id: 'sinNombre', companyId: 'coA', name: '+573007778899', phone: '+573007778899', optOut: false },
    { id: 'ajeno', companyId: 'coB', name: 'Ajeno', phone: '+573009990000', optOut: false },
  );
  const queue = opts.queue ?? { add: jest.fn(async () => ({ id: 'job' })) };
  const svc = new BookingsService(prisma as any, audit as any, queue);
  svc.now = () => NOW;
  return { prisma, db, svc, queue };
}
const book = (svc: BookingsService, contactId: string, start: Date, extra: Record<string, unknown> = {}) =>
  svc.book('coA', { contactId, start, source: 'IA', by: 'Asistente IA', serviceKey: 'futbol-1h', ...extra } as any);

describe('Configuración y horas', () => {
  it('la hora local del negocio se convierte bien (Bogotá UTC-5)', () => {
    expect(at(TOMORROW, '18:00').toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(localParts(new Date('2026-10-24T23:00:00Z'), TZ)).toMatchObject({ date: TOMORROW, time: '18:00', weekday: 6 });
  });

  it('no se activan reservas sin espacios ni servicios; la duración queda en tramos completos', () => {
    expect(() => normalizeBookingConfig({ enabled: true })).toThrow(/espacio/);
    expect(() => normalizeBookingConfig({ enabled: true, resources: [{ name: 'A' }] })).toThrow(/servicio/);
    const cfg = normalizeBookingConfig({ enabled: true, slotMinutes: 30, resources: [{ name: 'Sala' }], services: [{ name: 'Ensayo', durationMin: 50 }] });
    expect(cfg.services[0].durationMin).toBe(60);
    expect(cfg.resources[0].id).toMatch(/^r_sala-/);
  });
});

describe('Disponibilidad real (dos canchas)', () => {
  it('cada hora muestra qué canchas están libres; lo reservado desaparece', async () => {
    const { svc } = world();
    const before: any = await svc.availability('coA', { date: TOMORROW, serviceKey: 'futbol-1h' });
    expect(before.slots).toHaveLength(17); // 06:00 a 22:00
    expect(before.slots.find((s: any) => s.local === '18:00').resources.map((r: any) => r.name)).toEqual(['Cancha 1', 'Cancha 2']);
    await book(svc, 'laura', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 1' });
    const after: any = await svc.availability('coA', { date: TOMORROW, serviceKey: 'futbol-1h' });
    expect(after.slots.find((s: any) => s.local === '18:00').resources.map((r: any) => r.name)).toEqual(['Cancha 2']);
    await book(svc, 'pedro', at(TOMORROW, '18:00'));
    const full: any = await svc.availability('coA', { date: TOMORROW, serviceKey: 'futbol-1h' });
    expect(full.slots.find((s: any) => s.local === '18:00')).toBeUndefined();
  });

  it('respeta anticipación, días cerrados, rango máximo y servicio ambiguo', async () => {
    const { svc } = world();
    const today: any = await svc.availability('coA', { date: '2026-10-23', serviceKey: 'futbol-1h' });
    expect(today.slots[0].local).toBe('11:00'); // ahora son las 10:00 y se pide 1 h de anticipación
    expect((await svc.availability('coA', { date: '2026-12-25', serviceKey: 'futbol-1h' }) as any).slots).toEqual([]);
    expect((await svc.availability('coA', { date: '2027-01-30', serviceKey: 'futbol-1h' }) as any).slots).toEqual([]);
    expect(await svc.availability('coA', { date: TOMORROW })).toMatchObject({ ok: false, code: 'NO_SERVICE' });
  });
});

describe('Reservar', () => {
  it('una reserva válida queda con su espacio, origen, historial, bloqueos y recordatorio', async () => {
    const { db, svc } = world();
    const r: any = await book(svc, 'laura', at(TOMORROW, '18:00'), { conversationId: 'conv1' });
    expect(r.ok).toBe(true);
    expect(r.appointment).toMatchObject({ resourceId: 'r_cancha-1', serviceKey: 'futbol-1h', source: 'IA', status: 'SCHEDULED', conversationId: 'conv1', durationMin: 60 });
    expect(JSON.parse(r.appointment.historyJson)[0]).toMatchObject({ action: 'CREATED', by: 'Asistente IA' });
    expect(db.bookingLock.filter((l: any) => l.appointmentId === r.appointment.id)).toHaveLength(1);
    expect(db.bookingNotice).toEqual([expect.objectContaining({ kind: 'REMINDER', status: 'PENDING', scheduledAt: at('2026-10-23', '18:00') })]);
  });

  it('la misma cancha a la misma hora no se reserva dos veces; ofrece alternativas', async () => {
    const { svc } = world();
    expect((await book(svc, 'laura', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 1' })).ok).toBe(true);
    const again: any = await book(svc, 'pedro', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 1' });
    expect(again).toMatchObject({ ok: false, code: 'TAKEN' });
    expect(again.alternatives.length).toBeGreaterThan(0);
    // Las 2 horas que se cruzan con una reserva existente tampoco
    const overlap: any = await book(svc, 'pedro', at(TOMORROW, '17:00'), { resourceRef: 'Cancha 1', serviceKey: 'futbol-2h' });
    expect(overlap).toMatchObject({ ok: false, code: 'TAKEN' });
  });

  it('dos (o cinco) pedidos simultáneos por la misma cancha y hora: entra exactamente uno', async () => {
    const { db, svc } = world({ bookings: { maxActivePerContact: 10 } });
    const start = at(TOMORROW, '20:00');
    const results: any[] = await Promise.all(['laura', 'pedro', 'laura', 'pedro', 'laura'].map((c) => book(svc, c, start, { resourceRef: 'Cancha 2' })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.code === 'TAKEN')).toBe(true);
    expect(db.appointment.filter((a: any) => a.resourceId === 'r_cancha-2')).toHaveLength(1);
    expect(db.bookingLock.filter((l: any) => l.resourceId === 'r_cancha-2')).toHaveLength(1);
    // Sin elegir cancha: tres pedidos simultáneos → dos entran (una por cancha), el tercero no
    const three: any[] = await Promise.all(['laura', 'pedro', 'laura'].map((c) => book(svc, c, at(TOMORROW, '21:00'))));
    expect(three.filter((r) => r.ok).map((r) => r.appointment.resourceId).sort()).toEqual(['r_cancha-1', 'r_cancha-2']);
  });

  it('aunque la base todavía no tenga el índice único, dos pedidos simultáneos no se cruzan (insertar y verificar)', async () => {
    const { prisma, db, svc } = world({ bookings: { maxActivePerContact: 10 } });
    // Sin índice: el create nunca falla por duplicado
    const realCreate = (prisma as any).bookingLock.create;
    (prisma as any).bookingLock.create = async ({ data }: any) => {
      const doc = { id: `lk${db.bookingLock.length}-${Math.random().toString(36).slice(2, 6)}`, createdAt: new Date(), ...data };
      db.bookingLock.push(doc);
      return { ...doc };
    };
    const results: any[] = await Promise.all(['laura', 'pedro', 'laura', 'pedro'].map((c) => book(svc, c, at(TOMORROW, '16:00'), { resourceRef: 'Cancha 1' })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(db.bookingLock.filter((l: any) => l.resourceId === 'r_cancha-1')).toHaveLength(1);
    (prisma as any).bookingLock.create = realCreate;
  });

  it('un bloqueo huérfano (proceso caído a mitad, sin reserva) se libera y no deja el turno tomado para siempre', async () => {
    const { db, svc } = world();
    db.bookingLock.push({ id: 'huerfano', companyId: 'coA', resourceId: 'r_cancha-1', slotStart: at(TOMORROW, '12:00'), appointmentId: 'no-existe', createdAt: new Date(Date.now() - 10 * 60_000) });
    expect((await book(svc, 'laura', at(TOMORROW, '12:00'), { resourceRef: 'Cancha 1' })).ok).toBe(true);
    expect(db.bookingLock.find((l: any) => l.id === 'huerfano')).toBeUndefined();
    // uno recién creado (otro pedido en curso) NO se toca
    db.bookingLock.push({ id: 'enCurso', companyId: 'coA', resourceId: 'r_cancha-1', slotStart: at(TOMORROW, '13:00'), appointmentId: 'en-curso', createdAt: new Date() });
    expect(await book(svc, 'pedro', at(TOMORROW, '13:00'), { resourceRef: 'Cancha 1' })).toMatchObject({ ok: false, code: 'TAKEN' });
  });

  it('un reintento con la misma clave no duplica la reserva', async () => {
    const { db, svc } = world();
    const a: any = await book(svc, 'laura', at(TOMORROW, '09:00'), { idempotencyKey: 'ia:conv1:x' });
    const b: any = await book(svc, 'laura', at(TOMORROW, '09:00'), { idempotencyKey: 'ia:conv1:x' });
    expect(b).toMatchObject({ ok: true, already: true });
    expect(b.appointment.id).toBe(a.appointment.id);
    expect(db.appointment).toHaveLength(1);
  });

  it('valida todo en el servidor: fuera de horario, hora rara, muy pronto, cerrado, sin servicio y tope por cliente', async () => {
    const { svc } = world({ bookings: { maxActivePerContact: 2 } });
    expect(await book(svc, 'laura', at(TOMORROW, '23:00'))).toMatchObject({ ok: false, code: 'OUT_OF_HOURS' });
    expect(await book(svc, 'laura', at(TOMORROW, '18:30'))).toMatchObject({ ok: false, code: 'OFF_GRID' });
    expect(await book(svc, 'laura', at('2026-10-23', '10:30'))).toMatchObject({ ok: false });
    expect(await book(svc, 'laura', at('2026-12-25', '10:00'))).toMatchObject({ ok: false, code: 'CLOSED' });
    expect(await book(svc, 'laura', at(TOMORROW, '10:00'), { serviceKey: 'tenis' })).toMatchObject({ ok: false, code: 'NO_SERVICE' });
    await book(svc, 'laura', at(TOMORROW, '10:00'));
    await book(svc, 'laura', at(TOMORROW, '11:00'));
    expect(await book(svc, 'laura', at(TOMORROW, '12:00'))).toMatchObject({ ok: false, code: 'LIMIT' });
  });
});

describe('Cancelar y reprogramar', () => {
  it('cancelar libera la cancha y anula el recordatorio; muy cerca de la hora, el asistente no cancela', async () => {
    const { db, svc } = world();
    const r: any = await book(svc, 'laura', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 1' });
    const c: any = await svc.cancel('coA', r.appointment.id, { by: 'Asistente IA', actor: 'IA' });
    expect(c.appointment.status).toBe('CANCELLED');
    expect(db.bookingLock).toHaveLength(0);
    expect(db.bookingNotice[0].status).toBe('CANCELLED');
    expect((await book(svc, 'pedro', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 1' })).ok).toBe(true);
    const soon: any = await book(svc, 'laura', at('2026-10-23', '11:00'));
    expect(await svc.cancel('coA', soon.appointment.id, { by: 'Asistente IA', actor: 'IA' })).toMatchObject({ ok: false, code: 'TOO_LATE' });
    expect((await svc.cancel('coA', soon.appointment.id, { by: 'Ana', actor: 'STAFF' })).ok).toBe(true); // el equipo sí
  });

  it('reprogramar toma la hora nueva antes de soltar la vieja; a una hora ocupada no se mueve', async () => {
    const { db, svc } = world();
    const r: any = await book(svc, 'laura', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 1', serviceKey: 'futbol-2h' });
    await book(svc, 'pedro', at(TOMORROW, '21:00'), { resourceRef: 'Cancha 1' });
    // Correrla una hora se cruza consigo misma (19:00 era suyo): se puede
    const moved: any = await svc.reschedule('coA', r.appointment.id, { start: at(TOMORROW, '19:00'), resourceRef: 'Cancha 1', by: 'Asistente IA', actor: 'IA' });
    expect(moved.ok).toBe(true);
    const locks = db.bookingLock.filter((l: any) => l.appointmentId === r.appointment.id).map((l: any) => localParts(new Date(l.slotStart), TZ).time).sort();
    expect(locks).toEqual(['19:00', '20:00']);
    // A las 20:00 por 2 h choca con la de Pedro (21:00): no se mueve y conserva su hora
    const blocked: any = await svc.reschedule('coA', r.appointment.id, { start: at(TOMORROW, '20:00'), resourceRef: 'Cancha 1', by: 'Asistente IA', actor: 'IA' });
    expect(blocked).toMatchObject({ ok: false, code: 'TAKEN' });
    expect(db.appointment.find((a: any) => a.id === r.appointment.id)!.startsAt).toEqual(at(TOMORROW, '19:00'));
    expect(JSON.parse(db.appointment.find((a: any) => a.id === r.appointment.id)!.historyJson).map((h: any) => h.action)).toEqual(['CREATED', 'RESCHEDULED']);
    // El recordatorio se movió con la reserva
    expect(db.bookingNotice.filter((n: any) => n.status === 'PENDING' && n.appointmentId === r.appointment.id).map((n: any) => n.scheduledAt)).toEqual([at('2026-10-23', '19:00')]);
  });
});

describe('Aislamiento entre empresas y permisos', () => {
  it('otra empresa no ve, no cancela ni reprograma reservas ajenas, ni reserva para contactos ajenos', async () => {
    const { svc } = world();
    const r: any = await book(svc, 'laura', at(TOMORROW, '18:00'));
    expect(await svc.cancel('coB', r.appointment.id, { by: 'x', actor: 'STAFF' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await svc.reschedule('coB', r.appointment.id, { start: at(TOMORROW, '19:00'), by: 'x', actor: 'STAFF' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await svc.book('coB', { contactId: 'laura', start: at(TOMORROW, '18:00'), source: 'IA', by: 'x', serviceKey: 'futbol-1h' })).toMatchObject({ ok: false, code: 'NO_CONTACT' });
    // La cancha de otra empresa con el mismo nombre no choca: los bloqueos son por empresa
    expect((await svc.book('coB', { contactId: 'ajeno', start: at(TOMORROW, '18:00'), source: 'IA', by: 'x', serviceKey: 'futbol-1h', resourceRef: 'Cancha 1' })).ok).toBe(true);
    const staffB = { id: 'u', role: 'COMPANY_ADMIN', companyId: 'coB', name: 'B' } as any;
    await expect(svc.staffCancel(staffB, r.appointment.id, {}, 'coA')).rejects.toThrow(/no encontrada/);
    await expect(svc.detail(staffB, r.appointment.id, 'coA')).rejects.toThrow(/no encontrada/);
  });

  it('sin BackOffice Automation los endpoints de reservas responden 403', async () => {
    const { prisma } = world({ products: ['CREATIVE'] });
    const guard = new ProductsGuard(new Reflector(), prisma as any);
    const ctx = (m: string) => ({ getHandler: () => (BookingsController.prototype as any)[m], getClass: () => BookingsController, switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', role: 'COMPANY_ADMIN', companyId: 'coA' } }) }) } as any);
    await expect(guard.canActivate(ctx('create'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('availability'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('las herramientas de reservas son solo del preset de reservas; un restaurante no las recibe', () => {
    expect(BOOKING_TOOL_NAMES.every((n) => AGENT_TOOLS.some((t) => t.name === n))).toBe(true);
    for (const preset of ['domicilios', 'pedidos_programados', 'solo_consultas']) {
      expect(AGENT_PRESETS[preset].tools.map((t) => t.tool).some((t) => BOOKING_TOOL_NAMES.includes(t))).toBe(false);
    }
    const reservas = Object.fromEntries(AGENT_PRESETS.reservas.tools.map((t) => [t.tool, t.access]));
    expect(reservas).toMatchObject({ ver_disponibilidad: 'read', crear_reserva: 'write', cancelar_reserva: 'write', reprogramar_reserva: 'write', mis_reservas: 'read' });
    expect(reservas.armar_pedido).toBeUndefined();
  });
});

describe('Avisos al cliente por el canal real', () => {
  async function bookingWithChat(opts: Parameters<typeof world>[0] = {}, lastInboundHoursAgo = 2, channel = 'WHATSAPP') {
    const w = world(opts);
    w.db.conversation.push({ id: 'conv1', companyId: 'coA', contactId: 'laura', channel, status: 'OPEN', lastMessageAt: NOW });
    const r: any = await book(w.svc, 'laura', at('2026-10-25', '18:00'), { conversationId: 'conv1' });
    const notice = w.db.bookingNotice[0];
    const dueAt = new Date(notice.scheduledAt.getTime() + 1000);
    // Último mensaje del cliente: N horas antes de que toque el recordatorio (define la ventana de 24 h)
    w.db.message.push({ id: 'in1', conversationId: 'conv1', direction: 'IN', content: 'hola', createdAt: new Date(dueAt.getTime() - lastInboundHoursAgo * 3600e3) });
    return { ...w, appointment: r.appointment, notice, dueAt };
  }

  it('dentro de las 24 h el recordatorio sale por la cola de WhatsApp como UTILIDAD', async () => {
    const { db, svc, queue, dueAt } = await bookingWithChat({}, 2);
    expect(await svc.dispatchDue(new Date(NOW.getTime() + 3600e3))).toMatchObject({ sent: 0 }); // todavía no toca
    expect(await svc.dispatchDue(dueAt)).toMatchObject({ sent: 1 });
    expect(queue.add).toHaveBeenCalledWith('outbound', expect.objectContaining({ metaCategory: 'UTILIDAD' }), expect.objectContaining({ attempts: 5 }));
    const out = db.message.find((m: any) => m.direction === 'OUT')!;
    expect(out.content).toContain('Te recordamos tu reserva');
    expect(db.bookingNotice[0]).toMatchObject({ status: 'SENT', messageId: out.id });
    expect(await svc.dispatchDue(dueAt)).toMatchObject({ sent: 0 }); // no se envía dos veces
  });

  it('fuera de las 24 h sin plantilla aprobada no se envía y queda el motivo; con plantilla sale con ella', async () => {
    const a = await bookingWithChat({}, 30);
    expect(await a.svc.dispatchDue(a.dueAt)).toMatchObject({ skipped: 1 });
    expect(a.db.bookingNotice[0]).toMatchObject({ status: 'SKIPPED', skipReason: expect.stringMatching(/24 h.*recordatorio_reserva/) });
    expect(a.queue.add).not.toHaveBeenCalled();
    const b = await bookingWithChat({}, 30);
    b.db.company[0].waTemplatesJson = JSON.stringify([{ key: 'recordatorio_reserva', contentSid: 'HX123' }]);
    expect(await b.svc.dispatchDue(b.dueAt)).toMatchObject({ sent: 1 });
    expect(b.queue.add).toHaveBeenCalledWith('outbound', expect.objectContaining({ contentSid: 'HX123' }), expect.anything());
  });

  it('respeta la baja del cliente, los recordatorios apagados, las reservas canceladas y el producto', async () => {
    const optOut = await bookingWithChat();
    optOut.db.contact.find((c: any) => c.id === 'laura')!.optOut = true;
    await optOut.svc.dispatchDue(optOut.dueAt);
    expect(optOut.db.bookingNotice[0]).toMatchObject({ status: 'SKIPPED', skipReason: expect.stringMatching(/no recibir/) });
    const off = await bookingWithChat();
    off.db.company[0].orderConfigJson = JSON.stringify({ bookings: { ...BOOKINGS, reminders: { enabled: false, hoursBefore: 24 } } });
    await off.svc.dispatchDue(off.dueAt);
    expect(off.db.bookingNotice[0].status).toBe('SKIPPED');
    const noAuto = await bookingWithChat();
    noAuto.db.company[0].productsJson = JSON.stringify({ AUTOMATION: { enabled: false }, CREATIVE: { enabled: true }, ADS: { enabled: false } });
    await noAuto.svc.dispatchDue(noAuto.dueAt);
    expect(noAuto.db.bookingNotice[0]).toMatchObject({ status: 'SKIPPED', skipReason: expect.stringMatching(/Automation/) });
  });

  it('si la cola de envío falla se reintenta con espera creciente, sin duplicar el mensaje; al quinto intento falla a la vista', async () => {
    const queue = { add: jest.fn(async () => { throw new Error('Redis caído'); }) };
    const { db, svc, dueAt, appointment } = await bookingWithChat({ queue });
    let when = dueAt;
    for (let i = 1; i <= 4; i++) {
      expect(await svc.dispatchDue(when)).toMatchObject({ retried: 1 });
      expect(db.bookingNotice[0]).toMatchObject({ status: 'PENDING', attempts: i, lastError: 'Redis caído' });
      when = new Date(db.bookingNotice[0].scheduledAt.getTime() + 1000);
    }
    expect(await svc.dispatchDue(when)).toMatchObject({ failed: 1 });
    expect(db.bookingNotice[0]).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(db.message.filter((m: any) => m.direction === 'OUT')).toHaveLength(1); // un solo mensaje en el chat
    expect(JSON.parse(db.appointment.find((a: any) => a.id === appointment.id)!.historyJson).at(-1)).toMatchObject({ action: 'NOTICE_FAILED' });
    // Si la cola vuelve, un aviso nuevo sale normal
    queue.add.mockResolvedValue({ id: 'ok' } as never);
  });
});

describe('El panel gestiona las reservas sin romper los bloqueos', () => {
  const STAFF = { id: 'u1', role: 'COMPANY_ADMIN', companyId: 'coA', name: 'Ana' } as any;

  it('el equipo reserva por teléfono (crea el contacto), cancela y reprograma; avisa al cliente', async () => {
    const { db, svc } = world();
    const a: any = await svc.staffBook(STAFF, { phone: '300 123 4567', name: 'Carlos', serviceKey: 'futbol-1h', start: at(TOMORROW, '19:00').toISOString(), resourceId: 'r_cancha-2' }, 'coB');
    expect(a).toMatchObject({ companyId: 'coA', source: 'MANUAL', createdBy: 'Ana', resourceId: 'r_cancha-2' }); // la empresa sale de la sesión
    expect(db.contact.find((c: any) => c.id === a.contactId)).toMatchObject({ name: 'Carlos', companyId: 'coA' });
    expect(db.bookingNotice.map((n: any) => n.kind).sort()).toEqual(['CONFIRMATION', 'REMINDER']);
    await expect(svc.staffBook(STAFF, { contactId: 'pedro', serviceKey: 'futbol-1h', start: at(TOMORROW, '19:00').toISOString(), resourceId: 'r_cancha-2' })).rejects.toBeInstanceOf(ConflictException);
    // Un teléfono nuevo con el turno ocupado no deja un contacto suelto
    const before = db.contact.length;
    await expect(svc.staffBook(STAFF, { phone: '311 000 0000', name: 'X', serviceKey: 'futbol-1h', start: at(TOMORROW, '19:00').toISOString(), resourceId: 'r_cancha-2' })).rejects.toBeInstanceOf(ConflictException);
    expect(db.contact).toHaveLength(before);
    await svc.staffReschedule(STAFF, a.id, { start: at(TOMORROW, '20:00').toISOString() });
    await svc.staffCancel(STAFF, a.id, { reason: 'Llovió' });
    expect(db.bookingNotice.map((n: any) => n.kind)).toEqual(expect.arrayContaining(['RESCHEDULE', 'CANCELLATION']));
    const detail = await svc.detail(STAFF, a.id);
    expect(detail.history.map((h: any) => h.action)).toEqual(['CREATED', 'RESCHEDULED', 'CANCELLED']);
    expect(detail.code).toBe(bookingCode(a.id));
  });

  it('la agenda clásica no puede mover la hora de una reserva por fuera (rompería los bloqueos); cancelar o borrar los libera', async () => {
    const { prisma, db, svc } = world();
    const appts = new AppointmentsService(prisma as any, audit as any, svc);
    const r: any = await book(svc, 'laura', at(TOMORROW, '18:00'));
    await expect(appts.update(STAFF, r.appointment.id, { startsAt: at(TOMORROW, '19:00').toISOString() })).rejects.toBeInstanceOf(BadRequestException);
    await appts.update(STAFF, r.appointment.id, { status: 'CANCELLED' });
    expect(db.bookingLock).toHaveLength(0);
    const r2: any = await book(svc, 'laura', at(TOMORROW, '18:00'));
    await appts.remove(STAFF, r2.appointment.id);
    expect(db.bookingLock).toHaveLength(0);
  });

  it('no deja borrar un espacio con reservas futuras (solo desactivarlo)', async () => {
    const { svc } = world();
    await book(svc, 'laura', at(TOMORROW, '18:00'), { resourceRef: 'Cancha 2' });
    const cfg = { ...BOOKINGS, resources: [BOOKINGS.resources[0]] };
    await expect(svc.saveConfig(STAFF, { config: cfg })).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.saveConfig(STAFF, { config: { ...BOOKINGS, resources: [BOOKINGS.resources[0], { ...BOOKINGS.resources[1], active: false }] } })).resolves.toBeTruthy();
  });
});

/* ═══ Conversación completa con el asistente ═══ */

class FakeProvider implements AiProvider {
  calls: AiChatOptions[] = [];
  private q: string[] = [];
  script(...o: object[]) { this.q.push(...o.map((x) => JSON.stringify(x))); }
  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    this.calls.push(opts);
    const content = this.q.shift();
    if (content === undefined) throw new Error('sin guion');
    return { content, inputTokens: 100, outputTokens: 20, model: opts.model };
  }
  async transcribe() { return { text: '' }; }
}

describe('Por el chat: el asistente consulta, pide confirmación y reserva', () => {
  function chat(contactId = 'laura') {
    const w = world();
    w.svc.now = () => new Date(); // la conversación corre en tiempo real
    const provider = new FakeProvider();
    const agent = new AgentService(w.prisma as any, provider, undefined, undefined, undefined, undefined, w.svc);
    const engine = new EngineService(w.prisma as any, provider, audit as any, undefined, undefined, undefined, agent);
    Object.assign(w.db.company[0], { deepinfraApiKey: 'di_key', aiBillingMode: 'BYOK', aiSpendCapUsd: null });
    w.db.aiModel.push({ modelId: 'meta-llama/Llama-3.3-70B-Instruct', inputCostPerMTok: 0.23, outputCostPerMTok: 0.4 });
    w.db.bot.push({ id: 'bot1', companyId: 'coA', status: 'ACTIVE', engineMode: 'AGENT', toolsJson: JSON.stringify(AGENT_PRESETS.reservas.tools), systemPrompt: 'Atiendes las reservas de Canchas El Golazo.', personalityJson: '{}', salesJson: '{}', model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.4, replyDelayMinSec: 1, replyDelayMaxSec: 2, typingSimulation: false, handoffKeywords: '', welcomeMessage: null });
    w.db.integration.push({ id: 'line1', companyId: 'coA', botId: 'bot1', type: 'WHATSAPP', promptMode: 'INHERIT', overridePersonalityJson: '{}', overrideSalesJson: '{}' });
    w.db.conversation.push({ id: 'conv1', companyId: 'coA', contactId, integrationId: 'line1', botId: 'bot1', channel: 'SIMULATOR', status: 'OPEN', botPaused: false, needsAttention: false, aiStateJson: '{}', lastMessageAt: new Date() });
    const say = (content: string) => w.db.message.push({ id: `m${w.db.message.length + 1}`, conversationId: 'conv1', direction: 'IN', author: 'CONTACT', content, type: 'TEXT', createdAt: new Date(Date.now() + w.db.message.length) });
    const tomorrow = addDaysLocal(localParts(new Date(), TZ).date, 1);
    return { ...w, provider, engine, say, tomorrow };
  }

  it('sin el SÍ del cliente no reserva; con el SÍ reserva, da el código y el sistema lo registra como IA', async () => {
    const { db, provider, engine, say, tomorrow } = chat();
    say('Hola, ¿tienen cancha mañana a las 7 de la noche?');
    provider.script(
      { tool_calls: [{ name: 'ver_disponibilidad', args: { fecha: 'mañana', servicio: 'futbol-1h' } }] },
      { tool_calls: [{ name: 'crear_reserva', args: { fecha: 'mañana', hora: '19:00', servicio: 'futbol-1h' } }] }, // sin confirmación: debe negarse
      { reply: ['Sí, a las 7 pm están libres la Cancha 1 y la 2, cuesta $90.000. ¿Te la reservo?'], confidence: 0.9, state: 'esperando_confirmacion' },
    );
    await engine.processConversation('conv1');
    expect(db.appointment).toHaveLength(0);
    const disp = provider.calls[1].messages.find((m) => String(m.content).startsWith('[RESULTADO ver_disponibilidad]'))!;
    expect(disp.content).toContain('"hora":"19:00"');
    const denied = provider.calls[2].messages.find((m) => String(m.content).startsWith('[RESULTADO crear_reserva]'))!;
    expect(denied.content).toContain('SÍ explícito');

    say('Sí, la Cancha 1 por favor');
    provider.script(
      { tool_calls: [{ name: 'crear_reserva', args: { fecha: 'mañana', hora: '7 pm', servicio: 'futbol-1h', espacio: 'Cancha 1', cliente_confirmo: true } }] },
      { reply: ['¡Listo! Quedó reservada.'], confidence: 0.95, state: 'confirmado' },
    );
    await engine.processConversation('conv1');
    expect(db.appointment).toEqual([expect.objectContaining({ source: 'IA', resourceId: 'r_cancha-1', contactId: 'laura', conversationId: 'conv1', status: 'SCHEDULED' })]);
    expect(localParts(new Date(db.appointment[0].startsAt), TZ)).toMatchObject({ date: tomorrow, time: '19:00' });
    const ok = provider.calls[3].messages.find((m) => String(m.content).startsWith('[RESULTADO crear_reserva]'))!;
    expect(ok.content).toContain(`"codigo":"${bookingCode(db.appointment[0].id)}"`);
    // El prompt le dice al asistente cómo reservar (solo porque tiene las herramientas)
    expect(String(provider.calls[0].messages[0].content)).toContain('RESERVAS: consulta ver_disponibilidad');
  });

  it('pide el nombre si el contacto solo tiene el número; la hora ocupada devuelve alternativas', async () => {
    const { db, svc, provider, engine, say, tomorrow } = chat('sinNombre');
    await svc.book('coA', { contactId: 'pedro', start: localToUtc(tomorrow, '20:00', TZ), source: 'IA', by: 'x', serviceKey: 'futbol-1h', resourceRef: 'Cancha 1' });
    await svc.book('coA', { contactId: 'pedro', start: localToUtc(tomorrow, '20:00', TZ), source: 'IA', by: 'x', serviceKey: 'futbol-1h', resourceRef: 'Cancha 2' });
    say('Resérvame mañana a las 8 pm, sí confirmo');
    provider.script(
      { tool_calls: [{ name: 'crear_reserva', args: { fecha: 'mañana', hora: '20:00', servicio: 'futbol-1h', cliente_confirmo: true } }] },
      { tool_calls: [{ name: 'crear_reserva', args: { fecha: 'mañana', hora: '20:00', servicio: 'futbol-1h', nombre: 'Andrés', cliente_confirmo: true } }] },
      { reply: ['A las 8 está todo ocupado, ¿te sirve a las 7 o a las 9?'], confidence: 0.9, state: 'consultando' },
    );
    await engine.processConversation('conv1');
    const results = provider.calls.flatMap((c) => c.messages).filter((m) => String(m.content).startsWith('[RESULTADO crear_reserva]')).map((m) => String(m.content));
    expect(results[0]).toContain('Falta el nombre');
    expect(results[1]).toContain('alternativas');
    expect(db.contact.find((c: any) => c.id === 'sinNombre')!.name).toBe('Andrés');
    expect(db.appointment.filter((a: any) => a.contactId === 'sinNombre')).toHaveLength(0);
  });

  it('el cliente solo puede cancelar SUS reservas (su número es su identidad)', async () => {
    const { db, svc, provider, engine, say, tomorrow } = chat('laura');
    const pedro: any = await svc.book('coA', { contactId: 'pedro', start: localToUtc(tomorrow, '15:00', TZ), source: 'IA', by: 'x', serviceKey: 'futbol-1h' });
    say(`Cancela la reserva ${bookingCode(pedro.appointment.id)}`);
    provider.script(
      { tool_calls: [{ name: 'cancelar_reserva', args: { codigo: bookingCode(pedro.appointment.id), cliente_confirmo: true } }] },
      { reply: ['No encuentro esa reserva a tu nombre.'], confidence: 0.9, state: 'consultando' },
    );
    await engine.processConversation('conv1');
    expect(db.appointment.find((a: any) => a.id === pedro.appointment.id)!.status).toBe('SCHEDULED');
  });
});
