import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { STAGE_LABELS, fmtDateTime, timeAgo } from '../../lib/format';
import type { Appointment, Contact, FollowUp } from '../../lib/types';
import {
  Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Select, Stat, Tabs, Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

export const APPOINTMENT_STATUS_LABELS: Record<string, string> = {
  SCHEDULED: 'Programada',
  CONFIRMED: 'Confirmada',
  COMPLETED: 'Completada',
  CANCELLED: 'Cancelada',
  NO_SHOW: 'No asistió',
};

function dayLabel(dateIso: string): string {
  const date = new Date(dateIso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'long', day: '2-digit', month: 'short',
  }).format(date);
}

const fmtTime = (d: string) =>
  new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' }).format(new Date(d));

function toLocalInputValue(offsetHours = 24): string {
  const d = new Date(Date.now() + offsetHours * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* Modal reutilizable para crear cita (también se usa desde la bandeja) */
export function AppointmentModal({
  open,
  onClose,
  contacts,
  presetContactId,
}: {
  open: boolean;
  onClose: () => void;
  contacts: Contact[];
  presetContactId?: string;
}) {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    contactId: '', title: '', startsAt: toLocalInputValue(), durationMin: '30',
    location: '', notes: '',
  });
  const contactId = form.contactId || presetContactId || '';

  const create = useMutation({
    mutationFn: () =>
      api.post('/appointments', {
        contactId,
        title: form.title,
        startsAt: new Date(form.startsAt).toISOString(),
        durationMin: Number(form.durationMin),
        location: form.location || undefined,
        notes: form.notes || undefined,
        ...(companyId ? { companyId } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      toast.success('Cita agendada');
      setForm({ contactId: '', title: '', startsAt: toLocalInputValue(), durationMin: '30', location: '', notes: '' });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <Modal open={open} onClose={onClose} kicker="Agenda" title="Nueva cita">
      <div className="space-y-4">
        <Field label="Contacto" required>
          <Select value={contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
            <option value="">Elegir contacto…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {STAGE_LABELS[c.stage]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Motivo" required>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Valoración inicial, visita al proyecto…" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Fecha y hora" required>
            <Input type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </Field>
          <Field label="Duración (min)">
            <Input type="number" min={5} step={5} value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })} />
          </Field>
        </div>
        <Field label="Lugar">
          <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Sede norte, videollamada…" />
        </Field>
        <Field label="Notas">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <Button
          className="w-full"
          disabled={!contactId || !form.title || !form.startsAt || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Agendando…' : 'Agendar cita'}
        </Button>
      </div>
    </Modal>
  );
}

/* Modal reutilizable para crear seguimiento */
export function FollowUpModal({
  open,
  onClose,
  contacts,
  presetContactId,
}: {
  open: boolean;
  onClose: () => void;
  contacts: Contact[];
  presetContactId?: string;
}) {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ contactId: '', note: '', dueAt: toLocalInputValue(24) });
  const contactId = form.contactId || presetContactId || '';

  const create = useMutation({
    mutationFn: () =>
      api.post('/followups', {
        contactId,
        note: form.note,
        dueAt: new Date(form.dueAt).toISOString(),
        ...(companyId ? { companyId } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followups'] });
      toast.success('Seguimiento creado');
      setForm({ contactId: '', note: '', dueAt: toLocalInputValue(24) });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <Modal open={open} onClose={onClose} kicker="Seguimientos" title="Nuevo seguimiento">
      <div className="space-y-4">
        <Field label="Contacto" required>
          <Select value={contactId} onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
            <option value="">Elegir contacto…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {STAGE_LABELS[c.stage]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Qué hay que hacer" required>
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Reintentar venta del pack, confirmar asistencia…" />
        </Field>
        <Field label="Cuándo" required>
          <Input type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
        </Field>
        <Button
          className="w-full"
          disabled={!contactId || !form.note || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creando…' : 'Crear seguimiento'}
        </Button>
      </div>
    </Modal>
  );
}

export default function Agenda() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('citas');
  const [creatingAppointment, setCreatingAppointment] = useState(false);
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);

  const { data: appointments, isLoading } = useQuery({
    queryKey: ['appointments', q],
    queryFn: () => api.get<Appointment[]>(withScope('/appointments', q)),
    enabled: ready,
  });
  const { data: followUps } = useQuery({
    queryKey: ['followups', q],
    queryFn: () => api.get<FollowUp[]>(withScope('/followups', q)),
    enabled: ready,
  });
  const { data: contacts } = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => api.get<Contact[]>(withScope('/contacts', q)),
    enabled: ready && (creatingAppointment || creatingFollowUp),
  });

  const updateAppointment = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/appointments/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['appointments'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const updateFollowUp = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/followups/${id}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['followups'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const grouped = useMemo(() => {
    const upcoming = (appointments ?? []).filter(
      (a) => new Date(a.startsAt) >= new Date(new Date().setHours(0, 0, 0, 0)),
    );
    const map = new Map<string, Appointment[]>();
    for (const appointment of upcoming) {
      const key = dayLabel(appointment.startsAt);
      map.set(key, [...(map.get(key) ?? []), appointment]);
    }
    return [...map.entries()];
  }, [appointments]);

  const past = useMemo(
    () =>
      (appointments ?? [])
        .filter((a) => new Date(a.startsAt) < new Date(new Date().setHours(0, 0, 0, 0)))
        .reverse(),
    [appointments],
  );

  if (!ready) return <PickCompany />;
  if (isLoading) return <Loading label="Cargando agenda…" />;

  const today = (appointments ?? []).filter(
    (a) => dayLabel(a.startsAt) === 'Hoy' && ['SCHEDULED', 'CONFIRMED'].includes(a.status),
  ).length;
  const week = (appointments ?? []).filter((a) => {
    const d = new Date(a.startsAt);
    const now = new Date();
    return d >= now && d <= new Date(now.getTime() + 7 * 86400000);
  }).length;
  const completed = (appointments ?? []).filter((a) => a.status === 'COMPLETED').length;
  const noShow = (appointments ?? []).filter((a) => a.status === 'NO_SHOW').length;
  const pendingFollowUps = (followUps ?? []).filter((f) => f.status === 'PENDING');
  const overdue = pendingFollowUps.filter((f) => new Date(f.dueAt) < new Date());

  return (
    <>
      <PageHeader
        kicker="Citas y seguimientos"
        title="Agenda"
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setCreatingFollowUp(true)}>+ Seguimiento</Button>
              <Button onClick={() => setCreatingAppointment(true)}>+ Nueva cita</Button>
            </>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Citas hoy" value={today} />
        <Stat label="Próximos 7 días" value={week} />
        <Stat
          label="Asistencia"
          value={completed + noShow > 0 ? `${Math.round((completed / (completed + noShow)) * 100)}%` : '—'}
          hint={`${completed} completadas · ${noShow} no asistieron`}
          tone={noShow > completed ? 'warn' : 'ok'}
        />
        <Stat
          label="Seguimientos"
          value={pendingFollowUps.length}
          hint={overdue.length ? `${overdue.length} vencido(s)` : 'Al día'}
          tone={overdue.length > 0 ? 'bad' : 'ok'}
        />
      </div>

      <div className="mt-6">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'citas', label: 'Próximas citas' },
            { id: 'pasadas', label: 'Historial' },
            { id: 'seguimientos', label: 'Seguimientos', badge: pendingFollowUps.length },
          ]}
        />
      </div>

      <div className="mt-6 space-y-6">
        {tab === 'citas' && (
          grouped.length === 0 ? (
            <EmptyState
              title="Sin citas próximas"
              hint="Agenda la primera — cuando el motor de IA esté conectado, tu asistente las creará solo."
              action={canWrite ? <Button onClick={() => setCreatingAppointment(true)}>Agendar cita</Button> : undefined}
            />
          ) : (
            grouped.map(([label, items]) => (
              <div key={label}>
                <p className="kicker mb-2">{label}</p>
                <div className="space-y-2">
                  {items.map((appointment) => (
                    <AppointmentRow
                      key={appointment.id}
                      appointment={appointment}
                      canWrite={canWrite}
                      onStatus={(status) => updateAppointment.mutate({ id: appointment.id, status })}
                    />
                  ))}
                </div>
              </div>
            ))
          )
        )}

        {tab === 'pasadas' && (
          past.length === 0 ? (
            <EmptyState title="Sin historial todavía" />
          ) : (
            <div className="space-y-2">
              {past.map((appointment) => (
                <AppointmentRow
                  key={appointment.id}
                  appointment={appointment}
                  canWrite={canWrite}
                  onStatus={(status) => updateAppointment.mutate({ id: appointment.id, status })}
                  showDate
                />
              ))}
            </div>
          )
        )}

        {tab === 'seguimientos' && (
          (followUps?.length ?? 0) === 0 ? (
            <EmptyState
              title="Sin seguimientos"
              hint="Crea recordatorios sobre tus contactos: reintentar una venta, confirmar una cita, volver a escribir."
              action={canWrite ? <Button onClick={() => setCreatingFollowUp(true)}>Crear seguimiento</Button> : undefined}
            />
          ) : (
            <div className="space-y-2">
              {followUps?.map((followUp) => {
                const isOverdue = followUp.status === 'PENDING' && new Date(followUp.dueAt) < new Date();
                return (
                  <div
                    key={followUp.id}
                    className={`flex flex-wrap items-center justify-between gap-3 border-2 bg-paper px-4 py-3 ${isOverdue ? 'border-bad' : 'border-ink'}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{followUp.note}</p>
                      <p className="text-xs text-ink-3">
                        {followUp.contact.name} · {isOverdue ? `vencido ${timeAgo(followUp.dueAt)}` : fmtDateTime(followUp.dueAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={followUp.status === 'DONE' ? 'ok' : isOverdue ? 'bad' : 'warn'}>
                        {followUp.status === 'DONE' ? 'Hecho' : isOverdue ? 'Vencido' : 'Pendiente'}
                      </Badge>
                      {canWrite && followUp.status === 'PENDING' && (
                        <Button size="sm" onClick={() => updateFollowUp.mutate({ id: followUp.id, status: 'DONE' })}>
                          Hecho ✓
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      <AppointmentModal
        open={creatingAppointment}
        onClose={() => setCreatingAppointment(false)}
        contacts={contacts ?? []}
      />
      <FollowUpModal
        open={creatingFollowUp}
        onClose={() => setCreatingFollowUp(false)}
        contacts={contacts ?? []}
      />
    </>
  );
}

function AppointmentRow({
  appointment,
  canWrite,
  onStatus,
  showDate,
}: {
  appointment: Appointment;
  canWrite: boolean;
  onStatus: (status: string) => void;
  showDate?: boolean;
}) {
  const isActive = ['SCHEDULED', 'CONFIRMED'].includes(appointment.status);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="border-2 border-ink bg-bone px-2 py-1 text-center">
          <p className="display text-lg leading-none">{fmtTime(appointment.startsAt)}</p>
          {showDate && (
            <p className="text-[10px] text-ink-3">
              {new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short' }).format(new Date(appointment.startsAt))}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{appointment.title}</p>
          <p className="truncate text-xs text-ink-3">
            {appointment.contact.name}
            {appointment.location ? ` · ${appointment.location}` : ''} · {appointment.durationMin} min
            {appointment.source === 'IA' ? ' · agendada por la IA' : ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={statusTone(appointment.status === 'SCHEDULED' ? 'PENDING' : appointment.status === 'CONFIRMED' ? 'OPEN' : appointment.status === 'NO_SHOW' ? 'ERROR' : appointment.status)}>
          {APPOINTMENT_STATUS_LABELS[appointment.status]}
        </Badge>
        {canWrite && isActive && (
          <>
            {appointment.status === 'SCHEDULED' && (
              <Button size="sm" variant="outline" onClick={() => onStatus('CONFIRMED')}>Confirmar</Button>
            )}
            <Button size="sm" onClick={() => onStatus('COMPLETED')}>Completada ✓</Button>
            <Button size="sm" variant="ghost" onClick={() => onStatus('NO_SHOW')}>No asistió</Button>
          </>
        )}
      </div>
    </div>
  );
}
