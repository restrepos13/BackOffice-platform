import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { timeAgo } from '../../../lib/format';
import { Badge, Button, Card, Field, Modal, Select, Switch } from '../../../components/ui';
import { useBookingConfig } from '../agenda/Bookings';
import { withScope } from '../shared';

/**
 * Google Calendar de la empresa (OAuth propio de cada negocio). Todo lo decide el
 * servidor: aquí no hay tokens, solo estado, ajustes y conflictos por resolver.
 */

export type GoogleSyncState = 'SYNCED' | 'PENDING' | 'CONFLICT' | 'ERROR';

export interface CalendarConflict {
  id: string;
  kind: 'EDITED_IN_GOOGLE' | 'DELETED_IN_GOOGLE' | 'OVERLAPS_BOOKING';
  detail?: string;
  at?: string;
  googleStart?: string;
  googleEnd?: string;
  codes?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  appointment: { id: string; code: string; title: string; startsAt: string; status: string } | null;
}

export interface CalendarStatus {
  configured: boolean;
  notifications: boolean;
  connection: null | {
    status: 'PENDING_SELECTION' | 'CONNECTED' | 'ERROR' | 'REVOKED';
    accountEmail: string | null;
    calendarId: string | null;
    calendarName: string | null;
    calendarTimeZone: string | null;
    calendars: Array<{ id: string; name: string; primary: boolean }>;
    direction: 'BOTH' | 'PUSH' | 'PULL';
    blockResourceIds: string[];
    allDayBlocks: boolean;
    importTitles: boolean;
    lastSyncAt: string | null;
    lastSyncStatus: string | null;
    lastError: string | null;
    nextRetryAt: string | null;
    channelActive: boolean;
  };
  conflicts: CalendarConflict[];
  errors: Array<{ id: string; appointment: { code: string; title: string } | null; pendingOp: string | null; attempts: number; lastError: string; nextRetryAt: string | null }>;
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  CONNECTED: { label: 'Conectado', tone: 'ok' },
  PENDING_SELECTION: { label: 'Falta elegir calendario', tone: 'warn' },
  ERROR: { label: 'Con errores', tone: 'bad' },
  REVOKED: { label: 'Hay que reconectar', tone: 'bad' },
};
const DIRECTIONS = [
  { value: 'BOTH', label: 'En ambos sentidos', hint: 'Las reservas van a Google y lo que esté ocupado en Google bloquea horarios.' },
  { value: 'PUSH', label: 'Solo de BackOffice a Google', hint: 'Las reservas aparecen en Google; Google no bloquea nada.' },
  { value: 'PULL', label: 'Solo de Google a BackOffice', hint: 'Lo ocupado en Google bloquea horarios; las reservas no se copian.' },
];
const RETURN_MESSAGES: Record<string, [string, 'success' | 'error' | 'info']> = {
  elegir: ['Cuenta de Google vinculada. Elige el calendario.', 'success'],
  error: ['No se pudo conectar con Google. Intenta de nuevo.', 'error'],
  cancelado: ['Cancelaste la conexión con Google.', 'info'],
  permisos: ['Faltaron permisos: al conectar marca las dos casillas de Google Calendar.', 'error'],
};
const fmt = (d?: string | null) =>
  d ? new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d)) : '—';

export function useGoogleCalendar(q: string, enabled = true) {
  return useQuery({
    queryKey: ['google-calendar', q],
    queryFn: () => api.get<CalendarStatus>(withScope('/calendar/google', q)),
    enabled,
  });
}

