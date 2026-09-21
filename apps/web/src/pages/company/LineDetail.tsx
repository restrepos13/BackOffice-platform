import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, Save, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { INTEGRATION_STATUS_LABELS, timeAgo } from '../../lib/format';
import type { Bot, Integration, PersonaTemplate } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Textarea,
  statusTone,
} from '../../components/ui';
import { PersonaPicker } from '../../components/PersonaPicker';
import { ModelSelect } from '../../components/media';
import { useCompanyScope, withScope } from './shared';

interface LineForm {
  name: string;
  botId: string;
  promptMode: 'INHERIT' | 'CUSTOM';
  overridePrompt: string;
  tone: string;
  style: string;
  limits: string;
  overrideWelcome: string;
  overrideHandoff: string;
  overrideModel: string;
  overrideTemperature: string;
  delayMin: string;
  delayMax: string;
  salesGoal: string;
  salesStyle: string;
  salesCatalog: string;
  salesUpsell: string;
  salesObjections: string;
}

export default function LineDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const { q } = useCompanyScope();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: line, isLoading } = useQuery({
    queryKey: ['integration', id],
    queryFn: () => api.get<Integration & { bot?: Bot | null }>(`/integrations/${id}`),
  });
  const { data: bots } = useQuery({
    queryKey: ['bots', q],
    queryFn: () => api.get<Bot[]>(withScope('/bots', q)),
  });

  const [form, setForm] = useState<LineForm | null>(null);
  useEffect(() => {
    if (line && !form) {
      setForm({
        name: line.name,
        botId: line.botId ?? '',
        promptMode: line.promptMode,
        overridePrompt: line.overridePrompt ?? '',
        tone: line.overridePersonality.tone ?? '',
        style: line.overridePersonality.style ?? '',
        limits: line.overridePersonality.limits ?? '',
        overrideWelcome: line.overrideWelcome ?? '',
        overrideHandoff: line.overrideHandoff ?? '',
        overrideModel: line.overrideModel ?? '',
        overrideTemperature:
          line.overrideTemperature != null ? String(line.overrideTemperature) : '',
        delayMin:
          line.overrideReplyDelayMinSec != null ? String(line.overrideReplyDelayMinSec) : '',
        delayMax:
          line.overrideReplyDelayMaxSec != null ? String(line.overrideReplyDelayMaxSec) : '',
        salesGoal: line.overrideSales.goal ?? '',
        salesStyle: line.overrideSales.style ?? '',
        salesCatalog: line.overrideSales.catalog ?? '',
        salesUpsell: line.overrideSales.upsell ?? '',
        salesObjections: line.overrideSales.objections ?? '',
      });
    }
  }, [line, form]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/integrations/${id}`, {
        name: form!.name,
        botId: form!.botId || null,
        promptMode: form!.promptMode,
        overridePrompt: form!.overridePrompt,
        overridePersonality: {
          tone: form!.tone, style: form!.style, limits: form!.limits, language: 'es',
        },
        overrideWelcome: form!.overrideWelcome || null,
        overrideHandoff: form!.overrideHandoff || null,
        overrideModel: form!.overrideModel || null,
        overrideTemperature: form!.overrideTemperature
          ? Number(form!.overrideTemperature)
          : null,
        overrideReplyDelayMinSec: form!.delayMin ? Number(form!.delayMin) : null,
        overrideReplyDelayMaxSec: form!.delayMax ? Number(form!.delayMax) : null,
        overrideSales: {
          goal: form!.salesGoal, style: form!.salesStyle,
          catalog: form!.salesCatalog, upsell: form!.salesUpsell,
          objections: form!.salesObjections,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integration', id] });
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast.success('Línea guardada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const clone = useMutation({
    mutationFn: () => api.post<Integration>(`/integrations/${id}/clone`),
    onSuccess: (copy) => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast.success(`Línea clonada: ${copy.name}`);
      navigate(`/app/lines/${copy.id}`);
      setForm(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const saveAsTemplate = useMutation({
    mutationFn: () =>
      api.post('/personas', {
        name: `Personalidad de ${form!.name}`,
        category: 'Mis plantillas',
        description: `Guardada desde la línea ${form!.name}.`,
        systemPrompt: form!.overridePrompt,
        personality: { tone: form!.tone, style: form!.style, limits: form!.limits, language: 'es' },
        welcomeMessage: form!.overrideWelcome || undefined,
        handoffKeywords: form!.overrideHandoff || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['personas'] });
      toast.success('Guardada en tu biblioteca de personalidades');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !line || !form) return <Loading label="Cargando línea…" />;
  const set = (patch: Partial<LineForm>) => setForm({ ...form, ...patch });
  const bot = bots?.find((b) => b.id === form.botId);

  const applyTemplate = (t: PersonaTemplate) => {
    set({
      promptMode: 'CUSTOM',
      overridePrompt: t.systemPrompt,
      tone: t.personality.tone ?? '',
      style: t.personality.style ?? '',
      limits: t.personality.limits ?? '',
      overrideWelcome: t.welcomeMessage ?? form.overrideWelcome,
      overrideHandoff: t.handoffKeywords ?? form.overrideHandoff,
    });
    toast.success(`Plantilla "${t.name}" aplicada — revisa y guarda`);
  };

  return (
    <>
      <PageHeader
        kicker={`Línea WhatsApp · ${line.config.displayPhone || 'sin número aún'}`}
        title={line.name}
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => clone.mutate()}>
                <Copy size={13} /> Clonar línea
              </Button>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                <Save size={13} /> {save.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </>
          ) : undefined
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Badge tone={statusTone(line.status)}>{INTEGRATION_STATUS_LABELS[line.status]}</Badge>
        <Badge tone={form.promptMode === 'CUSTOM' ? 'ink' : 'neutral'}>
          {form.promptMode === 'CUSTOM' ? 'Personalidad propia' : 'Hereda del bot'}
        </Badge>
        <Badge tone="neutral">{line._count?.conversations ?? 0} conversaciones</Badge>
        {line.lastSyncAt && (
          <span className="text-xs text-ink-3">sync {timeAgo(line.lastSyncAt)}</span>
        )}
        {canWrite && line.status !== 'CONNECTED' && line.connectUrl && (
          <a href={line.connectUrl} target="_blank" rel="noreferrer" className="ml-auto">
            <Button size="sm">Conectar número →</Button>
          </a>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          {/* Modo de instrucciones */}
          <Card kicker="Cómo responde la IA en este número" title="Modo de instrucciones">
            <div className="grid gap-3 md:grid-cols-2">
              <button
                type="button"
                disabled={!canWrite}
                onClick={() => set({ promptMode: 'INHERIT' })}
                className={clsx(
                  'cursor-pointer border-2 p-4 text-left transition-colors disabled:cursor-default',
                  form.promptMode === 'INHERIT'
                    ? 'border-ink bg-ink text-bone'
                    : 'border-ink bg-paper hover:bg-bone-2',
                )}
              >
                <p className="display text-lg">Instrucciones generales</p>
                <p className={clsx('mt-1 text-xs', form.promptMode === 'INHERIT' ? 'text-line' : 'text-ink-3')}>
                  Este número usa tal cual el prompt y la personalidad del bot asignado.
                  Un solo lugar para mantener todo.
                </p>
              </button>
              <button
                type="button"
                disabled={!canWrite}
                onClick={() => set({ promptMode: 'CUSTOM' })}
                className={clsx(
                  'cursor-pointer border-2 p-4 text-left transition-colors disabled:cursor-default',
                  form.promptMode === 'CUSTOM'
                    ? 'border-ink bg-ink text-bone'
                    : 'border-ink bg-paper hover:bg-bone-2',
                )}
              >
                <p className="display text-lg">Personalidad propia</p>
                <p className={clsx('mt-1 text-xs', form.promptMode === 'CUSTOM' ? 'text-line' : 'text-ink-3')}>
                  100% personalizable: prompt, tono, bienvenida, handoff y hasta el
                  modelo de IA, solo para este número.
                </p>
              </button>
            </div>
          </Card>

          {/* Datos base */}
          <Card kicker="Línea" title="Datos">
            <fieldset disabled={!canWrite} className="grid gap-4 md:grid-cols-2">
              <Field label="Nombre de la línea" hint="Ej: Línea Valentina, Citas sede norte…">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Field label="Bot asignado (motor base)">
                <Select value={form.botId} onChange={(e) => set({ botId: e.target.value })}>
                  <option value="">Sin bot</option>
                  {bots?.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} · {b.model}</option>
                  ))}
                </Select>
              </Field>
            </fieldset>
          </Card>

          {/* Instrucciones propias */}
          {form.promptMode === 'CUSTOM' && (
            <Card
              kicker="Solo para este número"
              title="Instrucciones propias"
              actions={
                canWrite ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                      <Sparkles size={12} /> Aplicar plantilla
                    </Button>
                    <Button
                      size="sm" variant="ghost"
                      disabled={!form.overridePrompt || saveAsTemplate.isPending}
                      onClick={() => saveAsTemplate.mutate()}
                    >
                      Guardar como plantilla
                    </Button>
                  </>
                ) : undefined
              }
            >
              <fieldset disabled={!canWrite} className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <Field label="Prompt de la línea" hint="Quién es y cómo actúa la IA en este número">
                    <Textarea
                      rows={7} className="font-mono text-xs"
                      value={form.overridePrompt}
                      onChange={(e) => set({ overridePrompt: e.target.value })}
                      placeholder="Eres Valentina: dulce, juguetona y atenta…"
                    />
                  </Field>
                </div>
                <Field label="Tono">
                  <Input value={form.tone} onChange={(e) => set({ tone: e.target.value })} placeholder="Dulce y juguetona" />
                </Field>
                <Field label="Estilo">
                  <Input value={form.style} onChange={(e) => set({ style: e.target.value })} placeholder="Frases cortas, con memoria de detalles" />
                </Field>
                <div className="md:col-span-2">
                  <Field label="Límites" hint="Lo que esta línea nunca debe hacer">
                    <Textarea rows={2} value={form.limits} onChange={(e) => set({ limits: e.target.value })} />
                  </Field>
                </div>
                <Field label="Mensaje de bienvenida">
                  <Input value={form.overrideWelcome} onChange={(e) => set({ overrideWelcome: e.target.value })} />
                </Field>
                <Field label="Palabras de handoff" hint="Pasan la conversación a un humano">
                  <Input value={form.overrideHandoff} onChange={(e) => set({ overrideHandoff: e.target.value })} placeholder="pago, problema, supervisor" />
                </Field>
                <Field label="Modelo IA (opcional)" hint="Vacío = el del bot · costos DeepInfra declarados">
                  <ModelSelect
                    value={form.overrideModel}
                    onChange={(v) => set({ overrideModel: v })}
                    allowInherit
                    disabled={!canWrite}
                  />
                </Field>
                <Field label="Temperatura (opcional)" hint="Vacío = la del bot">
                  <Input
                    type="number" min={0} max={1} step={0.1}
                    value={form.overrideTemperature}
                    onChange={(e) => set({ overrideTemperature: e.target.value })}
                  />
                </Field>
                <Field label="Respuesta: mín. seg. (opcional)" hint="Vacío = tiempos del bot">
                  <Input
                    type="number" min={0} max={600}
                    value={form.delayMin}
                    onChange={(e) => set({ delayMin: e.target.value })}
                  />
                </Field>
                <Field label="Respuesta: máx. seg. (opcional)" hint="La IA espera un tiempo aleatorio entre ambos">
                  <Input
                    type="number" min={0} max={600}
                    value={form.delayMax}
                    onChange={(e) => set({ delayMax: e.target.value })}
                  />
                </Field>
              </fieldset>
            </Card>
          )}

          {form.promptMode === 'CUSTOM' && (
            <Card kicker="Chatter con objetivos" title="Habilidades de venta de la línea">
              <p className="mb-4 text-xs text-ink-3">
                Reglas comerciales propias de este número (vacío = sin reglas de
                venta específicas). El contenido de pago se carga en la Galería
                con su precio y puede asignarse a esta línea.
              </p>
              <fieldset disabled={!canWrite} className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <Field label="Objetivo de venta">
                    <Input value={form.salesGoal} onChange={(e) => set({ salesGoal: e.target.value })} placeholder="Convertir a los VIP en compradores semanales de PPV…" />
                  </Field>
                </div>
                <Field label="Estilo de venta">
                  <Textarea rows={3} value={form.salesStyle} onChange={(e) => set({ salesStyle: e.target.value })} />
                </Field>
                <Field label="Catálogo y precios">
                  <Textarea rows={3} value={form.salesCatalog} onChange={(e) => set({ salesCatalog: e.target.value })} />
                </Field>
                <Field label="Reglas de upsell">
                  <Textarea rows={3} value={form.salesUpsell} onChange={(e) => set({ salesUpsell: e.target.value })} />
                </Field>
                <Field label="Manejo de objeciones">
                  <Textarea rows={3} value={form.salesObjections} onChange={(e) => set({ salesObjections: e.target.value })} />
                </Field>
              </fieldset>
            </Card>
          )}
        </div>

        {/* Panel lateral: instrucciones efectivas */}
        <div className="space-y-4">
          <Card kicker="Lo que la IA obedece hoy" title="Instrucciones efectivas">
            <div className="space-y-3 text-sm">
              <div>
                <p className="kicker mb-1">Fuente</p>
                <p>
                  {form.promptMode === 'CUSTOM'
                    ? 'Esta línea (personalidad propia)'
                    : bot
                      ? `Bot «${bot.name}»`
                      : 'Sin bot asignado — la línea no responde'}
                </p>
              </div>
              <div>
                <p className="kicker mb-1">Prompt activo</p>
                <p className="max-h-48 overflow-y-auto whitespace-pre-wrap border-2 border-line bg-bone p-2 font-mono text-[11px] text-ink-2">
                  {(form.promptMode === 'CUSTOM'
                    ? form.overridePrompt
                    : bot?.systemPrompt) || '—'}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <p className="kicker">Modelo</p>
                  <p className="font-mono">
                    {form.promptMode === 'CUSTOM' && form.overrideModel
                      ? form.overrideModel
                      : (bot?.model ?? '—')}
                  </p>
                </div>
                <div>
                  <p className="kicker">Bienvenida</p>
                  <p className="truncate" title={form.promptMode === 'CUSTOM' ? form.overrideWelcome : (bot?.welcomeMessage ?? '')}>
                    {(form.promptMode === 'CUSTOM'
                      ? form.overrideWelcome
                      : bot?.welcomeMessage) || '—'}
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <Card kicker="Técnico" title="Conexión">
            <div className="space-y-2 text-xs">
              <p className="kicker">Webhook</p>
              <p className="break-all border-2 border-line bg-bone p-2 font-mono text-[10px]">
                {line.webhookUrl ?? '—'}
              </p>
              {line.config.phoneNumberId && (
                <p className="text-ink-3">Phone Number ID: {line.config.phoneNumberId}</p>
              )}
              {line.config.wabaId && (
                <p className="text-ink-3">WABA: {line.config.wabaId}</p>
              )}
            </div>
          </Card>
        </div>
      </div>

      <PersonaPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onApply={applyTemplate}
        scopeQuery={q}
      />
    </>
  );
}
