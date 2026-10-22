import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Badge, Button, EmptyState, Field, Loading, Modal, Select, Textarea } from '../ui';

/**
 * Radar comercial: tarjetas de oportunidad reutilizables (Creative y
 * Publicidad). La lógica vive en el servidor; aquí solo se muestra y se pide
 * la decisión. Hechos, interpretación y datos faltantes van separados.
 */

export interface Opportunity {
  id: string; source: 'ADS' | 'CRM'; mode: 'REAL' | 'DEMO'; ruleKey: string; severity: string; title: string; summary: string | null; entityName: string | null;
  evidence: 'SUFFICIENT' | 'INITIAL' | 'MISSING_DATA'; status: string; statusLabel: string; firstSeenAt: string; lastSeenAt: string; actedAt: string | null; resultAt: string | null;
  explanation: { facts: string[]; interpretation: string; assumptions: string[]; missing: string[]; action: string; expected: string; uncertainty: string };
  sources: string[]; period: Record<string, any>;
  action: { type: 'PAUSE' | 'FOLLOW_UP' | 'REVIEW' | 'LINK' | 'NONE'; label?: string; risk: string; reversible: boolean; href?: string; contacts: number };
  decisions: Array<{ at: string; by: string; status: string; note?: string }>;
  result: { kind?: string; facts?: string[]; note?: string; metrics?: Record<string, unknown>; declared?: { note: string; by: string; at: string } } | null;
}

const EVIDENCE: Record<string, [string, 'ok' | 'info' | 'warn']> = {
  SUFFICIENT: ['Evidencia suficiente', 'ok'], INITIAL: ['Indicio inicial', 'info'], MISSING_DATA: ['Faltan datos', 'warn'],
};
const STATUS_TONE: Record<string, 'neutral' | 'warn' | 'info' | 'ok'> = {
  NEW: 'info', REVIEWING: 'neutral', PREPARED: 'warn', NEEDS_APPROVAL: 'warn', EXECUTED: 'ok', OBSERVING: 'info', RESULT: 'ok', DISMISSED: 'neutral', SNOOZED: 'neutral',
};
const fmtDate = (d: string) => new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

function periodText(p: Record<string, any>) {
  if (p?.since && p?.until) return `${p.since} a ${p.until}`;
  if (p?.current?.since) return `${p.current.since} a ${p.current.until}`;
  if (p?.lastDays) return `últimos ${p.lastDays} días`;
  if (p?.day) return p.day;
  return null;
}

