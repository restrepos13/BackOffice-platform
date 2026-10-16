import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, LayoutGrid, List } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { CHANNEL_LABELS, STAGE_LABELS, timeAgo } from '../../lib/format';
import type { Contact, Pipeline, PipelineStage } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Switch, Table,
  Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

const DEFAULT_STAGES: PipelineStage[] = ['CURIOSO', 'POTENCIAL', 'CALIENTE', 'CLIENTE', 'DESCARTADO'].map((key) => ({
  key, label: STAGE_LABELS[key], kind: key === 'CLIENTE' ? 'WON' : key === 'DESCARTADO' ? 'LOST' : 'OPEN',
}));

function stageTone(stage?: PipelineStage): 'ok' | 'bad' | 'neutral' {
  return stage?.kind === 'WON' ? 'ok' : stage?.kind === 'LOST' ? 'bad' : 'neutral';
}

interface ContactForm {
  id?: string;
  name: string;
  phone: string;
  email: string;
  stage: string;
  channel: string;
  tags: string;
  notes: string;
  pipelineId: string;
  optOut: boolean;
}

const emptyForm: ContactForm = {
  name: '', phone: '', email: '', stage: '', channel: 'WHATSAPP', tags: '', notes: '', pipelineId: 'default', optOut: false,
};

const toForm = (c: Contact): ContactForm => ({
  id: c.id, name: c.name, phone: c.phone ?? '', email: c.email ?? '', stage: c.stage, channel: c.channel,
  tags: c.tags.join(', '), notes: c.notes ?? '', pipelineId: c.pipelineId ?? 'default', optOut: !!c.optOut,
});

