import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '../../lib/api';
import { AUTOMATION_STATUS_LABELS, ORDER_STATUS_LABELS, RUN_STATUS_LABELS, timeAgo } from '../../lib/format';
import {
  Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/* ─── Tipos (espejo del API /automations) ─────────────────────────────── */

export interface CatalogField { key: string; label: string; type: 'string' | 'enum' | 'number' | 'tags' | 'bool'; options?: string[]; operators: string[] }
export interface Catalog {
  triggers: Array<{ type: string; label: string; record: 'contact' | 'order'; config: Record<string, { label: string; type: string; options?: string[] }>; fields: CatalogField[] }>;
  actions: Array<{ type: string; label: string; needs: 'contact' | 'order' | null; config: Record<string, { type: string; required: boolean }> }>;
  limits: { rules: number; actions: number; text: number; waitHours: number; runsPerHour: { default: number; max: number }; attempts: { default: number; max: number } };
  stages: Array<{ pipelineId: string | null; name: string; stages: Array<{ key: string; label: string }> }>;
  users: Array<{ id: string; name: string; role: string }>;
  courierAssignment: { via: 'legacy' | 'automation'; owner: 'legacy' | 'automation' } | null;
}
interface Rule { field: string; op: string; value?: string | number | string[] }
interface Action { type: string; config: Record<string, string | number> }
export interface DefinitionDraft {
  trigger?: { type: string; config?: Record<string, string> };
  conditions?: { match: 'all' | 'any'; rules: Rule[] };
  actions?: Action[];
  options?: { dedupe?: 'per_event' | 'once_per_record'; maxRunsPerHour?: number; maxAttempts?: number };
}
export interface AutomationRow {
  id: string; name: string; description: string | null; status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  triggerType: string | null; version: number; legacy: boolean; legacyTrigger: string | null;
  definition: DefinitionDraft; validation: { valid: boolean; errors: string[] };
  stats?: { runs30d: number; failed30d: number; lastRun: { id: string; status: string; createdAt: string } | null };
}
export interface RunRow {
  id: string; automationId: string; automationName: string | null; automationVersion: number | null; status: string;
  triggerType: string; sourceType: string; sourceId: string; attempts: number; maxAttempts: number;
  createdAt: string; startedAt: string | null; finishedAt: string | null; nextRetryAt: string | null;
  error: { message: string; attempt: number | null } | null; stepsDone: number;
  eventId?: string; depth?: number;
  steps?: Array<{ index: number; type: string; status: string; at: string; output?: Record<string, unknown>; error?: string; resumeAt?: string }>;
  conditions?: Array<{ field: string; op: string; passed: boolean }>;
}

const OP_LABELS: Record<string, string> = {
  eq: 'es igual a', neq: 'es diferente de', contains: 'contiene', not_contains: 'no contiene', exists: 'tiene un valor', not_exists: 'está vacío',
  in: 'es alguno de', gt: 'es mayor que', gte: 'es mayor o igual a', lt: 'es menor que', lte: 'es menor o igual a', is_true: 'sí', is_false: 'no',
};
const NO_VALUE = new Set(['exists', 'not_exists', 'is_true', 'is_false']);
const runTone = (s: string) => (s === 'COMPLETED' ? 'ok' : s === 'FAILED' ? 'bad' : s === 'CANCELLED' ? 'neutral' : s === 'RUNNING' ? 'info' : 'warn');
const optionLabel = (v: string) => ORDER_STATUS_LABELS[v] ?? v;
const errorsOf = (e: unknown) => (e instanceof ApiError && e.errors?.length ? e.errors : [e instanceof Error ? e.message : 'Error']);

const emptyDraft = (): DefinitionDraft => ({ trigger: { type: '', config: {} }, conditions: { match: 'all', rules: [] }, actions: [], options: {} });

export default function Automations() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const [tab, setTab] = useState<'list' | 'runs'>('list');
  const [editing, setEditing] = useState<{ id?: string; status?: AutomationRow['status']; name: string; description: string; definition: DefinitionDraft } | null>(null);
  const [runsFor, setRunsFor] = useState<string>('');

  const catalog = useQuery({ queryKey: ['automations-catalog', q], queryFn: () => api.get<Catalog>(withScope('/automations/catalog', q)), enabled: ready });
  const list = useQuery({ queryKey: ['automations', q], queryFn: () => api.get<AutomationRow[]>(withScope('/automations', q)), enabled: ready });

  if (!ready) return <PickCompany />;
  if (list.isLoading || catalog.isLoading) return <Loading />;
  const cat = catalog.data;

  return (
    <>
      <PageHeader
        kicker="Flujos y reglas"
        title="Automatizaciones"
        actions={canWrite && cat ? <Button onClick={() => setEditing({ name: '', description: '', definition: emptyDraft() })}>+ Nueva automatización</Button> : undefined}
      />
      <Tabs tabs={[{ id: 'list', label: 'Automatizaciones' }, { id: 'runs', label: 'Historial de ejecuciones' }]} active={tab} onChange={(t) => setTab(t as 'list' | 'runs')} />
      <div className="mt-4">
        {tab === 'list' ? (
          <AutomationList
            rows={list.data ?? []} catalog={cat} canWrite={canWrite} q={q}
            onEdit={(a) => setEditing({ id: a.id, status: a.status, name: a.name, description: a.description ?? '', definition: { ...emptyDraft(), ...a.definition } })}
            onHistory={(id) => { setRunsFor(id); setTab('runs'); }}
            onCreate={() => setEditing({ name: '', description: '', definition: emptyDraft() })}
          />
        ) : (
          <RunHistory q={q} canWrite={canWrite} automations={list.data ?? []} automationId={runsFor} onAutomation={setRunsFor} />
        )}
      </div>
      {cat?.courierAssignment && tab === 'list' && <CourierMigration q={q} companyId={companyId} canWrite={canWrite} state={cat.courierAssignment} />}
      {editing && cat && <Builder catalog={cat} q={q} companyId={companyId} initial={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/* ─── Lista ──────────────────────────────────────────────────────────── */

function AutomationList({ rows, catalog, canWrite, q, onEdit, onHistory, onCreate }: {
  rows: AutomationRow[]; catalog?: Catalog; canWrite: boolean; q: string;
  onEdit: (a: AutomationRow) => void; onHistory: (id: string) => void; onCreate: () => void;
}) {
  const queryClient = useQueryClient();
  const triggerLabel = (t: string | null) => catalog?.triggers.find((x) => x.type === t)?.label ?? '—';
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post<{ cancelledRuns?: number }>(withScope(`/automations/${id}/status`, q), { status }),
    onSuccess: (r, v) => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      queryClient.invalidateQueries({ queryKey: ['automations-catalog'] });
      toast.success(`${AUTOMATION_STATUS_LABELS[v.status]}${r.cancelledRuns ? ` · ${r.cancelledRuns} ejecución(es) pendiente(s) cancelada(s)` : ''}`);
    },
    onError: (e) => toast.error(errorsOf(e).join(' · ')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(withScope(`/automations/${id}`, q)),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['automations'] }); toast.success('Borrador eliminado'); },
    onError: (e) => toast.error(errorsOf(e).join(' · ')),
  });

  if (!rows.length) {
    return (
      <EmptyState
        title="Nada automatizado todavía"
        hint="Elige un evento (contacto nuevo, cambio de etapa, estado de pedido), pon condiciones y las acciones internas que deben ocurrir."
        action={canWrite ? <Button onClick={onCreate}>Crear la primera</Button> : undefined}
      />
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {rows.map((a) => (
        <Card key={a.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(a.status)}>{AUTOMATION_STATUS_LABELS[a.status] ?? a.status}</Badge>
            {a.version > 0 && <Badge tone="neutral">v{a.version}</Badge>}
            {a.legacy && <Badge tone="warn">Anterior · sin motor</Badge>}
            {!a.legacy && a.status === 'DRAFT' && !a.validation.valid && <Badge tone="warn">Incompleta</Badge>}
          </div>
          <h3 className="display mt-2 text-xl">{a.name}</h3>
          {a.description && <p className="mt-1 text-sm text-ink-2">{a.description}</p>}
          <p className="mt-2 text-xs text-ink-3">
            {a.legacy
              ? <>Descripción anterior: «{a.legacyTrigger ?? 'sin disparador'}». No se ejecuta hasta configurarla con el constructor.</>
              : <>Disparador: <b>{triggerLabel(a.triggerType ?? a.definition.trigger?.type ?? null)}</b></>}
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2 border-t-2 border-line pt-3 text-center">
            <div><p className="kicker">Ejecuciones 30 d</p><p className="display text-lg">{a.stats?.runs30d ?? 0}</p></div>
            <div><p className="kicker">Fallidas 30 d</p><p className={`display text-lg ${a.stats?.failed30d ? 'text-bad' : ''}`}>{a.stats?.failed30d ?? 0}</p></div>
            <div>
              <p className="kicker">Última</p>
              {a.stats?.lastRun
                ? <p className="mt-1 text-xs"><Badge tone={runTone(a.stats.lastRun.status)}>{RUN_STATUS_LABELS[a.stats.lastRun.status] ?? a.stats.lastRun.status}</Badge> <span className="block text-ink-3">{timeAgo(a.stats.lastRun.createdAt)}</span></p>
                : <p className="mt-1 text-xs text-ink-3">Nunca</p>}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">Datos reales del motor (no incluye cifras de demostración).</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {canWrite && a.status !== 'ARCHIVED' && <Button size="sm" variant="outline" onClick={() => onEdit(a)}>Editar</Button>}
            {canWrite && (a.status === 'DRAFT' || a.status === 'PAUSED') && !a.legacy && (
              <Button size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: a.id, status: 'ACTIVE' })}>Activar</Button>
            )}
            {canWrite && a.status === 'ACTIVE' && <Button size="sm" variant="outline" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: a.id, status: 'PAUSED' })}>Pausar</Button>}
            {canWrite && a.status !== 'ARCHIVED' && <Button size="sm" variant="ghost" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: a.id, status: 'ARCHIVED' })}>Archivar</Button>}
            {canWrite && a.status === 'ARCHIVED' && <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: a.id, status: 'DRAFT' })}>Volver a borrador</Button>}
            {canWrite && a.status === 'DRAFT' && a.version === 0 && !a.stats?.runs30d && (
              <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(a.id)}>Eliminar</Button>
            )}
            {a.version > 0 && <Button size="sm" variant="ghost" onClick={() => onHistory(a.id)}>Historial</Button>}
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ─── Constructor ────────────────────────────────────────────────────── */