export function OpportunityCard({ o, scope, canWrite, compact }: { o: Opportunity; scope: (path: string) => string; canWrite: boolean; compact?: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(!compact);
  const [dialog, setDialog] = useState<null | 'act' | 'dismiss' | 'snooze' | 'contacts' | 'result'>(null);
  const [note, setNote] = useState('');
  const [days, setDays] = useState('7');
  const refresh = () => ['opportunities', 'creative-context', 'ads-overview', 'ads-campaigns', 'ads-actions'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'No se pudo completar');
  const move = useMutation({
    mutationFn: (body: { to: string; note?: string; snoozeDays?: number }) => api.post(scope(`/opportunities/${o.id}/move`), body),
    onSuccess: (_r, v) => { refresh(); setDialog(null); setNote(''); toast.success(v.to === 'SNOOZED' ? 'Pospuesta: volverá a aparecer en su fecha' : v.to === 'DISMISSED' ? 'Descartada. Queda el registro de tu decisión.' : 'Listo'); },
    onError: err,
  });
  const act = useMutation({
    mutationFn: () => api.post<{ demo: boolean }>(scope(`/opportunities/${o.id}/act`), { confirm: true, note: note || undefined }),
    onSuccess: (r) => { refresh(); setDialog(null); setNote(''); toast.success(o.action.type === 'PAUSE' ? (r.demo ? 'Pausado (simulado en la demostración). Mediremos qué pasa en los próximos días.' : 'Pausado en la plataforma. Mediremos qué pasa en los próximos días.') : 'Registrado. Mediremos qué pasa en los próximos días.'); },
    onError: err,
  });
  const result = useMutation({ mutationFn: () => api.post(scope(`/opportunities/${o.id}/result`), { note }), onSuccess: () => { refresh(); setDialog(null); setNote(''); toast.success('Resultado anotado'); }, onError: err });
  const contacts = useQuery({ queryKey: ['opportunity-contacts', o.id], queryFn: () => api.get<Array<{ id: string; name: string; phone: string | null; stage: string }>>(scope(`/opportunities/${o.id}/contacts`)), enabled: dialog === 'contacts' });
  const isOpen = ['NEW', 'REVIEWING', 'PREPARED', 'NEEDS_APPROVAL'].includes(o.status);
  const [evLabel, evTone] = EVIDENCE[o.evidence] ?? ['—', 'info'];
  const period = periodText(o.period);
  const a = o.action;

  // Siguiente paso principal según el estado (una acción clara)
  let primary: { label: string; onClick: () => void } | null = null;
  if (canWrite && isOpen) {
    if (a.type === 'PAUSE') primary = o.status === 'NEEDS_APPROVAL' ? { label: 'Aprobar y pausar', onClick: () => setDialog('act') } : { label: 'Preparar la pausa', onClick: () => move.mutate({ to: 'NEEDS_APPROVAL' }) };
    else if (a.type === 'FOLLOW_UP') primary = o.status === 'PREPARED' ? { label: 'Ya hice el seguimiento', onClick: () => setDialog('act') } : { label: a.label ?? 'Preparar lista', onClick: () => move.mutate({ to: 'PREPARED' }) };
    else primary = { label: 'Ya lo hice', onClick: () => setDialog('act') };
  }

  return (
    <article className={clsx('border-2 bg-paper', o.severity === 'HIGH' && isOpen ? 'border-ink shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]' : 'border-line')}>
      <header className="flex flex-wrap items-start justify-between gap-2 p-4 pb-2">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap gap-1">
            <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.statusLabel}</Badge>
            <Badge tone={evTone}>{evLabel}</Badge>
            <Badge tone="neutral">{o.source === 'ADS' ? 'Anuncios' : 'CRM'}</Badge>
            {o.mode === 'DEMO' && <Badge tone="info">Demostración</Badge>}
          </div>
          <h3 className="font-semibold leading-snug">{o.title}</h3>
          {o.summary && <p className="mt-1 text-sm text-ink-2">{o.summary}</p>}
        </div>
        {compact && <button type="button" className="cursor-pointer text-xs underline" onClick={() => setOpen(!open)}>{open ? 'Ocultar detalle' : 'Ver evidencia'}</button>}
      </header>
      {open && (
        <div className="grid gap-4 px-4 pb-3 text-sm md:grid-cols-3">
          <div>
            <p className="kicker mb-1">Hechos</p>
            <ul className="list-disc space-y-0.5 pl-5">{o.explanation.facts?.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
          <div>
            <p className="kicker mb-1">Lo que puede significar</p>
            <p>{o.explanation.interpretation}</p>
            {o.explanation.assumptions?.length > 0 && <p className="mt-1 text-xs text-ink-3">Suponemos: {o.explanation.assumptions.join(' · ')}</p>}
          </div>
          <div>
            <p className="kicker mb-1">Qué falta saber</p>
            {o.explanation.missing?.length ? <ul className="list-disc space-y-0.5 pl-5 text-ink-2">{o.explanation.missing.map((m) => <li key={m}>{m}</li>)}</ul> : <p className="text-ink-3">Nada relevante.</p>}
            <p className="mt-1 text-xs text-ink-3">{o.explanation.uncertainty}</p>
          </div>
        </div>
      )}
      <div className="border-t border-line px-4 py-3 text-sm">
        <p><b>Siguiente paso:</b> {o.explanation.action} <span className="text-ink-3">Resultado esperado: {o.explanation.expected}</span></p>
        <p className="mt-1 text-[11px] text-ink-3">Fuente: {o.sources.join(' · ') || '—'}{period ? ` · periodo ${period}` : ''} · detectada el {fmtDate(o.firstSeenAt)}</p>
        {o.result && (
          <div className="mt-3 border-l-4 border-ok bg-ok-soft/40 px-3 py-2">
            <p className="kicker mb-1">{o.result.kind === 'CONDITION_GONE' ? 'Ya no se detecta' : 'Qué pasó después'}</p>
            {o.result.facts?.length ? <ul className="list-disc pl-5">{o.result.facts.map((f) => <li key={f}>{f}</li>)}</ul> : null}
            {o.result.note && <p className="mt-1 text-xs text-ink-2">{o.result.note}</p>}
            {o.result.declared && <p className="mt-1 text-xs">Anotado por {o.result.declared.by}: «{o.result.declared.note}» (dato declarado, no medido)</p>}
          </div>
        )}
        {o.status === 'OBSERVING' && <p className="mt-2 text-xs text-info">En observación desde el {o.actedAt ? fmtDate(o.actedAt) : '—'}: el resultado se mide solo en unos días.</p>}
        {canWrite && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {primary && <Button size="sm" disabled={move.isPending} onClick={primary.onClick}>{primary.label}</Button>}
            {a.contacts > 0 && <Button size="sm" variant="outline" onClick={() => setDialog('contacts')}>Ver a quiénes ({a.contacts})</Button>}
            {a.href && isOpen && <Link to={a.href} className="border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase tracking-wider hover:bg-bone-2">{a.type === 'LINK' ? a.label ?? 'Ir' : 'Abrir'}</Link>}
            {isOpen && o.status === 'NEW' && <Button size="sm" variant="ghost" onClick={() => move.mutate({ to: 'REVIEWING' })}>Lo reviso luego</Button>}
            {isOpen && <Button size="sm" variant="ghost" onClick={() => setDialog('snooze')}>Posponer</Button>}
            {isOpen && <Button size="sm" variant="ghost" onClick={() => setDialog('dismiss')}>Descartar</Button>}
            {['OBSERVING', 'RESULT'].includes(o.status) && <Button size="sm" variant="ghost" onClick={() => setDialog('result')}>Anotar resultado</Button>}
            {['DISMISSED', 'SNOOZED'].includes(o.status) && <Button size="sm" variant="ghost" onClick={() => move.mutate({ to: 'NEW' })}>Reabrir</Button>}
          </div>
        )}
        {o.decisions.length > 0 && (
          <details className="mt-2 text-xs text-ink-3">
            <summary className="cursor-pointer">Historial de decisiones ({o.decisions.length})</summary>
            <ul className="mt-1 space-y-0.5">{o.decisions.map((d, i) => <li key={i}>{fmtDate(d.at)} · {d.by}: {d.note ?? d.status}</li>)}</ul>
          </details>
        )}
      </div>

      <Modal open={dialog === 'act'} onClose={() => setDialog(null)} kicker="Confirmación" title={a.type === 'PAUSE' ? 'Pausar en la plataforma' : 'Registrar que actuaste'}>
        <div className="space-y-3 text-sm">
          {a.type === 'PAUSE'
            ? <p><b>{o.entityName}</b> dejará de entregarse y de gastar. Se puede reanudar desde Publicidad → Campañas. {o.mode === 'DEMO' && <span className="text-info">Es una demostración: no se toca ninguna cuenta real.</span>}</p>
            : <p>Quedará «en observación». En unos días mediremos qué pasó después (por ejemplo, cuántos contactos respondieron o compraron). No damos la oportunidad por resuelta solo con este clic.</p>}
          <Field label="Nota (opcional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Qué hiciste" /></Field>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDialog(null)}>Cancelar</Button><Button disabled={act.isPending} onClick={() => act.mutate()}>{a.type === 'PAUSE' ? 'Sí, pausar' : 'Registrar'}</Button></div>
        </div>
      </Modal>
      <Modal open={dialog === 'dismiss'} onClose={() => setDialog(null)} kicker="Descartar" title="¿Por qué no aplica?">
        <div className="space-y-3 text-sm">
          <Field label="Motivo" hint="Nos ayuda a no volver a sugerirte cosas parecidas"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDialog(null)}>Cancelar</Button><Button onClick={() => move.mutate({ to: 'DISMISSED', note })}>Descartar</Button></div>
        </div>
      </Modal>
      <Modal open={dialog === 'snooze'} onClose={() => setDialog(null)} kicker="Posponer" title="¿Cuándo te la recordamos?">
        <div className="space-y-3 text-sm">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>{[['1', 'Mañana'], ['3', 'En 3 días'], ['7', 'En una semana'], ['14', 'En dos semanas'], ['30', 'En un mes']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDialog(null)}>Cancelar</Button><Button onClick={() => move.mutate({ to: 'SNOOZED', snoozeDays: Number(days) })}>Posponer</Button></div>
        </div>
      </Modal>
      <Modal open={dialog === 'result'} onClose={() => setDialog(null)} kicker="Resultado" title="¿Qué pasó?">
        <div className="space-y-3 text-sm">
          <p className="text-ink-2">Queda como dato declarado por ti, separado de lo que medimos.</p>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: dos clientes volvieron a pedir" />
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDialog(null)}>Cancelar</Button><Button disabled={!note.trim() || result.isPending} onClick={() => result.mutate()}>Guardar</Button></div>
        </div>
      </Modal>
      <Modal open={dialog === 'contacts'} onClose={() => setDialog(null)} kicker="Lista de seguimiento" title={`${a.contacts} contactos`}>
        {contacts.isLoading ? <Loading /> : (
          <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
            {(contacts.data ?? []).map((c) => <li key={c.id} className="flex justify-between py-1.5"><span>{c.name}</span><span className="text-xs text-ink-3">{c.stage.toLowerCase()}</span></li>)}
          </ul>
        )}
        <p className="mt-3 text-xs text-ink-3">No se envía ningún mensaje automático desde aquí. Escríbeles desde Conversaciones.</p>
      </Modal>
    </article>
  );
}

