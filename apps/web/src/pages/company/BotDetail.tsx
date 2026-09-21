import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { BOT_STATUS_LABELS, INTEGRATION_STATUS_LABELS, timeAgo } from '../../lib/format';
import type { Bot } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Switch,
  Tabs, Textarea, statusTone,
} from '../../components/ui';

export default function BotDetail() {
  const { id = '' } = useParams();
  const { canWrite } = useAuth();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('personalidad');

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
        personality: {
          tone: form.tone, style: form.style, limits: form.limits, language: 'es',
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
          { id: 'canales', label: 'Canales', badge: bot.integrations?.length },
        ]}
      />

      <fieldset disabled={!canWrite} className="mt-6">
        {tab === 'personalidad' && (
          <Card kicker="Cómo habla" title="Personalidad">
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
              <Field label="Modelo">
                <Select value={form.model} onChange={(e) => set({ model: e.target.value })}>
                  <option value="claude-sonnet-5">Claude Sonnet 5</option>
                  <option value="claude-opus-5">Claude Opus 5</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
                </Select>
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
    </>
  );
}
