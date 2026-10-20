import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CalendarCheck, Check, Headset, Phone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { Button, Field, Input, Modal, Textarea } from './ui';
import { withScope } from '../pages/company/shared';

/**
 * "Agéndame una cita con un agente de BackOffice": lo técnico lo hacemos
 * nosotros en una llamada. Día y hora en dos toques, sin formularios largos.
 */

export type CallTopic = 'SETUP' | 'AI' | 'WHATSAPP' | 'TEMPLATES' | 'PLAN' | 'TEAM' | 'OTHER';

export interface AgentCallView {
  id: string; topic: CallTopic; topicLabel: string; slotAt: string; when: string; phone: string;
  status: 'REQUESTED' | 'CONFIRMED' | 'DONE' | 'CANCELLED' | 'NO_SHOW'; statusLabel: string;
  agentName: string | null; meetUrl: string | null; doneNotes: string | null; notes: string | null;
}
interface Mine { next: AgentCallView | null; history: AgentCallView[]; topics: Record<CallTopic, string> }
interface Slots { days: Array<{ date: string; label: string; slots: Array<{ at: string; label: string }> }> }

export function useMyAgentCalls(q: string, enabled = true) {
  return useQuery({ queryKey: ['agent-calls', q], queryFn: () => api.get<Mine>(withScope('/agent-calls/mine', q)), enabled });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Botón + modal para agendar. Si ya hay una cita pendiente, la muestra en vez de pedir otra. */
export default function ScheduleCall({
  q,
  topic = 'SETUP',
  label = 'Agéndame una cita con un agente',
  defaultPhone = '',
  variant = 'solid',
  size,
  className,
}: {
  q: string;
  topic?: CallTopic;
  label?: string;
  defaultPhone?: string;
  variant?: 'solid' | 'outline';
  size?: 'sm';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data: mine } = useMyAgentCalls(q);
  const next = mine?.next;
  return (
    <>
      {next ? (
        <button type="button" onClick={() => setOpen(true)} className={clsx('inline-flex cursor-pointer items-center gap-2 border-2 border-ok bg-ok-soft px-3 py-2 text-left text-sm', className)}>
          <CalendarCheck size={16} className="shrink-0" />
          <span>Tu llamada: <b>{next.when}</b>{next.status === 'CONFIRMED' ? ' · confirmada' : ''}</span>
        </button>
      ) : (
        <Button variant={variant === 'outline' ? 'outline' : undefined} size={size} className={className} onClick={() => setOpen(true)}>
          <Headset size={14} /> {label}
        </Button>
      )}
      {open && <ScheduleModal q={q} topic={topic} defaultPhone={defaultPhone} mine={mine} onClose={() => setOpen(false)} />}
    </>
  );
}

function ScheduleModal({ q, topic, defaultPhone, mine, onClose }: { q: string; topic: CallTopic; defaultPhone: string; mine?: Mine; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: slots } = useQuery({ queryKey: ['agent-slots'], queryFn: () => api.get<Slots>('/agent-calls/slots'), staleTime: 60_000 });
  const [day, setDay] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);
  const [phone, setPhone] = useState(defaultPhone);
  const [notes, setNotes] = useState('');
  const [what, setWhat] = useState<CallTopic>(topic);
  const [booked, setBooked] = useState<AgentCallView | null>(null);
  const book = useMutation({
    mutationFn: () => api.post<AgentCallView>(withScope('/agent-calls', q), { slotAt: at, topic: what, phone, notes }),
    onSuccess: (c) => {
      setBooked(c);
      queryClient.invalidateQueries({ queryKey: ['agent-calls'] });
      queryClient.invalidateQueries({ queryKey: ['agent-slots'] });
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'No se pudo agendar');
      queryClient.invalidateQueries({ queryKey: ['agent-slots'] });
      setAt(null);
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(withScope(`/agent-calls/${id}/cancel`, q), {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['agent-calls'] }); toast.success('Cita cancelada. Puedes agendar otra cuando quieras.'); onClose(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const next = mine?.next;
  const selectedDay = slots?.days.find((d) => d.date === (day ?? slots.days[0]?.date));

  if (booked || next) {
    const c = booked ?? next!;
    return (
      <Modal open onClose={onClose} kicker="Tu agente de BackOffice" title={booked ? '¡Listo, quedó agendada!' : 'Tu próxima llamada'}>
        <div className="space-y-4 text-sm">
          <div className="flex items-start gap-3 border-2 border-ok bg-ok-soft p-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-ok bg-ok text-white"><Check size={20} /></span>
            <div>
              <p className="text-base font-semibold">{cap(c.when)}</p>
              <p className="text-ink-2">{c.topicLabel} · te llamamos al {c.phone}</p>
              {c.agentName && <p className="text-ink-2">Te atiende {c.agentName}</p>}
              {c.meetUrl && <a href={c.meetUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">Entrar a la videollamada</a>}
            </div>
          </div>
          <p className="text-ink-2">
            No tienes que preparar nada técnico: en la llamada lo configuramos contigo, paso a paso. Si tienes a mano tu catálogo o lista de precios, mejor.
          </p>
          <div className="flex justify-between gap-2">
            {!booked && <Button variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(c.id)}>Cancelar la cita</Button>}
            <Button className="ml-auto" onClick={onClose}>Entendido</Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} kicker="Lo hacemos contigo" title="Agenda una llamada con tu agente">
      <div className="space-y-5 text-sm">
        <p className="flex items-start gap-2 text-ink-2">
          <Phone size={16} className="mt-0.5 shrink-0" />
          Un agente de BackOffice te llama y deja todo funcionando contigo. Dura unos 20 minutos.
        </p>

        <div>
          <p className="kicker mb-2">1. ¿Qué día te queda bien?</p>
          {!slots ? <p className="text-ink-3">Buscando horarios libres…</p> : slots.days.length === 0 ? (
            <p className="text-ink-3">No hay horarios libres esta semana. Escríbenos por WhatsApp y te atendemos.</p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {slots.days.map((d) => (
                <button key={d.date} type="button" onClick={() => { setDay(d.date); setAt(null); }}
                  className={clsx('shrink-0 cursor-pointer border-2 px-3 py-2 text-left', d.date === selectedDay?.date ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink')}>
                  <span className="block font-semibold">{cap(d.label)}</span>
                  <span className={clsx('block text-xs', d.date === selectedDay?.date ? 'text-line' : 'text-ink-3')}>{d.slots.length} horarios</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selectedDay && (
          <div>
            <p className="kicker mb-2">2. ¿A qué hora?</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {selectedDay.slots.map((s) => (
                <button key={s.at} type="button" onClick={() => setAt(s.at)}
                  className={clsx('cursor-pointer border-2 px-2 py-2 text-center tabular-nums', at === s.at ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink')}>
                  {s.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-ink-3">Hora de Colombia.</p>
          </div>
        )}

        {at && (
          <div className="space-y-3">
            <p className="kicker">3. ¿Dónde te llamamos?</p>
            <Field label="Tu celular o WhatsApp">
              <Input inputMode="tel" value={phone} placeholder="300 123 4567" onChange={(e) => setPhone(e.target.value)} autoFocus />
            </Field>
            {mine?.topics && (
              <div className="flex flex-wrap gap-1.5">
                {(Object.entries(mine.topics) as Array<[CallTopic, string]>).map(([k, v]) => (
                  <button key={k} type="button" onClick={() => setWhat(k)}
                    className={clsx('cursor-pointer border-2 px-2.5 py-1 text-xs', what === k ? 'border-ink bg-ink text-bone' : 'border-line hover:border-ink')}>
                    {v}
                  </button>
                ))}
              </div>
            )}
            <Field label="¿Algo que debamos saber? (opcional)">
              <Textarea rows={2} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Ahora no</Button>
          <Button disabled={!at || phone.replace(/\D/g, '').length < 7 || book.isPending} onClick={() => book.mutate()}>
            {book.isPending ? 'Agendando…' : 'Agendar mi llamada'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
