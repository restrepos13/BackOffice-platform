import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Tabs, Textarea } from '../../../components/ui';
import { PickCompany, useCompanyScope } from '../shared';
import {
  AVAILABILITY_LABEL, BILLING_LABEL, CHANNEL_LABEL, LINE_CATEGORY_LABEL, PRIORITY_LABEL, QUOTE_STATUS_LABEL, RESERVATION_LABEL, RESOURCE_KIND_LABEL,
  SERVICE_LABEL, TASK_STATUS_LABEL, type TeamResponse, UNIT_LABEL, VALUE_STATUS_LABEL, StatusBadge, fmtDate, fmtMoney, fromLocalInput, prodApi,
  toLocalInput, useProdMutation,
} from './shared';

/* ── Tipos de la respuesta del servidor ── */
interface Detail {
  production: any;
  brief: Record<string, any>;
  briefFields: Array<{ key: string; label: string; group: string; kind: string }>;
  durations: string[];
  missing: { toComplete: Array<{ key: string; label: string }>; toQuote: Array<{ key: string; label: string }>; configStatus: string };
  transitions: Array<{ status: string; label: string; needsReason: boolean; needsEvidence: boolean }>;
  tasks: any[];
  issues: any[];
  assignments: any[];
  quotes: any[];
  events: any[];
  ai: { calls: number; costUsd: number } | null;
  permissions: string[];
  serviceTypes: Array<{ key: string; label: string }>;
  holdHours: number | null;
}

