import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, api } from '../../../lib/api';
import type { Contact } from '../../../lib/types';
import { Badge, Button, Card, Field, Input, Loading, Modal, Select, Switch } from '../../../components/ui';
import { withScope } from '../shared';

/**
 * Reservas en línea en la agenda del panel. Todo lo valida el servidor
 * (disponibilidad, bloqueos, horario); aquí solo se configura y se elige.
 */

export interface BookingConfig {
  enabled: boolean;
  slotMinutes: number;
  resources: Array<{ id?: string; name: string; active: boolean }>;
  services: Array<{ key?: string; name: string; durationMin: number; price: number | null; resourceIds: string[] }>;
  hours: Array<{ day: number; open: string; close: string }>;
  leadMinutes: number;
  maxDaysAhead: number;
  cancelUntilHours: number;
  maxActivePerContact: number;
  requireName: boolean;
  reminders: { enabled: boolean; hoursBefore: number };
  notifyOnStaffChanges: boolean;
}

const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const NOTICE_LABEL: Record<string, string> = { REMINDER: 'Recordatorio', CONFIRMATION: 'Confirmación', RESCHEDULE: 'Cambio', CANCELLATION: 'Cancelación' };
const NOTICE_STATUS: Record<string, string> = { PENDING: 'Programado', SENDING: 'Enviando', SENT: 'Enviado', SKIPPED: 'No enviado', FAILED: 'Falló', CANCELLED: 'Anulado' };
const ACTION_LABEL: Record<string, string> = { CREATED: 'Creada', RESCHEDULED: 'Reprogramada', CANCELLED: 'Cancelada', NOTICE_FAILED: 'Aviso fallido' };

