import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays, Facebook, Instagram, MessageCircle, Megaphone, Send,
  Workflow as WorkflowIcon, Link2, Settings2,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { CHANNEL_LABELS, INTEGRATION_STATUS_LABELS, timeAgo } from '../../lib/format';
import type { Bot, Integration } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select,
  statusTone,
} from '../../components/ui';
import ScheduleCall from '../../components/ScheduleCall';
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
  const { ready, q, canWrite, companyId, isPlatform } = useCompanyScope();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState('WHATSAPP');
  const [newName, setNewName] = useState('');
  const [assigning, setAssigning] = useState<Integration | null>(null);
  const [connectingMeta, setConnectingMeta] = useState<Integration | null>(null);

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
        name: newName.trim() || CHANNEL_LABELS[newType],
        ...(companyId ? { companyId } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast.success(newType === 'WHATSAPP' ? 'Línea creada — configúrale su IA y conéctala' : 'Canal agregado — listo para conectar');
      setAdding(false);
      setNewName('');
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

      {!isPlatform && !integrations?.some((i) => i.type === 'WHATSAPP' && i.status === 'CONNECTED') && (
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper p-4">
          <div className="max-w-xl text-sm">
            <p className="font-semibold">Conectar tu WhatsApp lo hacemos contigo</p>
            <p className="text-ink-2">Un agente de BackOffice te llama, conecta tu número con Meta y deja tu asistente respondiendo. Tú solo tienes tu celular a la mano.</p>
          </div>
          <ScheduleCall q={q} topic="WHATSAPP" label="Agéndame con un agente" />
        </div>
      )}

      {/* ─── Líneas WhatsApp (varios números, personalidad por línea) ─── */}
      <div className="mb-3 flex items-end justify-between">
        <div>
          <p className="kicker">Un número por perfil, área o campaña</p>
          <h2 className="display text-2xl">Líneas WhatsApp</h2>
        </div>
        {canWrite && (
          <Button
            size="sm"
            onClick={() => { setNewType('WHATSAPP'); setAdding(true); }}
          >
            + Agregar línea
          </Button>
        )}
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {integrations?.filter((i) => i.type === 'WHATSAPP').map((line) => {
          const connected = line.status === 'CONNECTED';
          return (
            <Card key={line.id}>
              <div className="flex items-start justify-between">
                <div className={`flex h-11 w-11 items-center justify-center border-2 border-ink ${connected ? 'bg-ink text-bone' : 'bg-paper'}`}>
                  <MessageCircle size={20} />
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge tone={statusTone(line.status)}>
                    {INTEGRATION_STATUS_LABELS[line.status]}
                  </Badge>
                  <Badge tone={line.promptMode === 'CUSTOM' ? 'ink' : 'neutral'}>
                    {line.promptMode === 'CUSTOM' ? 'Personalidad propia' : 'Hereda del bot'}
                  </Badge>
                </div>
              </div>
              <h3 className="display mt-3 text-lg">{line.name}</h3>
              <p className="mt-0.5 font-mono text-sm">
                {line.config.displayPhone || 'Número pendiente de conectar'}
              </p>
              <div className="mt-2 space-y-1 border-t-2 border-line pt-2 text-xs text-ink-3">
                <p>
                  Bot: {line.bot?.name ?? 'Sin asignar'} · {line._count?.conversations ?? 0} conversaciones
                </p>
                {line.promptMode === 'CUSTOM' && line.overridePersonality.tone && (
                  <p className="truncate">Tono: {line.overridePersonality.tone}</p>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/app/lines/${line.id}`} className="flex-1">
                  <Button className="w-full" size="sm" variant={connected ? 'primary' : 'outline'}>
                    <Settings2 size={12} /> Configurar IA
                  </Button>
                </Link>
                {canWrite && !connected && line.connectUrl && (
                  <a href={line.connectUrl} target="_blank" rel="noreferrer">
                    <Button size="sm" variant="outline">Conectar →</Button>
                  </a>
                )}
              </div>
            </Card>
          );
        })}
        {integrations?.filter((i) => i.type === 'WHATSAPP').length === 0 && (
          <p className="text-sm text-ink-3 md:col-span-2 xl:col-span-3">
            Sin líneas todavía. Agrega el primer número de WhatsApp.
          </p>
        )}
      </div>

      {/* ─── Otros canales ─── */}
      <div className="mb-3">
        <p className="kicker">Ecosistema</p>
        <h2 className="display text-2xl">Otros canales</h2>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {integrations?.filter((i) => i.type !== 'WHATSAPP').map((integration) => {
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
                {['INSTAGRAM', 'MESSENGER'].includes(integration.type) && integration.config.sandbox && (
                  <p className="font-semibold text-warn">Modo prueba: no se envían mensajes reales</p>
                )}
                {integration.webhookUrl && !['INSTAGRAM', 'MESSENGER'].includes(integration.type) && (
                  <p className="truncate font-mono text-[10px] text-ink-3" title={integration.webhookUrl}>
                    {integration.webhookUrl}
                  </p>
                )}
              </div>

              {canWrite && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {['INSTAGRAM', 'MESSENGER'].includes(integration.type) && (
                    <Button size="sm" className="flex-1" variant={connected ? 'outline' : 'primary'} onClick={() => setConnectingMeta(integration)}>
                      {connected ? 'Configurar' : 'Conectar →'}
                    </Button>
                  )}
                  {!connected && integration.connectUrl && !['INSTAGRAM', 'MESSENGER'].includes(integration.type) && (
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

      {connectingMeta && <MetaConnectModal integration={connectingMeta} onClose={() => setConnectingMeta(null)} />}

      {/* Agregar canal / línea */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        kicker="Integraciones"
        title={newType === 'WHATSAPP' ? 'Nueva línea WhatsApp' : 'Agregar canal'}
      >
        <div className="space-y-4">
          <Field label="Tipo de canal">
            <Select value={newType} onChange={(e) => setNewType(e.target.value)}>
              {ADDABLE.map((type) => (
                <option key={type} value={type}>{CHANNEL_LABELS[type]}</option>
              ))}
            </Select>
          </Field>
          {newType === 'WHATSAPP' && (
            <Field
              label="Nombre de la línea"
              hint="Ej: Línea Valentina, Citas sede norte, Campaña Meta…"
            >
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
          )}
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

/** Instagram / Messenger por la API oficial de Meta (token de página). */
function MetaConnectModal({ integration, onClose }: { integration: Integration; onClose: () => void }) {
  const queryClient = useQueryClient();
  const isIg = integration.type === 'INSTAGRAM';
  const cfg = integration.config as Record<string, any>;
  const [pageId, setPageId] = useState<string>(cfg.pageId ?? '');
  const [igUserId, setIgUserId] = useState<string>(cfg.igUserId ?? '');
  const [token, setToken] = useState('');
  const [sandbox, setSandbox] = useState<boolean>(cfg.sandbox ?? !cfg.metaConfigured);
  const slug = integration.company?.slug ?? '';
  const webhook = `${window.location.origin}/api/webhooks/${slug}/meta`;
  const save = useMutation({
    mutationFn: () => api.patch(`/integrations/${integration.id}`, {
      status: 'CONNECTED',
      config: { provider: 'META', pageId: pageId.trim(), igUserId: igUserId.trim() || undefined, sandbox, ...(token.trim() ? { accessToken: token.trim() } : {}) },
    }),
    onSuccess: () => {
      toast.success(sandbox ? 'Conectado en modo prueba' : 'Canal conectado');
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open onClose={onClose} kicker="Meta" title={`Conectar ${isIg ? 'Instagram' : 'Messenger'}`}>
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 pl-4 text-xs text-ink-2">
          <li>En developers.facebook.com, en tu app, agrega el producto {isIg ? 'Instagram' : 'Messenger'} y vincula tu página.</li>
          <li>Pega esta URL de webhook y el token de verificación configurado en Dev Tools. Suscríbete a <span className="font-mono">messages</span>.</li>
          <li>Genera un token de página permanente y pégalo aquí.</li>
        </ol>
        <Field label="URL del webhook">
          <div className="flex items-center gap-2 border-2 border-line bg-bone-2 px-2 py-1.5 text-xs">
            <span className="truncate font-mono">{webhook}</span>
            <button type="button" className="cursor-pointer text-ink-3 hover:text-ink" onClick={() => navigator.clipboard?.writeText(webhook).then(() => toast.success('Copiado'))}>Copiar</button>
          </div>
        </Field>
        <Field label="ID de la página de Facebook" required><Input value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="1234567890" /></Field>
        {isIg && <Field label="ID de la cuenta de Instagram" hint="Instagram profesional vinculada a la página"><Input value={igUserId} onChange={(e) => setIgUserId(e.target.value)} placeholder="17841400000000000" /></Field>}
        <Field label="Token de acceso de la página" hint={cfg.metaConfigured ? 'Guardado (cifrado). Escribe uno nuevo para reemplazarlo.' : 'Se guarda cifrado; nunca se vuelve a mostrar'}>
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Modo prueba (no envía respuestas reales)
        </label>
        <Button className="w-full" disabled={!pageId.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar conexión'}
        </Button>
      </div>
    </Modal>
  );
}