/** Pide uno o varios datos antes de llamar a la API (motivo, evidencia, vencimiento…). */
function PromptModal({ open, title, fields, onClose, onSubmit, busy, confirmLabel, message }: {
  open: boolean; title: string; confirmLabel: string; busy: boolean; message?: string;
  fields: Array<{ key: string; label: string; type?: 'text' | 'long' | 'datetime'; required?: boolean; hint?: string }>;
  onClose: () => void; onSubmit: (values: Record<string, string>) => void;
}) {
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => { if (open) setV({}); }, [open]);
  const missing = fields.some((f) => f.required && !v[f.key]?.trim());
  return (
    <Modal open={open} onClose={onClose} kicker="Confirmar" title={title}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!missing) onSubmit(v); }}>
        {message && <p className="text-sm text-ink-2">{message}</p>}
        {fields.map((f) => (
          <Field key={f.key} label={f.label} required={f.required} hint={f.hint}>
            {f.type === 'long'
              ? <Textarea rows={3} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
              : <Input type={f.type === 'datetime' ? 'datetime-local' : 'text'} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
          </Field>
        ))}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || missing}>{busy ? 'Guardando…' : confirmLabel}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function ProductionDetail() {
  const { id = '' } = useParams();
  const { ready, q } = useCompanyScope();
  const [tab, setTab] = useState('resumen');
  const d = useQuery({ queryKey: ['production', q, id], queryFn: () => prodApi.get<Detail>(q, `/${id}`), enabled: ready && !!id });
  const team = useQuery({ queryKey: ['production-team', q], queryFn: () => prodApi.get<TeamResponse>(q, '/team'), enabled: ready });
  const [prompt, setPrompt] = useState<null | { title: string; confirmLabel: string; fields: any[]; message?: string; run: (v: Record<string, string>) => Promise<unknown> }>(null);
  const run = useProdMutation(q, (b: { fn: (v: Record<string, string>) => Promise<unknown>; v: Record<string, string> }) => b.fn(b.v), 'Listo');

  if (!ready) return <PickCompany />;
  if (d.isLoading) return <Loading />;
  if (d.isError || !d.data) return <EmptyState title="No se pudo abrir la producción" hint={(d.error as Error)?.message} action={<Link to="/app/productions/list"><Button variant="outline">Volver al listado</Button></Link>} />;
  const data = d.data;
  const p = data.production;
  const can = new Set(data.permissions);
  const users = team.data?.users ?? [];
  const ask: Ask = (title, confirmLabel, fields, fn, message) => setPrompt({ title, confirmLabel, fields, run: fn, message });
  const openTasks = data.tasks.filter((t) => ['TODO', 'IN_PROGRESS', 'BLOCKED'].includes(t.status)).length;

  return (
    <>
      <PageHeader kicker={`Producción ${p.code}${p.isTest ? ' · REGISTRO DE PRUEBA' : ''}`} title={p.clientName} accent={p.brand ?? undefined} />
      {/* Estado, responsable, próxima acción y qué falta */}
      <div className="mb-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="border-2 border-ink bg-paper p-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.status} label={p.statusLabel} />
            <Badge tone="neutral">{CHANNEL_LABEL[p.channel] ?? p.channel}</Badge>
            <Badge tone={p.priority === 'URGENTE' || p.priority === 'ALTA' ? 'warn' : 'neutral'}>Prioridad {PRIORITY_LABEL[p.priority] ?? p.priority}</Badge>
            {p.isTest && <Badge tone="warn">Prueba</Badge>}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-ink-3">Responsable</dt><dd className="font-semibold">{p.ownerName ?? <span className="text-warn">Sin asignar</span>}</dd></div>
            <div><dt className="text-xs text-ink-3">Fecha solicitada</dt><dd className="font-semibold">{fmtDate(p.requestedDate, true)}</dd></div>
            <div className="col-span-2"><dt className="text-xs text-ink-3">Próxima acción</dt><dd className="font-semibold">{p.nextAction ?? 'Sin definir'}{p.nextActionOwnerName ? ` · ${p.nextActionOwnerName}` : ''}{p.nextActionDueAt ? ` · ${fmtDate(p.nextActionDueAt, true)}` : ''}</dd></div>
          </dl>
          {p.closeReason && <p className="mt-2 text-sm text-ink-2">Motivo: {p.closeReason}</p>}
        </div>
        <div className="border-2 border-ink bg-paper p-4">
          <p className="kicker">Qué falta</p>
          {data.missing.toComplete.length ? <p className="mt-1 text-sm">Para completar el brief: <b>{data.missing.toComplete.map((m) => m.label).join(', ')}</b></p> : <p className="mt-1 text-sm text-ok">El brief tiene lo necesario para darse por completo.</p>}
          {data.missing.toQuote.length ? <p className="mt-1 text-sm">Para cotizar: <b>{data.missing.toQuote.map((m) => m.label).join(', ')}</b></p> : <p className="mt-1 text-sm text-ok">Listo para cotizar.</p>}
          {data.missing.configStatus === 'PENDING' && <p className="mt-1 text-xs text-ink-3">Los campos obligatorios son una sugerencia inicial, pendiente de confirmar con LPulpo.</p>}
          {can.has('edit') && data.transitions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {data.transitions.map((t) => (
                <Button
                  key={t.status}
                  size="sm"
                  variant={['CANCELADA', 'PERDIDA'].includes(t.status) ? 'danger' : t.status === 'EN_PAUSA' ? 'ghost' : 'outline'}
                  onClick={() => {
                    const call = (v: Record<string, string>) => prodApi.post(q, `/${id}/transition`, { to: t.status, reason: v.reason, evidence: v.evidence, expectedVersion: p.version });
                    if (t.needsReason || t.needsEvidence) {
                      ask(`Pasar a «${t.label}»`, 'Confirmar', [t.needsReason ? { key: 'reason', label: 'Motivo', type: 'long', required: true } : { key: 'evidence', label: '¿Cómo y cuándo aceptó el cliente?', type: 'long', required: true }], call);
                    } else {
                      run.mutate({ fn: call, v: {} });
                    }
                  }}
                >
                  → {t.label}
                </Button>
              ))}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-3">Los estados de cotización (por aprobar, aprobada, enviada) se mueven desde la pestaña Cotizaciones.</p>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'resumen', label: 'Resumen' }, { id: 'brief', label: 'Brief', badge: data.missing.toComplete.length || undefined },
          { id: 'recursos', label: 'Recursos y disponibilidad', badge: data.assignments.length || undefined },
          { id: 'cotizaciones', label: 'Cotizaciones', badge: data.quotes.length || undefined }, { id: 'tareas', label: 'Tareas', badge: openTasks || undefined },
          { id: 'historial', label: 'Historial' }, { id: 'incidencias', label: 'Incidencias', badge: data.issues.filter((i) => i.status === 'OPEN').length || undefined },
          { id: 'archivos', label: 'Archivos' },
        ]}
      />
      <div className="mt-5">
        {tab === 'resumen' && <SummaryTab q={q} data={data} users={users} />}
        {tab === 'brief' && <BriefTab q={q} data={data} />}
        {tab === 'recursos' && <ResourcesTab q={q} data={data} ask={ask} />}
        {tab === 'cotizaciones' && <QuotesTab q={q} data={data} ask={ask} />}
        {tab === 'tareas' && <TasksTab q={q} data={data} users={users} />}
        {tab === 'historial' && <HistoryTab data={data} />}
        {tab === 'incidencias' && <IssuesTab q={q} data={data} ask={ask} />}
        {tab === 'archivos' && <FilesTab data={data} />}
      </div>

      <PromptModal
        open={!!prompt}
        title={prompt?.title ?? ''}
        confirmLabel={prompt?.confirmLabel ?? ''}
        fields={prompt?.fields ?? []}
        message={prompt?.message}
        busy={run.isPending}
        onClose={() => setPrompt(null)}
        onSubmit={async (v) => { if (prompt) await run.mutateAsync({ fn: prompt.run, v }).then(() => setPrompt(null)).catch(() => undefined); }}
      />
    </>
  );
}

type Ask = (title: string, confirmLabel: string, fields: any[], fn: (v: Record<string, string>) => Promise<unknown>, message?: string) => void;

