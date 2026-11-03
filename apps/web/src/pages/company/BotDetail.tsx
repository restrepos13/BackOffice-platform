import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AI_MODE_LABELS, BOT_STATUS_LABELS, INTEGRATION_STATUS_LABELS, timeAgo } from '../../lib/format';
import type { Bot, PersonaTemplate } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Switch,
  Tabs, Textarea, statusTone,
} from '../../components/ui';
import { PersonaPicker } from '../../components/PersonaPicker';
import { ModelSelect } from '../../components/media';
import { useCompanyScope } from './shared';
import { AgentConfig, AgentSimulator } from '../../components/AgentConfig';
import ScheduleCall from '../../components/ScheduleCall';
import { useActiveCompany } from '../../lib/products';

const CHANNEL_LABELS: Record<string, string> = { WHATSAPP: 'WhatsApp', WHATSAPP_TWILIO: 'WhatsApp', MESSENGER: 'Facebook Messenger', FACEBOOK: 'Facebook Messenger', INSTAGRAM: 'Instagram', TELEGRAM: 'Telegram', WEBCHAT: 'Chat de tu web' };

/** Nombre legible del modelo (sin el proveedor delante). */
function modelName(model: string) {
  const short = String(model ?? '').split('/').pop() ?? model;
  return short.replace(/-Instruct.*$/i, '').replace(/-/g, ' ');
}

function payerMode(aiSource: string, companyMode?: string | null) {
  return aiSource && aiSource !== 'INHERIT' ? aiSource : companyMode || 'BYOK';
}

function payerLabel(aiSource: string, companyMode?: string | null) {
  return ({ BYOK: 'Tu empresa, con su propia cuenta de IA', PLATFORM: 'Incluida en tu plan de BackOffice', HYBRID: 'Tu cuenta de IA, con respaldo de BackOffice' } as Record<string, string>)[payerMode(aiSource, companyMode)] ?? 'Según tu plan';
}

function payerHint(aiSource: string, companyMode?: string | null) {
  return ({
    BYOK: 'Tu empresa paga directamente al proveedor de IA (DeepInfra u OpenRouter) lo que consume el asistente. BackOffice no cobra ese consumo.',
    PLATFORM: 'BackOffice te da la IA dentro de tu plan o paquete. Ves el consumo en «Costo del asistente».',
    HYBRID: 'Se usa tu cuenta de IA y, si falla o se queda sin saldo, responde la de BackOffice para no dejar clientes sin respuesta.',
  } as Record<string, string>)[payerMode(aiSource, companyMode)] ?? '';
}