export default function Contacts() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [view, setView] = useState<'lista' | 'tablero'>('lista');
  const [editing, setEditing] = useState<ContactForm | null>(null);
  const [pipelineId, setPipelineId] = useState('default');
  const [editingPipeline, setEditingPipeline] = useState<Partial<Pipeline> | null>(null);

  const { data: pipelines } = useQuery({
    queryKey: ['pipelines', q],
    queryFn: () => api.get<Pipeline[]>(withScope('/pipelines', q)),
    enabled: ready,
  });
  const pipeline = pipelines?.find((p) => p.id === pipelineId);
  const STAGES = pipeline?.stages ?? DEFAULT_STAGES;
  const stagesFor = (id: string) => pipelines?.find((p) => p.id === id)?.stages ?? DEFAULT_STAGES;
  const labelOf = useMemo(() => {
    const map = new Map<string, PipelineStage>();
    (pipelines ?? []).forEach((p) => p.stages.forEach((st) => map.set(st.key, st)));
    DEFAULT_STAGES.forEach((st) => map.has(st.key) || map.set(st.key, st));
    return map;
  }, [pipelines]);

  const path = withScope(
    `/contacts?pipelineId=${pipelineId}${stage ? `&stage=${stage}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    q,
  );
  const { data: contacts, isLoading } = useQuery({
    queryKey: ['contacts', path],
    queryFn: () => api.get<Contact[]>(path),
    enabled: ready,
  });

  const save = useMutation({
    mutationFn: (form: ContactForm) => {
      const payload = {
        name: form.name, phone: form.phone || undefined,
        email: form.email || undefined, stage: form.stage, channel: form.channel,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        notes: form.notes || undefined,
        pipelineId: form.pipelineId,
        optOut: form.optOut,
        ...(companyId ? { companyId } : {}),
      };
      return form.id
        ? api.patch(`/contacts/${form.id}`, payload)
        : api.post('/contacts', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast.success('Contacto guardado');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const changeStage = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) =>
      api.patch(`/contacts/${id}`, { stage }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contacts'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;

  const counts = STAGES.map((s) => ({
    stage: s.key,
    label: s.label,
    count: contacts?.filter((c) => c.stage === s.key).length ?? 0,
  }));

  /** "Tu base de datos de clientes, 100% tuya" — exportación a CSV. */
  function exportCsv() {
    const rows = contacts ?? [];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      ['Nombre', 'Teléfono', 'Correo', 'Etapa', 'Canal', 'Etiquetas', 'Notas', 'Última actividad', 'Creado'].join(';'),
      ...rows.map((c) =>
        [
          esc(c.name), esc(c.phone), esc(c.email), esc(labelOf.get(c.stage)?.label ?? c.stage),
          esc(CHANNEL_LABELS[c.channel] ?? c.channel), esc(c.tags.join(', ')),
          esc(c.notes), esc(new Date(c.lastActivityAt).toLocaleString('es-CO')),
          esc(new Date(c.createdAt).toLocaleString('es-CO')),
        ].join(';'),
      ),
    ].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contactos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${rows.length} contactos exportados — la base es tuya`);
  }

  return (
    <>
      <PageHeader
        kicker="CRM · tu base de datos, 100% tuya"
        title="Contactos"
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} disabled={!contacts?.length}>
              <Download size={13} /> Exportar CSV
            </Button>
            {canWrite && (
              <Button onClick={() => setEditing({ ...emptyForm, pipelineId, stage: STAGES[0].key })}>+ Nuevo contacto</Button>
            )}
          </>
        }
      />

      {/* Pipeline resumido */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="kicker">Embudo</span>
        <Select
          value={pipelineId}
          onChange={(e) => { setPipelineId(e.target.value); setStage(''); }}
          className="!w-auto !py-1.5 text-sm"
          aria-label="Embudo"
        >
          {(pipelines ?? [{ id: 'default', name: 'Embudo estándar' } as Pipeline]).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </Select>
        {canWrite && (
          <>
            {pipeline && !pipeline.builtIn && (
              <Button size="sm" variant="ghost" onClick={() => setEditingPipeline(pipeline)}>Editar embudo</Button>
            )}
            <Button
              size="sm" variant="ghost"
              onClick={() => setEditingPipeline({
                name: '', isDefault: false,
                stages: [
                  { key: '', label: 'Nuevo', kind: 'OPEN' }, { key: '', label: 'En proceso', kind: 'OPEN' },
                  { key: '', label: 'Ganado', kind: 'WON' }, { key: '', label: 'Perdido', kind: 'LOST' },
                ],
              })}
            >
              + Nuevo embudo
            </Button>
          </>
        )}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        {counts.map(({ stage: s, label, count }) => (
          <button
            key={s}
            onClick={() => setStage(stage === s ? '' : s)}
            className={`cursor-pointer border-2 px-3 py-2 text-left transition-colors ${
              stage === s ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper hover:bg-bone-2'
            }`}
          >
            <p className="kicker" style={stage === s ? { color: '#c3bbb2' } : undefined}>
              {label}
            </p>
            <p className="display text-2xl">{count}</p>
          </button>
        ))}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          placeholder="Buscar por nombre, teléfono o correo…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex border-2 border-ink" role="group" aria-label="Vista">
          <button
            className={`flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] ${view === 'lista' ? 'bg-ink text-bone' : 'bg-paper hover:bg-bone-2'}`}
            onClick={() => setView('lista')}
          >
            <List size={13} /> Lista
          </button>
          <button
            className={`flex cursor-pointer items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] ${view === 'tablero' ? 'bg-ink text-bone' : 'bg-paper hover:bg-bone-2'}`}
            onClick={() => setView('tablero')}
          >
            <LayoutGrid size={13} /> Tablero
          </button>
        </div>
      </div>

      {isLoading ? (
        <Loading />
      ) : view === 'tablero' ? (
        /* ─── Vista tablero: el embudo como kanban ─── */
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {STAGES.map((st, stageIndex) => {
            const items = (contacts ?? []).filter((c) => c.stage === st.key);
            return (
              <div key={st.key} className="border-2 border-ink bg-bone-2">
                <div className="flex items-center justify-between border-b-2 border-ink bg-paper px-3 py-2">
                  <p className="kicker">{st.label}</p>
                  <span className="display text-lg">{items.length}</span>
                </div>
                <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2">
                  {items.map((contact) => (
                    <div key={contact.id} className="border-2 border-ink bg-paper p-2.5">
                      <button
                        className="block w-full cursor-pointer text-left"
                        onClick={() => canWrite && setEditing(toForm(contact))}
                      >
                        <p className="truncate text-sm font-semibold">{contact.name}{contact.optOut && <span className="ml-1.5 text-[10px] font-bold uppercase text-bad">baja</span>}</p>
                        <p className="truncate text-[11px] text-ink-3">
                          {contact.phone ?? contact.email ?? '—'} · {timeAgo(contact.lastActivityAt)}
                        </p>
                        {contact.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {contact.tags.slice(0, 2).map((tag) => <Badge key={tag}>{tag}</Badge>)}
                          </div>
                        )}
                      </button>
                      {canWrite && (
                        <div className="mt-1.5 flex justify-between border-t border-line pt-1.5">
                          <button
                            className="cursor-pointer p-0.5 text-ink-3 hover:text-ink disabled:opacity-30"
                            disabled={stageIndex === 0}
                            aria-label="Mover a etapa anterior"
                            onClick={() => changeStage.mutate({ id: contact.id, stage: STAGES[stageIndex - 1].key })}
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <button
                            className="cursor-pointer p-0.5 text-ink-3 hover:text-ink disabled:opacity-30"
                            disabled={stageIndex === STAGES.length - 1}
                            aria-label="Mover a etapa siguiente"
                            onClick={() => changeStage.mutate({ id: contact.id, stage: STAGES[stageIndex + 1].key })}
                          >
                            <ChevronRight size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {items.length === 0 && (
                    <p className="py-4 text-center text-xs text-ink-3">Vacío</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Table head={['Contacto', 'Canal', 'Etapa', 'Etiquetas', 'Última actividad', canWrite ? '' : ' ']}>
          {contacts?.map((contact) => (
            <tr key={contact.id}>
              <td className="px-4 py-3">
                <p className="flex items-center gap-2 font-semibold">
                  {contact.name}
                  {contact.optOut && <Badge tone="bad">No escribir</Badge>}
                </p>
                <p className="text-xs text-ink-3">
                  {[contact.phone, contact.email].filter(Boolean).join(' · ') || '—'}
                </p>
              </td>
              <td className="px-4 py-3 text-sm">{CHANNEL_LABELS[contact.channel] ?? contact.channel}</td>
              <td className="px-4 py-3">
                {canWrite ? (
                  <Select
                    value={contact.stage}
                    onChange={(e) => changeStage.mutate({ id: contact.id, stage: e.target.value })}
                    className="!w-auto !py-1 text-xs"
                    aria-label={`Etapa de ${contact.name}`}
                  >
                    {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </Select>
                ) : (
                  <Badge tone={stageTone(labelOf.get(contact.stage))}>{labelOf.get(contact.stage)?.label ?? contact.stage}</Badge>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {contact.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                </div>
              </td>
              <td className="px-4 py-3 text-xs text-ink-3">{timeAgo(contact.lastActivityAt)}</td>
              <td className="px-4 py-3 text-right">
                {canWrite && (
                  <Button
                    size="sm" variant="ghost"
                    onClick={() => setEditing(toForm(contact))}
                  >
                    Editar
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {contacts?.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-3">Sin contactos.</td></tr>
          )}
        </Table>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="CRM"
        title={editing?.id ? `Editar ${editing.name}` : 'Nuevo contacto'}
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Nombre" required>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="WhatsApp / teléfono">
                <Input value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
              </Field>
              <Field label="Correo">
                <Input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
              </Field>
              <Field label="Embudo">
                <Select
                  value={editing.pipelineId}
                  onChange={(e) => setEditing({ ...editing, pipelineId: e.target.value, stage: stagesFor(e.target.value)[0].key })}
                >
                  {(pipelines ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Etapa">
                <Select value={editing.stage} onChange={(e) => setEditing({ ...editing, stage: e.target.value })}>
                  {stagesFor(editing.pipelineId).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </Select>
              </Field>
              <Field label="Canal">
                <Select value={editing.channel} onChange={(e) => setEditing({ ...editing, channel: e.target.value })}>
                  {Object.entries(CHANNEL_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Etiquetas" hint="Separadas por coma">
              <Input value={editing.tags} onChange={(e) => setEditing({ ...editing, tags: e.target.value })} />
            </Field>
            <Field label="Notas">
              <Textarea rows={3} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </Field>
            <div className="border-2 border-line p-3">
              <Switch showLabel
                checked={editing.optOut}
                onChange={(v) => setEditing({ ...editing, optOut: v })}
                label="No quiere recibir campañas ni seguimientos"
              />
              <p className="mt-1 text-[11px] text-ink-3">Se activa solo si el cliente escribe SALIR o BAJA; con ACTIVAR vuelve a recibirlos.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button disabled={!editing.name || save.isPending} onClick={() => save.mutate(editing)}>
                {save.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {editingPipeline && (
        <PipelineModal
          pipeline={editingPipeline}
          q={q}
          onClose={() => setEditingPipeline(null)}
          onSaved={(id) => { setPipelineId(id); setStage(''); }}
        />
      )}
    </>
  );
}

/* ─── Editor de embudo ──────────────────────────────────────────────── */

function PipelineModal({ pipeline, q, onClose, onSaved }: {
  pipeline: Partial<Pipeline>;
  q: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(pipeline.name ?? '');
  const [isDefault, setIsDefault] = useState(!!pipeline.isDefault);
  const [stages, setStages] = useState<PipelineStage[]>(pipeline.stages ?? []);
  const save = useMutation({
    mutationFn: () => {
      const body = { name, isDefault, stages };
      return pipeline.id
        ? api.patch<Pipeline>(withScope(`/pipelines/${pipeline.id}`, q), body)
        : api.post<Pipeline>(withScope('/pipelines', q), body);
    },
    onSuccess: (p) => {
      toast.success('Embudo guardado');
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onSaved(p.id);
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(withScope(`/pipelines/${pipeline.id}`, q)),
    onSuccess: () => {
      toast.success('Embudo eliminado: sus contactos vuelven al estándar');
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onSaved('default');
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const move = (i: number, d: -1 | 1) => {
    const next = [...stages];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setStages(next);
  };
  return (
    <Modal open onClose={onClose} kicker="CRM" title={pipeline.id ? 'Editar embudo' : 'Nuevo embudo'}>
      <div className="space-y-4">
        <Field label="Nombre" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ventas corporativas" />
        </Field>
        <div className="space-y-2">
          <p className="kicker">Etapas (2 a 12)</p>
          {stages.map((st, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
              <Input value={st.label} onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Select
                value={st.kind}
                className="!w-32"
                onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, kind: e.target.value as PipelineStage['kind'] } : x)))}
              >
                <option value="OPEN">Abierta</option>
                <option value="WON">Ganada</option>
                <option value="LOST">Perdida</option>
              </Select>
              <button className="cursor-pointer p-1 text-ink-3 hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir">
                <ChevronLeft size={14} className="rotate-90" />
              </button>
              <button className="cursor-pointer p-1 text-ink-3 hover:text-ink disabled:opacity-30" disabled={i === stages.length - 1} onClick={() => move(i, 1)} aria-label="Bajar">
                <ChevronRight size={14} className="rotate-90" />
              </button>
              <button className="cursor-pointer px-1 text-xs text-ink-3 hover:text-bad" onClick={() => setStages(stages.filter((_, j) => j !== i))}>
                Quitar
              </button>
            </div>
          ))}
          {stages.length < 12 && (
            <Button size="sm" variant="outline" onClick={() => setStages([...stages, { key: '', label: '', kind: 'OPEN' }])}>
              + Etapa
            </Button>
          )}
        </div>
        <Switch showLabel checked={isDefault} onChange={setIsDefault} label="Embudo por defecto para contactos nuevos" />
        {pipeline.id && (
          <p className="text-[11px] text-ink-3">Si quitas una etapa, los contactos que estaban en ella pasan a la primera.</p>
        )}
        <div className="flex justify-between gap-2">
          {pipeline.id ? (
            <Button variant="danger" size="sm" onClick={() => window.confirm('¿Eliminar este embudo?') && remove.mutate()}>Eliminar</Button>
          ) : <span />}
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Guardando…' : 'Guardar embudo'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
