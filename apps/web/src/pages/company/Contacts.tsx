import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, LayoutGrid, List } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { CHANNEL_LABELS, STAGE_LABELS, timeAgo } from '../../lib/format';
import type { Contact } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Table,
  Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

const STAGES = ['CURIOSO', 'POTENCIAL', 'CALIENTE', 'CLIENTE', 'DESCARTADO'];

interface ContactForm {
  id?: string;
  name: string;
  phone: string;
  email: string;
  stage: string;
  channel: string;
  tags: string;
  notes: string;
}

const emptyForm: ContactForm = {
  name: '', phone: '', email: '', stage: 'CURIOSO', channel: 'WHATSAPP', tags: '', notes: '',
};

export default function Contacts() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  const [view, setView] = useState<'lista' | 'tablero'>('lista');
  const [editing, setEditing] = useState<ContactForm | null>(null);

  const path = withScope(
    `/contacts?x=1${stage ? `&stage=${stage}` : ''}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
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
    stage: s,
    count: contacts?.filter((c) => c.stage === s).length ?? 0,
  }));

  /** "Tu base de datos de clientes, 100% tuya" — exportación a CSV. */
  function exportCsv() {
    const rows = contacts ?? [];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      ['Nombre', 'Teléfono', 'Correo', 'Etapa', 'Canal', 'Etiquetas', 'Notas', 'Última actividad', 'Creado'].join(';'),
      ...rows.map((c) =>
        [
          esc(c.name), esc(c.phone), esc(c.email), esc(STAGE_LABELS[c.stage]),
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
              <Button onClick={() => setEditing({ ...emptyForm })}>+ Nuevo contacto</Button>
            )}
          </>
        }
      />

      {/* Pipeline resumido */}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-5">
        {counts.map(({ stage: s, count }) => (
          <button
            key={s}
            onClick={() => setStage(stage === s ? '' : s)}
            className={`cursor-pointer border-2 px-3 py-2 text-left transition-colors ${
              stage === s ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper hover:bg-bone-2'
            }`}
          >
            <p className="kicker" style={stage === s ? { color: '#c3bbb2' } : undefined}>
              {STAGE_LABELS[s]}
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
          {STAGES.map((s, stageIndex) => {
            const items = (contacts ?? []).filter((c) => c.stage === s);
            return (
              <div key={s} className="border-2 border-ink bg-bone-2">
                <div className="flex items-center justify-between border-b-2 border-ink bg-paper px-3 py-2">
                  <p className="kicker">{STAGE_LABELS[s]}</p>
                  <span className="display text-lg">{items.length}</span>
                </div>
                <div className="max-h-[60vh] space-y-2 overflow-y-auto p-2">
                  {items.map((contact) => (
                    <div key={contact.id} className="border-2 border-ink bg-paper p-2.5">
                      <button
                        className="block w-full cursor-pointer text-left"
                        onClick={() =>
                          canWrite &&
                          setEditing({
                            id: contact.id, name: contact.name,
                            phone: contact.phone ?? '', email: contact.email ?? '',
                            stage: contact.stage, channel: contact.channel,
                            tags: contact.tags.join(', '), notes: contact.notes ?? '',
                          })
                        }
                      >
                        <p className="truncate text-sm font-semibold">{contact.name}</p>
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
                            onClick={() => changeStage.mutate({ id: contact.id, stage: STAGES[stageIndex - 1] })}
                          >
                            <ChevronLeft size={14} />
                          </button>
                          <button
                            className="cursor-pointer p-0.5 text-ink-3 hover:text-ink disabled:opacity-30"
                            disabled={stageIndex === STAGES.length - 1}
                            aria-label="Mover a etapa siguiente"
                            onClick={() => changeStage.mutate({ id: contact.id, stage: STAGES[stageIndex + 1] })}
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
                <p className="font-semibold">{contact.name}</p>
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
                    {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                  </Select>
                ) : (
                  <Badge tone={statusTone(contact.stage)}>{STAGE_LABELS[contact.stage]}</Badge>
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
                    onClick={() =>
                      setEditing({
                        id: contact.id, name: contact.name,
                        phone: contact.phone ?? '', email: contact.email ?? '',
                        stage: contact.stage, channel: contact.channel,
                        tags: contact.tags.join(', '), notes: contact.notes ?? '',
                      })
                    }
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
              <Field label="Etapa">
                <Select value={editing.stage} onChange={(e) => setEditing({ ...editing, stage: e.target.value })}>
                  {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
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
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button disabled={!editing.name || save.isPending} onClick={() => save.mutate(editing)}>
                {save.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
