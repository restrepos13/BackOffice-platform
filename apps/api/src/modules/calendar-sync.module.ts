import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Headers, HttpCode, Injectable, Logger, Module,
  NotFoundException, OnModuleInit, Param, Post, Put, Query, Res,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { signState, verifyState } from '../common/meta-publish';
import { publicWebUrl } from '../common/tracking';
import { hasProduct } from '../common/products';
import { bookingCode, localToUtc } from '../common/bookings';
import {
  FetchLike, GOOGLE_SCOPES, GoogleApiError, GoogleApp, GoogleEvent, authUrl, deleteEvent, eventRange, exchangeCode, insertEvent,
  listEvents, listWritableCalendars, patchEvent, refreshAccess, revokeToken, stopChannel, watchEvents,
} from '../common/google-calendar';
import { AuditModule, AuditService } from './audit.module';
import { BookingsModule, BookingsService } from './bookings.module';

/**
 * Google Calendar ↔ BackOffice, por empresa.
 *
 *  - BackOffice manda en sus reservas: crea, cambia y borra SU evento en Google
 *    (id determinista + extendedProperties: nunca duplica, sabe cuál es suyo).
 *  - Lo que se edita o borra en Google de una reserva de BackOffice NO se aplica
 *    solo (saltaría bloqueos y avisos al cliente): queda como conflicto a resolver.
 *  - Los eventos ajenos se importan como "ocupado" (sin título salvo que la
 *    empresa lo pida) y bloquean los espacios elegidos. La disponibilidad sigue
 *    controlada por los bloqueos de BackOffice; Google solo suma ocupación.
 *  - Ciclos: lo que BackOffice escribió vuelve con el mismo etag y se ignora; lo
 *    que BackOffice ya envió (misma huella) no se reenvía.
 *  - Incremental con syncToken; 410 → lectura completa. Notificaciones push
 *    (renovadas antes de vencer) + sincronización de recuperación cada 15 min.
 *  - Errores: credencial revocada → REVOKED (reconectar); red/cuota/servidor →
 *    reintento con espera creciente. La reserva y su historial nunca dependen de Google.
 */

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;
const ACTIVE = ['SCHEDULED', 'CONFIRMED'];
const DIRECTIONS = ['PUSH', 'PULL', 'BOTH'] as const;
const MAX_PUSH_ATTEMPTS = 8;
const CHANNEL_TTL_S = 7 * 24 * 3600;
const RENEW_BEFORE_MS = 24 * 3600e3;
const SYNC_LEASE_MS = 5 * 60_000;
/** Eventos externos que se guardan: de ayer en adelante (el pasado no bloquea nada) */
const PAST_WINDOW_MS = 24 * 3600e3;

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
/** Id de evento en Google derivado de la reserva (base32hex válido): reintentar nunca duplica */
export const eventIdFor = (appointmentId: string) => `bo${Buffer.from(appointmentId).toString('hex')}`.toLowerCase().slice(0, 200);