function Builder({ catalog, q, companyId, initial, onClose }: {
  catalog: Catalog; q: string; companyId: string | null;
  initial: { id?: string; status?: AutomationRow['status']; name: string; description: string; definition: DefinitionDraft };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [d, setD] = useState<DefinitionDraft>(initial.definition);
  const [errors, setErrors] = useState<string[]>([]);
  const [sim, setSim] = useState<null | { wouldRun: boolean; triggerMatches: boolean; conditions: { passed: boolean; results: Array<{ field: string; op: string; passed: boolean }> }; actions: Array<{ description: string }>; note: string }>(null);
  const [simRecord, setSimRecord] = useState('');
  const published = initial.status === 'ACTIVE' || initial.status === 'PAUSED';

  const trigger = catalog.triggers.find((t) => t.type === d.trigger?.type);
  const fields = trigger?.fields ?? [];
  const actionsAvailable = catalog.actions.filter((a) => a.needs !== 'order' || trigger?.record === 'order');
  const stageOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of catalog.stages) for (const s of p.stages) if (!seen.has(s.key)) seen.set(s.key, `${s.label}${catalog.stages.length > 1 ? ` (${p.name})` : ''}`);
    return [...seen.entries()];
  }, [catalog.stages]);
  const rules = d.conditions?.rules ?? [];
  const actions = d.actions ?? [];
  const setRules = (next: Rule[]) => setD({ ...d, conditions: { match: d.conditions?.match ?? 'all', rules: next } });
  const setActions = (next: Action[]) => setD({ ...d, actions: next });

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, definition: d };
      return initial.id
        ? api.patch<AutomationRow>(withScope(`/automations/${initial.id}`, q), body)
        : api.post<AutomationRow>('/automations', { ...body, ...(companyId ? { companyId } : {}) });
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      setErrors(r.validation && !r.validation.valid ? r.validation.errors : []);
      toast.success(published ? 'Guardada: se publicó una versión nueva' : r.validation?.valid ? 'Borrador guardado (listo para activar)' : 'Borrador guardado; aún le falta para poder activarse');
      if (published || r.validation?.valid) onClose();
    },
    onError: (e) => setErrors(errorsOf(e)),
  });
  const simulate = useMutation({
    mutationFn: () => api.post<NonNullable<typeof sim>>('/automations/simulate', { definition: d, ...(simRecord.trim() ? { recordId: simRecord.trim() } : {}), ...(companyId ? { companyId } : {}) }),
    onSuccess: (r) => { setSim(r); setErrors([]); },
    onError: (e) => { setSim(null); setErrors(errorsOf(e)); },
  });

  return (
    <Modal open onClose={onClose} wide kicker={published ? `Editar · se publicará la versión siguiente` : 'Constructor'} title={initial.id ? `Editar «${initial.name}»` : 'Nueva automatización'}>
      <div className="space-y-5">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Nombre" required><Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Bienvenida a contactos nuevos" /></Field>
          <Field label="Descripción"><Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>

        <section>
          <p className="kicker mb-2">1 · Cuándo</p>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Disparador" required>
              <Select aria-label="Disparador" value={d.trigger?.type ?? ''} onChange={(e) => setD({ ...d, trigger: { type: e.target.value, config: {} }, conditions: { match: 'all', rules: [] }, actions: (d.actions ?? []).filter((a) => a.type !== 'assign_courier') })}>
                <option value="">Elige…</option>
                {catalog.triggers.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
              </Select>
            </Field>
            {trigger && Object.entries(trigger.config).map(([key, cfg]) => (
              <Field key={key} label={cfg.label}>
                <Select value={d.trigger?.config?.[key] ?? ''} onChange={(e) => setD({ ...d, trigger: { type: d.trigger!.type, config: { ...(d.trigger?.config ?? {}), [key]: e.target.value } } })}>
                  <option value="">Cualquiera</option>
                  {(cfg.options ?? stageOptions.map(([k]) => k)).map((o) => <option key={o} value={o}>{cfg.options ? optionLabel(o) : stageOptions.find(([k]) => k === o)?.[1]}</option>)}
                </Select>
              </Field>
            ))}
          </div>
        </section>

        {trigger && (
          <section>
            <div className="mb-2 flex items-center gap-2">
              <p className="kicker">2 · Solo si</p>
              <Select className="!w-auto" aria-label="Tipo de coincidencia" value={d.conditions?.match ?? 'all'} onChange={(e) => setD({ ...d, conditions: { match: e.target.value as 'all' | 'any', rules } })}>
                <option value="all">se cumplen todas</option>
                <option value="any">se cumple alguna</option>
              </Select>
            </div>
            {!rules.length && <p className="text-sm text-ink-3">Sin condiciones: corre con cada evento.</p>}
            <div className="space-y-2">
              {rules.map((r, i) => {
                const f = fields.find((x) => x.key === r.field);
                return (
                  <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                    <Select aria-label={`Campo ${i + 1}`} value={r.field} onChange={(e) => { const nf = fields.find((x) => x.key === e.target.value); setRules(rules.map((x, j) => (j === i ? { field: e.target.value, op: nf?.operators[0] ?? 'eq' } : x))); }}>
                      {fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </Select>
                    <Select aria-label={`Operador ${i + 1}`} value={r.op} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { field: x.field, op: e.target.value } : x)))}>
                      {(f?.operators ?? []).map((o) => <option key={o} value={o}>{OP_LABELS[o] ?? o}</option>)}
                    </Select>
                    {NO_VALUE.has(r.op) ? <span /> : f?.type === 'enum' ? (
                      <Select aria-label={`Valor ${i + 1}`} multiple={r.op === 'in'} value={r.op === 'in' ? (Array.isArray(r.value) ? r.value : []) : String(r.value ?? '')}
                        onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: r.op === 'in' ? [...e.target.selectedOptions].map((o) => o.value) : e.target.value } : x)))}>
                        {r.op !== 'in' && <option value="">Elige…</option>}
                        {(f.options ?? []).map((o) => <option key={o} value={o}>{optionLabel(o)}</option>)}
                      </Select>
                    ) : (
                      <Input aria-label={`Valor ${i + 1}`} type={f?.type === 'number' ? 'number' : 'text'} maxLength={100} value={String(r.value ?? '')}
                        onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: f?.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value } : x)))} />
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Quitar</Button>
                  </div>
                );
              })}
            </div>
            {rules.length < catalog.limits.rules && fields.length > 0 && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setRules([...rules, { field: fields[0].key, op: fields[0].operators[0] }])}>+ Condición</Button>
            )}
          </section>
        )}

        {trigger && (
          <section>
            <p className="kicker mb-2">3 · Entonces (en este orden)</p>
            <p className="mb-2 text-xs text-ink-3">Solo acciones internas de BackOffice: no se envían mensajes, correos ni cobros.</p>
            <div className="space-y-2">
              {actions.map((a, i) => (
                <div key={i} className="border-2 border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="display text-lg">{i + 1}</span>
                    <Select className="!w-auto" aria-label={`Acción ${i + 1}`} value={a.type} onChange={(e) => setActions(actions.map((x, j) => (j === i ? { type: e.target.value, config: {} } : x)))}>
                      {actionsAvailable.map((x) => <option key={x.type} value={x.type}>{x.label}</option>)}
                    </Select>
                    <span className="flex-1" />
                    <Button size="sm" variant="ghost" disabled={i === 0} aria-label={`Subir acción ${i + 1}`} onClick={() => { const n = [...actions]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setActions(n); }}>↑</Button>
                    <Button size="sm" variant="ghost" disabled={i === actions.length - 1} aria-label={`Bajar acción ${i + 1}`} onClick={() => { const n = [...actions]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setActions(n); }}>↓</Button>
                    <Button size="sm" variant="ghost" onClick={() => setActions(actions.filter((_, j) => j !== i))}>Quitar</Button>
                  </div>
                  <ActionConfig action={a} catalog={catalog} stageOptions={stageOptions} onChange={(config) => setActions(actions.map((x, j) => (j === i ? { ...x, config } : x)))} />
                </div>
              ))}
            </div>
            {actions.length < catalog.limits.actions && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => setActions([...actions, { type: actionsAvailable[0].type, config: {} }])}>+ Acción</Button>
            )}
          </section>
        )}

        {trigger && (
          <section>
            <p className="kicker mb-2">Opciones</p>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Repeticiones">
                <Select value={d.options?.dedupe ?? 'per_event'} onChange={(e) => setD({ ...d, options: { ...d.options, dedupe: e.target.value as 'per_event' | 'once_per_record' } })}>
                  <option value="per_event">Una vez por evento</option>
                  <option value="once_per_record">Una sola vez por {trigger.record === 'order' ? 'pedido' : 'contacto'}</option>
                </Select>
              </Field>
              <Field label="Máximo por hora" hint={`1 a ${catalog.limits.runsPerHour.max}`}>
                <Input type="number" min={1} max={catalog.limits.runsPerHour.max} value={d.options?.maxRunsPerHour ?? catalog.limits.runsPerHour.default} onChange={(e) => setD({ ...d, options: { ...d.options, maxRunsPerHour: Number(e.target.value) } })} />
              </Field>
              <Field label="Intentos si falla" hint={`1 a ${catalog.limits.attempts.max}`}>
                <Input type="number" min={1} max={catalog.limits.attempts.max} value={d.options?.maxAttempts ?? catalog.limits.attempts.default} onChange={(e) => setD({ ...d, options: { ...d.options, maxAttempts: Number(e.target.value) } })} />
              </Field>
            </div>
          </section>
        )}

        {errors.length > 0 && (
          <div role="alert" className="border-2 border-bad bg-bad-soft p-3 text-sm text-bad">
            <p className="font-semibold">Revisa esto antes de {published ? 'guardar' : 'activar'}:</p>
            <ul className="mt-1 list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}

        {trigger && (
          <section className="border-2 border-dashed border-line p-3">
            <p className="kicker">Probar · simulación</p>
            <p className="mt-1 text-xs text-ink-3">Evalúa disparador y condiciones contra un {trigger.record === 'order' ? 'pedido' : 'contacto'} real de tu empresa (solo lectura). No ejecuta acciones ni crea historial.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Input className="!w-auto flex-1" aria-label="Id del registro" placeholder={`Id del ${trigger.record === 'order' ? 'pedido' : 'contacto'}`} value={simRecord} onChange={(e) => setSimRecord(e.target.value)} />
              <Button size="sm" variant="outline" disabled={simulate.isPending || !simRecord.trim()} onClick={() => simulate.mutate()}>Simular</Button>
            </div>
            {sim && (
              <div className="mt-3 text-sm" data-testid="simulation">
                <Badge tone="info">Simulación</Badge>{' '}
                <b>{sim.wouldRun ? 'Se ejecutaría' : 'No se ejecutaría'}</b>
                {!sim.triggerMatches && <span className="text-ink-3"> · no cumple el filtro del disparador</span>}
                <ul className="mt-1 space-y-0.5 text-xs">
                  {sim.conditions.results.map((r, i) => <li key={i}>{r.passed ? '✓' : '✗'} {fields.find((f) => f.key === r.field)?.label ?? r.field} {OP_LABELS[r.op] ?? r.op}</li>)}
                </ul>
                {sim.wouldRun && <ol className="mt-1 list-decimal pl-5 text-xs">{sim.actions.map((a, i) => <li key={i}>{a.description}</li>)}</ol>}
                <p className="mt-1 text-xs text-ink-3">{sim.note}</p>
              </div>
            )}
          </section>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={save.isPending || name.trim().length < 2} onClick={() => save.mutate()}>
            {save.isPending ? 'Guardando…' : published ? 'Guardar y publicar versión' : 'Guardar borrador'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ActionConfig({ action, catalog, stageOptions, onChange }: { action: Action; catalog: Catalog; stageOptions: Array<[string, string]>; onChange: (c: Action['config']) => void }) {
  const c = action.config;
  const set = (k: string, v: string | number) => onChange({ ...c, [k]: v });
  const num = (v: string) => (v === '' ? '' : Number(v));
  switch (action.type) {
    case 'create_follow_up':
      return (
        <div className="mt-2 grid gap-2 md:grid-cols-[1fr_160px]">
          <Field label="Nota" hint="Puedes usar {{contact.name}}"><Textarea rows={2} maxLength={catalog.limits.text} value={String(c.note ?? '')} onChange={(e) => set('note', e.target.value)} /></Field>
          <Field label="Vence en (horas)"><Input type="number" min={0} max={catalog.limits.waitHours} value={String(c.dueInHours ?? '')} onChange={(e) => set('dueInHours', num(e.target.value))} /></Field>
        </div>
      );
    case 'add_tag':
    case 'remove_tag':
      return <div className="mt-2"><Field label="Etiqueta"><Input maxLength={40} value={String(c.tag ?? '')} onChange={(e) => set('tag', e.target.value)} /></Field></div>;
    case 'set_stage':
      return (
        <div className="mt-2"><Field label="Etapa">
          <Select value={String(c.stage ?? '')} onChange={(e) => set('stage', e.target.value)}>
            <option value="">Elige…</option>
            {stageOptions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </Select>
        </Field></div>
      );
    case 'assign_owner':
      return (
        <div className="mt-2"><Field label="Responsable">
          <Select value={String(c.userId ?? '')} onChange={(e) => set('userId', e.target.value)}>
            <option value="">Elige…</option>
            {catalog.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </Select>
        </Field></div>
      );
    case 'log_activity':
      return <div className="mt-2"><Field label="Texto" hint="Queda en el registro de actividad"><Input maxLength={catalog.limits.text} value={String(c.text ?? '')} onChange={(e) => set('text', e.target.value)} /></Field></div>;
    case 'wait':
      return <div className="mt-2"><Field label="Horas de espera" hint={`1 a ${catalog.limits.waitHours} (se revisa al menos cada 5 minutos)`}><Input type="number" min={1} max={catalog.limits.waitHours} value={String(c.hours ?? '')} onChange={(e) => set('hours', num(e.target.value))} /></Field></div>;
    case 'assign_courier':
      return <p className="mt-2 text-xs text-ink-3">Usa la misma regla que hoy (domiciliario en turno con menos pedidos activos). Solo asigna si activas la migración de abajo.</p>;
    default:
      return null;
  }
}

/* ─── Historial ──────────────────────────────────────────────────────── */

function RunHistory({ q, canWrite, automations, automationId, onAutomation }: { q: string; canWrite: boolean; automations: AutomationRow[]; automationId: string; onAutomation: (id: string) => void }) {
  const [status, setStatus] = useState('');
  const [pages, setPages] = useState<string[]>(['']);
  const [open, setOpen] = useState<string | null>(null);
  const filters = `${automationId ? `automationId=${encodeURIComponent(automationId)}&` : ''}${status ? `status=${status}&` : ''}limit=20`;
  const results = useQuery({
    queryKey: ['automation-runs', q, filters, pages],
    queryFn: async () => {
      const out: RunRow[] = [];
      let next: string | null = null;
      for (const before of pages) {
        const r = await api.get<{ items: RunRow[]; nextCursor: string | null }>(withScope(`/automations/runs?${filters}${before ? `&before=${encodeURIComponent(before)}` : ''}`, q));
        out.push(...r.items);
        next = r.nextCursor;
      }
      return { items: out, next };
    },
  });
  const reset = () => setPages(['']);

  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="!w-auto" aria-label="Filtrar por automatización" value={automationId} onChange={(e) => { onAutomation(e.target.value); reset(); }}>
          <option value="">Todas las automatizaciones</option>
          {automations.filter((a) => a.version > 0).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
        <Select className="!w-auto" aria-label="Filtrar por estado" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }}>
          <option value="">Todos los estados</option>
          {Object.entries(RUN_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>
      {results.isLoading ? <Loading /> : !results.data?.items.length ? (
        <EmptyState title="Sin ejecuciones" hint="Aquí aparece cada vez que una automatización activa se dispara: qué evento la originó, qué hizo y si falló." />
      ) : (
        <>
          <Table head={['Inicio', 'Automatización', 'Origen', 'Estado', 'Pasos', 'Intentos', '']}>
            {results.data.items.map((r) => (
              <tr key={r.id}>
                <td className="px-4 py-3 text-xs">{new Date(r.createdAt).toLocaleString('es-CO')}</td>
                <td className="px-4 py-3 text-sm">{r.automationName ?? '—'} <span className="text-xs text-ink-3">v{r.automationVersion}</span></td>
                <td className="px-4 py-3 text-xs">{r.sourceType === 'order' ? 'Pedido' : 'Contacto'} <span className="font-mono text-ink-3">{r.sourceId.slice(-6)}</span></td>
                <td className="px-4 py-3"><Badge tone={runTone(r.status)}>{RUN_STATUS_LABELS[r.status] ?? r.status}</Badge>{r.error && <span className="mt-1 block max-w-[220px] truncate text-xs text-bad" title={r.error.message}>{r.error.message}</span>}</td>
                <td className="px-4 py-3 text-sm">{r.stepsDone}</td>
                <td className="px-4 py-3 text-sm">{r.attempts}/{r.maxAttempts}</td>
                <td className="px-4 py-3 text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>Detalle</Button></td>
              </tr>
            ))}
          </Table>
          {results.data.next && <Button variant="outline" className="mt-3" onClick={() => setPages([...pages, results.data!.next!])}>Cargar más</Button>}
        </>
      )}
      {open && <RunDetail id={open} q={q} canWrite={canWrite} onClose={() => setOpen(null)} />}
    </>
  );
}

function RunDetail({ id, q, canWrite, onClose }: { id: string; q: string; canWrite: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const run = useQuery({ queryKey: ['automation-run', id, q], queryFn: () => api.get<RunRow>(withScope(`/automations/runs/${id}`, q)) });
  const cancel = useMutation({
    mutationFn: () => api.post(withScope(`/automations/runs/${id}/cancel`, q), {}),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['automation-run'] }); queryClient.invalidateQueries({ queryKey: ['automation-runs'] }); toast.success('Ejecución cancelada'); },
    onError: (e) => toast.error(errorsOf(e).join(' · ')),
  });
  const r = run.data;
  return (
    <Modal open onClose={onClose} wide kicker="Ejecución" title={r ? `${r.automationName ?? 'Automatización'} · v${r.automationVersion}` : 'Cargando…'}>
      {!r ? <Loading /> : (
        <div className="space-y-4 text-sm">
          <div className="grid gap-2 md:grid-cols-3">
            <p><span className="kicker block">Estado</span><Badge tone={runTone(r.status)}>{RUN_STATUS_LABELS[r.status] ?? r.status}</Badge></p>
            <p><span className="kicker block">Inicio / fin</span>{new Date(r.createdAt).toLocaleString('es-CO')}{r.finishedAt ? ` → ${new Date(r.finishedAt).toLocaleString('es-CO')}` : ''}</p>
            <p><span className="kicker block">Intentos</span>{r.attempts} de {r.maxAttempts}{r.nextRetryAt && (r.status === 'RETRYABLE' || r.status === 'WAITING') ? ` · sigue ${new Date(r.nextRetryAt).toLocaleString('es-CO')}` : ''}</p>
            <p><span className="kicker block">Origen</span>{r.sourceType === 'order' ? 'Pedido' : 'Contacto'} <span className="font-mono text-xs">{r.sourceId}</span></p>
            <p className="md:col-span-2"><span className="kicker block">Evento</span><span className="font-mono text-xs break-all">{r.eventId}</span>{(r.depth ?? 1) > 1 ? ` · encadenada (nivel ${r.depth})` : ''}</p>
          </div>
          {!!r.conditions?.length && (
            <div><p className="kicker mb-1">Condiciones al dispararse</p>
              <ul className="text-xs">{r.conditions.map((c, i) => <li key={i}>{c.passed ? '✓' : '✗'} {c.field} {OP_LABELS[c.op] ?? c.op}</li>)}</ul>
            </div>
          )}
          <div><p className="kicker mb-1">Acciones</p>
            {!r.steps?.length ? <p className="text-xs text-ink-3">Aún no empezó.</p> : (
              <ol className="space-y-1 text-xs">
                {r.steps.map((s) => (
                  <li key={s.index}><Badge tone={s.status === 'DONE' ? 'ok' : s.status === 'FAILED' ? 'bad' : 'warn'}>{s.status === 'DONE' ? 'Hecha' : s.status === 'FAILED' ? 'Falló' : 'Esperando'}</Badge> {s.index + 1}. {s.type}
                    {s.error && <span className="text-bad"> · {s.error}</span>}{s.resumeAt && <span className="text-ink-3"> · hasta {new Date(s.resumeAt).toLocaleString('es-CO')}</span>}</li>
                ))}
              </ol>
            )}
          </div>
          {r.error && <p className="border-2 border-bad bg-bad-soft p-2 text-xs text-bad">Último error: {r.error.message}</p>}
          {canWrite && ['PENDING', 'RETRYABLE', 'WAITING'].includes(r.status) && (
            <div className="flex justify-end"><Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancelar ejecución</Button></div>
          )}
        </div>
      )}
    </Modal>
  );
}

/* ─── Migración (asignación de domiciliarios) ────────────────────────── */

function CourierMigration({ q, companyId, canWrite, state }: { q: string; companyId: string | null; canWrite: boolean; state: NonNullable<Catalog['courierAssignment']> }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (via: 'legacy' | 'automation') => api.put<{ via: string; owner: string }>(withScope('/automations/migrations/courier-assignment', q), { via, ...(companyId ? { companyId } : {}) }),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['automations-catalog'] }); toast.success(r.owner === 'automation' ? 'Ahora asigna la automatización' : 'Asigna el proceso original'); },
    onError: (e) => toast.error(errorsOf(e).join(' · ')),
  });
  return (
    <Card className="mt-6">
      <p className="kicker">Migración · asignación automática de domiciliarios</p>
      <p className="mt-1 text-sm">
        Hoy la hace: <b>{state.owner === 'automation' ? 'una automatización de esta página' : 'el proceso original de pedidos'}</b>.
        {state.via === 'automation' && state.owner === 'legacy' && ' (Elegiste la automatización, pero no hay una activa que asigne: sigue el proceso original para no dejar pedidos sin domiciliario.)'}
      </p>
      <p className="mt-1 text-xs text-ink-3">Solo uno asigna a la vez y la asignación es condicional, así nunca hay doble asignación. Volver al proceso original es inmediato.</p>
      {canWrite && (
        <div className="mt-3">
          {state.via === 'automation'
            ? <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => change.mutate('legacy')}>Volver al proceso original</Button>
            : <Button size="sm" disabled={change.isPending} onClick={() => change.mutate('automation')}>Pasar a la automatización</Button>}
        </div>
      )}
    </Card>
  );
}