export default function BotDetail() {
  const { id = '' } = useParams();
  const { canWrite, isPlatform } = useAuth();
  const { q, companyId } = useCompanyScope();
  const { company } = useActiveCompany();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('personalidad');
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: bot, isLoading } = useQuery({
    queryKey: ['bot', id],
    queryFn: () => api.get<Bot>(`/bots/${id}`),
  });

  const [form, setForm] = useState<any>(null);
  useEffect(() => {
    if (bot && !form) {
      setForm({
        name: bot.name,
        description: bot.description ?? '',
        status: bot.status,
        model: bot.model,
        temperature: bot.temperature,
        maxTokens: bot.maxTokens,
        systemPrompt: bot.systemPrompt,
        memoryEnabled: bot.memoryEnabled,
        welcomeMessage: bot.welcomeMessage ?? '',
        handoffKeywords: bot.handoffKeywords ?? '',
        tone: bot.personality.tone ?? '',
        style: bot.personality.style ?? '',
        limits: bot.personality.limits ?? '',
        replyDelayMinSec: bot.replyDelayMinSec,
        replyDelayMaxSec: bot.replyDelayMaxSec,
        typingSimulation: bot.typingSimulation,
        salesGoal: bot.sales.goal ?? '',
        salesStyle: bot.sales.style ?? '',
        salesCatalog: bot.sales.catalog ?? '',
        salesUpsell: bot.sales.upsell ?? '',
        salesObjections: bot.sales.objections ?? '',
        engineMode: bot.engineMode ?? 'ORDERS',
        tools: bot.tools ?? [],
        aiSource: bot.aiSource ?? 'INHERIT',
      });
    }
  }, [bot, form]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<Bot>(`/bots/${id}`, {
        name: form.name,
        description: form.description || undefined,
        status: form.status,
        model: form.model,
        temperature: Number(form.temperature),
        maxTokens: Number(form.maxTokens),
        systemPrompt: form.systemPrompt,
        memoryEnabled: form.memoryEnabled,
        welcomeMessage: form.welcomeMessage || undefined,
        handoffKeywords: form.handoffKeywords || undefined,
        replyDelayMinSec: Number(form.replyDelayMinSec),
        replyDelayMaxSec: Number(form.replyDelayMaxSec),
        typingSimulation: form.typingSimulation,
        personality: {
          tone: form.tone, style: form.style, limits: form.limits, language: 'es',
        },
        sales: {
          goal: form.salesGoal, style: form.salesStyle, catalog: form.salesCatalog,
          upsell: form.salesUpsell, objections: form.salesObjections,
        },
        engineMode: form.engineMode,
        tools: form.tools,
        // Quién paga la IA del asistente: solo BackOffice lo cambia
        ...(isPlatform ? { aiSource: form.aiSource } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bot', id] });
      queryClient.invalidateQueries({ queryKey: ['bots'] });
      toast.success('Asistente guardado');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !bot || !form) return <Loading label="Cargando asistente…" />;
  const set = (patch: Record<string, unknown>) => setForm({ ...form, ...patch });

  return (
    <>
      <PageHeader
        kicker={`Asistente · ${bot.company?.name ?? ''}`}
        title={bot.name}
        actions={
          canWrite ? (
            <>
              {form.status === 'ACTIVE' ? (
                <Button variant="outline" onClick={() => { set({ status: 'PAUSED' }); }}>
                  Pausar
                </Button>
              ) : (
                <Button variant="outline" onClick={() => { set({ status: 'ACTIVE' }); }}>
                  Activar
                </Button>
              )}
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Guardando…' : 'Guardar cambios'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-4 flex gap-2">
        <Badge tone={statusTone(form.status)}>{BOT_STATUS_LABELS[form.status as string]}</Badge>
        <Badge tone="neutral">{bot.model}</Badge>
        <Badge tone={form.engineMode === 'AGENT' ? 'info' : 'neutral'}>
          {form.engineMode === 'AGENT' ? `Agente · ${form.tools.length} herramientas` : 'Pedidos estructurados'}
        </Badge>
        <Badge tone="neutral">{bot._count?.conversations ?? 0} conversaciones</Badge>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'personalidad', label: 'Personalidad' },
          { id: 'agente', label: 'Agente' },
          { id: 'modelo', label: 'Modelo IA' },
          { id: 'comportamiento', label: 'Comportamiento' },
          { id: 'ventas', label: 'Ventas' },
          { id: 'canales', label: 'Canales', badge: bot.integrations?.length },
          { id: 'probar', label: 'Probar' },
        ]}
      />

      <fieldset disabled={!canWrite} className="mt-6">
        {tab === 'personalidad' && (
          <Card
            kicker="Cómo habla"
            title="Personalidad"
            actions={
              canWrite ? (
                <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                  Aplicar plantilla
                </Button>
              ) : undefined
            }
          >
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nombre">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Descripción">
                <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
              </Field>
              <Field label="Tono" hint="Ej: cálido y profesional">
                <Input value={form.tone} onChange={(e) => set({ tone: e.target.value })} />
              </Field>
              <Field label="Estilo" hint="Ej: frases cortas, cercano">
                <Input value={form.style} onChange={(e) => set({ style: e.target.value })} />
              </Field>
              <div className="md:col-span-2">
                <Field label="Límites" hint="Lo que el bot nunca debe hacer">
                  <Textarea rows={2} value={form.limits} onChange={(e) => set({ limits: e.target.value })} />
                </Field>
              </div>
              <div className="md:col-span-2">
                <Field label="System prompt" hint="La instrucción base del asistente — el conocimiento del negocio">
                  <Textarea rows={8} value={form.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} className="font-mono text-xs" />
                </Field>
              </div>
            </div>
          </Card>
        )}

        {tab === 'agente' && (
          <AgentConfig
            engineMode={form.engineMode}
            tools={form.tools}
            disabled={!canWrite}
            onChange={(patch) => set(patch)}
          />
        )}

        {tab === 'modelo' && (
          <Card kicker="Motor" title="La IA de tu asistente">
            {/* El cliente ve qué IA usa y quién la paga en palabras simples; cambiarlo lo hace el equipo */}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="border-2 border-line bg-bone px-4 py-3">
                <p className="kicker">Modelo</p>
                <p className="text-sm font-semibold">{modelName(bot.model)}</p>
                <p className="mt-1 text-xs text-ink-3">Es el «cerebro» que escribe las respuestas. Lo elegimos para que responda bien y rápido sin gastar de más.</p>
              </div>
              <div className="border-2 border-line bg-bone px-4 py-3">
                <p className="kicker">Quién paga la IA</p>
                <p className="text-sm font-semibold">{payerLabel(form.aiSource, company?.aiBillingMode)}</p>
                <p className="mt-1 text-xs text-ink-3">{payerHint(form.aiSource, company?.aiBillingMode)}</p>
              </div>
            </div>
            {!isPlatform && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-2 border-line px-4 py-3">
                <p className="text-sm text-ink-2">¿Quieres otro modelo o cambiar cómo se paga la IA? Lo ajusta el equipo de BackOffice según tu plan.</p>
                <ScheduleCall q={q} topic="AI" label="Hablar con el equipo" variant="outline" size="sm" />
              </div>
            )}
            {isPlatform && (
              <div className="mt-4 space-y-4 border-2 border-dashed border-line px-4 py-3">
                <p className="kicker">Solo equipo BackOffice</p>
                <div className="grid gap-4 md:grid-cols-3">
                  <Field label="Modelo (DeepInfra / OpenRouter)" hint="El costo por millón de tokens se declara al cliente tal cual">
                    <ModelSelect value={form.model} onChange={(v) => set({ model: v })} disabled={!canWrite} />
                  </Field>
                  <Field label="Temperatura" hint="0 = predecible · 1 = creativo">
                    <Input type="number" min={0} max={1} step={0.1} value={form.temperature} onChange={(e) => set({ temperature: e.target.value })} />
                  </Field>
                  <Field label="Máx. tokens por respuesta">
                    <Input type="number" min={128} max={8192} value={form.maxTokens} onChange={(e) => set({ maxTokens: e.target.value })} />
                  </Field>
                </div>
                <Field label="Quién paga la IA de este asistente" hint="Por defecto, lo que tenga la empresa. BackOffice puede vender este asistente con su propia IA aunque la empresa use su cuenta para los demás.">
                  <Select value={form.aiSource} onChange={(e) => set({ aiSource: e.target.value })}>
                    {['INHERIT', 'BYOK', 'PLATFORM', 'HYBRID'].map((v) => (
                      <option key={v} value={v}>{AI_MODE_LABELS[v]}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <div className="mt-4 flex items-center justify-between border-2 border-line bg-bone px-4 py-3">
              <div>
                <p className="text-sm font-semibold">Memoria de largo plazo</p>
                <p className="text-xs text-ink-3">
                  El asistente recuerda lo que cada cliente ya le contó: no vuelve a preguntar lo mismo.
                </p>
              </div>
              <Switch
                checked={form.memoryEnabled}
                onChange={(v) => set({ memoryEnabled: v })}
                label="Memoria"
                disabled={!canWrite}
              />
            </div>
          </Card>
        )}

        {tab === 'comportamiento' && (
          <Card kicker="Flujo" title="Comportamiento">
            <div className="space-y-4">
              <Field label="Mensaje de bienvenida">
                <Textarea rows={2} value={form.welcomeMessage} onChange={(e) => set({ welcomeMessage: e.target.value })} />
              </Field>
              <Field
                label="Palabras clave de handoff"
                hint="Si el cliente las menciona, la conversación pasa a un humano y se marca con atención. Separadas por coma."
              >
                <Input value={form.handoffKeywords} onChange={(e) => set({ handoffKeywords: e.target.value })} placeholder="urgencia, queja, hablar con humano" />
              </Field>

              <div className="border-t-2 border-line pt-4">
                <p className="kicker mb-2">Tiempos de respuesta humanizados</p>
                <p className="mb-3 text-xs text-ink-3">
                  Nadie responde en 0 segundos: la IA espera un tiempo aleatorio
                  entre el mínimo y el máximo antes de contestar.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Mínimo (segundos)">
                    <Input
                      type="number" min={0} max={600}
                      value={form.replyDelayMinSec}
                      onChange={(e) => set({ replyDelayMinSec: e.target.value })}
                    />
                  </Field>
                  <Field label="Máximo (segundos)">
                    <Input
                      type="number" min={0} max={600}
                      value={form.replyDelayMaxSec}
                      onChange={(e) => set({ replyDelayMaxSec: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="mt-3 flex items-center justify-between border-2 border-line bg-bone px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold">Simular "escribiendo…"</p>
                    <p className="text-xs text-ink-3">
                      Muestra el indicador de escritura antes de enviar, proporcional al largo del mensaje.
                    </p>
                  </div>
                  <Switch
                    checked={form.typingSimulation}
                    onChange={(v) => set({ typingSimulation: v })}
                    label="Simular escritura"
                    disabled={!canWrite}
                  />
                </div>
              </div>
            </div>
          </Card>
        )}

        {tab === 'ventas' && (
          <Card kicker="Chatter con objetivos" title="Habilidades de venta">
            <p className="mb-4 text-sm text-ink-2">
              Reglas comerciales que la IA sigue en cada conversación: qué vende,
              cómo lo ofrece y cómo maneja objeciones. El contenido de pago se
              carga en la <strong>Galería</strong> con su precio.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <Field label="Objetivo de venta" hint="Qué debe lograr la IA en cada conversación">
                  <Input value={form.salesGoal} onChange={(e) => set({ salesGoal: e.target.value })} placeholder="Fidelizar clientes y vender contenido premium (PPV)…" />
                </Field>
              </div>
              <Field label="Estilo de venta">
                <Textarea rows={3} value={form.salesStyle} onChange={(e) => set({ salesStyle: e.target.value })} placeholder="Venta suave: primero conexión, después la oferta…" />
              </Field>
              <Field label="Catálogo y precios" hint="Lo que puede ofrecer y a cuánto">
                <Textarea rows={3} value={form.salesCatalog} onChange={(e) => set({ salesCatalog: e.target.value })} placeholder="Contenido de la galería según su precio; personalizados desde $50…" />
              </Field>
              <Field label="Reglas de upsell">
                <Textarea rows={3} value={form.salesUpsell} onChange={(e) => set({ salesUpsell: e.target.value })} placeholder="A clientes recurrentes ofrecer packs…" />
              </Field>
              <Field label="Manejo de objeciones">
                <Textarea rows={3} value={form.salesObjections} onChange={(e) => set({ salesObjections: e.target.value })} placeholder="Si dice que es caro: recordar el valor de lo exclusivo…" />
              </Field>
            </div>
          </Card>
        )}
      </fieldset>

      {tab === 'canales' && (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-ink-2">
            Por dónde responde este asistente. Cada canal (un número de WhatsApp, una página de Facebook, una cuenta de Instagram) se conecta
            en <Link to="/app/integrations" className="font-semibold underline">Canales e integraciones</Link> y ahí eliges qué asistente lo atiende.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            {bot.integrations?.map((integration) => (
              <Card key={integration.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="kicker">{CHANNEL_LABELS[integration.type] ?? integration.type}</p>
                    <h3 className="display truncate text-lg">{integration.name}</h3>
                  </div>
                  <Badge tone={statusTone(integration.status)}>
                    {INTEGRATION_STATUS_LABELS[integration.status] ?? integration.status}
                  </Badge>
                </div>
                {integration.config?.displayPhone && (
                  <p className="mt-2 font-mono text-sm">{integration.config.displayPhone}</p>
                )}
                <p className="mt-1 text-xs text-ink-3">
                  {integration.lastSyncAt ? `Último mensaje ${timeAgo(integration.lastSyncAt)}` : 'Todavía sin mensajes'}
                </p>
              </Card>
            ))}
          </div>
          {(bot.integrations?.length ?? 0) === 0 && (
            <div className="border-2 border-dashed border-line px-4 py-6 text-center text-sm text-ink-3">
              Este asistente todavía no atiende ningún canal. <Link to="/app/integrations" className="font-semibold underline">Conecta uno</Link> y asígnaselo.
            </div>
          )}
        </div>
      )}

      {tab === 'probar' && (
        <div className="mt-6">
          {(form.engineMode !== (bot.engineMode ?? 'ORDERS') ||
            JSON.stringify(form.tools) !== JSON.stringify(bot.tools ?? [])) && (
            <p className="mb-3 border-2 border-warn bg-warn-soft px-4 py-2 text-sm text-warn">
              Tienes cambios sin guardar en el agente: guárdalos para probarlos.
            </p>
          )}
          <AgentSimulator integrationId={bot.integrations?.[0]?.id} scopeQuery={q} companyId={companyId} />
        </div>
      )}

      <PersonaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        scopeQuery={q}
        onApply={(t: PersonaTemplate) => {
          set({
            systemPrompt: t.systemPrompt,
            tone: t.personality.tone ?? '',
            style: t.personality.style ?? '',
            limits: t.personality.limits ?? '',
            welcomeMessage: t.welcomeMessage ?? form.welcomeMessage,
            handoffKeywords: t.handoffKeywords ?? form.handoffKeywords,
          });
        }}
      />
    </>
  );
}
