import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import type { AiCreditPackage, Plan } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Table, Textarea,
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
  includedAiConversations: number;
  line: 'PRO' | 'NEGOCIOS';
  currency: 'USD' | 'COP';
  maxLines: number;
  maxCouriers: number;
  minTermMonths: number;
  setupFeeValue: number;
}

const emptyForm: PlanForm = {
  code: '', name: '', priceMonthly: 0, maxBots: 10, maxWorkspaces: 1,
  maxUsers: 5, features: '', highlight: false, isCustom: false,
  includedAiConversations: 0, line: 'NEGOCIOS', currency: 'COP',
  maxLines: 1, maxCouriers: 0, minTermMonths: 6, setupFeeValue: 0,
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
        includedAiConversations: Number(form.includedAiConversations) || 0,
        line: form.line, currency: form.currency,
        maxLines: Number(form.maxLines) || 0, maxCouriers: Number(form.maxCouriers) || 0,
        minTermMonths: Number(form.minTermMonths) || 0, setupFeeValue: Number(form.setupFeeValue) || 0,
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
              {plan.isCustom ? 'A medida' : fmtMoney(plan.priceMonthly, plan.currency ?? 'USD')}
              {!plan.isCustom && <span className="text-sm text-ink-3">/mes</span>}
            </p>
            <p className="mt-1 text-xs text-ink-3">+ consumo aparte, al costo</p>
            <p className="mt-1 flex flex-wrap gap-1">
              <Badge tone={plan.line === 'NEGOCIOS' ? 'info' : 'neutral'}>{plan.line === 'NEGOCIOS' ? 'Negocios' : 'Pro'}</Badge>
              {(plan.minTermMonths ?? 0) > 0 && <Badge tone="neutral">Permanencia {plan.minTermMonths} meses</Badge>}
              {(plan.includedAiConversations ?? 0) > 0 && <Badge tone="ok">{plan.includedAiConversations} conv. IA/mes</Badge>}
            </p>
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
                    includedAiConversations: plan.includedAiConversations ?? 0,
                    line: plan.line ?? 'PRO', currency: plan.currency ?? 'USD',
                    maxLines: plan.maxLines ?? 1, maxCouriers: plan.maxCouriers ?? 0,
                    minTermMonths: plan.minTermMonths ?? 0, setupFeeValue: plan.setupFeeValue ?? 0,
                  })
                }
              >
                Editar
              </Button>
            </div>
          </Card>
        ))}
      </div>

      <AiPackages />

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
            <div className="grid grid-cols-2 gap-2">
              <Field label="Línea">
                <Select value={editing.line} onChange={(e) => setEditing({ ...editing, line: e.target.value as PlanForm['line'] })}>
                  <option value="NEGOCIOS">Negocios (comidas, domicilios)</option>
                  <option value="PRO">Pro (webcam, empresas)</option>
                </Select>
              </Field>
              <Field label="Moneda">
                <Select value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value as PlanForm['currency'] })}>
                  <option value="COP">COP</option>
                  <option value="USD">USD</option>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Líneas WhatsApp">
                <Input type="number" min={0} value={editing.maxLines} onChange={(e) => setEditing({ ...editing, maxLines: Number(e.target.value) })} />
              </Field>
              <Field label="Domiciliarios">
                <Input type="number" min={0} value={editing.maxCouriers} onChange={(e) => setEditing({ ...editing, maxCouriers: Number(e.target.value) })} />
              </Field>
              <Field label="IA incluida / mes" hint="Conversaciones">
                <Input type="number" min={0} step={50} value={editing.includedAiConversations}
                  onChange={(e) => setEditing({ ...editing, includedAiConversations: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Permanencia (meses)" hint="Montaje gratis con permanencia">
                <Input type="number" min={0} value={editing.minTermMonths} onChange={(e) => setEditing({ ...editing, minTermMonths: Number(e.target.value) })} />
              </Field>
              <Field label="Valor del montaje" hint="Salida anticipada: proporcional">
                <Input type="number" min={0} step={10000} value={editing.setupFeeValue} onChange={(e) => setEditing({ ...editing, setupFeeValue: Number(e.target.value) })} />
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

/** Paquetes prepagos de IA de BackOffice (los compra la empresa con Wompi). */
function AiPackages() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<AiCreditPackage> | null>(null);
  const { data: packages } = useQuery({
    queryKey: ['ai-packages-all'],
    queryFn: () => api.get<AiCreditPackage[]>('/ai-credits/packages?all=1'),
  });
  const save = useMutation({
    mutationFn: (p: Partial<AiCreditPackage>) =>
      p.id ? api.patch(`/ai-credits/packages/${p.id}`, p) : api.post('/ai-credits/packages', p),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-packages-all'] });
      toast.success('Paquete guardado');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="kicker">IA de BackOffice · prepago</p>
          <h2 className="display text-2xl">Paquetes de conversaciones</h2>
        </div>
        <Button size="sm" onClick={() => setEditing({ name: '', conversations: 1000, price: 0, currency: 'COP', validityMonths: 12, active: true })}>
          + Nuevo paquete
        </Button>
      </div>
      <Table head={['Paquete', 'Conversaciones', 'Precio', 'Por conversación', 'Vigencia', 'Estado', '']}>
        {packages?.map((p) => (
          <tr key={p.id} className={p.active ? '' : 'opacity-50'}>
            <td className="px-4 py-3 font-semibold">{p.name}</td>
            <td className="px-4 py-3 tabular-nums">{p.conversations.toLocaleString('es-CO')}</td>
            <td className="px-4 py-3 tabular-nums">{fmtMoney(p.price, p.currency)}</td>
            <td className="px-4 py-3 tabular-nums">{fmtMoney(Math.round(p.price / p.conversations), p.currency)}</td>
            <td className="px-4 py-3">{p.validityMonths} meses</td>
            <td className="px-4 py-3"><Badge tone={p.active ? 'ok' : 'neutral'}>{p.active ? 'Activo' : 'Inactivo'}</Badge></td>
            <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setEditing(p)}>Editar</Button></td>
          </tr>
        ))}
        {(packages?.length ?? 0) === 0 && (
          <tr><td colSpan={7} className="px-4 py-8 text-center text-ink-3">Sin paquetes: carga los precios con pnpm db:seed:precios o créalos aquí.</td></tr>
        )}
      </Table>
      <Modal open={!!editing} onClose={() => setEditing(null)} kicker="IA prepaga" title={editing?.id ? 'Editar paquete' : 'Nuevo paquete'}>
        {editing && (
          <div className="space-y-4">
            <Field label="Nombre" required><Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Conversaciones"><Input type="number" min={1} value={editing.conversations ?? 0} onChange={(e) => setEditing({ ...editing, conversations: Number(e.target.value) })} /></Field>
              <Field label="Vigencia (meses)"><Input type="number" min={1} max={36} value={editing.validityMonths ?? 12} onChange={(e) => setEditing({ ...editing, validityMonths: Number(e.target.value) })} /></Field>
              <Field label="Precio"><Input type="number" min={0} step={1000} value={editing.price ?? 0} onChange={(e) => setEditing({ ...editing, price: Number(e.target.value) })} /></Field>
              <Field label="Moneda">
                <Select value={editing.currency ?? 'COP'} onChange={(e) => setEditing({ ...editing, currency: e.target.value })}>
                  <option value="COP">COP</option><option value="USD">USD</option>
                </Select>
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Disponible para comprar
            </label>
            <Button className="w-full" disabled={!editing.name || save.isPending} onClick={() => save.mutate(editing)}>
              {save.isPending ? 'Guardando…' : 'Guardar paquete'}
            </Button>
          </div>
        )}
      </Modal>
    </section>
  );
}
