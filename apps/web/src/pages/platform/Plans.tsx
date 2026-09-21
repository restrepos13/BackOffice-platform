import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtUsd } from '../../lib/format';
import type { Plan } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Textarea,
} from '../../components/ui';

interface PlanForm {
  id?: string;
  code: string;
  name: string;
  priceMonthly: number;
  maxBots: number;
  maxWorkspaces: number;
  maxUsers: number;
  features: string;
  highlight: boolean;
  isCustom: boolean;
}

const emptyForm: PlanForm = {
  code: '', name: '', priceMonthly: 0, maxBots: 10, maxWorkspaces: 1,
  maxUsers: 5, features: '', highlight: false, isCustom: false,
};

export default function Plans() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<PlanForm | null>(null);

  const { data: plans, isLoading } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<Plan[]>('/plans'),
  });

  const save = useMutation({
    mutationFn: (form: PlanForm) => {
      const payload = {
        code: form.code, name: form.name, priceMonthly: Number(form.priceMonthly),
        maxBots: Number(form.maxBots), maxWorkspaces: Number(form.maxWorkspaces),
        maxUsers: Number(form.maxUsers),
        features: form.features.split('\n').map((f) => f.trim()).filter(Boolean),
        highlight: form.highlight, isCustom: form.isCustom,
      };
      return form.id
        ? api.patch(`/plans/${form.id}`, payload)
        : api.post('/plans', payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      toast.success('Plan guardado');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="Plataforma"
        title="Planes"
        actions={<Button onClick={() => setEditing({ ...emptyForm })}>+ Nuevo plan</Button>}
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {plans?.map((plan) => (
          <Card key={plan.id} className={plan.highlight ? 'shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]' : ''}>
            <div className="mb-2 flex items-start justify-between">
              <div>
                <p className="kicker">{plan.code}</p>
                <h3 className="display text-2xl">{plan.name}</h3>
              </div>
              {plan.highlight && <Badge tone="ink">Recomendado</Badge>}
            </div>
            <p className="display text-3xl">
              {plan.isCustom ? 'A medida' : fmtUsd(plan.priceMonthly)}
              {!plan.isCustom && <span className="text-sm text-ink-3">/mes</span>}
            </p>
            <p className="mt-1 text-xs text-ink-3">+ consumo aparte, al costo</p>
            <ul className="mt-3 space-y-1 border-t-2 border-line pt-3 text-[13px]">
              {plan.features.map((f) => <li key={f}>— {f}</li>)}
            </ul>
            <div className="mt-3 flex items-center justify-between border-t-2 border-line pt-3">
              <p className="kicker">{plan._count?.companies ?? 0} empresas</p>
              <Button
                size="sm" variant="outline"
                onClick={() =>
                  setEditing({
                    id: plan.id, code: plan.code, name: plan.name,
                    priceMonthly: plan.priceMonthly, maxBots: plan.maxBots,
                    maxWorkspaces: plan.maxWorkspaces, maxUsers: plan.maxUsers,
                    features: plan.features.join('\n'),
                    highlight: plan.highlight, isCustom: plan.isCustom,
                  })
                }
              >
                Editar
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="Planes"
        title={editing?.id ? `Editar ${editing.name}` : 'Nuevo plan'}
        wide
      >
        {editing && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Código" required>
              <Input value={editing.code} disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, code: e.target.value })} />
            </Field>
            <Field label="Nombre" required>
              <Input value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Precio mensual (USD)">
              <Input type="number" value={editing.priceMonthly}
                onChange={(e) => setEditing({ ...editing, priceMonthly: Number(e.target.value) })} />
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Máx. bots">
                <Input type="number" value={editing.maxBots}
                  onChange={(e) => setEditing({ ...editing, maxBots: Number(e.target.value) })} />
              </Field>
              <Field label="Workspaces">
                <Input type="number" value={editing.maxWorkspaces}
                  onChange={(e) => setEditing({ ...editing, maxWorkspaces: Number(e.target.value) })} />
              </Field>
              <Field label="Máx. usuarios">
                <Input type="number" value={editing.maxUsers}
                  onChange={(e) => setEditing({ ...editing, maxUsers: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Características (una por línea)">
                <Textarea rows={6} value={editing.features}
                  onChange={(e) => setEditing({ ...editing, features: e.target.value })} />
              </Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.highlight}
                onChange={(e) => setEditing({ ...editing, highlight: e.target.checked })} />
              Marcar como recomendado
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.isCustom}
                onChange={(e) => setEditing({ ...editing, isCustom: e.target.checked })} />
              Precio a medida (Enterprise)
            </label>
            <div className="md:col-span-2 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button disabled={save.isPending} onClick={() => save.mutate(editing)}>
                {save.isPending ? 'Guardando…' : 'Guardar plan'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
