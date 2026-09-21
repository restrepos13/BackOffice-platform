import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BOT_STATUS_LABELS, INTEGRATION_STATUS_LABELS, timeAgo } from '../../lib/format';
import type { Bot, PersonaTemplate } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Switch,
  Tabs, Textarea, statusTone,
} from '../../components/ui';
import { PersonaPicker } from '../../components/PersonaPicker';
import { ModelSelect } from '../../components/media';
import { useCompanyScope } from './shared';

export default function BotDetail() {
  const { id = '' } = useParams();
  const { canWrite } = useAuth();
  const { q } = useCompanyScope();
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
        <Badge tone="neutral">{bot._count?.conversations ?? 0} conversaciones</Badge>
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'personalidad', label: 'Personalidad' },
          { id: 'modelo', label: 'Modelo IA' },
          { id: 'comportamiento', label: 'Comportamiento' },
          { id: 'ventas', label: 'Ventas' },
          { id: 'canales', label: 'Canales', badge: bot.integrations?.length },
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

        {tab === 'modelo' && (
          <Card kicker="Motor" title="Modelo IA">
            <div className="grid gap-4 md:grid-cols-3">
              <Field
                label="Modelo (DeepInfra)"
                hint="El costo por millón de tokens se declara al cliente tal cual"
              >
                <ModelSelect value={form.model} onChange={(v) => set({ model: v })} disabled={!canWrite} />
              </Field>
              <Field label="Temperatura" hint="0 = predecible · 1 = creativo">
                <Input
                  type="number" min={0} max={1} step={0.1}
                  value={form.temperature}
                  onChange={(e) => set({ temperature: e.target.value })}
                />
              </Field>
              <Field label="Máx. tokens por respuesta">
                <Input
                  type="number" min={128} max={8192}
                  value={form.maxTokens}
                  onChange={(e) => set({ maxTokens: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-4 flex items-center justify-between border-2 border-line bg-bone px-4 py-3">
              <div>
                <p className="text-sm font-semibold">Memoria de largo plazo</p>
                <p className="text-xs text-ink-3">
                  El asistente recuerda cada conversación: nada de charlas genéricas y repetitivas.
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
        <div className="mt-0 grid gap-4 md:grid-cols-2">
          {bot.integrations?.map((integration) => (
            <Card key={integration.id}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="kicker">{integration.type}</p>
                  <h3 className="display text-lg">{integration.name}</h3>
                </div>
                <Badge tone={statusTone(integration.status)}>
                  {INTEGRATION_STATUS_LABELS[integration.status]}
                </Badge>
              </div>
              {integration.config.displayPhone && (
                <p className="mt-2 font-mono text-sm">{integration.config.displayPhone}</p>
              )}
              <p className="mt-1 text-xs text-ink-3">
                {integration.lastSyncAt ? `Última sync ${timeAgo(integration.lastSyncAt)}` : 'Nunca sincronizada'}
              </p>
            </Card>
          ))}
          {(bot.integrations?.length ?? 0) === 0 && (
            <p className="text-sm text-ink-3">
              Este asistente no tiene canales asignados. Vincúlalos desde Integraciones.
            </p>
          )}
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
