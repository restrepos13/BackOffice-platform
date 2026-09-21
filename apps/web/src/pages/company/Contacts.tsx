import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

  return (
    <>
      <PageHeader
        kicker="CRM"
        title="Contactos"
        actions={canWrite ? <Button onClick={() => setEditing({ ...emptyForm })}>+ Nuevo contacto</Button> : undefined}
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

      <div className="mb-4">
        <Input
          placeholder="Buscar por nombre, teléfono o correo…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {isLoading ? (
        <Loading />
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
