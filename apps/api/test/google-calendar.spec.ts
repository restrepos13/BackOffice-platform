/**
 * Fase 2A.1 — Google Calendar ↔ BackOffice, contra un Google falso que responde
 * como la API oficial (test/helpers/fake-google.ts). Cubre conexión y
 * desconexión, ida y vuelta, cancelaciones y borrados, duplicados y ciclos,
 * conflictos y ediciones simultáneas, fallos y reintentos, notificaciones e
 * incremental, aislamiento, permisos y zonas horarias.
 *
 * Esto prueba NUESTRO código contra el contrato de Google; la prueba de punta a
 * punta con una cuenta real requiere el cliente OAuth (ver docs/google-calendar.md).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProductsGuard } from '../src/auth/products.guard';
import { BookingsService } from '../src/modules/bookings.module';
import { CalendarSyncController, CalendarSyncService, eventIdFor } from '../src/modules/calendar-sync.module';
import { localToUtc, localParts } from '../src/common/bookings';
import { eventRange } from '../src/common/google-calendar';
import { createMockPrisma } from './helpers/mock-prisma';
import { FakeGoogle } from './helpers/fake-google';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba';
const audit = { log: jest.fn(async () => undefined) };
const TZ = 'America/Bogota';
const NOW = new Date('2026-10-23T15:00:00Z'); // viernes 10:00 en Bogotá
const TOMORROW = '2026-10-24';
const at = (d: string, t: string) => localToUtc(d, t, TZ);
const ADMIN = { id: 'uA', name: 'Ana', email: 'a@x', role: 'COMPANY_ADMIN', companyId: 'coA' } as any;
const ADMIN_B = { id: 'uB', name: 'Beto', email: 'b@x', role: 'COMPANY_ADMIN', companyId: 'coB' } as any;
const CAL = 'canchas@group.calendar.google.com';

const BOOKINGS = {
  enabled: true, slotMinutes: 60,
  resources: [{ id: 'r_cancha-1', name: 'Cancha 1', active: true }, { id: 'r_cancha-2', name: 'Cancha 2', active: true }],
  services: [{ key: 'futbol-1h', name: 'Fútbol 5 · 1 hora', durationMin: 60, price: 90000, resourceIds: [] }],
  hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: '06:00', close: '23:00' })),
  leadMinutes: 60, maxDaysAhead: 30, cancelUntilHours: 2, maxActivePerContact: 10, requireName: true,
  reminders: { enabled: false, hoursBefore: 24 }, notifyOnStaffChanges: false,
};

function world(opts: { credentials?: boolean; https?: boolean } = {}) {
  if (opts.credentials === false) {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  } else {
    process.env.GOOGLE_CLIENT_ID = 'cliente.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'secreto-cliente';
  }
  const { prisma, db: rawDb } = createMockPrisma();
  const db = rawDb as any;
  const productsJson = JSON.stringify({ AUTOMATION: { enabled: true }, CREATIVE: { enabled: false }, ADS: { enabled: false } });
  for (const id of ['coA', 'coB']) {
    db.company.push({ id, name: id === 'coA' ? 'Canchas El Golazo' : 'Otra', timezone: TZ, currency: 'COP', planId: 'p1', productsJson, waTemplatesJson: '[]', orderConfigJson: JSON.stringify({ bookings: BOOKINGS }) });
  }
  db.platformSetting.push({ key: 'PUBLIC_WEB_URL', value: 'https://app.backoffice.test' });
  if (opts.https !== false) db.platformSetting.push({ key: 'WEBHOOK_BASE_URL', value: 'https://api.backoffice.test' });
  db.contact.push({ id: 'laura', companyId: 'coA', name: 'Laura', phone: '+573001112233', optOut: false });
  const bookings = new BookingsService(prisma as any, audit as any, null);
  bookings.now = () => NOW;
  const google = new FakeGoogle();
  const cal = new CalendarSyncService(prisma as any, audit as any, bookings);
  cal.fetchImpl = google.fetch as any;
  cal.now = () => NOW;
  return { prisma, db, bookings, cal, google };
}

async function connect(w: ReturnType<typeof world>, user = ADMIN, calendarId = CAL) {
  const { url } = await w.cal.start(user);
  const state = new URL(url).searchParams.get('state')!;
  const redirect = await w.cal.callback('codigo-bueno', state);
  expect(redirect).toBe('https://app.backoffice.test/app/integrations?google=elegir');
  return w.cal.selectCalendar(user, { calendarId });
}
const book = (w: ReturnType<typeof world>, start: Date, resourceRef = 'Cancha 1') =>
  w.bookings.book('coA', { contactId: 'laura', start, source: 'IA', by: 'Asistente IA', serviceKey: 'futbol-1h', resourceRef } as any);
const ext = (id: string, start: Date, end: Date, extra: Record<string, unknown> = {}) => ({ id, summary: 'Mantenimiento de la cancha', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, ...extra });

describe('Conexión', () => {
  it('sin el cliente OAuth configurado no se puede conectar (estado pendiente, sin simular)', async () => {
    const w = world({ credentials: false });
    await expect(w.cal.start(ADMIN)).rejects.toThrow(/GOOGLE_CLIENT_ID/);
    expect(await w.cal.status(ADMIN)).toMatchObject({ configured: false, connection: null });
  });

  it('pide solo los permisos necesarios, sin conexión offline no hay sincronización: guarda los tokens cifrados y nunca los devuelve', async () => {
    const w = world();
    const { url } = await w.cal.start(ADMIN);
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')!.split(' ')).toEqual([
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events',
    ]);
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.backoffice.test/api/public/calendar/google/callback');
    await w.cal.callback('codigo-bueno', u.searchParams.get('state')!);
    const conn = w.db.calendarConnection[0];
    expect(conn).toMatchObject({ companyId: 'coA', status: 'PENDING_SELECTION', accountEmail: 'dueno@gmail.com' });
    expect(JSON.stringify(conn)).not.toContain('refresco-secreto');
    expect(JSON.stringify(conn)).not.toContain('acceso-1');
    const view = await w.cal.status(ADMIN);
    expect(JSON.stringify(view)).not.toMatch(/refresco|acceso-1|tokenEnc|TokenEnc/);
    expect(view.connection!.calendars.map((c: any) => c.id)).toEqual(['dueno@gmail.com', CAL]);
  });

  it('estado falso, código inválido, permisos recortados o cancelación → vuelve con error y no conecta', async () => {
    const w = world();
    const { url } = await w.cal.start(ADMIN);
    const state = new URL(url).searchParams.get('state')!;
    expect(await w.cal.callback('codigo-bueno', 'falso')).toMatch(/google=error/);
    expect(await w.cal.callback('codigo-malo', state)).toMatch(/google=error/);
    expect(await w.cal.callback(undefined, state, 'access_denied')).toMatch(/google=cancelado/);
    w.google.grantedScope = 'https://www.googleapis.com/auth/calendar.events';
    expect(await w.cal.callback('codigo-bueno', state)).toMatch(/google=permisos/);
    expect(w.db.calendarConnection).toHaveLength(0);
  });

  it('elegir calendario: solo uno de la cuenta con permiso de escritura; conecta, sincroniza y abre el canal de notificaciones', async () => {
    const w = world();
    const { url } = await w.cal.start(ADMIN);
    await w.cal.callback('codigo-bueno', new URL(url).searchParams.get('state')!);
    await expect(w.cal.selectCalendar(ADMIN, { calendarId: 'ajeno@gmail.com' })).rejects.toBeInstanceOf(BadRequestException);
    const r = await w.cal.selectCalendar(ADMIN, { calendarId: CAL });
    expect(r.connection).toMatchObject({ status: 'CONNECTED', calendarId: CAL, calendarName: 'Canchas', channelActive: true, lastSyncStatus: 'OK' });
    expect([...w.google.channels.values()][0].address).toBe('https://api.backoffice.test/api/public/calendar/google/notify');
  });

  it('sin URL pública https no hay notificaciones: se sincroniza cada 15 min (y la interfaz lo dice)', async () => {
    const w = world({ https: false });
    w.db.platformSetting.find((s: any) => s.key === 'PUBLIC_WEB_URL').value = 'http://localhost:5173';
    const { url } = await w.cal.start(ADMIN);
    await w.cal.callback('codigo-bueno', new URL(url).searchParams.get('state')!);
    const r = await w.cal.selectCalendar(ADMIN, { calendarId: CAL });
    expect(r.notifications).toBe(false);
    expect(r.connection!.channelActive).toBe(false);
  });

  it('desconectar detiene el canal, revoca el acceso y borra los vínculos; los eventos creados quedan salvo que se pida borrarlos', async () => {
    const w = world();
    await connect(w);
    const a: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(a.appointment.id);
    const keep = await w.cal.disconnect(ADMIN, {});
    expect(keep.deletedEvents).toBe(0);
    expect(w.google.events.get(eventIdFor(a.appointment.id))!.status).toBe('confirmed');
    expect(w.google.stoppedChannels).toHaveLength(1);
    expect(w.google.revokedTokens).toEqual(['refresco-secreto']);
    expect(w.db.calendarConnection).toHaveLength(0);
    expect(w.db.calendarEventLink).toHaveLength(0);
    expect(w.db.appointment[0].status).toBe('SCHEDULED'); // las reservas no se tocan
    // Con la opción, también se borran en Google los eventos que creó BackOffice
    await connect(w);
    await w.cal.pushAppointment(a.appointment.id, { force: true });
    expect((await w.cal.disconnect(ADMIN, { deleteCreatedEvents: true })).deletedEvents).toBe(1);
    expect(w.google.events.get(eventIdFor(a.appointment.id))!.status).toBe('cancelled');
  });
});

describe('BackOffice → Google', () => {
  it('crea el evento de una reserva (id fijo, marca de BackOffice, sin datos del cliente), lo cambia y lo borra al cancelar', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SYNCED');
    const ev = w.google.events.get(eventIdFor(r.appointment.id))!;
    expect(ev).toMatchObject({ summary: 'Fútbol 5 · 1 hora · Cancha 1 · BackOffice', start: { dateTime: '2026-10-24T23:00:00.000Z', timeZone: TZ } });
    expect(ev.extendedProperties.private).toEqual({ backofficeAppointmentId: r.appointment.id, backofficeCompanyId: 'coA' });
    expect(JSON.stringify(ev)).not.toMatch(/Laura|3001112233/);
    // Lo mismo otra vez: no llama a Google
    const before = w.google.calls.length;
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SKIPPED');
    expect(w.google.calls.length).toBe(before);
    // Reprogramar → PATCH con If-Match del etag conocido
    await w.bookings.reschedule('coA', r.appointment.id, { start: at(TOMORROW, '19:00'), by: 'Ana', actor: 'STAFF' });
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SYNCED');
    const patch = w.google.calls.filter((c) => c.method === 'PATCH').at(-1)!;
    expect(patch.headers!['If-Match']).toBe(ev.etag);
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.start.dateTime).toBe('2026-10-25T00:00:00.000Z');
    await w.bookings.cancel('coA', r.appointment.id, { by: 'Ana', actor: 'STAFF' });
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SYNCED');
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.status).toBe('cancelled');
    expect(w.db.calendarEventLink[0].status).toBe('DELETED');
  });

  it('cada cambio de una reserva se envía solo (oyente) y borrar la cita desde la agenda borra su evento', async () => {
    const w = world();
    await connect(w);
    w.cal.onModuleInit();
    const r: any = await book(w, at(TOMORROW, '17:00'));
    for (let i = 0; i < 20 && !w.google.events.has(eventIdFor(r.appointment.id)); i++) await new Promise((x) => setImmediate(x));
    expect(w.google.events.get(eventIdFor(r.appointment.id))?.status).toBe('confirmed');
    w.db.appointment.splice(0, 1);
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SYNCED');
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.status).toBe('cancelled');
  });

  it('si Google sí creó el evento pero la respuesta se perdió, el reintento no lo duplica (409 → actualiza)', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    w.google.external({ id: eventIdFor(r.appointment.id), summary: 'creado antes', start: { dateTime: at(TOMORROW, '18:00').toISOString() }, end: { dateTime: at(TOMORROW, '19:00').toISOString() } });
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SYNCED');
    expect([...w.google.events.keys()].filter((k) => k === eventIdFor(r.appointment.id))).toHaveLength(1);
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.summary).toContain('BackOffice');
  });
});

describe('Google → BackOffice', () => {
  it('un evento ajeno ocupa el espacio: la disponibilidad lo excluye y no se puede reservar encima', async () => {
    const w = world();
    await connect(w);
    w.google.external(ext('mant1', at(TOMORROW, '15:00'), at(TOMORROW, '17:00')));
    await w.cal.syncNow('coA');
    const av: any = await w.bookings.availability('coA', { date: TOMORROW, serviceKey: 'futbol-1h' });
    expect(av.slots.find((s: any) => s.local === '15:00')).toBeUndefined(); // bloquea las dos canchas (todas por defecto)
    expect(av.slots.find((s: any) => s.local === '17:00').resources).toHaveLength(2);
    expect(await book(w, at(TOMORROW, '16:00'))).toMatchObject({ ok: false, code: 'TAKEN', message: expect.stringMatching(/calendario del negocio/) });
    // Sin datos personales: el título no se guarda
    expect(w.db.calendarEventLink.find((l: any) => l.externalEventId === 'mant1').title).toBeNull();
  });

  it('elegir qué espacios bloquea Google: solo la Cancha 2', async () => {
    const w = world();
    await connect(w);
    await w.cal.saveSettings(ADMIN, { blockResourceIds: ['r_cancha-2', 'r_inventado'] });
    expect(JSON.parse(w.db.calendarConnection[0].blockResourceIdsJson)).toEqual(['r_cancha-2']);
    w.google.external(ext('mant2', at(TOMORROW, '15:00'), at(TOMORROW, '16:00')));
    await w.cal.syncNow('coA');
    const av: any = await w.bookings.availability('coA', { date: TOMORROW, serviceKey: 'futbol-1h' });
    expect(av.slots.find((s: any) => s.local === '15:00').resources.map((r: any) => r.name)).toEqual(['Cancha 1']);
  });

  it('cambios y borrados en Google se reflejan; "disponible", rechazados y (si se elige) todo el día no ocupan', async () => {
    const w = world();
    await connect(w);
    w.google.external(ext('e1', at(TOMORROW, '08:00'), at(TOMORROW, '09:00')));
    w.google.external(ext('libre', at(TOMORROW, '10:00'), at(TOMORROW, '11:00'), { transparency: 'transparent' }));
    w.google.external(ext('rechazado', at(TOMORROW, '12:00'), at(TOMORROW, '13:00'), { attendees: [{ self: true, responseStatus: 'declined' }] }));
    w.google.external({ id: 'feriado', summary: 'Puente', start: { date: '2026-10-26' }, end: { date: '2026-10-27' } });
    await w.cal.syncNow('coA');
    const byId = (id: string) => w.db.calendarEventLink.find((l: any) => l.externalEventId === id);
    expect([byId('e1').busy, byId('libre').busy, byId('rechazado').busy, byId('feriado').busy]).toEqual([true, false, false, true]);
    expect(byId('feriado')).toMatchObject({ allDay: true, startsAt: at('2026-10-26', '00:00'), endsAt: at('2026-10-27', '00:00') });
    w.google.external({ id: 'e1', start: { dateTime: at(TOMORROW, '20:00').toISOString() }, end: { dateTime: at(TOMORROW, '21:00').toISOString() } });
    w.google.remove('libre');
    await w.cal.syncNow('coA');
    expect(byId('e1').startsAt).toEqual(at(TOMORROW, '20:00'));
    expect(byId('libre')).toBeUndefined();
    await w.cal.saveSettings(ADMIN, { allDayBlocks: false });
    w.google.external({ id: 'feriado', summary: 'Puente (cambiado)' });
    await w.cal.syncNow('coA');
    expect(byId('feriado').busy).toBe(false);
  });

  it('solo guarda títulos si la empresa lo pide, y al apagarlo los borra', async () => {
    const w = world();
    await connect(w);
    await w.cal.saveSettings(ADMIN, { importTitles: true });
    w.google.external(ext('t1', at(TOMORROW, '08:00'), at(TOMORROW, '09:00')));
    await w.cal.syncNow('coA');
    expect(w.db.calendarEventLink.find((l: any) => l.externalEventId === 't1').title).toBe('Mantenimiento de la cancha');
    await w.cal.saveSettings(ADMIN, { importTitles: false });
    expect(w.db.calendarEventLink.find((l: any) => l.externalEventId === 't1').title).toBeNull();
  });
});

describe('Duplicados y ciclos', () => {
  it('lo que BackOffice escribe vuelve de Google con el mismo etag y se ignora; nada se importa como externo ni se reenvía', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(r.appointment.id);
    const writes = () => w.google.calls.filter((c) => ['POST', 'PATCH', 'DELETE'].includes(c.method) && c.url.includes('/events')).length;
    const before = writes();
    for (let i = 0; i < 3; i++) await w.cal.syncNow('coA');
    expect(writes()).toBe(before);
    expect(w.db.calendarEventLink.filter((l: any) => l.origin === 'GOOGLE')).toHaveLength(0);
    expect(w.db.calendarEventLink.filter((l: any) => l.status === 'CONFLICT')).toHaveLength(0);
  });

  it('el mismo evento externo leído varias veces (completo e incremental) queda una sola vez', async () => {
    const w = world();
    await connect(w);
    w.google.external(ext('dup', at(TOMORROW, '08:00'), at(TOMORROW, '09:00')));
    await w.cal.syncNow('coA');
    w.db.calendarConnection[0].syncToken = null; // fuerza otra lectura completa
    await w.cal.syncNow('coA');
    await w.cal.syncNow('coA');
    expect(w.db.calendarEventLink.filter((l: any) => l.externalEventId === 'dup')).toHaveLength(1);
  });

  it('dos sincronizaciones a la vez para la misma empresa: corre una sola', async () => {
    const w = world();
    await connect(w);
    const [a, b] = await Promise.all([w.cal.syncNow('coA'), w.cal.syncNow('coA')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('entre servidores: si otro tiene la sincronización en curso se espera; si quedó colgada (>5 min) se retoma', async () => {
    const w = world();
    await connect(w);
    Object.assign(w.db.calendarConnection[0], { lastSyncStatus: 'RUNNING', updatedAt: new Date(NOW.getTime() - 60_000) });
    expect(await w.cal.syncNow('coA')).toMatchObject({ ok: false, reason: 'ya está sincronizando' });
    w.db.calendarConnection[0].updatedAt = new Date(NOW.getTime() - 6 * 60_000);
    expect((await w.cal.syncNow('coA')).ok).toBe(true);
  });
});

describe('Conflictos y ediciones simultáneas', () => {
  it('si en Google cambian la hora de una reserva, no se aplica sola: conflicto; mantener BackOffice la restaura', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(r.appointment.id);
    w.google.external({ id: eventIdFor(r.appointment.id), start: { dateTime: at(TOMORROW, '20:00').toISOString() }, end: { dateTime: at(TOMORROW, '21:00').toISOString() } });
    await w.cal.syncNow('coA');
    expect(w.db.appointment[0].startsAt).toEqual(at(TOMORROW, '18:00'));
    const view = await w.cal.status(ADMIN);
    expect(view.conflicts).toEqual([expect.objectContaining({ kind: 'EDITED_IN_GOOGLE', googleStart: at(TOMORROW, '20:00').toISOString() })]);
    // Mientras hay conflicto, BackOffice no pisa el evento por su cuenta
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('CONFLICT');
    await w.cal.resolve(ADMIN, view.conflicts[0].id, { action: 'KEEP_BACKOFFICE' });
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.start.dateTime).toBe(at(TOMORROW, '18:00').toISOString());
    expect((await w.cal.status(ADMIN)).conflicts).toHaveLength(0);
  });

  it('aplicar la hora de Google reprograma con las mismas validaciones (bloqueos y horario)', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await book(w, at(TOMORROW, '21:00')); // la Cancha 1 ocupada a las 21:00
    await w.cal.pushAppointment(r.appointment.id);
    const move = async (h: string) => {
      w.google.external({ id: eventIdFor(r.appointment.id), start: { dateTime: at(TOMORROW, h).toISOString() }, end: { dateTime: new Date(at(TOMORROW, h).getTime() + 3600e3).toISOString() } });
      await w.cal.syncNow('coA');
      return (await w.cal.status(ADMIN)).conflicts[0];
    };
    const c1 = await move('21:00');
    // A las 21:00 la Cancha 1 está tomada, pero la Cancha 2 no: se mueve allá
    await w.cal.resolve(ADMIN, c1.id, { action: 'APPLY_GOOGLE' });
    expect(w.db.appointment.find((a: any) => a.id === r.appointment.id)).toMatchObject({ startsAt: at(TOMORROW, '21:00'), resourceId: 'r_cancha-2' });
    const c2 = await move('23:30');
    await expect(w.cal.resolve(ADMIN, c2.id, { action: 'APPLY_GOOGLE' })).rejects.toThrow(/No se pudo aplicar/);
  });

  it('borrada en Google: conflicto; se puede recrear o cancelar la reserva', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(r.appointment.id);
    w.google.remove(eventIdFor(r.appointment.id));
    await w.cal.syncNow('coA');
    let c: any = (await w.cal.status(ADMIN)).conflicts[0];
    expect(c.kind).toBe('DELETED_IN_GOOGLE');
    await w.cal.resolve(ADMIN, c.id, { action: 'RECREATE' });
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.status).toBe('confirmed');
    w.google.remove(eventIdFor(r.appointment.id));
    await w.cal.syncNow('coA');
    c = (await w.cal.status(ADMIN)).conflicts[0];
    await w.cal.resolve(ADMIN, c.id, { action: 'CANCEL_BOOKING' });
    expect(w.db.appointment[0].status).toBe('CANCELLED');
    expect(w.db.bookingLock).toHaveLength(0);
  });

  it('edición simultánea: Google cambia el evento y BackOffice reprograma antes de leerlo → 412 y conflicto, sin pisar', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(r.appointment.id);
    w.google.external({ id: eventIdFor(r.appointment.id), description: 'nota del dueño' });
    await w.bookings.reschedule('coA', r.appointment.id, { start: at(TOMORROW, '19:00'), by: 'Ana', actor: 'STAFF' });
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('CONFLICT');
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.description).toBe('nota del dueño');
    expect(w.db.appointment[0].startsAt).toEqual(at(TOMORROW, '19:00')); // la reserva y su historial siguen
  });

  it('un evento externo que llega encima de una reserva confirmada se muestra como conflicto; descartarlo lo mantiene hasta que cambie', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    w.google.external(ext('choque', at(TOMORROW, '18:00'), at(TOMORROW, '20:00')));
    await w.cal.syncNow('coA');
    const c = (await w.cal.status(ADMIN)).conflicts[0];
    expect(c).toMatchObject({ kind: 'OVERLAPS_BOOKING', codes: [expect.any(String)] });
    expect(w.db.appointment[0].status).toBe('SCHEDULED'); // nunca se cancela sola
    await w.cal.resolve(ADMIN, c.id, { action: 'DISMISS' });
    w.db.calendarConnection[0].syncToken = null;
    await w.cal.syncNow('coA');
    expect((await w.cal.status(ADMIN)).conflicts).toHaveLength(0);
    w.google.external({ id: 'choque', end: { dateTime: at(TOMORROW, '21:00').toISOString() } });
    await w.cal.syncNow('coA');
    expect((await w.cal.status(ADMIN)).conflicts).toHaveLength(1);
    expect(r.ok).toBe(true);
  });
});

describe('Fallos de Google, reintentos y recuperación', () => {
  it('Google caído al enviar: la reserva queda igual, el envío se reintenta con espera y luego se completa', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    w.google.failNext(/POST .*\/events$/, 503, 2);
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('RETRY');
    const link = () => w.db.calendarEventLink.find((l: any) => l.appointmentId === r.appointment.id);
    expect(link()).toMatchObject({ pendingOp: 'CREATE', attempts: 1 });
    expect(link().nextRetryAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect((await w.cal.status(ADMIN)).errors).toHaveLength(1);
    // La sincronización respeta la espera; cuando llega la hora, reintenta
    await w.cal.syncNow('coA');
    expect(link().pendingOp).toBe('CREATE');
    w.cal.now = () => new Date(NOW.getTime() + 3 * 60_000);
    w.google.failures = [];
    await w.cal.syncNow('coA');
    expect(link()).toMatchObject({ pendingOp: null, attempts: 0, lastError: null });
    expect(w.google.events.get(eventIdFor(r.appointment.id))!.status).toBe('confirmed');
    expect(JSON.parse(w.db.appointment[0].historyJson)[0].action).toBe('CREATED');
  });

  it('red caída o cuota (429) al leer: error visible y próximo intento programado; luego se recupera', async () => {
    const w = world();
    await connect(w);
    w.google.failNext(/GET .*\/events\?/, 0);
    expect((await w.cal.syncNow('coA')).ok).toBe(false);
    expect(w.db.calendarConnection[0]).toMatchObject({ lastSyncStatus: 'ERROR', failureCount: 1 });
    expect(w.db.calendarConnection[0].nextRetryAt.getTime()).toBeGreaterThan(NOW.getTime());
    w.google.failNext(/GET .*\/events\?/, 429);
    expect((await w.cal.syncNow('coA')).ok).toBe(false);
    expect(w.db.calendarConnection[0].failureCount).toBe(2);
    expect((await w.cal.syncNow('coA')).ok).toBe(true);
    expect(w.db.calendarConnection[0]).toMatchObject({ lastSyncStatus: 'OK', failureCount: 0, lastError: null });
  });

  it('acceso revocado en Google: la conexión queda REVOKED pidiendo reconectar (sin borrar nada)', async () => {
    const w = world();
    await connect(w);
    w.db.calendarConnection[0].accessExpiresAt = new Date(NOW.getTime() - 1000); // obliga a renovar
    w.google.revoked = true;
    expect((await w.cal.syncNow('coA')).ok).toBe(false);
    expect(w.db.calendarConnection[0]).toMatchObject({ status: 'REVOKED', lastError: expect.stringMatching(/reconecta/) });
    const r: any = await book(w, at(TOMORROW, '18:00'));
    expect(r.ok).toBe(true); // reservar nunca depende de Google
    expect(await w.cal.pushAppointment(r.appointment.id)).toBe('SKIPPED');
  });
});

describe('Incremental y notificaciones', () => {
  it('usa syncToken después de la primera lectura; si Google lo invalida (410) relee todo sin perder ni duplicar', async () => {
    const w = world();
    await connect(w);
    w.google.pageSize = 2; // fuerza varias páginas
    for (let i = 1; i <= 5; i++) w.google.external(ext(`p${i}`, at(TOMORROW, `0${i + 5}:00`), at(TOMORROW, `0${i + 6}:00`.replace('010', '10'))));
    await w.cal.syncNow('coA');
    const token = w.db.calendarConnection[0].syncToken;
    expect(token).toMatch(/^st-/);
    expect(w.db.calendarEventLink.filter((l: any) => l.origin === 'GOOGLE')).toHaveLength(5);
    w.google.external(ext('nuevo', at(TOMORROW, '12:00'), at(TOMORROW, '13:00')));
    await w.cal.syncNow('coA');
    expect(w.google.calls.filter((c) => c.url.includes(`syncToken=${token}`))).toHaveLength(1);
    expect(w.db.calendarEventLink.filter((l: any) => l.origin === 'GOOGLE')).toHaveLength(6);
    w.google.expiredSyncTokens.add(w.db.calendarConnection[0].syncToken);
    w.google.remove('p1');
    await w.cal.syncNow('coA');
    expect(w.db.calendarEventLink.filter((l: any) => l.origin === 'GOOGLE').map((l: any) => l.externalEventId).sort()).toEqual(['nuevo', 'p2', 'p3', 'p4', 'p5']);
  });

  it('el canal se renueva antes de vencer (el nuevo antes de detener el viejo)', async () => {
    const w = world();
    await connect(w);
    const first = w.db.calendarConnection[0].channelId;
    expect(await w.cal.ensureWatch('coA')).toMatchObject({ watching: true, renewed: false });
    w.db.calendarConnection[0].channelExpiresAt = new Date(NOW.getTime() + 3600e3); // vence en 1 h
    expect(await w.cal.ensureWatch('coA')).toMatchObject({ watching: true, renewed: true });
    expect(w.db.calendarConnection[0].channelId).not.toBe(first);
    expect(w.google.stoppedChannels).toEqual([first]);
  });

  it('una notificación válida dispara la sincronización; con token falso, otro canal o el aviso inicial, no', async () => {
    const w = world();
    await connect(w);
    const conn = w.db.calendarConnection[0];
    const channelToken = w.google.channels.get(conn.channelId)!.token;
    const spy = jest.spyOn(w.cal, 'syncNow');
    expect(await w.cal.notification({ channelId: conn.channelId, token: 'falso', state: 'exists' })).toEqual({ ok: false });
    expect(await w.cal.notification({ channelId: 'otro', token: channelToken, state: 'exists' })).toEqual({ ok: false });
    expect(await w.cal.notification({ channelId: conn.channelId, token: channelToken, state: 'sync' })).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();
    expect(await w.cal.notification({ channelId: conn.channelId, token: channelToken, state: 'exists', resourceId: conn.channelResourceId })).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith('coA', 'PUSH');
  });
});

describe('Aislamiento y permisos', () => {
  it('cada empresa ve y opera solo su conexión; un conflicto ajeno no se puede resolver', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(r.appointment.id);
    w.google.remove(eventIdFor(r.appointment.id));
    await w.cal.syncNow('coA');
    const c = (await w.cal.status(ADMIN)).conflicts[0];
    expect(await w.cal.status(ADMIN_B, 'coA')).toMatchObject({ connection: null }); // el companyId del navegador no cuenta
    await expect(w.cal.resolve(ADMIN_B, c.id, { action: 'RECREATE' }, 'coA')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.cal.disconnect(ADMIN_B, {}, 'coA')).rejects.toBeInstanceOf(NotFoundException);
    expect((await w.cal.calendarOverlay(ADMIN_B, { companyId: 'coA' })).blocks).toEqual([]);
  });

  it('el estado de una empresa B no se mezcla aunque use el mismo calendario de Google', async () => {
    const w = world();
    await connect(w);
    await connect(w, ADMIN_B);
    const r: any = await book(w, at(TOMORROW, '18:00'));
    await w.cal.pushAppointment(r.appointment.id);
    await w.cal.syncNow('coB');
    // Para B, la reserva de A es un evento ajeno (ocupado), nunca "suyo"
    expect(w.db.calendarEventLink.filter((l: any) => l.companyId === 'coB').map((l: any) => l.origin)).toEqual(['GOOGLE']);
  });

  it('sin BackOffice Automation los endpoints responden 403', async () => {
    const w = world();
    w.db.company[0].productsJson = JSON.stringify({ AUTOMATION: { enabled: false }, CREATIVE: { enabled: true }, ADS: { enabled: false } });
    const guard = new ProductsGuard(new Reflector(), w.prisma as any);
    const ctx = (m: string) => ({ getHandler: () => (CalendarSyncController.prototype as any)[m], getClass: () => CalendarSyncController, switchToHttp: () => ({ getRequest: () => ({ user: ADMIN }) }) } as any);
    await expect(guard.canActivate(ctx('connect'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx('status'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Zonas horarias y cambios de horario', () => {
  it('eventos con otra zona y con offset quedan en el instante correcto; los de todo el día usan la zona del calendario', () => {
    expect(eventRange({ id: 'x', start: { dateTime: '2026-10-24T18:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-24T19:00:00-04:00' } }, TZ, localToUtc))
      .toMatchObject({ start: new Date('2026-10-24T22:00:00Z'), allDay: false });
    // 1 de noviembre de 2026 termina el horario de verano en Nueva York: ese día dura 25 h
    const dst = eventRange({ id: 'y', start: { date: '2026-11-01', timeZone: 'America/New_York' }, end: { date: '2026-11-02' } }, TZ, localToUtc)!;
    expect(dst.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect((dst.end.getTime() - dst.start.getTime()) / 3600e3).toBe(25);
    // En Bogotá (sin horario de verano) un día completo dura 24 h
    const bog = eventRange({ id: 'z', start: { date: '2026-11-01' }, end: { date: '2026-11-02' } }, TZ, localToUtc)!;
    expect((bog.end.getTime() - bog.start.getTime()) / 3600e3).toBe(24);
  });

  it('la reserva viaja con la zona del negocio y el instante exacto; leída de vuelta no genera conflicto', async () => {
    const w = world();
    await connect(w);
    const r: any = await book(w, at(TOMORROW, '06:00'));
    await w.cal.pushAppointment(r.appointment.id);
    const ev = w.google.events.get(eventIdFor(r.appointment.id))!;
    expect(ev.start).toEqual({ dateTime: '2026-10-24T11:00:00.000Z', timeZone: TZ });
    expect(localParts(new Date(ev.start.dateTime), TZ).time).toBe('06:00');
    // Google la devuelve escrita en otra zona (mismo instante): no es un cambio
    w.google.external({ id: ev.id, start: { dateTime: '2026-10-24T07:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-24T08:00:00-04:00' } });
    await w.cal.syncNow('coA');
    expect((await w.cal.status(ADMIN)).conflicts).toHaveLength(0);
  });
});
