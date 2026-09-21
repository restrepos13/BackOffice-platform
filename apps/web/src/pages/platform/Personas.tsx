import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import type { PersonaTemplate } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Textarea,
} from '../../components/ui';

interface TemplateForm {
  id?: string;
  name: string;
  category: string;
  description: string;
  systemPrompt: string;
  tone: string;
  style: string;
  limits: string;
  welcomeMessage: string;
  handoffKeywords: string;
}

const emptyForm: TemplateForm = {
  name: '', category: 'General', description: '', systemPrompt: '',
  tone: '', style: '', limits: '', welcomeMessage: '', handoffKeywords: '',
};

export default function Personas() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<TemplateForm | null>(null);

  const { data: templates, isLoading } = useQuery({
    queryKey: ['personas-all'],
    queryFn: () => api.get<PersonaTemplate[]>('/personas'),
  });

  const save = useMutation({
    mutationFn: (form: TemplateForm) => {
      const payload = {
        name: form.name,
        category: form.category,
        description: form.description || undefined,
        systemPrompt: form.systemPrompt,
        personality: {
          tone: form.tone, style: form.style, limits: form.limits, language: 'es',
        },
        welcomeMessage: form.welcomeMessage || undefined,
        handoffKeywords: form.handoffKeywords || undefined,
      };
      return form.id
        ? api.patch(`/personas/${form.id}`, payload)
        : api.post('/personas', payload); // sin companyId = global
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['personas-all'] });
      queryClient.invalidateQueries({ queryKey: ['personas'] });
      toast.success('Plantilla guardada');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/personas/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['personas-all'] });
      toast.success('Plantilla eliminada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="El plus de BackOffice"
        title="Biblioteca de"
        accent="personalidades."
        actions={<Button onClick={() => setEditing({ ...emptyForm })}>+ Nueva plantilla</Button>}
      />

      <p className="mb-6 max-w-2xl text-sm text-ink-2">
        Personalidades listas para aplicar a cualquier bot o línea con un clic.
        Las globales las ven todas las empresas; cada empresa puede además
        guardar las suyas desde el editor de línea.
      </p>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {templates?.map((template) => (
          <Card key={template.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="kicker">{template.category}</p>
                <h3 className="display text-xl">{template.name}</h3>
              </div>
              {template.companyId ? (
                <Badge tone="info">{template.company?.name ?? 'Empresa'}</Badge>
              ) : (
                <Badge tone="ink">Global</Badge>
              )}
            </div>
            <p className="mt-2 min-h-[2.6em] text-sm text-ink-2">
              {template.description ?? '—'}
            </p>
            <div className="mt-2 space-y-1 border-t-2 border-line pt-2 text-xs text-ink-3">
              {template.personality.tone && <p>Tono: {template.personality.tone}</p>}
              {template.personality.limits && (
                <p className="truncate" title={template.personality.limits}>
                  Límites: {template.personality.limits}
                </p>
              )}
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm" variant="outline" className="flex-1"
                onClick={() =>
                  setEditing({
                    id: template.id, name: template.name, category: template.category,
                    description: template.description ?? '',
                    systemPrompt: template.systemPrompt,
                    tone: template.personality.tone ?? '',
                    style: template.personality.style ?? '',
                    limits: template.personality.limits ?? '',
                    welcomeMessage: template.welcomeMessage ?? '',
                    handoffKeywords: template.handoffKeywords ?? '',
                  })
                }
              >
                Editar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(template.id)}>
                Eliminar
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="Biblioteca"
        title={editing?.id ? `Editar ${editing.name}` : 'Nueva plantilla global'}
        wide
      >
        {editing && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Nombre" required>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Categoría" hint="Clínicas, Estudios webcam, Automotriz, Ventas…">
              <Input value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Descripción corta">
                <Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="System prompt" required>
                <Textarea rows={6} className="font-mono text-xs" value={editing.systemPrompt}
                  onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })} />
              </Field>
            </div>
            <Field label="Tono">
              <Input value={editing.tone} onChange={(e) => setEditing({ ...editing, tone: e.target.value })} />
            </Field>
            <Field label="Estilo">
              <Input value={editing.style} onChange={(e) => setEditing({ ...editing, style: e.target.value })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Límites">
                <Textarea rows={2} value={editing.limits} onChange={(e) => setEditing({ ...editing, limits: e.target.value })} />
              </Field>
            </div>
            <Field label="Mensaje de bienvenida">
              <Input value={editing.welcomeMessage} onChange={(e) => setEditing({ ...editing, welcomeMessage: e.target.value })} />
            </Field>
            <Field label="Palabras de handoff">
              <Input value={editing.handoffKeywords} onChange={(e) => setEditing({ ...editing, handoffKeywords: e.target.value })} />
            </Field>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button
                disabled={!editing.name || !editing.systemPrompt || save.isPending}
                onClick={() => save.mutate(editing)}
              >
                {save.isPending ? 'Guardando…' : 'Guardar plantilla'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