export default function GoogleCalendarCard({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data, isLoading } = useGoogleCalendar(q);
  const bookingConfig = useBookingConfig(q);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deleteEvents, setDeleteEvents] = useState(false);
  const [calendarId, setCalendarId] = useState('');

  // Vuelta desde Google (?google=elegir|error|cancelado|permisos)
  useEffect(() => {
    const r = params.get('google');
    if (!r) return;
    const [msg, kind] = RETURN_MESSAGES[r] ?? RETURN_MESSAGES.error;
    toast[kind](msg);
    params.delete('google');
    setParams(params, { replace: true });
    queryClient.invalidateQueries({ queryKey: ['google-calendar'] });
  }, [params, setParams, queryClient]);

  const refresh = (s?: CalendarStatus) => {
    if (s) queryClient.setQueryData(['google-calendar', q], s);
    queryClient.invalidateQueries({ queryKey: ['google-calendar'] });
    queryClient.invalidateQueries({ queryKey: ['google-overlay'] });
  };
  const onError = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');

  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>(withScope('/calendar/google/connect', q)),
    onSuccess: (r) => { window.location.href = r.url; },
    onError,
  });
  const select = useMutation({
    mutationFn: (id: string) => api.post<CalendarStatus & { sync?: { ok: boolean; reason?: string } }>(withScope('/calendar/google/calendar', q), { calendarId: id }),
    onSuccess: (r) => { refresh(r); toast.success('Calendario conectado'); },
    onError,
  });
  const settings = useMutation({
    mutationFn: (dto: Record<string, unknown>) => api.put<CalendarStatus>(withScope('/calendar/google/settings', q), dto),
    onSuccess: (r) => { refresh(r); toast.success('Guardado'); },
    onError,
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; reason?: string; created?: number; updated?: number; removed?: number; conflicts?: number; pushed?: number }>(withScope('/calendar/google/sync', q)),
    onSuccess: (r) => {
      refresh();
      if (r.ok) toast.success(`Sincronizado: ${r.created ?? 0} nuevos, ${r.updated ?? 0} cambiados, ${r.removed ?? 0} quitados, ${r.pushed ?? 0} enviados`);
      else toast.error(r.reason ?? 'No se pudo sincronizar');
    },
    onError,
  });
  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) => api.post<{ status: CalendarStatus }>(withScope(`/calendar/google/conflicts/${id}/resolve`, q), { action }),
    onSuccess: (r) => { refresh(r.status); queryClient.invalidateQueries({ queryKey: ['appointments'] }); toast.success('Conflicto resuelto'); },
    onError,
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete<{ deletedEvents: number }>(withScope(`/calendar/google?deleteCreatedEvents=${deleteEvents ? '1' : '0'}`, q)),
    onSuccess: (r) => {
      setDisconnecting(false);
      refresh();
      toast.success(r.deletedEvents ? `Desconectado. Se quitaron ${r.deletedEvents} eventos de Google.` : 'Google Calendar desconectado');
    },
    onError,
  });

  if (isLoading || !data) return null;
  const conn = data.connection;
  const resources = (bookingConfig.data?.config.resources ?? []).filter((r) => r.id && r.active);
  const busy = connect.isPending || select.isPending || settings.isPending || sync.isPending || resolve.isPending || disconnect.isPending;
  const st = conn ? STATUS[conn.status] : null;

  return (
    <Card className="mb-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className={`flex h-11 w-11 items-center justify-center border-2 border-ink ${conn?.status === 'CONNECTED' ? 'bg-ink text-bone' : 'bg-paper'}`}>
            <CalendarDays size={20} />
          </div>
          <div>
            <h3 className="display text-lg">Google Calendar</h3>
            <p className="max-w-xl text-xs text-ink-2">
              Las reservas de BackOffice aparecen en tu calendario y lo que tengas ocupado allá bloquea esos horarios aquí.
              BackOffice siempre revalida antes de confirmar: si Google falla, reservar sigue funcionando.
            </p>
          </div>
        </div>
        {st ? <Badge tone={st.tone}>{st.label}</Badge> : <Badge tone={data.configured ? 'neutral' : 'warn'}>{data.configured ? 'Sin conectar' : 'Pendiente de configurar'}</Badge>}
      </div>

      {/* Sin cliente OAuth en la plataforma: no se simula nada */}
      {!data.configured && !conn && (
        <p className="mt-4 border-2 border-warn bg-warn-soft p-3 text-sm">
          La conexión con Google todavía no está habilitada en BackOffice (falta el cliente OAuth de la plataforma).
          Cuando el equipo la active podrás conectar tu calendario desde aquí.
        </p>
      )}

      {data.configured && !conn && canWrite && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => connect.mutate()} disabled={busy}>{connect.isPending ? 'Abriendo Google…' : 'Conectar Google Calendar'}</Button>
          <p className="text-xs text-ink-3">Solo pedimos ver tu lista de calendarios y manejar eventos. No leemos tu correo ni tus contactos.</p>
        </div>
      )}

      {conn && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <p><span className="text-ink-3">Cuenta:</span> {conn.accountEmail ?? '—'}</p>
            <p><span className="text-ink-3">Calendario:</span> {conn.calendarName ?? 'Sin elegir'}</p>
            <p>
              <span className="text-ink-3">Última sincronización:</span>{' '}
              {conn.lastSyncAt ? timeAgo(conn.lastSyncAt) : 'Nunca'}
              {conn.lastSyncStatus === 'ERROR' && conn.nextRetryAt ? ` · reintenta ${fmt(conn.nextRetryAt)}` : ''}
            </p>
            <p>
              <span className="text-ink-3">Cambios desde Google:</span>{' '}
              {conn.channelActive ? 'al instante (notificaciones activas)' : data.notifications ? 'cada 15 minutos (activando avisos)' : 'cada 15 minutos'}
            </p>
          </div>

          {conn.lastError && (
            <p className="border-2 border-bad bg-bad-soft p-3 text-sm">{conn.lastError}</p>
          )}

          {canWrite && conn.status === 'REVOKED' && (
            <Button onClick={() => connect.mutate()} disabled={busy}>Reconectar Google Calendar</Button>
          )}

          {canWrite && (conn.status === 'PENDING_SELECTION' || conn.status === 'CONNECTED') && conn.calendars.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label={conn.status === 'PENDING_SELECTION' ? 'Elige el calendario de las reservas' : 'Calendario'}>
                <Select value={calendarId || conn.calendarId || ''} onChange={(e) => setCalendarId(e.target.value)}>
                  <option value="" disabled>Elige…</option>
                  {conn.calendars.map((c) => <option key={c.id} value={c.id}>{c.name}{c.primary ? ' (principal)' : ''}</option>)}
                </Select>
              </Field>
              {(calendarId && calendarId !== conn.calendarId) || conn.status === 'PENDING_SELECTION' ? (
                <Button disabled={busy || !(calendarId || conn.calendarId)} onClick={() => select.mutate(calendarId || conn.calendarId!)}>
                  {select.isPending ? 'Conectando…' : 'Usar este calendario'}
                </Button>
              ) : null}
            </div>
          )}

          {conn.status === 'CONNECTED' && (
            <div className="space-y-3 border-t-2 border-line pt-3">
              <Field label="Qué se sincroniza" hint={DIRECTIONS.find((d) => d.value === conn.direction)?.hint}>
                <Select value={conn.direction} disabled={!canWrite || busy} onChange={(e) => settings.mutate({ direction: e.target.value })}>
                  {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </Select>
              </Field>
              {conn.direction !== 'PUSH' && (
                <>
                  {resources.length > 1 && (
                    <div>
                      <p className="text-xs font-semibold">Espacios que bloquea lo ocupado en Google</p>
                      <p className="mb-1 text-xs text-ink-3">Si no marcas ninguno, se bloquean todos.</p>
                      <div className="flex flex-wrap gap-3">
                        {resources.map((r) => {
                          const on = conn.blockResourceIds.includes(r.id!);
                          return (
                            <Switch
                              key={r.id}
                              showLabel
                              label={r.name}
                              checked={on}
                              disabled={!canWrite || busy}
                              onChange={(v) => settings.mutate({ blockResourceIds: v ? [...conn.blockResourceIds, r.id] : conn.blockResourceIds.filter((x) => x !== r.id) })}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <Switch showLabel label="Los eventos de todo el día bloquean el día completo" checked={conn.allDayBlocks} disabled={!canWrite || busy} onChange={(v) => settings.mutate({ allDayBlocks: v })} />
                  <Switch showLabel label="Mostrar el título de los eventos de Google en la agenda (si no, solo dice «Ocupado»)" checked={conn.importTitles} disabled={!canWrite || busy} onChange={(v) => settings.mutate({ importTitles: v })} />
                  <p className="text-xs text-ink-3">
                    Los eventos marcados como «Disponible» o que rechazaste no bloquean. BackOffice nunca cambia ni borra eventos que no creó.
                  </p>
                </>
              )}
            </div>
          )}

          {data.conflicts.length > 0 && (
            <div className="space-y-2 border-t-2 border-line pt-3">
              <p className="text-sm font-semibold">Conflictos por resolver ({data.conflicts.length})</p>
              {data.conflicts.map((c) => (
                <ConflictRow key={c.id} c={c} canWrite={canWrite} busy={busy} onResolve={(action) => resolve.mutate({ id: c.id, action })} />
              ))}
            </div>
          )}

          {data.errors.length > 0 && (
            <div className="space-y-1 border-t-2 border-line pt-3">
              <p className="text-sm font-semibold">Envíos pendientes a Google</p>
              {data.errors.map((e) => (
                <p key={e.id} className="text-xs">
                  {e.appointment ? `${e.appointment.title} (${e.appointment.code})` : 'Reserva borrada'}: {e.lastError}
                  {e.nextRetryAt ? ` · reintento ${fmt(e.nextRetryAt)}` : ' · sin más reintentos automáticos; usa «Sincronizar ahora»'}
                </p>
              ))}
            </div>
          )}

          {canWrite && (
            <div className="flex flex-wrap gap-2 border-t-2 border-line pt-3">
              {conn.status === 'CONNECTED' && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => sync.mutate()}>
                  <RefreshCw size={12} /> {sync.isPending ? 'Sincronizando…' : 'Sincronizar ahora'}
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDisconnecting(true)}>Desconectar</Button>
            </div>
          )}
        </div>
      )}

      <Modal open={disconnecting} onClose={() => setDisconnecting(false)} kicker="Google Calendar" title="Desconectar">
        <div className="space-y-3 text-sm">
          <p>Al desconectar:</p>
          <ul className="list-disc space-y-1 pl-5 text-ink-2">
            <li>Tus reservas en BackOffice no cambian.</li>
            <li>Lo ocupado en Google deja de bloquear horarios aquí.</li>
            <li>BackOffice pierde el acceso a tu cuenta de Google y deja de recibir avisos.</li>
          </ul>
          <Switch showLabel label="Quitar también de Google los eventos que creó BackOffice" checked={deleteEvents} onChange={setDeleteEvents} />
          <p className="text-xs text-ink-3">{deleteEvents ? 'Se borran solo los eventos de reservas; los tuyos no se tocan.' : 'Los eventos de reservas quedan en tu calendario como copia.'}</p>
          <div className="flex gap-2">
            <Button variant="danger" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>{disconnect.isPending ? 'Desconectando…' : 'Desconectar'}</Button>
            <Button variant="ghost" onClick={() => setDisconnecting(false)}>Cancelar</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

function ConflictRow({ c, canWrite, busy, onResolve }: { c: CalendarConflict; canWrite: boolean; busy: boolean; onResolve: (action: string) => void }) {
  const a = c.appointment;
  const name = a ? `${a.title} (${a.code})` : 'Reserva';
  const text =
    c.kind === 'EDITED_IN_GOOGLE'
      ? c.googleStart
        ? `${name}: en Google la movieron a ${fmt(c.googleStart)}; en BackOffice sigue el ${fmt(a?.startsAt)}.`
        : `${name}: ${c.detail ?? 'el evento cambió en Google al mismo tiempo que en BackOffice.'}`
      : c.kind === 'DELETED_IN_GOOGLE'
        ? `${name}: el evento se borró en Google; la reserva sigue activa en BackOffice.`
        : `Un evento de Google (${fmt(c.startsAt)}) se cruza con la reserva ${c.codes?.join(', ') ?? ''}. La reserva no se canceló.`;
  return (
    <div className="border-2 border-warn bg-warn-soft p-3">
      <p className="text-sm">{text}</p>
      {canWrite && (
        <div className="mt-2 flex flex-wrap gap-2">
          {c.kind === 'EDITED_IN_GOOGLE' && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onResolve('KEEP_BACKOFFICE')}>Mantener BackOffice</Button>
              {c.googleStart && <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve('APPLY_GOOGLE')}>Usar la hora de Google</Button>}
            </>
          )}
          {c.kind === 'DELETED_IN_GOOGLE' && (
            <>
              <Button size="sm" disabled={busy} onClick={() => onResolve('RECREATE')}>Volver a ponerla en Google</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => onResolve('CANCEL_BOOKING')}>Cancelar la reserva</Button>
            </>
          )}
          {c.kind === 'OVERLAPS_BOOKING' && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve('DISMISS')}>Entendido, mantener ambos</Button>
          )}
        </div>
      )}
    </div>
  );
}
