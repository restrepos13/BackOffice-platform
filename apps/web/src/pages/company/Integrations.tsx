import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays, Facebook, Instagram, MessageCircle, Megaphone, Send,
  Workflow as WorkflowIcon, Link2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { CHANNEL_LABELS, INTEGRATION_STATUS_LABELS, timeAgo } from '../../lib/format';
import type { Bot, Integration } from '../../lib/types';
import {
  Badge, Button, Card, Field, Loading, Modal, PageHeader, Select, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

const TYPE_ICONS: Record<string, typeof MessageCircle> = {
  WHATSAPP: MessageCircle,
  INSTAGRAM: Instagram,
  MESSENGER: Facebook,
  TELEGRAM: Send,
  META_ADS: Megaphone,
  N8N: WorkflowIcon,
  GOOGLE_CALENDAR: CalendarDays,
  WEBHOOK: Link2,
};

const TYPE_BLURBS: Record<string, string> = {
  WHATSAPP: 'API oficial de Meta. Tu asistente atiende, vende y agenda por WhatsApp.',
  INSTAGRAM: 'Mensajes directos de Instagram atendidos por la misma IA con la misma memoria.',
  MESSENGER: 'El chat de tu página de Facebook conectado al asistente.',
  TELEGRAM: 'Bots, canales y flujos automatizados en Telegram.',
  META_ADS: 'Campañas en Facebook e Instagram conectadas directo a tu WhatsApp.',
  N8N: 'Flujos sin IA para tareas repetitivas: integraciones, reportes y procesos internos.',
  GOOGLE_CALENDAR: 'Agendamiento directo en el calendario de tu equipo.',
  WEBHOOK: 'Integración personalizada por webhook para cualquier sistema.',
};

const ADDABLE = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'TELEGRAM', 'META_ADS', 'N8N', 'GOOGLE_CALENDAR', 'WEBHOOK'];

export default function Integrations() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState('WHATSAPP');
  const [assigning, setAssigning] = useState<Integration | null>(null);

  const { data: integrations, isLoading } = useQuery({
    queryKey: ['integrations', q],
    queryFn: () => api.get<Integration[]>(withScope('/integrations', q)),
    enabled: ready,
  });
  const { data: bots } = useQuery({
    queryKey: ['bots', q],
    queryFn: () => api.get<Bot[]>(withScope('/bots', q)),
    enabled: ready,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post('/integrations', {
        type: newType,
        name: CHANNEL_LABELS[newType],
        ...(companyId ? { companyId } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Canal agregado — listo para conectar');
      setAdding(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const assignBot = useMutation({
    mutationFn: ({ id, botId }: { id: string; botId: string | null }) =>
      api.patch(`/integrations/${id}`, { botId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      setAssigning(null);
      toast.success('Bot asignado');
    },
  });

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      api.patch(`/integrations/${id}`, { status: 'DISCONNECTED', config: {} }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Canal desconectado');
    },
  });

  if (!ready) return <PickCompany />;
  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="Todo conectado"
        title="Integraciones"
        actions={canWrite ? <Button onClick={() => setAdding(true)}>+ Agregar canal</Button> : undefined}
      />

      <p className="mb-6 max-w-2xl text-sm text-ink-2">
        Cada mensaje entra por donde sea, lo atiende la misma IA con la misma
        memoria, y todo queda medido en un solo lugar. Las cuentas se vinculan
        con el botón <strong>Conectar</strong> — no guardamos credenciales aquí.
      </p>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {integrations?.map((integration) => {
          const Icon = TYPE_ICONS[integration.type] ?? Link2;
          const connected = integration.status === 'CONNECTED';
          return (
            <Card key={integration.id}>
              <div className="flex items-start justify-between">
                <div className={`flex h-11 w-11 items-center justify-center border-2 border-ink ${connected ? 'bg-ink text-bone' : 'bg-paper'}`}>
                  <Icon size={20} />
                </div>
                <Badge tone={statusTone(integration.status)}>
                  {INTEGRATION_STATUS_LABELS[integration.status]}
                </Badge>
              </div>
              <h3 className="display mt-3 text-lg">{integration.name}</h3>
              <p className="mt-1 min-h-[2.6em] text-xs text-ink-2">
                {TYPE_BLURBS[integration.type] ?? ''}
              </p>

              <div className="mt-2 space-y-1 border-t-2 border-line pt-2 text-xs">
                {integration.config.displayPhone && (
                  <p className="font-mono">{integration.config.displayPhone}</p>
                )}
                <p className="text-ink-3">
                  Bot: {integration.bot?.name ?? 'Sin asignar'}
                  {integration.lastSyncAt && ` · sync ${timeAgo(integration.lastSyncAt)}`}
                </p>
                {integration.webhookUrl && (
                  <p className="truncate font-mono text-[10px] text-ink-3" title={integration.webhookUrl}>
                    {integration.webhookUrl}
                  </p>
                )}
              </div>

              {canWrite && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {!connected && integration.connectUrl && (
                    <a href={integration.connectUrl} target="_blank" rel="noreferrer" className="flex-1">
                      <Button className="w-full" size="sm">Conectar →</Button>
                    </a>
                  )}
                  {connected && (
                    <Button size="sm" variant="outline" onClick={() => disconnect.mutate(integration.id)}>
                      Desconectar
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setAssigning(integration)}>
                    Asignar bot
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Agregar canal */}
      <Modal open={adding} onClose={() => setAdding(false)} kicker="Integraciones" title="Agregar canal">
        <div className="space-y-4">
          <Field label="Tipo de canal">
            <Select value={newType} onChange={(e) => setNewType(e.target.value)}>
              {ADDABLE.map((type) => (
                <option key={type} value={type}>{CHANNEL_LABELS[type]}</option>
              ))}
            </Select>
          </Field>
          <p className="text-xs text-ink-3">{TYPE_BLURBS[newType]}</p>
          <Button className="w-full" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'Agregando…' : 'Agregar (queda sin conectar)'}
          </Button>
        </div>
      </Modal>

      {/* Asignar bot */}
      <Modal
        open={!!assigning}
        onClose={() => setAssigning(null)}
        kicker={assigning?.name ?? ''}
        title="Asignar asistente"
      >
        <div className="space-y-2">
          <button
            className="block w-full cursor-pointer border-2 border-line bg-bone px-4 py-2 text-left text-sm hover:border-ink"
            onClick={() => assigning && assignBot.mutate({ id: assigning.id, botId: null })}
          >
            Sin bot (canal pasivo)
          </button>
          {bots?.map((bot) => (
            <button
              key={bot.id}
              className={`block w-full cursor-pointer border-2 px-4 py-2 text-left text-sm hover:border-ink ${
                assigning?.botId === bot.id ? 'border-ink bg-ink text-bone' : 'border-line bg-bone'
              }`}
              onClick={() => assigning && assignBot.mutate({ id: assigning.id, botId: bot.id })}
            >
              {bot.name} <span className="opacity-60">· {bot.model}</span>
            </button>
          ))}
        </div>
      </Modal>
    </>
  );
}