/* ── Resumen ── */
function SummaryTab({ q, data, users }: { q: string; data: Detail; users: TeamResponse['users'] }) {
  const p = data.production;
  const can = new Set(data.permissions);
  const [f, setF] = useState<Record<string, any>>({});
  useEffect(() => {
    setF({
      title: p.title, clientName: p.clientName, brand: p.brand ?? '', contactName: p.contactName ?? '', contactPhone: p.contactPhone ?? '', contactEmail: p.contactEmail ?? '',
      channel: p.channel, referredBy: p.referredBy ?? '', priority: p.priority, requestedDate: toLocalInput(p.requestedDate), requestedDateNote: p.requestedDateNote ?? '',
      ownerId: p.ownerId ?? '', nextAction: p.nextAction ?? '', nextActionOwnerId: p.nextActionOwnerId ?? '', nextActionDueAt: toLocalInput(p.nextActionDueAt), notes: p.notes ?? '',
    });
  }, [p.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useProdMutation(q, () => {
    const body: Record<string, unknown> = { ...f, requestedDate: fromLocalInput(f.requestedDate), nextActionDueAt: fromLocalInput(f.nextActionDueAt) };
    if (!can.has('assign')) { delete body.ownerId; delete body.nextActionOwnerId; }
    return prodApi.patch(q, `/${p.id}`, body);
  }, 'Cambios guardados');
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ro = !can.has('edit');
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
      <Card kicker="Cliente y contacto" title="Datos de la solicitud">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Título"><Input value={f.title ?? ''} onChange={set('title')} disabled={ro} /></Field>
          <Field label="Cliente" required><Input value={f.clientName ?? ''} onChange={set('clientName')} disabled={ro} /></Field>
          <Field label="Marca"><Input value={f.brand ?? ''} onChange={set('brand')} disabled={ro} /></Field>
          <Field label="Contacto"><Input value={f.contactName ?? ''} onChange={set('contactName')} disabled={ro} /></Field>
          <Field label="Teléfono"><Input value={f.contactPhone ?? ''} onChange={set('contactPhone')} disabled={ro} /></Field>
          <Field label="Correo"><Input value={f.contactEmail ?? ''} onChange={set('contactEmail')} disabled={ro} /></Field>
          <Field label="Canal"><Select value={f.channel ?? 'OTHER'} onChange={set('channel')} disabled={ro}>{Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          {f.channel === 'REFERRAL' && <Field label="Referido por"><Input value={f.referredBy ?? ''} onChange={set('referredBy')} disabled={ro} /></Field>}
          <Field label="Prioridad"><Select value={f.priority ?? 'NORMAL'} onChange={set('priority')} disabled={ro}>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Fecha solicitada"><Input type="datetime-local" value={f.requestedDate ?? ''} onChange={set('requestedDate')} disabled={ro} /></Field>
          <Field label="Nota sobre la fecha"><Input value={f.requestedDateNote ?? ''} onChange={set('requestedDateNote')} disabled={ro} placeholder="Ej.: el cliente dice «a mediados de noviembre»" /></Field>
        </div>
      </Card>
      <Card kicker="Coordinación" title="Responsable y próxima acción">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Responsable (booker)" hint={can.has('assign') ? undefined : 'Necesitas permiso para asignar'}>
            <Select value={f.ownerId ?? ''} onChange={set('ownerId')} disabled={ro || !can.has('assign')}><option value="">Sin asignar</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
          </Field>
          <Field label="Próxima acción"><Input value={f.nextAction ?? ''} onChange={set('nextAction')} disabled={ro} /></Field>
          <Field label="Responsable de la acción"><Select value={f.nextActionOwnerId ?? ''} onChange={set('nextActionOwnerId')} disabled={ro || !can.has('assign')}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
          <Field label="Fecha límite"><Input type="datetime-local" value={f.nextActionDueAt ?? ''} onChange={set('nextActionDueAt')} disabled={ro} /></Field>
        </div>
        <div className="mt-3"><Field label="Notas internas"><Textarea rows={3} value={f.notes ?? ''} onChange={set('notes')} disabled={ro} /></Field></div>
      </Card>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink-3">
        <span>
          {p.conversationId ? <>Vinculada a una conversación · <Link className="underline" to="/app/inbox">ver conversaciones</Link></> : 'Sin conversación vinculada (registro manual)'}
          {data.ai ? ` · IA de la conversación: ${data.ai.calls} llamadas, USD ${data.ai.costUsd}` : ''}
        </span>
        {!ro && <Button type="submit" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar cambios'}</Button>}
      </div>
    </form>
  );
}

/* ── Brief ── */
function BriefTab({ q, data }: { q: string; data: Detail }) {
  const [b, setB] = useState<Record<string, any>>(data.brief);
  useEffect(() => setB(data.brief), [data.production.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useProdMutation(q, () => prodApi.put(q, `/${data.production.id}/brief`, { brief: b }), 'Brief guardado');
  const ro = !data.permissions.includes('edit');
  const missing = new Set([...data.missing.toComplete, ...data.missing.toQuote].map((m) => m.key));
  const groups = [...new Set(data.briefFields.map((f) => f.group))];
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
      {groups.map((g) => (
        <Card key={g} kicker="Brief" title={g}>
          <div className="grid gap-3 sm:grid-cols-2">
            {data.briefFields.filter((f) => f.group === g).map((f) => {
              const label = `${f.label}${missing.has(f.key) ? ' · falta' : ''}`;
              const v = b[f.key] ?? '';
              const onChange = (e: { target: { value: string } }) => setB({ ...b, [f.key]: e.target.value });
              return (
                <Field key={f.key} label={label}>
                  {f.kind === 'long' ? <Textarea rows={3} value={v} onChange={onChange} disabled={ro} />
                    : f.kind === 'choice' ? <Select value={v} onChange={onChange} disabled={ro}><option value="">Sin definir</option>{data.durations.map((x) => <option key={x} value={x}>{x}</option>)}</Select>
                    : <Input type={f.kind === 'number' ? 'number' : 'text'} min={0} value={v} onChange={onChange} disabled={ro} />}
                </Field>
              );
            })}
          </div>
        </Card>
      ))}
      {!ro && <div className="flex justify-end"><Button type="submit" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar brief'}</Button></div>}
    </form>
  );
}

/* ── Recursos, disponibilidad y reservas ── */
const SERVICE_TO_KIND: Record<string, string> = { MODEL: 'MODEL', LOCATION: 'LOCATION', PHOTOGRAPHY: 'PHOTOGRAPHER', CREATIVE_DIRECTION: 'CREATIVE_DIRECTION', STYLING: 'STYLING', ASSISTANT: 'ASSISTANT', CATERING: 'CATERING', OTHER: 'OTHER' };

function ResourcesTab({ q, data, ask }: { q: string; data: Detail; ask: Ask }) {
  const can = new Set(data.permissions);
  const id = data.production.id;
  const catalog = useQuery({ queryKey: ['production-resources', q], queryFn: () => prodApi.get<any[]>(q, '/resources?active=true') });
  const [f, setF] = useState({ serviceType: data.serviceTypes[0]?.key ?? 'MODEL', resourceId: '', label: '', role: 'CANDIDATE', startsAt: '', endsAt: '' });
  const add = useProdMutation(q, () => prodApi.post(q, `/${id}/assignments`, { ...f, resourceId: f.resourceId || undefined, startsAt: fromLocalInput(f.startsAt), endsAt: fromLocalInput(f.endsAt) }), 'Recurso agregado');
  const avail = useProdMutation(q, (b: { aid: string; availability: string; note?: string }) => prodApi.post(q, `/assignments/${b.aid}/availability`, b), 'Disponibilidad registrada');
  const options = (catalog.data ?? []).filter((r) => r.kind === SERVICE_TO_KIND[f.serviceType]);
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">La disponibilidad aquí es la que registra una persona (nadie se consultó desde BackOffice). Retener no es confirmar: una retención vence y se libera sola.{data.holdHours ? ` Las retenciones duran ${data.holdHours} h (regla confirmada).` : ' La duración de las retenciones está pendiente de configurar: al retener se pide la fecha de vencimiento.'}</p>
      {data.assignments.length === 0 ? <EmptyState title="Sin recursos" hint="Agrega los modelos, la locación, el fotógrafo y los demás servicios que necesita la producción." /> : (
        <div className="space-y-2">
          {data.assignments.map((a) => (
            <div key={a.id} className="border-2 border-ink bg-paper p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{SERVICE_LABEL[a.serviceType] ?? a.serviceType}: {a.resourceName ?? a.label ?? 'Por definir'}</p>
                  <p className="text-xs text-ink-3">{a.role === 'SELECTED' ? 'Seleccionado' : 'Candidato'} · {a.startsAt ? `${fmtDate(a.startsAt, true)} → ${fmtDate(a.endsAt, true)}` : 'Sin horario'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={a.availability === 'AVAILABLE' ? 'ok' : a.availability === 'UNAVAILABLE' ? 'bad' : 'neutral'}>{AVAILABILITY_LABEL[a.availability]}</Badge>
                  <Badge tone={a.reservation === 'CONFIRMED' ? 'ok' : a.reservation === 'HOLD' || a.reservation === 'PENDING_CONFIRMATION' ? 'warn' : 'neutral'}>{RESERVATION_LABEL[a.reservation]}{a.reservation === 'HOLD' && a.holdExpiresAt ? ` hasta ${fmtDate(a.holdExpiresAt, true)}` : ''}</Badge>
                  {a.holdExpired && <Badge tone="bad">Retención vencida</Badge>}
                </div>
              </div>
              {a.availabilityNote && <p className="mt-1 text-xs text-ink-2">Disponibilidad: {a.availabilityNote} ({fmtDate(a.availabilityAt, true)})</p>}
              {can.has('resources') && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select aria-label="Disponibilidad" className="!w-auto" value={a.availability} onChange={(e) => {
                    const availability = e.target.value;
                    if (['AVAILABLE', 'UNAVAILABLE'].includes(availability)) ask('Registrar disponibilidad', 'Guardar', [{ key: 'note', label: '¿Quién respondió y por dónde?', type: 'long', required: true }], (v) => prodApi.post(q, `/assignments/${a.id}/availability`, { availability, note: v.note }));
                    else avail.mutate({ aid: a.id, availability });
                  }}>
                    {Object.entries(AVAILABILITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                  {['NONE', 'RELEASED', 'CANCELLED'].includes(a.reservation) && a.resourceId && (
                    <Button size="sm" variant="outline" onClick={() => ask('Retener temporalmente', 'Retener', data.holdHours ? [] : [{ key: 'holdExpiresAt', label: 'Retener hasta', type: 'datetime', required: true, hint: 'La duración de las retenciones aún no está definida por LPulpo' }], (v) => prodApi.post(q, `/assignments/${a.id}/hold`, { holdExpiresAt: fromLocalInput(v.holdExpiresAt ?? '') }))}>Retener</Button>
                  )}
                  {['NONE', 'HOLD', 'RELEASED'].includes(a.reservation) && a.resourceId && (
                    <Button size="sm" variant="outline" onClick={() => ask('Pendiente de confirmación', 'Registrar', [], () => prodApi.post(q, `/assignments/${a.id}/request-confirmation`, {}), 'BackOffice no contacta a nadie: esto registra que pediste la confirmación por tu cuenta y bloquea el horario hasta que se confirme o se libere.')}>Pendiente de confirmar</Button>
                  )}
                  {['HOLD', 'PENDING_CONFIRMATION'].includes(a.reservation) && can.has('confirm') && (
                    <Button size="sm" onClick={() => ask('Confirmar reserva', 'Confirmar', [{ key: 'evidence', label: '¿Quién confirmó y por dónde?', type: 'long', required: true }], (v) => prodApi.post(q, `/assignments/${a.id}/confirm`, { evidence: v.evidence }))}>Confirmar</Button>
                  )}
                  {['HOLD', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(a.reservation) && (
                    <Button size="sm" variant="ghost" onClick={() => ask(a.reservation === 'CONFIRMED' ? 'Cancelar reserva confirmada' : 'Liberar', 'Liberar', [{ key: 'reason', label: 'Motivo', type: 'long', required: a.reservation === 'CONFIRMED' }], (v) => prodApi.post(q, `/assignments/${a.id}/release`, { reason: v.reason }))}>Liberar</Button>
                  )}
                  {a.role === 'CANDIDATE' && <Button size="sm" variant="ghost" onClick={() => ask('Seleccionar este recurso', 'Seleccionar', [], () => prodApi.patch(q, `/assignments/${a.id}`, { role: 'SELECTED' }), 'Pasa de candidato a seleccionado para la producción. No confirma ni reserva nada.')}>Seleccionar</Button>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {can.has('resources') && (
        <Card kicker="Agregar" title="Recurso para esta producción">
          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }}>
            <Field label="Servicio"><Select value={f.serviceType} onChange={(e) => setF({ ...f, serviceType: e.target.value, resourceId: '' })}>{data.serviceTypes.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></Field>
            <Field label="Del catálogo" hint={options.length ? undefined : 'No hay recursos de este tipo; agrégalos en «Modelos y proveedores» o usa un nombre provisional'}>
              <Select value={f.resourceId} onChange={(e) => setF({ ...f, resourceId: e.target.value })}><option value="">Por definir</option>{options.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select>
            </Field>
            {!f.resourceId && <Field label="Nombre provisional"><Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ej.: fotógrafo por definir" /></Field>}
            <Field label="Papel"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="CANDIDATE">Candidato</option><option value="SELECTED">Seleccionado</option></Select></Field>
            <Field label="Inicio"><Input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
            <Field label="Fin"><Input type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} /></Field>
            <div className="sm:col-span-2 lg:col-span-3"><Button type="submit" disabled={add.isPending}>{add.isPending ? 'Agregando…' : 'Agregar recurso'}</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

/* ── Cotizaciones ── */
const emptyLine = () => ({ id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, category: 'MODEL', description: '', quantity: 1, unit: 'FULL_DAY', unitCost: null, costStatus: 'PENDING', unitPrice: null, priceStatus: 'PENDING', billing: 'TO_CONFIRM', commission: null, notes: null });

function QuotesTab({ q, data, ask }: { q: string; data: Detail; ask: Ask }) {
  const can = new Set(data.permissions);
  const id = data.production.id;
  const create = useProdMutation(q, (b: any) => prodApi.post(q, `/${id}/quotes`, b), 'Versión creada');
  const draft = data.quotes.find((x) => x.status === 'DRAFT');
  const canCreate = can.has('quotes') && !data.quotes.some((x) => ['DRAFT', 'PENDING_APPROVAL'].includes(x.status)) && ['PROPUESTA_EN_PREPARACION', 'COTIZACION_APROBADA', 'COTIZACION_ENVIADA', 'PENDIENTE_RESPUESTA_CLIENTE'].includes(data.production.status);
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">BackOffice no envía cotizaciones: se aprueban aquí y el booker las envía por su cuenta; después se registra el envío. Los valores que no se conocen quedan pendientes y se ven como tales.</p>
      {canCreate && <Button onClick={() => create.mutate({})} disabled={create.isPending}>{data.quotes.length ? '+ Nueva versión (a partir de la última)' : '+ Crear cotización'}</Button>}
      {!data.quotes.length && !canCreate && <EmptyState title="Sin cotizaciones" hint="Se preparan cuando la producción está en «Propuesta en preparación»." />}
      {draft && can.has('quotes') && <QuoteEditor key={draft.id + data.production.version} q={q} quote={draft} data={data} />}
      {data.quotes.filter((x) => x !== draft || !can.has('quotes')).map((x) => (
        <Card key={x.id} kicker={`Versión ${x.version}`} title={QUOTE_STATUS_LABEL[x.status] ?? x.status}>
          {x.redacted ? <p className="text-sm text-ink-3">No tienes permiso para ver valores. {x.totals.complete ? 'Todos los valores están definidos.' : `${x.totals.pendingCount} valor(es) pendientes.`}</p> : <QuoteTable quote={x} />}
          {x.diff && (x.diff.added.length || x.diff.removed.length || x.diff.changed.length) ? (
            <p className="mt-2 text-xs text-ink-3">Cambios frente a la versión anterior: {x.diff.added.length} línea(s) nuevas, {x.diff.removed.length} quitadas, {x.diff.changed.length} modificadas{x.diff.changed.length ? ` (${x.diff.changed.map((c: any) => c.fields.join(', ')).join(' · ')})` : ''}.</p>
          ) : null}
          {x.decidedAt && <p className="mt-2 text-sm">{x.status === 'REJECTED' ? 'Rechazada' : 'Decidida'} por <b>{x.decidedByName}</b> el {fmtDate(x.decidedAt, true)}{x.decisionNote ? `: ${x.decisionNote}` : ''}</p>}
          {x.sentManuallyAt && <p className="mt-1 text-sm">Envío registrado el {fmtDate(x.sentManuallyAt, true)}: {x.sentManuallyNote}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {x.status === 'PENDING_APPROVAL' && can.has('approve') && (
              <>
                <Button size="sm" onClick={() => ask(`Aprobar la versión ${x.version}`, 'Aprobar', [{ key: 'note', label: 'Observaciones (opcional)', type: 'long' }], (v) => prodApi.post(q, `/quotes/${x.id}/decision`, { decision: 'APPROVE', note: v.note }))}>Aprobar</Button>
                <Button size="sm" variant="danger" onClick={() => ask(`Rechazar la versión ${x.version}`, 'Rechazar', [{ key: 'note', label: 'Por qué se rechaza', type: 'long', required: true }], (v) => prodApi.post(q, `/quotes/${x.id}/decision`, { decision: 'REJECT', note: v.note }))}>Rechazar</Button>
              </>
            )}
            {x.status === 'PENDING_APPROVAL' && !can.has('approve') && <span className="text-sm text-ink-3">Esperando a quien tenga permiso de aprobar.</span>}
            {x.status === 'APPROVED' && x.id === data.production.approvedQuoteId && data.production.status === 'COTIZACION_APROBADA' && can.has('quotes') && (
              <Button size="sm" variant="outline" onClick={() => ask('Registrar envío hecho por fuera de BackOffice', 'Registrar', [{ key: 'note', label: '¿Cómo y cuándo se envió?', type: 'long', required: true }], (v) => prodApi.post(q, `/quotes/${x.id}/mark-sent`, { note: v.note }))}>Registrar envío</Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

function QuoteTable({ quote }: { quote: any }) {
  const t = quote.totals;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead><tr className="border-b border-line text-left text-xs text-ink-3"><th className="py-1">Concepto</th><th>Cant.</th><th>Costo unit.</th><th>Precio unit.</th><th>Va en</th></tr></thead>
        <tbody>
          {quote.lines.map((l: any) => (
            <tr key={l.id} className="border-b border-line last:border-0">
              <td className="py-1"><b>{LINE_CATEGORY_LABEL[l.category]}</b> {l.description}{l.commission ? ` (${l.commission.percent ?? '?'} % sobre ${l.commission.base === 'PRICE' ? 'precio' : 'costo'} de ${l.commission.appliesTo.length} línea(s))` : ''}</td>
              <td>{l.quantity} {UNIT_LABEL[l.unit]}</td>
              <td>{l.category === 'COMMISSION' ? '—' : `${fmtMoney(l.unitCost, quote.currency)} · ${VALUE_STATUS_LABEL[l.costStatus]}`}</td>
              <td>{l.category === 'COMMISSION' ? 'Calculado' : `${fmtMoney(l.unitPrice, quote.currency)} · ${VALUE_STATUS_LABEL[l.priceStatus]}`}</td>
              <td>{BILLING_LABEL[l.billing]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 grid gap-1 text-sm sm:grid-cols-4">
        <span>Total al cliente: <b>{t.clientTotal === null ? 'Incompleto' : fmtMoney(t.clientTotal, quote.currency)}</b></span>
        <span>Costo: <b>{t.costTotal === null ? 'Incompleto' : fmtMoney(t.costTotal, quote.currency)}</b></span>
        <span>Margen: <b>{t.margin === null ? 'Sin calcular' : fmtMoney(t.margin, quote.currency)}</b></span>
        <span>Paga el cliente aparte: <b>{fmtMoney(t.clientDirect, quote.currency)}</b></span>
      </div>
      {t.pending?.length ? <ul className="mt-1 list-disc pl-5 text-xs text-warn">{t.pending.map((p: any, i: number) => <li key={i}>{p.what}</li>)}</ul> : null}
    </div>
  );
}

function QuoteEditor({ q, quote, data }: { q: string; quote: any; data: Detail }) {
  const [lines, setLines] = useState<any[]>(quote.lines.length ? quote.lines : [emptyLine()]);
  const [notes, setNotes] = useState(quote.notes ?? '');
  const save = useProdMutation(q, () => prodApi.put(q, `/quotes/${quote.id}`, { lines, notes }), 'Borrador guardado');
  const submit = useProdMutation(q, async () => { await prodApi.put(q, `/quotes/${quote.id}`, { lines, notes }); return prodApi.post(q, `/quotes/${quote.id}/submit`, {}); }, 'Enviada a aprobación interna');
  const upd = (i: number, patch: Record<string, unknown>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <Card kicker={`Versión ${quote.version} · borrador`} title="Editar cotización">
      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={l.id} className="grid gap-2 border-b border-line pb-3 sm:grid-cols-6">
            <Select aria-label="Categoría" value={l.category} onChange={(e) => upd(i, { category: e.target.value, commission: e.target.value === 'COMMISSION' ? { percent: null, base: 'PRICE', appliesTo: [] } : null })}>{Object.entries(LINE_CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Input aria-label="Descripción" className="sm:col-span-2" placeholder="Descripción" value={l.description} onChange={(e) => upd(i, { description: e.target.value })} />
            <Input aria-label="Cantidad" type="number" min={0} step="0.5" value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} />
            <Select aria-label="Unidad" value={l.unit} onChange={(e) => upd(i, { unit: e.target.value })}>{Object.entries(UNIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            <Select aria-label="Va en el total" value={l.billing} onChange={(e) => upd(i, { billing: e.target.value })}>{Object.entries(BILLING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
            {l.category === 'COMMISSION' ? (
              <div className="grid gap-2 sm:col-span-6 sm:grid-cols-3">
                <Input aria-label="Porcentaje" type="number" min={0} max={100} placeholder="% (por confirmar)" value={l.commission?.percent ?? ''} onChange={(e) => upd(i, { commission: { ...l.commission, percent: num(e.target.value) } })} />
                <Select aria-label="Base" value={l.commission?.base ?? 'PRICE'} onChange={(e) => upd(i, { commission: { ...l.commission, base: e.target.value } })}><option value="PRICE">Sobre el precio al cliente</option><option value="COST">Sobre el costo del proveedor</option></Select>
                <div className="flex flex-wrap gap-2 text-xs">
                  {lines.filter((x) => x.category !== 'COMMISSION').map((x) => (
                    <label key={x.id} className="flex items-center gap-1"><input type="checkbox" checked={l.commission?.appliesTo?.includes(x.id) ?? false} onChange={(e) => upd(i, { commission: { ...l.commission, appliesTo: e.target.checked ? [...(l.commission?.appliesTo ?? []), x.id] : (l.commission?.appliesTo ?? []).filter((y: string) => y !== x.id) } })} />{x.description || LINE_CATEGORY_LABEL[x.category]}</label>
                  ))}
                </div>
                <p className="text-xs text-ink-3 sm:col-span-3">La regla de comisión de LPulpo está pendiente de confirmar: elige porcentaje, base y líneas a mano en cada cotización.</p>
              </div>
            ) : (
              <>
                <Input aria-label="Costo unitario" type="number" min={0} placeholder="Costo (vacío = pendiente)" value={l.unitCost ?? ''} onChange={(e) => upd(i, { unitCost: num(e.target.value) })} />
                <Select aria-label="Estado del costo" value={l.costStatus} onChange={(e) => upd(i, { costStatus: e.target.value })}>{Object.entries(VALUE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
                <Input aria-label="Precio unitario" type="number" min={0} placeholder="Precio (vacío = pendiente)" value={l.unitPrice ?? ''} onChange={(e) => upd(i, { unitPrice: num(e.target.value) })} />
                <Select aria-label="Estado del precio" value={l.priceStatus} onChange={(e) => upd(i, { priceStatus: e.target.value })}>{Object.entries(VALUE_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
                <Input aria-label="Notas de la línea" className="sm:col-span-1" placeholder="Notas" value={l.notes ?? ''} onChange={(e) => upd(i, { notes: e.target.value })} />
                <Button type="button" size="sm" variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Quitar</Button>
              </>
            )}
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={() => setLines([...lines, emptyLine()])}>+ Línea</Button>
        <Field label="Notas de la cotización"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <QuoteTable quote={quote} />
        <p className="text-xs text-ink-3">Los totales de arriba son los guardados; guarda para recalcular.{data.missing.toQuote.length ? ` Para enviar a aprobación falta en el brief: ${data.missing.toQuote.map((m) => m.label).join(', ')}.` : ''}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => save.mutate(undefined)} disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar borrador'}</Button>
          <Button onClick={() => submit.mutate(undefined)} disabled={submit.isPending}>{submit.isPending ? 'Enviando…' : 'Enviar a aprobación interna'}</Button>
        </div>
      </div>
    </Card>
  );
}

/* ── Tareas ── */
function TasksTab({ q, data, users }: { q: string; data: Detail; users: TeamResponse['users'] }) {
  const can = new Set(data.permissions);
  const [f, setF] = useState({ title: '', assigneeId: '', dueAt: '', dependsOn: [] as string[] });
  const create = useProdMutation(q, () => prodApi.post(q, `/${data.production.id}/tasks`, { ...f, assigneeId: f.assigneeId || undefined, dueAt: fromLocalInput(f.dueAt) }), 'Tarea creada');
  const upd = useProdMutation(q, (b: { id: string } & Record<string, unknown>) => prodApi.patch(q, `/tasks/${b.id}`, b));
  return (
    <div className="space-y-4">
      {data.tasks.length === 0 ? <EmptyState title="Sin tareas" /> : (
        <div className="overflow-x-auto border-2 border-ink bg-paper">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="border-b-2 border-ink text-left text-xs uppercase text-ink-3"><th className="px-3 py-2">Tarea</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Responsable</th><th className="px-3 py-2">Vence</th><th className="px-3 py-2">Origen</th></tr></thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">{t.title}{t.dependsOn.length ? <span className="block text-xs text-ink-3">Depende de: {t.dependsOn.map((d: string) => data.tasks.find((x) => x.id === d)?.title).join(', ')}</span> : null}</td>
                  <td className="px-3 py-2">
                    <Select aria-label="Estado de la tarea" value={t.status} disabled={!can.has('edit')} onChange={(e) => upd.mutate({ id: t.id, status: e.target.value })}>{Object.entries(TASK_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
                  </td>
                  <td className="px-3 py-2">
                    <Select aria-label="Responsable de la tarea" value={t.assigneeId ?? ''} disabled={!can.has('assign')} onChange={(e) => upd.mutate({ id: t.id, assigneeId: e.target.value || null })}><option value="">Sin asignar</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
                  </td>
                  <td className={`px-3 py-2 ${t.overdue ? 'font-semibold text-bad' : ''}`}>{fmtDate(t.dueAt, true)}{t.overdue ? ' · vencida' : ''}</td>
                  <td className="px-3 py-2 text-xs">{t.origin === 'RULE' ? <span title={t.reason}>Regla: {t.reason}</span> : t.origin === 'MANUAL' ? 'Manual' : 'Integración'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can.has('edit') && (
        <Card kicker="Nueva" title="Tarea manual">
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); setF({ title: '', assigneeId: '', dueAt: '', dependsOn: [] }); }}>
            <Field label="Título" required><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Responsable"><Select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })} disabled={!can.has('assign')}><option value="">Sin asignar</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field>
            <Field label="Fecha límite"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
            <Field label="Depende de"><Select value="" onChange={(e) => e.target.value && setF({ ...f, dependsOn: [...new Set([...f.dependsOn, e.target.value])] })}><option value="">{f.dependsOn.length ? `${f.dependsOn.length} seleccionada(s)` : 'Ninguna'}</option>{data.tasks.filter((t) => !['DONE', 'CANCELLED'].includes(t.status)).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select></Field>
            <div className="sm:col-span-4"><Button type="submit" disabled={!f.title.trim() || create.isPending}>Crear tarea</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

/* ── Historial (solo lectura) ── */
function HistoryTab({ data }: { data: Detail }) {
  const ACTOR: Record<string, string> = { USER: 'Persona', SYSTEM: 'Sistema', AI: 'IA', INTEGRATION: 'Integración' };
  return data.events.length === 0 ? <EmptyState title="Sin historial" /> : (
    <ol className="space-y-2">
      {data.events.map((e) => (
        <li key={e.id} className={`border-l-4 bg-paper px-3 py-2 ${e.type === 'engine_error' ? 'border-bad' : e.type === 'approval' ? 'border-ok' : 'border-ink'}`}>
          <p className="text-sm">{e.summary}</p>
          <p className="text-xs text-ink-3">{fmtDate(e.createdAt, true)} · {ACTOR[e.actorType] ?? e.actorType}: {e.actorName}</p>
        </li>
      ))}
    </ol>
  );
}

/* ── Incidencias ── */
function IssuesTab({ q, data, ask }: { q: string; data: Detail; ask: Ask }) {
  const can = new Set(data.permissions);
  const [f, setF] = useState({ kind: '', severity: 'MEDIUM', description: '' });
  const create = useProdMutation(q, () => prodApi.post(q, `/${data.production.id}/issues`, f), 'Incidencia registrada');
  return (
    <div className="space-y-4">
      {data.issues.length === 0 ? <EmptyState title="Sin incidencias" /> : data.issues.map((i) => (
        <div key={i.id} className={`border-2 p-3 ${i.status === 'OPEN' ? 'border-bad bg-bad-soft' : 'border-line bg-paper'}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm"><b>{i.kind}</b> · {i.description}</p>
            <Badge tone={i.status === 'OPEN' ? 'bad' : 'ok'}>{i.status === 'OPEN' ? `Abierta · ${i.severity === 'HIGH' ? 'alta' : i.severity === 'LOW' ? 'baja' : 'media'}` : 'Resuelta'}</Badge>
          </div>
          {i.resolution && <p className="mt-1 text-xs">Resolución: {i.resolution}</p>}
          {i.status === 'OPEN' && can.has('edit') && <Button className="mt-2" size="sm" variant="outline" onClick={() => ask('Resolver incidencia', 'Resolver', [{ key: 'resolution', label: '¿Cómo se resolvió?', type: 'long', required: true }], (v) => prodApi.post(q, `/issues/${i.id}/resolve`, v))}>Resolver</Button>}
        </div>
      ))}
      {can.has('edit') && (
        <Card kicker="Nueva" title="Registrar incidencia">
          <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); setF({ kind: '', severity: 'MEDIUM', description: '' }); }}>
            <Field label="Tipo"><Input value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} placeholder="Ej.: cambio de fecha" /></Field>
            <Field label="Severidad"><Select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}><option value="LOW">Baja</option><option value="MEDIUM">Media</option><option value="HIGH">Alta</option></Select></Field>
            <div className="sm:col-span-2"><Field label="Descripción" required><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
            <div className="sm:col-span-4"><Button type="submit" disabled={!f.description.trim() || create.isPending}>Registrar</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

/* ── Archivos ── */
function FilesTab({ data }: { data: Detail }) {
  const ids = [...new Set(data.assignments.map((a) => a.resourceId).filter(Boolean))];
  const { ready, q } = useCompanyScope();
  const res = useQuery({ queryKey: ['production-resources', q], queryFn: () => prodApi.get<any[]>(q, '/resources'), enabled: ready });
  const refs = (res.data ?? []).filter((r) => ids.includes(r.id)).flatMap((r) => r.fileRefs.map((f: any) => ({ ...f, owner: r.name, kind: r.kind })));
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">Dropbox todavía no está conectado: aquí se ven las referencias registradas a mano en las fichas de los recursos de esta producción. BackOffice no descarga ni verifica estos archivos.</p>
      {refs.length === 0 ? <EmptyState title="Sin archivos referenciados" hint="Agrega rutas de Dropbox o enlaces en «Modelos y proveedores»." /> : (
        <ul className="divide-y divide-line border-2 border-ink bg-paper">
          {refs.map((f, i) => (
            <li key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span><b>{f.owner}</b> ({RESOURCE_KIND_LABEL[f.kind]}) · {f.label ?? 'Archivo'}</span>
              <span className="font-mono text-xs">{f.provider === 'URL' ? <a className="underline" href={f.ref} target="_blank" rel="noreferrer noopener">{f.ref}</a> : `${f.provider}: ${f.ref}`} · sin verificar</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
