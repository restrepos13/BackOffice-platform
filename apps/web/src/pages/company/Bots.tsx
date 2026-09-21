import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot as BotIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { BOT_STATUS_LABELS } from '../../lib/format';
import type { Bot } from '../../lib/types';
import {
  Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Textarea, statusTone,
} from '../../components/ui';
import { ModelSelect } from '../../components/media';
import { PickCompany, useCompanyScope, withScope } from './shared';

export default function Bots() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    name: '', description: '', model: 'meta-llama/Llama-3.3-70B-Instruct', systemPrompt: '',
  });

  const { data: bots, isLoading } = useQuery({
    queryKey: ['bots', q],
    queryFn: () => api.get<Bot[]>(withScope('/bots', q)),
    enabled: ready,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Bot>('/bots', { ...form, ...(companyId ? { companyId } : {}) }),
    onSuccess: (bot) => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      toast.success(`${bot.name} creado`);
      setCreating(false);
      setForm({ name: '', description: '', model: 'meta-llama/Llama-3.3-70B-Instruct', systemPrompt: '' });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="IA humanizada"
        title="Asistentes"
        accent="con memoria."
        actions={canWrite ? <Button onClick={() => setCreating(true)}>+ Nuevo asistente</Button> : undefined}
      />

      {bots?.length === 0 ? (
        <EmptyState
          title="Sin asistentes todavía"
          hint="Crea tu primer asistente IA: personalidad propia, memoria y canales conectados."
          action={canWrite ? <Button onClick={() => setCreating(true)}>Crear asistente</Button> : undefined}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {bots?.map((bot) => (
            <Link key={bot.id} to={`/app/bots/${bot.id}`}>
              <Card className="h-full transition-shadow hover:shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
                <div className="flex items-start justify-between">
                  <div className="flex h-11 w-11 items-center justify-center border-2 border-ink bg-ink text-bone">
                    <BotIcon size={20} />
                  </div>
                  <Badge tone={statusTone(bot.status)}>{BOT_STATUS_LABELS[bot.status]}</Badge>
                </div>
                <h3 className="display mt-3 text-xl">{bot.name}</h3>
                <p className="mt-1 line-clamp-2 min-h-[2.4em] text-sm text-ink-2">
                  {bot.description ?? 'Sin descripción.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5 border-t-2 border-line pt-3">
                  <Badge tone="neutral">{bot.model}</Badge>
                  <Badge tone="neutral">{bot._count?.conversations ?? 0} conversaciones</Badge>
                  {bot.integrations?.filter((i) => i.status === 'CONNECTED').map((i) => (
                    <Badge key={i.id} tone="ok">{i.type}</Badge>
                  ))}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} kicker="Asistentes" title="Nuevo asistente IA">
        <div className="space-y-4">
          <Field label="Nombre" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Asistente de ventas" />
          </Field>
          <Field label="Descripción">
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Modelo IA (DeepInfra)" hint="El costo por M de tokens se declara al cliente">
            <ModelSelect value={form.model} onChange={(v) => setForm({ ...form, model: v })} />
          </Field>
          <Field label="System prompt">
            <Textarea value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} placeholder="Eres el asistente de…" />
          </Field>
          <Button className="w-full" disabled={!form.name || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Creando…' : 'Crear asistente'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