@Injectable()
export class CalendarSyncService implements OnModuleInit {
  private readonly logger = new Logger('GoogleCalendar');
  fetchImpl: FetchLike = (u, i) => fetch(u, i as any) as any;
  now: () => Date = () => new Date();
  private running = new Set<string>();
  private busyCron = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
  ) {}

  /** Cada cambio de una reserva se refleja en Google (sin bloquear la reserva si Google falla). */
  onModuleInit() {
    this.bookings.onAppointmentChange((id) => {
      this.pushAppointment(id).catch((err) => this.logger.warn(`envío a Google ${id}: ${err?.message}`));
    });
  }

  /* ── Configuración de la app de Google ── */

  private async setting(key: string) {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null);
    return row?.value?.trim() || process.env[key] || '';
  }

  async app(): Promise<GoogleApp | null> {
    const clientId = await this.setting('GOOGLE_CLIENT_ID');
    const clientSecret = await this.setting('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) return null;
    const base = (await publicWebUrl(this.prisma)).replace(/\/$/, '');
    return { clientId, clientSecret, redirectUri: `${base}/api/public/calendar/google/callback` };
  }

  /** Dirección pública para las notificaciones push (Google exige https). */
  private async notifyAddress(): Promise<string | null> {
    const base = (await this.setting('WEBHOOK_BASE_URL')) || (await publicWebUrl(this.prisma));
    const url = `${base.replace(/\/$/, '')}/api/public/calendar/google/notify`;
    return url.startsWith('https://') ? url : null;
  }

  /* ── Empresa y conexión ── */

  private companyIdOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  private async connectionOf(companyId: string) {
    return this.prisma.calendarConnection.findUnique({ where: { companyId } });
  }

  private async update(id: string, data: Record<string, any>) {
    return this.prisma.calendarConnection.update({ where: { id }, data: { ...data, updatedAt: this.now() } });
  }

  /** Token de acceso vigente (se renueva solo). Si Google lo revocó, la conexión queda REVOKED. */
  private async accessToken(conn: any): Promise<string> {
    if (conn.accessTokenEnc && conn.accessExpiresAt && new Date(conn.accessExpiresAt).getTime() > this.now().getTime() + 60_000) {
      return decryptSecret(conn.accessTokenEnc);
    }
    const app = await this.app();
    if (!app) throw new GoogleApiError('NOT_CONFIGURED', 'Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET');
    if (!conn.refreshTokenEnc) throw new GoogleApiError('AUTH', 'No hay autorización guardada: reconecta Google Calendar');
    const r = await refreshAccess(app, decryptSecret(conn.refreshTokenEnc), this.fetchImpl);
    const expires = new Date(this.now().getTime() + r.expiresIn * 1000);
    await this.update(conn.id, { accessTokenEnc: encryptSecret(r.accessToken), accessExpiresAt: expires });
    conn.accessTokenEnc = encryptSecret(r.accessToken);
    conn.accessExpiresAt = expires;
    return r.accessToken;
  }

  /** Error de Google → estado de la conexión (sin tokens ni datos en el mensaje). */
  private async connectionError(conn: any, err: unknown) {
    const g = err instanceof GoogleApiError ? err : new GoogleApiError('SERVER', (err as any)?.message ?? 'Error');
    if (g.kind === 'AUTH') {
      await this.update(conn.id, { status: 'REVOKED', lastSyncStatus: 'ERROR', lastError: 'Google retiró el acceso (contraseña cambiada o permiso revocado): reconecta Google Calendar.' });
      await this.audit.log({ actor: null, companyId: conn.companyId, action: 'calendar.revoked', entity: 'CalendarConnection', entityId: conn.id, detail: g.message.slice(0, 120) });
      return;
    }
    const failureCount = (conn.failureCount ?? 0) + 1;
    await this.update(conn.id, {
      lastSyncStatus: 'ERROR', lastError: g.message.slice(0, 200), failureCount,
      nextRetryAt: g.retryable ? new Date(this.now().getTime() + Math.min(60, 2 ** failureCount) * 60_000) : null,
    });
  }

  /* ── Conectar ── */

  async start(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const app = await this.app();
    if (!app) throw new BadRequestException('Google Calendar aún no está habilitado en BackOffice (falta configurar GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET). Pídeselo al equipo.');
    const state = signState({ c: id, u: user.id, k: 'gcal' }, process.env.JWT_SECRET ?? 'dev');
    return { url: authUrl(app, state) };
  }

  /** Vuelta de Google: guarda la autorización cifrada y deja elegir el calendario. */
  async callback(code?: string, state?: string, error?: string): Promise<string> {
    const web = (await publicWebUrl(this.prisma)).replace(/\/$/, '');
    const back = (r: string) => `${web}/app/integrations?google=${r}`;
    const data = verifyState<{ c: string; u: string; k: string }>(String(state ?? ''), process.env.JWT_SECRET ?? 'dev');
    if (!data || data.k !== 'gcal') return back('error');
    if (error || !code) return back(error === 'access_denied' ? 'cancelado' : 'error');
    const app = await this.app();
    if (!app) return back('error');
    try {
      const t = await exchangeCode(app, code, this.fetchImpl);
      const granted = t.scope.split(' ');
      if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) return back('permisos');
      const existing = await this.connectionOf(data.c);
      const refresh = t.refreshToken ?? (existing?.refreshTokenEnc ? decryptSecret(existing.refreshTokenEnc) : null);
      if (!refresh) return back('error');
      const calendars = await listWritableCalendars(t.accessToken, this.fetchImpl);
      const primary = calendars.find((c) => c.primary);
      const fields = {
        status: 'PENDING_SELECTION', provider: 'GOOGLE', accountEmail: primary?.id ?? null,
        refreshTokenEnc: encryptSecret(refresh), accessTokenEnc: encryptSecret(t.accessToken),
        accessExpiresAt: new Date(this.now().getTime() + t.expiresIn * 1000), scopes: t.scope.slice(0, 500),
        calendarsJson: JSON.stringify(calendars.slice(0, 100)), lastError: null, failureCount: 0, createdBy: data.u, updatedAt: this.now(),
      };
      if (existing) await this.prisma.calendarConnection.update({ where: { id: existing.id }, data: fields });
      else await this.prisma.calendarConnection.create({ data: { companyId: data.c, ...fields } });
      await this.audit.log({ actor: null, companyId: data.c, action: 'calendar.authorized', entity: 'CalendarConnection', entityId: data.c, detail: primary?.id ?? 'cuenta de Google' });
      return back('elegir');
    } catch (err: any) {
      this.logger.warn(`OAuth Google Calendar: ${err?.kind ?? ''} ${String(err?.message ?? '').slice(0, 120)}`);
      return back('error');
    }
  }

  /** Elige el calendario y arranca: primera sincronización y notificaciones. */
  async selectCalendar(user: AuthUser, dto: { calendarId?: string }, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const conn = await this.connectionOf(id);
    if (!conn || !conn.refreshTokenEnc) throw new BadRequestException('Primero conecta tu cuenta de Google');
    const calendars = parseJson<Array<{ id: string; name: string; timeZone: string | null }>>(conn.calendarsJson, []);
    const chosen = calendars.find((c) => c.id === dto?.calendarId);
    if (!chosen) throw new BadRequestException('Ese calendario no está en tu cuenta o no tienes permiso para escribir en él');
    const changed = conn.calendarId && conn.calendarId !== chosen.id;
    if (changed) await this.stopWatch(conn);
    const updated = await this.update(conn.id, {
      status: 'CONNECTED', calendarId: chosen.id, calendarName: chosen.name.slice(0, 120), calendarTimeZone: chosen.timeZone,
      ...(changed ? { syncToken: null } : {}),
    });
    if (changed) await this.prisma.calendarEventLink.deleteMany({ where: { connectionId: conn.id } });
    await this.audit.log({ actor: user, companyId: id, action: 'calendar.selected', entity: 'CalendarConnection', entityId: conn.id, detail: chosen.name.slice(0, 80) });
    const result = await this.syncNow(updated.companyId, 'MANUAL');
    await this.ensureWatch(updated.companyId).catch(() => undefined);
    return { ...(await this.view(updated.companyId)), result };
  }

  async saveSettings(user: AuthUser, dto: any, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const conn = await this.connectionOf(id);
    if (!conn) throw new NotFoundException('Google Calendar no está conectado');
    const company = await this.prisma.company.findUnique({ where: { id } });
    const { cfg } = this.bookings.configOf(company);
    const valid = new Set(cfg.resources.map((r) => r.id));
    const data: Record<string, any> = {};
    if (DIRECTIONS.includes(dto?.direction)) data.direction = dto.direction;
    if (Array.isArray(dto?.blockResourceIds)) data.blockResourceIdsJson = JSON.stringify(dto.blockResourceIds.map(String).filter((r: string) => valid.has(r)));
    if (typeof dto?.allDayBlocks === 'boolean') data.allDayBlocks = dto.allDayBlocks;
    if (typeof dto?.importTitles === 'boolean') {
      data.importTitles = dto.importTitles;
      // Al apagar los títulos se borran los que ya se guardaron
      if (!dto.importTitles) await this.prisma.calendarEventLink.updateMany({ where: { connectionId: conn.id, origin: 'GOOGLE' }, data: { title: null } });
    }
    await this.update(conn.id, data);
    await this.audit.log({ actor: user, companyId: id, action: 'calendar.settings', entity: 'CalendarConnection', entityId: conn.id, detail: JSON.stringify(data).slice(0, 200) });
    return this.view(id);
  }

  /* ── Estado (sin tokens) ── */

  async view(companyId: string) {
    const app = await this.app();
    const conn = await this.connectionOf(companyId);
    if (!conn) return { configured: !!app, connection: null, conflicts: [], errors: [], notifications: !!(await this.notifyAddress()) };
    const links = await this.prisma.calendarEventLink.findMany({ where: { connectionId: conn.id, OR: [{ status: 'CONFLICT' }, { lastError: { not: null } }] }, take: 100 });
    const apptIds = links.map((l: any) => l.appointmentId).filter(Boolean);
    const appts = apptIds.length ? await this.prisma.appointment.findMany({ where: { id: { in: apptIds } }, select: { id: true, title: true, startsAt: true, status: true } }) : [];
    const byId = new Map(appts.map((a: any) => [a.id, a]));
    return {
      configured: !!app,
      notifications: !!(await this.notifyAddress()),
      connection: {
        status: conn.status, accountEmail: conn.accountEmail, calendarId: conn.calendarId, calendarName: conn.calendarName,
        calendarTimeZone: conn.calendarTimeZone,
        calendars: conn.status === 'PENDING_SELECTION' || conn.status === 'CONNECTED' ? parseJson<any[]>(conn.calendarsJson, []).map((c) => ({ id: c.id, name: c.name, primary: c.primary })) : [],
        direction: conn.direction, blockResourceIds: parseJson<string[]>(conn.blockResourceIdsJson, []), allDayBlocks: conn.allDayBlocks, importTitles: conn.importTitles,
        lastSyncAt: conn.lastSyncAt, lastSyncStatus: conn.lastSyncStatus, lastError: conn.lastError, nextRetryAt: conn.nextRetryAt,
        channelActive: !!conn.channelId && !!conn.channelExpiresAt && new Date(conn.channelExpiresAt).getTime() > this.now().getTime(),
        channelExpiresAt: conn.channelExpiresAt,
      },
      conflicts: links.filter((l: any) => l.status === 'CONFLICT').map((l: any) => ({
        id: l.id, origin: l.origin, ...parseJson<Record<string, any>>(l.conflictJson, {}),
        appointment: l.appointmentId && byId.get(l.appointmentId) ? { id: l.appointmentId, code: bookingCode(l.appointmentId), ...byId.get(l.appointmentId) } : null,
        startsAt: l.startsAt, endsAt: l.endsAt,
      })),
      errors: links.filter((l: any) => l.status !== 'CONFLICT' && l.lastError).map((l: any) => ({
        id: l.id, appointment: byId.get(l.appointmentId) ? { code: bookingCode(l.appointmentId), title: byId.get(l.appointmentId)!.title } : null,
        pendingOp: l.pendingOp, attempts: l.attempts, lastError: l.lastError, nextRetryAt: l.nextRetryAt,
      })),
    };
  }

  async status(user: AuthUser, companyId?: string) {
    return this.view(this.companyIdOf(user, companyId));
  }

  /** Para la agenda: eventos de Google que ocupan y estado de sincronización de cada reserva. */
  async calendarOverlay(user: AuthUser, q: { companyId?: string; from?: string; to?: string }) {
    const id = this.companyIdOf(user, q.companyId);
    const conn = await this.connectionOf(id);
    if (!conn) return { connected: false, blocks: [], sync: {} };
    const from = q.from ? new Date(q.from) : new Date(this.now().getTime() - 30 * 86400e3);
    const to = q.to ? new Date(q.to) : new Date(this.now().getTime() + 60 * 86400e3);
    const links = await this.prisma.calendarEventLink.findMany({ where: { connectionId: conn.id }, take: 2000 });
    const blocks = links
      .filter((l: any) => l.origin === 'GOOGLE' && l.busy && l.status !== 'DELETED' && l.startsAt && new Date(l.endsAt) > from && new Date(l.startsAt) < to)
      .map((l: any) => ({ id: l.id, startsAt: l.startsAt, endsAt: l.endsAt, allDay: l.allDay, title: l.title || 'Ocupado (Google Calendar)', conflict: l.status === 'CONFLICT' }));
    const sync: Record<string, 'SYNCED' | 'PENDING' | 'CONFLICT' | 'ERROR'> = {};
    for (const l of links.filter((x: any) => x.origin === 'BACKOFFICE' && x.appointmentId)) {
      sync[l.appointmentId!] = l.status === 'CONFLICT' ? 'CONFLICT' : l.lastError ? 'ERROR' : l.pendingOp ? 'PENDING' : 'SYNCED';
    }
    return { connected: conn.status === 'CONNECTED', blocks, sync };
  }

  /* ── BackOffice → Google ── */

  private eventBody(appt: any, company: any) {
    return {
      summary: `${appt.title} · BackOffice`.slice(0, 200),
      // Sin teléfono ni datos del cliente: solo lo necesario para ubicar la reserva
      description: `Reserva ${bookingCode(appt.id)} gestionada por BackOffice. Para cambiarla o cancelarla usa BackOffice: los cambios hechos aquí no se aplican solos.`,
      location: appt.location ?? undefined,
      start: { dateTime: new Date(appt.startsAt).toISOString(), timeZone: company.timezone || 'America/Bogota' },
      end: { dateTime: new Date(appt.endsAt ?? new Date(new Date(appt.startsAt).getTime() + appt.durationMin * 60000)).toISOString(), timeZone: company.timezone || 'America/Bogota' },
      transparency: 'opaque',
      extendedProperties: { private: { backofficeAppointmentId: appt.id, backofficeCompanyId: appt.companyId } },
    };
  }

  /** Lo que BackOffice manda de una reserva (huella para no reenviar lo mismo). */
  private desired(appt: any, company: any) {
    const active = ACTIVE.includes(appt.status);
    const body = active ? this.eventBody(appt, company) : null;
    return { active, body, pushedHash: hash(active ? JSON.stringify(body) : 'DELETED') };
  }

  /**
   * Refleja una reserva en Google. Idempotente: misma huella → nada; reintentos
   * del alta usan el mismo id de evento (Google responde 409 y se actualiza).
   */
  async pushAppointment(appointmentId: string, opts: { force?: boolean } = {}): Promise<'SKIPPED' | 'SYNCED' | 'RETRY' | 'CONFLICT'> {
    const found = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    // Reserva borrada desde la agenda: su evento en Google también se borra
    const orphan = found ? null : await this.prisma.calendarEventLink.findFirst({ where: { appointmentId, origin: 'BACKOFFICE' } });
    if (!found && !orphan) return 'SKIPPED';
    const appt: any = found ?? { id: appointmentId, companyId: orphan!.companyId, resourceId: 'borrada', status: 'DELETED' };
    if (!appt.resourceId) return 'SKIPPED'; // solo reservas en línea
    const conn = await this.connectionOf(appt.companyId);
    if (!conn || conn.status !== 'CONNECTED' || !conn.calendarId || conn.direction === 'PULL') return 'SKIPPED';
    const company = await this.prisma.company.findUnique({ where: { id: appt.companyId } });
    if (!company || !hasProduct(company, 'AUTOMATION')) return 'SKIPPED';
    let link = await this.prisma.calendarEventLink.findFirst({ where: { connectionId: conn.id, appointmentId: appt.id, origin: 'BACKOFFICE' } });
    const want = this.desired(appt, company);
    if (link?.status === 'CONFLICT' && !opts.force) return 'CONFLICT'; // lo resuelve una persona
    if (link && link.pushedHash === want.pushedHash && !link.pendingOp && !opts.force) return 'SKIPPED';
    if (!link && !want.active) return 'SKIPPED'; // nunca estuvo en Google
    // Solo existe en Google si Google lo confirmó (etag); un CREATE fallido se reintenta como CREATE (409 → actualiza)
    const op = !want.active ? 'DELETE' : link?.etag ? 'UPDATE' : 'CREATE';
    if (!link) {
      link = await this.prisma.calendarEventLink.create({ data: { companyId: appt.companyId, connectionId: conn.id, origin: 'BACKOFFICE', appointmentId: appt.id, externalEventId: eventIdFor(appt.id), pendingOp: op } });
    }
    try {
      const token = await this.accessToken(conn);
      let ev: GoogleEvent | null = null;
      if (op === 'CREATE') {
        try {
          ev = await insertEvent(token, conn.calendarId, { id: eventIdFor(appt.id), ...want.body }, this.fetchImpl);
        } catch (err) {
          // Ya existía (un reintento después de que Google sí lo creó): se actualiza
          if (err instanceof GoogleApiError && err.status === 409) ev = await patchEvent(token, conn.calendarId, eventIdFor(appt.id), { ...want.body, status: 'confirmed' }, null, this.fetchImpl);
          else throw err;
        }
      } else if (op === 'UPDATE') {
        ev = await patchEvent(token, conn.calendarId, link.externalEventId!, opts.force ? { ...want.body, status: 'confirmed' } : want.body!, opts.force ? null : link.etag, this.fetchImpl);
      } else {
        try {
          await deleteEvent(token, conn.calendarId, link.externalEventId!, this.fetchImpl);
        } catch (err) {
          if (!(err instanceof GoogleApiError && err.kind === 'NOT_FOUND')) throw err; // ya no estaba: listo
        }
      }
      await this.prisma.calendarEventLink.update({
        where: { id: link.id },
        data: {
          etag: ev?.etag ?? link.etag, pushedHash: want.pushedHash, pendingOp: null, attempts: 0, lastError: null, nextRetryAt: null,
          status: op === 'DELETE' ? 'DELETED' : 'ACTIVE', conflictJson: null, externalEventId: ev?.id ?? link.externalEventId, updatedAt: this.now(),
        },
      });
      return 'SYNCED';
    } catch (err: any) {
      const g = err instanceof GoogleApiError ? err : new GoogleApiError('SERVER', err?.message ?? 'Error');
      if (g.kind === 'PRECONDITION' || (g.kind === 'NOT_FOUND' && op === 'UPDATE')) {
        // Alguien cambió o borró el evento en Google mientras tanto: decide una persona
        await this.conflict(link.id, g.kind === 'PRECONDITION' ? 'EDITED_IN_GOOGLE' : 'DELETED_IN_GOOGLE', g.kind === 'PRECONDITION' ? 'El evento se cambió en Google al mismo tiempo que en BackOffice.' : 'El evento de esta reserva ya no está en Google.');
        return 'CONFLICT';
      }
      if (g.kind === 'AUTH' || g.kind === 'NOT_CONFIGURED') await this.connectionError(conn, g);
      const attempts = (link.attempts ?? 0) + 1;
      await this.prisma.calendarEventLink.update({
        where: { id: link.id },
        data: {
          pendingOp: op, attempts, lastError: g.message.slice(0, 200), updatedAt: this.now(),
          nextRetryAt: g.retryable && attempts < MAX_PUSH_ATTEMPTS ? new Date(this.now().getTime() + Math.min(60, 2 ** attempts) * 60_000) : null,
        },
      });
      return 'RETRY';
    }
  }

  private async conflict(linkId: string, kind: string, detail: string, extra: Record<string, unknown> = {}) {
    await this.prisma.calendarEventLink.update({
      where: { id: linkId },
      data: { status: 'CONFLICT', conflictJson: JSON.stringify({ kind, detail, at: this.now().toISOString(), ...extra }), pendingOp: null, nextRetryAt: null, updatedAt: this.now() },
    });
  }

  /* ── Google → BackOffice ── */

  /** Sincronización incremental de una empresa (manual, por notificación o de recuperación). */
  async syncNow(companyId: string, trigger: 'MANUAL' | 'PUSH' | 'CRON' = 'MANUAL') {
    // Una sola sincronización a la vez por empresa (aunque lleguen varias notificaciones):
    // se marca antes de cualquier await; entre instancias lo cubre el lease en la base
    if (this.running.has(companyId)) return { ok: false, reason: 'ya está sincronizando' };
    this.running.add(companyId);
    try {
      return await this.syncLocked(companyId, trigger);
    } finally {
      this.running.delete(companyId);
    }
  }

  private async syncLocked(companyId: string, trigger: 'MANUAL' | 'PUSH' | 'CRON') {
    const conn = await this.connectionOf(companyId);
    if (!conn || conn.status !== 'CONNECTED' || !conn.calendarId) return { ok: false, reason: 'no conectado' };
    const claim = await this.prisma.calendarConnection.updateMany({
      where: { id: conn.id, OR: [{ lastSyncStatus: { not: 'RUNNING' } }, { lastSyncStatus: null }, { updatedAt: { lt: new Date(this.now().getTime() - SYNC_LEASE_MS) } }] },
      data: { lastSyncStatus: 'RUNNING', updatedAt: this.now() },
    });
    if (!claim.count) return { ok: false, reason: 'ya está sincronizando' };
    try {
      const counts = { created: 0, updated: 0, removed: 0, conflicts: 0, pushed: 0 };
      if (conn.direction !== 'PUSH') await this.pull(conn, counts);
      // Lo que quedó pendiente de enviar (reintentos) y reservas aún no reflejadas
      if (conn.direction !== 'PULL') counts.pushed = await this.pushPending(conn);
      await this.update(conn.id, { lastSyncAt: this.now(), lastSyncStatus: 'OK', lastError: null, failureCount: 0, nextRetryAt: null });
      if (trigger === 'MANUAL') await this.audit.log({ actor: null, companyId, action: 'calendar.sync', entity: 'CalendarConnection', entityId: conn.id, detail: JSON.stringify(counts) });
      return { ok: true, ...counts };
    } catch (err) {
      await this.connectionError(await this.connectionOf(companyId), err);
      return { ok: false, reason: err instanceof Error ? err.message : 'error' };
    }
  }

  private async pull(conn: any, counts: Record<string, number>) {
    const token = await this.accessToken(conn);
    let result: { events: GoogleEvent[]; nextSyncToken: string | null };
    let full = !conn.syncToken;
    try {
      result = await listEvents(token, conn.calendarId, full ? { timeMin: new Date(this.now().getTime() - PAST_WINDOW_MS).toISOString() } : { syncToken: conn.syncToken }, this.fetchImpl);
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.kind === 'GONE')) throw err;
      // El syncToken venció: se vuelve a leer todo y se rehacen los bloqueos externos
      full = true;
      await this.prisma.calendarEventLink.deleteMany({ where: { connectionId: conn.id, origin: 'GOOGLE' } });
      result = await listEvents(token, conn.calendarId, { timeMin: new Date(this.now().getTime() - PAST_WINDOW_MS).toISOString() }, this.fetchImpl);
    }
    const company = await this.prisma.company.findUnique({ where: { id: conn.companyId } });
    const tz = conn.calendarTimeZone || company?.timezone || 'America/Bogota';
    const seen = new Set<string>();
    for (const e of result.events) {
      seen.add(e.id);
      const mine = e.extendedProperties?.private?.backofficeAppointmentId;
      if (mine && e.extendedProperties?.private?.backofficeCompanyId === conn.companyId) await this.pullOwn(conn, e, counts);
      else await this.pullExternal(conn, e, tz, counts);
    }
    if (full) {
      // Lectura completa: lo que ya no aparece fue borrado
      const stale = await this.prisma.calendarEventLink.findMany({ where: { connectionId: conn.id, origin: 'GOOGLE' } });
      const gone = stale.filter((l: any) => !seen.has(l.externalEventId)).map((l: any) => l.id);
      if (gone.length) {
        await this.prisma.calendarEventLink.deleteMany({ where: { id: { in: gone } } });
        counts.removed += gone.length;
      }
    }
    if (result.nextSyncToken) await this.update(conn.id, { syncToken: result.nextSyncToken });
  }

  /** Un evento de BackOffice que vuelve de Google: eco propio, cambio cosmético o conflicto. */
  private async pullOwn(conn: any, e: GoogleEvent, counts: Record<string, number>) {
    const appointmentId = e.extendedProperties!.private!.backofficeAppointmentId;
    const link = await this.prisma.calendarEventLink.findFirst({ where: { connectionId: conn.id, appointmentId, origin: 'BACKOFFICE' } });
    if (!link) return; // de una conexión anterior: no se toca
    if (link.etag && e.etag === link.etag) return; // nuestro propio cambio de vuelta (sin ciclo)
    const appt = await this.prisma.appointment.findUnique({ where: { id: appointmentId } });
    if (e.status === 'cancelled') {
      if (link.status === 'DELETED' || !appt || !ACTIVE.includes(appt.status)) return;
      await this.conflict(link.id, 'DELETED_IN_GOOGLE', 'Alguien borró en Google el evento de una reserva activa. La reserva sigue en BackOffice.');
      counts.conflicts++;
      return;
    }
    if (!appt) return;
    const range = eventRange(e, 'UTC', localToUtc);
    const same = range && range.start.getTime() === new Date(appt.startsAt).getTime() && range.end.getTime() === new Date(appt.endsAt ?? appt.startsAt).getTime();
    if (same) {
      // Cambio que no afecta la reserva (color, descripción): solo se actualiza el etag
      await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { etag: e.etag ?? link.etag, updatedAt: this.now() } });
      return;
    }
    await this.conflict(link.id, 'EDITED_IN_GOOGLE', 'La hora de esta reserva se cambió en Google. No se aplica sola: elige cuál queda.', {
      googleStart: range?.start.toISOString() ?? null, googleEnd: range?.end.toISOString() ?? null,
    });
    await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { etag: e.etag ?? link.etag } });
    counts.conflicts++;
  }

  /** Evento ajeno: se guarda como ocupado (sin datos personales) y se revisa si choca con reservas. */
  private async pullExternal(conn: any, e: GoogleEvent, tz: string, counts: Record<string, number>) {
    const existing = await this.prisma.calendarEventLink.findFirst({ where: { connectionId: conn.id, externalEventId: e.id, origin: 'GOOGLE' } });
    if (e.status === 'cancelled') {
      if (existing) {
        await this.prisma.calendarEventLink.delete({ where: { id: existing.id } });
        counts.removed++;
      }
      return;
    }
    const range = eventRange(e, tz, localToUtc);
    if (!range || range.end.getTime() < this.now().getTime() - PAST_WINDOW_MS) {
      if (existing) await this.prisma.calendarEventLink.delete({ where: { id: existing.id } });
      return;
    }
    const declined = (e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined');
    const busy = e.transparency !== 'transparent' && !declined && (!range.allDay || conn.allDayBlocks);
    const data = {
      startsAt: range.start, endsAt: range.end, allDay: range.allDay, busy, etag: e.etag ?? null,
      title: conn.importTitles && e.summary ? String(e.summary).slice(0, 80) : null, updatedAt: this.now(),
    };
    let linkId: string;
    if (existing) {
      if (existing.etag && existing.etag === e.etag) return; // sin cambios
      await this.prisma.calendarEventLink.update({ where: { id: existing.id }, data });
      linkId = existing.id;
      counts.updated++;
    } else {
      linkId = (await this.prisma.calendarEventLink.create({ data: { companyId: conn.companyId, connectionId: conn.id, origin: 'GOOGLE', externalEventId: e.id, ...data } })).id;
      counts.created++;
    }
    // ¿Choca con una reserva ya confirmada en un espacio que este calendario bloquea?
    const clash = busy ? await this.overlappingBookings(conn, range.start, range.end) : [];
    const prev = existing ? parseJson<Record<string, any>>(existing.conflictJson, {}) : {};
    if (clash.length && prev.dismissedEtag !== e.etag) {
      await this.conflict(linkId, 'OVERLAPS_BOOKING', `Un evento de Google se cruza con ${clash.length === 1 ? 'una reserva' : `${clash.length} reservas`} de BackOffice.`, { appointmentIds: clash.map((a: any) => a.id), codes: clash.map((a: any) => bookingCode(a.id)) });
      counts.conflicts++;
    } else if (!clash.length && existing?.status === 'CONFLICT') {
      await this.prisma.calendarEventLink.update({ where: { id: linkId }, data: { status: 'ACTIVE', conflictJson: null } });
    }
  }

  private blockedResources(conn: any, company: any): string[] {
    const chosen = parseJson<string[]>(conn.blockResourceIdsJson, []);
    if (chosen.length) return chosen;
    return this.bookings.configOf(company).cfg.resources.filter((r) => r.active).map((r) => r.id);
  }

  private async overlappingBookings(conn: any, start: Date, end: Date) {
    const company = await this.prisma.company.findUnique({ where: { id: conn.companyId } });
    const resources = this.blockedResources(conn, company);
    if (!resources.length) return [];
    const appts = await this.prisma.appointment.findMany({
      where: { companyId: conn.companyId, resourceId: { in: resources }, status: { in: ACTIVE }, startsAt: { lt: end } },
      select: { id: true, startsAt: true, endsAt: true, durationMin: true },
    });
    return appts.filter((a: any) => new Date(a.endsAt ?? new Date(new Date(a.startsAt).getTime() + a.durationMin * 60000)).getTime() > start.getTime());
  }

  /** Reintentos vencidos y reservas futuras que aún no están en Google. */
  private async pushPending(conn: any): Promise<number> {
    let n = 0;
    const due = await this.prisma.calendarEventLink.findMany({
      where: { connectionId: conn.id, origin: 'BACKOFFICE', pendingOp: { not: null }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: this.now() } }] },
      take: 50,
    });
    for (const l of due) if (l.attempts < MAX_PUSH_ATTEMPTS && l.appointmentId && (await this.pushAppointment(l.appointmentId)) === 'SYNCED') n++;
    const upcoming = await this.prisma.appointment.findMany({
      where: { companyId: conn.companyId, resourceId: { not: null }, startsAt: { gte: new Date(this.now().getTime() - PAST_WINDOW_MS) } },
      select: { id: true }, take: 500,
    });
    const linked = new Set((await this.prisma.calendarEventLink.findMany({ where: { connectionId: conn.id, origin: 'BACKOFFICE' }, select: { appointmentId: true } })).map((l: any) => l.appointmentId));
    for (const a of upcoming) if (!linked.has(a.id) && (await this.pushAppointment(a.id)) === 'SYNCED') n++;
    return n;
  }

  /* ── Notificaciones push ── */

  /** Crea o renueva el canal de notificaciones (antes de que venza). */
  async ensureWatch(companyId: string) {
    const conn = await this.connectionOf(companyId);
    if (!conn || conn.status !== 'CONNECTED' || !conn.calendarId || conn.direction === 'PUSH') return { watching: false, reason: 'no aplica' };
    if (conn.channelId && conn.channelExpiresAt && new Date(conn.channelExpiresAt).getTime() - this.now().getTime() > RENEW_BEFORE_MS) return { watching: true, renewed: false };
    const address = await this.notifyAddress();
    if (!address) return { watching: false, reason: 'sin URL pública https: se sincroniza cada 15 minutos' };
    const token = await this.accessToken(conn);
    const channelId = randomBytes(16).toString('hex');
    const channelToken = randomBytes(24).toString('hex');
    const r = await watchEvents(token, conn.calendarId, { id: channelId, address, token: channelToken, ttlSeconds: CHANNEL_TTL_S }, this.fetchImpl);
    const old = conn.channelId && conn.channelResourceId ? { id: conn.channelId, resourceId: conn.channelResourceId } : null;
    await this.update(conn.id, {
      channelId, channelResourceId: r.resourceId, channelTokenHash: hash(channelToken),
      channelExpiresAt: r.expiration ?? new Date(this.now().getTime() + CHANNEL_TTL_S * 1000),
    });
    // El canal viejo se detiene DESPUÉS de tener el nuevo (no se pierden avisos en el cambio)
    if (old) await stopChannel(token, old.id, old.resourceId, this.fetchImpl).catch(() => undefined);
    return { watching: true, renewed: !!old };
  }

  private async stopWatch(conn: any) {
    if (!conn.channelId || !conn.channelResourceId) return;
    try {
      await stopChannel(await this.accessToken(conn), conn.channelId, conn.channelResourceId, this.fetchImpl);
    } catch {
      /* si falla, el canal vence solo */
    }
    await this.update(conn.id, { channelId: null, channelResourceId: null, channelTokenHash: null, channelExpiresAt: null });
  }

  /** Aviso de Google: solo dice "algo cambió"; se valida el canal y se sincroniza. */
  async notification(headers: { channelId?: string; token?: string; state?: string; resourceId?: string }) {
    if (!headers.channelId) return { ok: false };
    const conn = await this.prisma.calendarConnection.findFirst({ where: { channelId: headers.channelId } });
    // Canal desconocido o token que no coincide: se ignora (no da pistas a quien lo envía)
    if (!conn || !conn.channelTokenHash || hash(String(headers.token ?? '')) !== conn.channelTokenHash) return { ok: false };
    if (headers.resourceId && conn.channelResourceId && headers.resourceId !== conn.channelResourceId) return { ok: false };
    if (headers.state === 'sync') return { ok: true }; // aviso inicial del canal
    this.syncNow(conn.companyId, 'PUSH').catch(() => undefined);
    return { ok: true };
  }

  /* ── Conflictos ── */

  async resolve(user: AuthUser, linkId: string, dto: { action?: string }, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const link = await this.prisma.calendarEventLink.findUnique({ where: { id: linkId } });
    if (!link || link.companyId !== id || link.status !== 'CONFLICT') throw new NotFoundException('Conflicto no encontrado');
    const c = parseJson<Record<string, any>>(link.conflictJson, {});
    const action = String(dto?.action ?? '');
    let result: any = null;
    if (c.kind === 'EDITED_IN_GOOGLE' && action === 'KEEP_BACKOFFICE') {
      await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { status: 'ACTIVE', conflictJson: null } });
      result = await this.pushAppointment(link.appointmentId!, { force: true });
    } else if (c.kind === 'EDITED_IN_GOOGLE' && action === 'APPLY_GOOGLE') {
      if (!c.googleStart) throw new BadRequestException('No hay una hora de Google para aplicar');
      // Mismo camino que el panel: valida disponibilidad y bloqueos, y avisa al cliente
      const r = await this.bookings.reschedule(id, link.appointmentId!, { start: new Date(c.googleStart), by: user.name, actor: 'STAFF', notify: true });
      if (!r.ok) throw new BadRequestException(`No se pudo aplicar la hora de Google: ${r.message}`);
      await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { status: 'ACTIVE', conflictJson: null } });
      result = await this.pushAppointment(link.appointmentId!, { force: true });
    } else if (c.kind === 'DELETED_IN_GOOGLE' && action === 'RECREATE') {
      await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { status: 'ACTIVE', conflictJson: null } });
      result = await this.pushAppointment(link.appointmentId!, { force: true });
    } else if ((c.kind === 'DELETED_IN_GOOGLE' || c.kind === 'EDITED_IN_GOOGLE') && action === 'CANCEL_BOOKING') {
      const r = await this.bookings.cancel(id, link.appointmentId!, { by: user.name, reason: 'Cancelada al resolver un conflicto con Google Calendar', actor: 'STAFF', notify: true });
      if (!r.ok) throw new BadRequestException(r.message);
      await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { status: 'ACTIVE', conflictJson: null, pushedHash: null } });
      result = await this.pushAppointment(link.appointmentId!, { force: true });
    } else if (c.kind === 'OVERLAPS_BOOKING' && action === 'DISMISS') {
      // Se acepta el cruce; si el evento vuelve a cambiar se revisa de nuevo
      await this.prisma.calendarEventLink.update({ where: { id: link.id }, data: { status: 'ACTIVE', conflictJson: JSON.stringify({ dismissedEtag: link.etag }) } });
    } else {
      throw new BadRequestException('Esa acción no aplica a este conflicto');
    }
    await this.audit.log({ actor: user, companyId: id, action: 'calendar.conflict', entity: 'CalendarEventLink', entityId: link.id, detail: `${c.kind} → ${action}` });
    return { ok: true, result, status: await this.view(id) };
  }

  /* ── Desconectar ── */

  async disconnect(user: AuthUser, dto: { deleteCreatedEvents?: boolean }, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const conn = await this.connectionOf(id);
    if (!conn) throw new NotFoundException('Google Calendar no está conectado');
    let deleted = 0;
    let token: string | null = null;
    try {
      token = await this.accessToken(conn);
    } catch {
      token = null; // revocado: igual se desconecta en BackOffice
    }
    if (token) {
      await this.stopWatch(conn);
      if (dto?.deleteCreatedEvents && conn.calendarId) {
        const mine = await this.prisma.calendarEventLink.findMany({ where: { connectionId: conn.id, origin: 'BACKOFFICE', status: { not: 'DELETED' } } });
        for (const l of mine) {
          try {
            await deleteEvent(token, conn.calendarId, l.externalEventId!, this.fetchImpl);
            deleted++;
          } catch {
            /* ya no estaba */
          }
        }
      }
      try {
        await revokeToken(conn.refreshTokenEnc ? decryptSecret(conn.refreshTokenEnc) : token, this.fetchImpl);
      } catch {
        /* si ya estaba revocado, nada que hacer */
      }
    }
    await this.prisma.calendarEventLink.deleteMany({ where: { connectionId: conn.id } });
    await this.prisma.calendarConnection.delete({ where: { id: conn.id } });
    await this.audit.log({ actor: user, companyId: id, action: 'calendar.disconnected', entity: 'CalendarConnection', entityId: conn.id, detail: `${conn.accountEmail ?? ''} · eventos de BackOffice borrados en Google: ${deleted}` });
    return { ok: true, deletedEvents: deleted };
  }

  async manualSync(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const r = await this.syncNow(id, 'MANUAL');
    await this.ensureWatch(id).catch(() => undefined);
    return { result: r, status: await this.view(id) };
  }

  /* ── Tareas programadas ── */

  /** Recuperación: las notificaciones no garantizan entregar todo. Reintentos y renovación de canales. */
  @Cron('*/15 * * * *')
  async recovery() {
    if (process.env.JEST_WORKER_ID || process.env.CALENDAR_CRON_DISABLED === '1' || this.busyCron) return;
    this.busyCron = true;
    try {
      const conns = await this.prisma.calendarConnection.findMany({ where: { status: { in: ['CONNECTED', 'ERROR'] } }, take: 200 });
      for (const c of conns) {
        if (c.nextRetryAt && new Date(c.nextRetryAt) > this.now()) continue;
        await this.syncNow(c.companyId, 'CRON').catch(() => undefined);
        await this.ensureWatch(c.companyId).catch((err) => this.logger.warn(`canal ${c.companyId}: ${err?.message}`));
      }
    } finally {
      this.busyCron = false;
    }
  }
}

