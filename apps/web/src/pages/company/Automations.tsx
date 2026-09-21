import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import {
  AUTOMATION_STATUS_LABELS, AUTOMATION_TYPE_LABELS, timeAgo,
} from '../../lib/format';
import type { Automation } from '../../lib/types';
import {
  Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Select, Switch, Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

interface AutomationForm {
  name: string;
  description: string;
  type: string;
  trigger: string;
}

export default function Automations() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AutomationForm>({
    name: '', description: '', type: 'FLOW', trigger: '',
  });

  const { data: automations, isLoading } = useQuery({
    queryKey: ['automations', q],
    queryFn: () => api.get<Automation[]>(withScope('/automations', q)),
    enabled: ready,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/automations', { ...form, ...(companyId ? { companyId } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['automations'] });
      toast.success('Automatización creada');
      setCreating(false);
      setForm({ name: '', description: '', type: 'FLOW', trigger: '' });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const toggle = useMutation({
    mutationFn: (a: Automation) =>
      api.patch(`/automations/${a.id}`, {
        status: a.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['automations'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="Operación en automático"
        title="Automatizaciones"
        actions={canWrite ? <Button onClick={() => setCreating(true)}>+ Nueva</Button> : undefined}
      />

      {automations?.length === 0 ? (
        <EmptyState
          title="Nada automatizado todavía"
          hint="Flujos, reportes y contenido: las tareas repetitivas se hacen solas."
          action={canWrite ? <Button onClick={() => setCreating(true)}>Crear la primera</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {automations?.map((automation) => (
            <Card key={automation.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="ink">{AUTOMATION_TYPE_LABELS[automation.type]}</Badge>
                    <Badge tone={statusTone(automation.status)}>
                      {AUTOMATION_STATUS_LABELS[automation.status]}
                    </Badge>
                  </div>
                  <h3 className="display mt-2 text-xl">{automation.name}</h3>
                  <p className="mt-1 text-sm text-ink-2">{automation.description ?? '—'}</p>
                </div>
                {canWrite && automation.status !== 'DRAFT' && (
                  <Switch
                    checked={automation.status === 'ACTIVE'}
                    onChange={() => toggle.mutate(automation)}
                    label={`Activar ${automation.name}`}
                  />
                )}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t-2 border-line pt-3 text-center">
                <div>
                  <p className="kicker">Disparador</p>
                  <p className="mt-0.5 truncate text-xs" title={automation.trigger ?? ''}>
                    {automation.trigger ?? 'Manual'}
                  </p>
                </div>
                <div>
                  <p className="kicker">Ejecuciones</p>
                  <p className="display text-lg">{automation.runsCount}</p>
                </div>
                <div>
                  <p className="kicker">Éxito</p>
                  <p className={`display text-lg ${automation.successRate >= 98 ? 'text-ok' : automation.successRate >= 90 ? 'text-warn' : 'text-bad'}`}>
                    {automation.successRate.toFixed(1)}%
                  </p>
                </div>
              </div>
              {automation.lastRunAt && (
                <p className="mt-2 text-xs text-ink-3">
                  Última ejecución {timeAgo(automation.lastRunAt)}
                  {automation.runs?.[0] && (
                    <> · <Badge tone={statusTone(automation.runs[0].status)}>{automation.runs[0].status === 'SUCCESS' ? 'OK' : automation.runs[0].status}</Badge></>
                  )}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} kicker="Automatizaciones" title="Nueva automatización">
        <div className="space-y-4">
          <Field label="Nombre" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Seguimiento a leads sin respuesta" />
          </Field>
          <Field label="Tipo">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {Object.entries(AUTOMATION_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Disparador" hint="Cuándo se ejecuta">
            <Input value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })} placeholder="Conversación inactiva 48h / Cron diario 7:00 am / Manual" />
          </Field>
          <Field label="Descripción">
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Button className="w-full" disabled={!form.name || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creando…' : 'Crear (queda en borrador)'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