export function useBookingConfig(q: string, enabled = true) {
  return useQuery({
    queryKey: ['booking-config', q],
    queryFn: () => api.get<{ config: BookingConfig; timezone: string; templateReady: boolean }>(withScope('/bookings/config', q)),
    enabled,
  });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Error');

/** Configuración: espacios, servicios, horario y reglas. */
export function BookingSettings({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useBookingConfig(q);
  const [cfg, setCfg] = useState<BookingConfig | null>(null);
  useEffect(() => { if (data) setCfg(data.config); }, [data]);
  const save = useMutation({
    mutationFn: () => api.put<{ config: BookingConfig }>(withScope('/bookings/config', q), { config: cfg }),
    onSuccess: (r) => { setCfg(r.config); queryClient.invalidateQueries({ queryKey: ['booking-config'] }); toast.success('Reservas guardadas'); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (isLoading || !cfg || !data) return <Loading />;
  const set = (p: Partial<BookingConfig>) => setCfg({ ...cfg, ...p });
  const dayHours = (d: number) => cfg.hours.find((h) => h.day === d);

  return (
    <div className="space-y-5">
      <Card kicker="Reservas en línea" title="Que tu asistente reserve por el chat">
        <p className="text-sm text-ink-2">
          Con esto activo, el asistente consulta los turnos libres, reserva cuando el cliente confirma, y cancela o reprograma sus reservas. Nunca reserva dos veces el mismo espacio a la misma hora, ni aunque dos clientes pidan al tiempo.
        </p>
        <div className="mt-3">
          <Switch checked={cfg.enabled} disabled={!canWrite} onChange={(enabled) => set({ enabled })} showLabel label="Recibir reservas por el chat" />
        </div>
      </Card>

      <Card kicker="Lo que se reserva" title="Espacios o recursos">
        <div className="space-y-2">
          {cfg.resources.map((r, i) => (
            <div key={r.id ?? i} className="flex flex-wrap items-center gap-2">
              <Input aria-label="Nombre del espacio" className="max-w-xs" value={r.name} disabled={!canWrite} onChange={(e) => set({ resources: cfg.resources.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <Switch checked={r.active} disabled={!canWrite} onChange={(active) => set({ resources: cfg.resources.map((x, j) => (j === i ? { ...x, active } : x)) })} showLabel label="Activo" />
              {canWrite && <Button size="sm" variant="ghost" aria-label={`Quitar ${r.name}`} onClick={() => set({ resources: cfg.resources.filter((_, j) => j !== i) })}><Trash2 size={14} /></Button>}
            </div>
          ))}
          {canWrite && <Button size="sm" variant="outline" onClick={() => set({ resources: [...cfg.resources, { name: `Espacio ${cfg.resources.length + 1}`, active: true }] })}><Plus size={14} /> Agregar espacio</Button>}
          <p className="text-xs text-ink-3">Ejemplos: «Cancha 1», «Sala de ensayo», «Consultorio 2». Un espacio con reservas futuras no se puede quitar: desactívalo.</p>
        </div>
      </Card>

      <Card kicker="Lo que se ofrece" title="Servicios reservables">
        <div className="space-y-3">
          {cfg.services.map((sv, i) => (
            <div key={sv.key ?? i} className="grid gap-2 border-2 border-line p-3 sm:grid-cols-[1fr_120px_140px_auto]">
              <Field label="Nombre"><Input value={sv.name} disabled={!canWrite} onChange={(e) => set({ services: cfg.services.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /></Field>
              <Field label="Duración (min)"><Input type="number" min={cfg.slotMinutes} step={cfg.slotMinutes} value={sv.durationMin} disabled={!canWrite} onChange={(e) => set({ services: cfg.services.map((x, j) => (j === i ? { ...x, durationMin: Number(e.target.value) } : x)) })} /></Field>
              <Field label="Precio (opcional)"><Input type="number" min={0} value={sv.price ?? ''} disabled={!canWrite} onChange={(e) => set({ services: cfg.services.map((x, j) => (j === i ? { ...x, price: e.target.value === '' ? null : Number(e.target.value) } : x)) })} /></Field>
              <div className="flex items-end">{canWrite && <Button size="sm" variant="ghost" aria-label={`Quitar ${sv.name}`} onClick={() => set({ services: cfg.services.filter((_, j) => j !== i) })}><Trash2 size={14} /></Button>}</div>
              {cfg.resources.some((r) => r.id) && (
                <div className="sm:col-span-4">
                  <p className="text-xs text-ink-3">Dónde se presta (ninguno marcado = en todos):</p>
                  <div className="mt-1 flex flex-wrap gap-3">
                    {cfg.resources.filter((r) => r.id).map((r) => (
                      <label key={r.id} className="inline-flex items-center gap-1.5 text-sm">
                        <input type="checkbox" disabled={!canWrite} checked={sv.resourceIds.includes(r.id!)} onChange={(e) => set({ services: cfg.services.map((x, j) => (j === i ? { ...x, resourceIds: e.target.checked ? [...x.resourceIds, r.id!] : x.resourceIds.filter((id) => id !== r.id) } : x)) })} />
                        {r.name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
          {canWrite && <Button size="sm" variant="outline" onClick={() => set({ services: [...cfg.services, { name: 'Reserva 1 hora', durationMin: 60, price: null, resourceIds: [] }] })}><Plus size={14} /> Agregar servicio</Button>}
        </div>
      </Card>

      <Card kicker="Cuándo" title="Horario de reservas">
        <div className="grid gap-2 sm:grid-cols-2">
          {DAYS.map((name, d) => {
            const h = dayHours(d);
            return (
              <div key={d} className="flex items-center gap-2">
                <label className="inline-flex w-28 items-center gap-1.5 text-sm">
                  <input type="checkbox" disabled={!canWrite} checked={!!h} onChange={(e) => set({ hours: e.target.checked ? [...cfg.hours, { day: d, open: '08:00', close: '20:00' }] : cfg.hours.filter((x) => x.day !== d) })} />
                  {name}
                </label>
                {h && (
                  <>
                    <Input type="time" aria-label={`Abre ${name}`} className="max-w-[120px]" value={h.open} disabled={!canWrite} onChange={(e) => set({ hours: cfg.hours.map((x) => (x.day === d ? { ...x, open: e.target.value } : x)) })} />
                    <Input type="time" aria-label={`Cierra ${name}`} className="max-w-[120px]" value={h.close} disabled={!canWrite} onChange={(e) => set({ hours: cfg.hours.map((x) => (x.day === d ? { ...x, close: e.target.value } : x)) })} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-ink-3">Sin días marcados se usa el horario general del negocio. Los festivos y días no laborales configurados no se ofrecen. Zona horaria: {data.timezone}.</p>
      </Card>

      <Card kicker="Reglas" title="Cómo se reserva">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Las reservas empiezan cada">
            <Select value={cfg.slotMinutes} disabled={!canWrite} onChange={(e) => set({ slotMinutes: Number(e.target.value) })}>
              {[15, 20, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutos</option>)}
            </Select>
          </Field>
          <Field label="Anticipación mínima (min)"><Input type="number" min={0} value={cfg.leadMinutes} disabled={!canWrite} onChange={(e) => set({ leadMinutes: Number(e.target.value) })} /></Field>
          <Field label="Reservar hasta (días)"><Input type="number" min={1} value={cfg.maxDaysAhead} disabled={!canWrite} onChange={(e) => set({ maxDaysAhead: Number(e.target.value) })} /></Field>
          <Field label="El asistente cancela hasta (h antes)"><Input type="number" min={0} value={cfg.cancelUntilHours} disabled={!canWrite} onChange={(e) => set({ cancelUntilHours: Number(e.target.value) })} /></Field>
          <Field label="Reservas activas por cliente"><Input type="number" min={1} value={cfg.maxActivePerContact} disabled={!canWrite} onChange={(e) => set({ maxActivePerContact: Number(e.target.value) })} /></Field>
          <div className="flex items-end"><Switch checked={cfg.requireName} disabled={!canWrite} onChange={(requireName) => set({ requireName })} showLabel label="Pedir el nombre" /></div>
        </div>
        <p className="mt-2 text-xs text-ink-3">Más reservas que el tope, o cancelar sobre la hora, lo pasa el asistente a una persona del equipo.</p>
      </Card>

      <Card kicker="Avisos" title="Recordatorios y confirmaciones">
        <div className="flex flex-wrap items-center gap-4">
          <Switch checked={cfg.reminders.enabled} disabled={!canWrite} onChange={(enabled) => set({ reminders: { ...cfg.reminders, enabled } })} showLabel label="Recordar cada reserva" />
          <Field label="Horas antes"><Input type="number" min={1} className="max-w-[100px]" value={cfg.reminders.hoursBefore} disabled={!canWrite} onChange={(e) => set({ reminders: { ...cfg.reminders, hoursBefore: Number(e.target.value) } })} /></Field>
          <Switch checked={cfg.notifyOnStaffChanges} disabled={!canWrite} onChange={(notifyOnStaffChanges) => set({ notifyOnStaffChanges })} showLabel label="Avisar al cliente lo que el equipo cambie" />
        </div>
        <p className="mt-2 text-xs text-ink-3">
          Se envían por el mismo chat de WhatsApp. Si el cliente escribió en las últimas 24 h, salen solos; si no, Meta exige una plantilla aprobada llamada «recordatorio_reserva».{' '}
          {data.templateReady ? <b>Tu plantilla está configurada.</b> : <b>Aún no tienes esa plantilla: fuera de las 24 h el aviso queda registrado como no enviado.</b>}{' '}
          Quien pidió no recibir mensajes no los recibe.
        </p>
      </Card>

      {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar reservas'}</Button>}
    </div>
  );
}

type Slot = { start: string; local: string; resources: Array<{ id: string; name: string }> };

/** Selector de turno: fecha → turnos libres reales → espacio. */
function SlotPicker({ q, serviceKey, onPick, picked }: { q: string; serviceKey: string; onPick: (s: { start: string; resourceId: string; label: string }) => void; picked: string | null }) {
  const [date, setDate] = useState(() => new Date(Date.now() + 86400e3).toISOString().slice(0, 10));
  const { data, isFetching } = useQuery({
    queryKey: ['booking-availability', q, serviceKey, date],
    queryFn: () => api.get<{ ok: boolean; slots?: Slot[]; message?: string; note?: string }>(withScope(`/bookings/availability?date=${date}&service=${encodeURIComponent(serviceKey)}`, q)),
    enabled: !!serviceKey,
  });
  return (
    <div className="space-y-2">
      <Field label="Fecha"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      {isFetching ? <p className="text-sm text-ink-3">Buscando turnos…</p> : data && !data.ok ? <p className="text-sm text-bad">{data.message}</p> : !data?.slots?.length ? (
        <p className="text-sm text-ink-3">{data?.note ?? 'No hay turnos libres ese día.'}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {data.slots.flatMap((s) => s.resources.map((r) => {
            const key = `${s.start}|${r.id}`;
            return (
              <button key={key} type="button" onClick={() => onPick({ start: s.start, resourceId: r.id, label: `${s.local} · ${r.name}` })}
                className={`cursor-pointer border-2 px-2 py-1 text-xs font-semibold ${picked === key ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink'}`}>
                {s.local} · {r.name}
              </button>
            );
          }))}
        </div>
      )}
    </div>
  );
}

/** El equipo reserva (cliente por teléfono o en persona). */
export function NewBookingModal({ open, onClose, q, contacts }: { open: boolean; onClose: () => void; q: string; contacts: Contact[] }) {
  const queryClient = useQueryClient();
  const { data } = useBookingConfig(q, open);
  const [contactId, setContactId] = useState('');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [serviceKey, setServiceKey] = useState('');
  const [slot, setSlot] = useState<{ start: string; resourceId: string; label: string } | null>(null);
  useEffect(() => { if (data?.config.services[0]?.key && !serviceKey) setServiceKey(data.config.services[0].key); }, [data, serviceKey]);
  const create = useMutation({
    mutationFn: () => api.post(withScope('/bookings', q), { contactId: contactId || undefined, phone: contactId ? undefined : phone, name, serviceKey, start: slot!.start, resourceId: slot!.resourceId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['appointments'] }); toast.success('Reserva creada'); onClose(); setSlot(null); },
    onError: (e) => { toast.error(errorText(e)); queryClient.invalidateQueries({ queryKey: ['booking-availability'] }); },
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Reservas en línea" title="Nueva reserva">
      {!data ? <Loading /> : !data.config.enabled ? (
        <p className="text-sm text-ink-2">Las reservas en línea están apagadas. Actívalas en la pestaña «Reservas en línea».</p>
      ) : (
        <div className="space-y-3">
          <Field label="Cliente">
            <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">Nuevo (por teléfono)</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          {!contactId && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Teléfono"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
              <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
            </div>
          )}
          <Field label="Servicio">
            <Select value={serviceKey} onChange={(e) => { setServiceKey(e.target.value); setSlot(null); }}>
              {data.config.services.map((s) => <option key={s.key} value={s.key}>{s.name} · {s.durationMin} min</option>)}
            </Select>
          </Field>
          {serviceKey && <SlotPicker q={q} serviceKey={serviceKey} picked={slot ? `${slot.start}|${slot.resourceId}` : null} onPick={setSlot} />}
          <Button className="w-full" disabled={!slot || (!contactId && phone.replace(/\D/g, '').length < 7) || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Reservando…' : slot ? `Reservar ${slot.label}` : 'Elige un turno'}
          </Button>
          <p className="text-xs text-ink-3">Si el aviso está activo, el cliente recibe la confirmación por su chat (si tiene uno con el negocio).</p>
        </div>
      )}
    </Modal>
  );
}

/** Reprogramar, cancelar e historial de una reserva en línea. */
export function BookingActionsModal({ open, onClose, q, appointment, canWrite }: {
  open: boolean; onClose: () => void; q: string; canWrite: boolean;
  appointment: { id: string; title: string; startsAt: string; serviceKey?: string | null; status: string };
}) {
  const queryClient = useQueryClient();
  const [slot, setSlot] = useState<{ start: string; resourceId: string; label: string } | null>(null);
  const { data } = useQuery({
    queryKey: ['booking-detail', appointment.id, q],
    queryFn: () => api.get<{ code: string; history: any[]; notices: any[] }>(withScope(`/bookings/${appointment.id}`, q)),
    enabled: open,
  });
  const done = (msg: string) => {
    queryClient.invalidateQueries({ queryKey: ['appointments'] });
    queryClient.invalidateQueries({ queryKey: ['booking-detail', appointment.id] });
    toast.success(msg);
  };
  const reschedule = useMutation({
    mutationFn: () => api.post(withScope(`/bookings/${appointment.id}/reschedule`, q), { start: slot!.start, resourceId: slot!.resourceId }),
    onSuccess: () => { done('Reserva reprogramada'); setSlot(null); onClose(); },
    onError: (e) => { toast.error(e instanceof ApiError ? e.message : errorText(e)); queryClient.invalidateQueries({ queryKey: ['booking-availability'] }); },
  });
  const cancel = useMutation({
    mutationFn: () => api.post(withScope(`/bookings/${appointment.id}/cancel`, q), { reason: 'Cancelada por el equipo' }),
    onSuccess: () => { done('Reserva cancelada'); onClose(); },
    onError: (e) => toast.error(errorText(e)),
  });
  const active = ['SCHEDULED', 'CONFIRMED'].includes(appointment.status);
  return (
    <Modal open={open} onClose={onClose} kicker={data ? `Reserva ${data.code}` : 'Reserva'} title={appointment.title} wide>
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-3">
          {canWrite && active && appointment.serviceKey ? (
            <>
              <p className="kicker">Reprogramar</p>
              <SlotPicker q={q} serviceKey={appointment.serviceKey} picked={slot ? `${slot.start}|${slot.resourceId}` : null} onPick={setSlot} />
              <Button disabled={!slot || reschedule.isPending} onClick={() => reschedule.mutate()}>{slot ? `Mover a ${slot.label}` : 'Elige el nuevo turno'}</Button>
              <div className="border-t-2 border-line pt-3">
                <Button variant="danger" disabled={cancel.isPending} onClick={() => { if (confirm('¿Cancelar esta reserva? Se libera el espacio.')) cancel.mutate(); }}>Cancelar reserva</Button>
              </div>
            </>
          ) : <p className="text-sm text-ink-3">Esta reserva ya no está activa.</p>}
        </div>
        <div className="space-y-3 text-sm">
          <p className="kicker">Historial</p>
          <ul className="space-y-1">
            {data?.history.map((h, i) => (
              <li key={i} className="border-l-2 border-ink pl-2">
                <b>{ACTION_LABEL[h.action] ?? h.action}</b> · {new Date(h.at).toLocaleString('es-CO')} · {h.by}{h.source === 'IA' ? ' (asistente)' : ''}
                {h.from ? <span className="block text-xs text-ink-3">De {h.from}</span> : null}
                {h.to ? <span className="block text-xs text-ink-3">{h.from ? 'A' : ''} {h.to}</span> : null}
                {h.note ? <span className="block text-xs text-ink-3">{h.note}</span> : null}
              </li>
            ))}
          </ul>
          <p className="kicker pt-2">Avisos al cliente</p>
          {!data?.notices.length ? <p className="text-xs text-ink-3">Sin avisos.</p> : (
            <ul className="space-y-1">
              {data.notices.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span>{NOTICE_LABEL[n.kind] ?? n.kind} · {new Date(n.scheduledAt).toLocaleString('es-CO')}</span>
                  <Badge tone={n.status === 'SENT' ? 'ok' : n.status === 'FAILED' ? 'bad' : n.status === 'SKIPPED' ? 'warn' : 'neutral'}>{NOTICE_STATUS[n.status] ?? n.status}</Badge>
                  {n.skipReason && <span className="w-full text-ink-3">{n.skipReason}</span>}
                  {n.status === 'FAILED' && n.lastError && <span className="w-full text-bad">{n.lastError}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
