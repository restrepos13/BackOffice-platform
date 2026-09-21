import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import type { AiModel } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Table, Textarea,
} from '../../components/ui';
import { fmtPerM } from '../../components/media';

interface ModelForm {
  id?: string;
  modelId: string;
  name: string;
  inputCostPerMTok: string;
  outputCostPerMTok: string;
  contextK: string;
  recommended: boolean;
  active: boolean;
  notes: string;
}

const emptyForm: ModelForm = {
  modelId: '', name: '', inputCostPerMTok: '', outputCostPerMTok: '',
  contextK: '128', recommended: false, active: true, notes: '',
};

export default function AiModels() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ModelForm | null>(null);

  const { data: models, isLoading } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => api.get<AiModel[]>('/ai-models'),
  });

  const save = useMutation({
    mutationFn: (form: ModelForm) => {
      const payload = {
        modelId: form.modelId,
        name: form.name,
        inputCostPerMTok: Number(form.inputCostPerMTok),
        outputCostPerMTok: Number(form.outputCostPerMTok),
        contextK: Number(form.contextK),
        recommended: form.recommended,
        active: form.active,
        notes: form.notes || undefined,
      };
      return form.id
        ? api.patch(`/ai-models/${form.id}`, payload)
        : api.post('/ai-models', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-models'] });
      toast.success('Modelo guardado');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="DeepInfra · consumo al costo"
        title="Modelos"
        accent="IA."
        actions={<Button onClick={() => setEditing({ ...emptyForm })}>+ Agregar modelo</Button>}
      />

      <p className="mb-6 max-w-2xl text-sm text-ink-2">
        Catálogo de modelos disponibles para los bots y líneas de todas las
        empresas. Los costos por millón de tokens son los que se{' '}
        <strong>declaran al cliente</strong> — mantenerlos al día contra{' '}
        <span className="font-mono text-xs">deepinfra.com/pricing</span>.
        La llave de API se configura en Dev Tools.
      </p>

      <Table head={['Modelo', 'ID DeepInfra', 'Entrada /1M', 'Salida /1M', 'Contexto', 'Estado', '']}>
        {models?.map((model) => (
          <tr key={model.id}>
            <td className="px-4 py-3">
              <p className="font-semibold">{model.name}{model.recommended ? ' ★' : ''}</p>
              <p className="max-w-[280px] truncate text-xs text-ink-3">{model.notes ?? ''}</p>
            </td>
            <td className="px-4 py-3 font-mono text-xs">{model.modelId}</td>
            <td className="px-4 py-3 tabular-nums">{fmtPerM(model.inputCostPerMTok)}</td>
            <td className="px-4 py-3 tabular-nums">{fmtPerM(model.outputCostPerMTok)}</td>
            <td className="px-4 py-3 tabular-nums">{model.contextK}K</td>
            <td className="px-4 py-3">
              <Badge tone={model.active ? 'ok' : 'bad'}>
                {model.active ? 'Activo' : 'Inactivo'}
              </Badge>
            </td>
            <td className="px-4 py-3 text-right">
              <Button
                size="sm" variant="outline"
                onClick={() =>
                  setEditing({
                    id: model.id, modelId: model.modelId, name: model.name,
                    inputCostPerMTok: String(model.inputCostPerMTok),
                    outputCostPerMTok: String(model.outputCostPerMTok),
                    contextK: String(model.contextK),
                    recommended: model.recommended, active: model.active,
                    notes: model.notes ?? '',
                  })
                }
              >
                Editar
              </Button>
            </td>
          </tr>
        ))}
      </Table>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="Catálogo DeepInfra"
        title={editing?.id ? `Editar ${editing.name}` : 'Agregar modelo'}
      >
        {editing && (
          <div className="space-y-4">
            <Field label="ID del modelo en DeepInfra" required hint="Ej: meta-llama/Llama-3.3-70B-Instruct">
              <Input value={editing.modelId} disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, modelId: e.target.value })} />
            </Field>
            <Field label="Nombre para mostrar" required>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Entrada USD/1M" required>
                <Input type="number" step={0.01} min={0} value={editing.inputCostPerMTok}
                  onChange={(e) => setEditing({ ...editing, inputCostPerMTok: e.target.value })} />
              </Field>
              <Field label="Salida USD/1M" required>
                <Input type="number" step={0.01} min={0} value={editing.outputCostPerMTok}
                  onChange={(e) => setEditing({ ...editing, outputCostPerMTok: e.target.value })} />
              </Field>
              <Field label="Contexto (K)">
                <Input type="number" min={1} value={editing.contextK}
                  onChange={(e) => setEditing({ ...editing, contextK: e.target.value })} />
              </Field>
            </div>
            <Field label="Nota" hint="Para qué sirve este modelo — la ve el cliente en Facturación">
              <Textarea rows={2} value={editing.notes}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
            </Field>
            <div className="flex gap-6">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.recommended}
                  onChange={(e) => setEditing({ ...editing, recommended: e.target.checked })} />
                Recomendado ★
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
                Activo (visible para empresas)
              </label>
            </div>
            <Button
              className="w-full"
              disabled={!editing.modelId || !editing.name || !editing.inputCostPerMTok || save.isPending}
              onClick={() => save.mutate(editing)}
            >
              {save.isPending ? 'Guardando…' : 'Guardar modelo'}
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