@Products('AUTOMATION')
@Controller('calendar/google')
export class CalendarSyncController {
  constructor(private readonly s: CalendarSyncService) {}

  @Get() @Roles(...READ)
  status(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.status(u, c); }

  @Get('overlay') @Roles(...READ)
  overlay(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.calendarOverlay(u, q); }

  @Post('connect') @Roles(...WRITE)
  connect(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.start(u, c); }

  @Post('calendar') @Roles(...WRITE)
  select(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.selectCalendar(u, dto, c); }

  @Put('settings') @Roles(...WRITE)
  settings(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.saveSettings(u, dto, c); }

  @Post('sync') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } })
  sync(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.manualSync(u, c); }

  @Post('conflicts/:id/resolve') @Roles(...WRITE)
  resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.resolve(u, id, dto, c); }

  @Delete() @Roles(...WRITE)
  disconnect(@CurrentUser() u: AuthUser, @Query('deleteCreatedEvents') del?: string, @Query('companyId') c?: string) {
    return this.s.disconnect(u, { deleteCreatedEvents: del === '1' || del === 'true' }, c);
  }
}

@Controller('public/calendar/google')
export class CalendarPublicController {
  constructor(private readonly s: CalendarSyncService) {}

  @Public()
  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    res.redirect(await this.s.callback(code, state, error));
  }

  /** Google exige un 2xx rápido; la validación del canal ocurre adentro. */
  @Public()
  @Post('notify')
  @HttpCode(200)
  async notify(
    @Headers('x-goog-channel-id') channelId?: string,
    @Headers('x-goog-channel-token') token?: string,
    @Headers('x-goog-resource-state') state?: string,
    @Headers('x-goog-resource-id') resourceId?: string,
  ) {
    await this.s.notification({ channelId, token, state, resourceId });
    return { ok: true };
  }
}

@Module({
  imports: [AuditModule, BookingsModule],
  controllers: [CalendarSyncController, CalendarPublicController],
  providers: [CalendarSyncService],
  exports: [CalendarSyncService],
})
export class CalendarSyncModule {}
