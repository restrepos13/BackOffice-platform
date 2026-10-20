import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea } from '../../components/ui';
import type { AgentCallView } from '../../components/ScheduleCall';

/**
 * Citas que agendan las empresas con un agente de BackOffice. Aquí el equipo
 * las confirma, se asigna, deja el enlace de la videollamada y las cierra.
 */

type Row = AgentCallView & { companyId: string; companyName: string; companyHasPlan: boolean; requestedBy: string };

const TONE: Record<string, 'warn' | 'info' | 'ok' | 'neutral' | 'bad'> = {
  REQUESTED: 'warn', CONFIRMED: 'info', DONE: 'ok', CANCELLED: 'neutral', NO_SHOW: 'bad',
};

function wa(phone: string) {
  const d = phone.replace(/\D/g, '');
  return d.length === 10 && d.startsWith('3') ? `57${d}` : d;
}

export default function Citas() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('OPEN');
  const [edit, setEdit] = useState<Row | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['agent-calls-all', tab], queryFn: () => api.get<Row[]>(`/agent-calls/all${tab === 'ALL' ? '' : `?status=${tab}`}`) });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: Record<string, unknown> }) => api.patch(`/agent-calls/${v.id}`, v.patch),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['agent-calls-all'] }); setEdit(null); toast.success('Cita actualizada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <>
      <PageHeader kicker="Lo técnico lo hacemos nosotros" title="Citas" accent="con clientes" />
      <Tabs
        tabs={[{ id: 'OPEN', label: 'Pendientes' }, { id: 'DONE', label: 'Hechas' }, { id: 'ALL', label: 'Todas' }]}
        active={tab}
        onChange={setTab}
      />
      {isLoading || !data ? <Loading /> : data.length === 0 ? (
        <EmptyState title="No hay citas aquí" hint="Cuando una empresa toque «Agéndame con un agente», aparece en esta lista y les llega un correo." />
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {data.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold first-letter:uppercase">{c.when}</p>
                  <p className="text-sm"><Link to={`/platform/companies/${c.companyId}`} className="font-semibold underline">{c.companyName}</Link>{c.companyHasPlan ? '' : ' · sin plan'}</p>
                </div>
                <Badge tone={TONE[c.status] ?? 'neutral'}>{c.statusLabel}</Badge>
              </div>
              <p className="mt-2 text-sm"><b>{c.topicLabel}</b> · pidió {c.requestedBy}</p>
              <p className="text-sm">
                {c.phone} · <a href={`https://wa.me/${wa(c.phone)}`} target="_blank" rel="noopener noreferrer" className="underline">WhatsApp</a>
                {c.agentName ? ` · agente: ${c.agentName}` : ''}
              </p>
              {c.notes && <p className="mt-1 text-xs text-ink-2">“{c.notes}”</p>}
              {c.doneNotes && <p className="mt-1 text-xs text-ink-3">Resultado: {c.doneNotes}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {c.status === 'REQUESTED' && <Button size="sm" onClick={() => update.mutate({ id: c.id, patch: { status: 'CONFIRMED' } })}>Confirmar</Button>}
                {['REQUESTED', 'CONFIRMED'].includes(c.status) && <Button size="sm" variant="outline" onClick={() => setEdit(c)}>Cerrar o editar</Button>}
                {['REQUESTED', 'CONFIRMED'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: c.id, patch: { status: 'NO_SHOW' } })}>No contestó</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {edit && <EditCall call={edit} onClose={() => setEdit(null)} onSave={(patch) => update.mutate({ id: edit.id, patch })} saving={update.isPending} />}
    </>
  );
}

function EditCall({ call, onClose, onSave, saving }: { call: Row; onClose: () => void; onSave: (p: Record<string, unknown>) => void; saving: boolean }) {
  const [status, setStatus] = useState<string>(call.status === 'REQUESTED' ? 'CONFIRMED' : 'DONE');
  const [agentName, setAgentName] = useState(call.agentName ?? '');
  const [meetUrl, setMeetUrl] = useState(call.meetUrl ?? '');
  const [doneNotes, setDoneNotes] = useState(call.doneNotes ?? '');
  return (
    <Modal open onClose={onClose} kicker={call.companyName} title="Cita">
      <div className="space-y-3">
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="CONFIRMED">Confirmada</option>
            <option value="DONE">Hecha</option>
            <option value="NO_SHOW">No contestó</option>
            <option value="CANCELLED">Cancelada</option>
          </Select>
        </Field>
        <Field label="Agente que atiende"><Input value={agentName} onChange={(e) => setAgentName(e.target.value)} /></Field>
        <Field label="Enlace de videollamada (opcional)" hint="Lo ve el cliente en su panel"><Input value={meetUrl} placeholder="https://meet.google.com/…" onChange={(e) => setMeetUrl(e.target.value)} /></Field>
        <Field label="Qué quedó hecho"><Textarea rows={3} value={doneNotes} onChange={(e) => setDoneNotes(e.target.value)} /></Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={saving} onClick={() => onSave({ status, agentName, meetUrl, doneNotes })}>Guardar</Button>
        </div>
      </div>
    </Modal>
  );
}