/** Lista con filtros por vista (abiertas / en curso / cerradas). */
export function OpportunityList({ scope, query, canWrite, emptyHint }: { scope: (path: string) => string; query: Record<string, string | undefined>; canWrite: boolean; emptyHint?: string }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState('open');
  const params = new URLSearchParams(Object.entries({ ...query, view }).filter(([, v]) => v) as [string, string][]).toString();
  const { data, isLoading } = useQuery({ queryKey: ['opportunities', params, scope('')], queryFn: () => api.get<Opportunity[]>(scope(`/opportunities?${params}`)) });
  const detect = useMutation({
    mutationFn: () => api.post(scope('/opportunities/detect')),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['opportunities'] }); toast.success('Revisamos tus datos de nuevo'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {[['open', 'Por atender'], ['done', 'En curso y resultados'], ['closed', 'Pospuestas y descartadas']].map(([k, l]) => (
          <button key={k} type="button" onClick={() => setView(k)} className={clsx('cursor-pointer border-2 px-3 py-1 text-sm', view === k ? 'border-ink bg-ink text-bone' : 'border-line')}>{l}</button>
        ))}
        {canWrite && <Button size="sm" variant="outline" disabled={detect.isPending} onClick={() => detect.mutate()}>{detect.isPending ? 'Revisando…' : 'Revisar ahora'}</Button>}
      </div>
      {isLoading || !data ? <Loading /> : !data.length ? (
        <EmptyState title={view === 'open' ? 'Nada pendiente con evidencia suficiente' : 'Nada por aquí todavía'} hint={view === 'open' ? emptyHint ?? 'Revisamos tus conversaciones, embudo, pedidos y anuncios. Cuando algo merezca tu atención aparecerá aquí con sus datos.' : undefined} />
      ) : (
        <div className="space-y-4">{data.map((o) => <OpportunityCard key={o.id} o={o} scope={scope} canWrite={canWrite} compact />)}</div>
      )}
    </div>
  );
}
