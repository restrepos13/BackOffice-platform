import { useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bot as BotIcon, MapPin, RotateCcw, Send, Wrench } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { AGENT_TOOL_HELP, AGENT_TOOL_LABELS } from '../lib/format';
import type { AgentCatalog, AgentToolGrant } from '../lib/types';
import { Badge, Button, Card, Loading, Switch } from './ui';

/* ─── Modo del motor + herramientas del agente ─────────────────────── */

export function AgentConfig({
  engineMode,
  tools,
  onChange,
  disabled,
}: {
  engineMode: 'ORDERS' | 'AGENT';
  tools: AgentToolGrant[];
  onChange: (patch: { engineMode?: 'ORDERS' | 'AGENT'; tools?: AgentToolGrant[] }) => void;
  disabled?: boolean;
}) {
  const { data: catalog, isLoading } = useQuery({
    queryKey: ['agent-catalog'],
    queryFn: () => api.get<AgentCatalog>('/bots/agent-catalog'),
    staleTime: Infinity,
  });
  if (isLoading || !catalog) return <Loading label="Cargando herramientas…" />;

  const granted = new Map(tools.map((t) => [t.tool, t.access]));
  const toggle = (name: string, access: 'read' | 'write', on: boolean) => {
    const next = tools.filter((t) => t.tool !== name);
    if (on) next.push({ tool: name, access });
    onChange({ tools: next });
  };
  const presetActive = (preset: AgentCatalog['presets'][number]) =>
    preset.tools.length === tools.length && preset.tools.every((t) => granted.get(t.tool) === t.access);

  const modes = [
    {
      id: 'ORDERS' as const,
      title: 'Pedidos estructurados',
      text: 'El motor arma el contexto y la IA extrae el pedido en un formato fijo. Ideal para catering con agenda y áreas de producción.',
    },
    {
      id: 'AGENT' as const,
      title: 'Agente con herramientas',
      text: 'La IA decide qué consultar y qué hacer: menú con precios, envío por ubicación, pedidos, estado y seguimiento. Para restaurantes y domicilios.',
    },
  ];

  return (
    <div className="space-y-4">
      <Card kicker="Motor" title="Cómo trabaja este asistente">
        <div className="grid gap-3 md:grid-cols-2">
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ engineMode: mode.id })}
              aria-pressed={engineMode === mode.id}
              className={clsx(
                'cursor-pointer border-2 p-4 text-left transition-colors disabled:cursor-not-allowed',
                engineMode === mode.id ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink',
              )}
            >
              <p className="flex items-center gap-2 text-sm font-semibold">
                {mode.id === 'AGENT' ? <Wrench size={14} /> : <BotIcon size={14} />} {mode.title}
              </p>
              <p className={clsx('mt-1 text-xs', engineMode === mode.id ? 'text-bone/80' : 'text-ink-3')}>{mode.text}</p>
            </button>
          ))}
        </div>
      </Card>

      {engineMode === 'AGENT' && (
        <>
          <Card kicker="Atajo" title="Plantilla por tipo de negocio">
            <div className="grid gap-3 md:grid-cols-3">
              {catalog.presets.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({ tools: preset.tools })}
                  className={clsx(
                    'cursor-pointer border-2 p-3 text-left transition-colors disabled:cursor-not-allowed',
                    presetActive(preset) ? 'border-ink bg-paper shadow-[3px_3px_0_0_rgba(26,26,26,0.9)]' : 'border-line bg-bone hover:border-ink',
                  )}
                >
                  <p className="text-sm font-semibold">{preset.label}</p>
                  <p className="mt-1 text-xs text-ink-3">{preset.description}</p>
                </button>
              ))}
            </div>
          </Card>

          <Card kicker="Permisos" title="Herramientas del agente">
            <p className="mb-3 text-sm text-ink-2">
              Cada herramienta es una acción acotada a esta empresa. Las que <strong>modifican datos</strong> (crear,
              confirmar o cancelar pedidos) solo se ejecutan si están activas aquí. Pasar a una persona está siempre disponible.
            </p>
            <ul className="divide-y divide-line border-2 border-ink bg-bone">
              {catalog.tools.map((tool) => {
                const always = tool.name === 'pasar_a_humano';
                const on = always || granted.has(tool.name);
                return (
                  <li key={tool.name} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        {AGENT_TOOL_LABELS[tool.name] ?? tool.name}
                        {tool.access === 'write' && <Badge tone="warn">Modifica datos</Badge>}
                        {always && <Badge tone="neutral">Siempre activa</Badge>}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-3">{AGENT_TOOL_HELP[tool.name] ?? tool.description}</p>
                    </div>
                    <Switch
                      checked={on}
                      disabled={disabled || always}
                      onChange={(v) => toggle(tool.name, tool.access, v)}
                      label={AGENT_TOOL_LABELS[tool.name] ?? tool.name}
                    />
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

/* ─── Simulador de conversación (sin WhatsApp real) ───────────────── */

interface SimResult {
  state: string;
  escalated: boolean;
  escalationReason?: string | null;
  transcript: Array<{ author: string; content: string }>;
}

export function AgentSimulator({
  integrationId,
  scopeQuery,
  companyId,
}: {
  integrationId?: string;
  scopeQuery: string;
  companyId?: string | null;
}) {
  const [text, setText] = useState('');
  const [transcript, setTranscript] = useState<SimResult['transcript']>([]);
  const [status, setStatus] = useState<{ state: string; escalated: boolean; reason?: string | null } | null>(null);
  const [resetNext, setResetNext] = useState(true);
  const phone = useRef(`+5730${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [transcript]);

  const send = useMutation({
    mutationFn: (payload: { content: string; latitude?: number; longitude?: number }) =>
      api.post<SimResult>(`/engine/simulate${scopeQuery ? `?${scopeQuery}` : ''}`, {
        companyId: companyId ?? undefined,
        integrationId,
        phone: phone.current,
        name: 'Cliente de prueba',
        reset: resetNext,
        ...payload,
      }),
    onMutate: (payload) => {
      setTranscript((t) => [...t, { author: 'CONTACT', content: payload.latitude != null ? '[ubicación compartida]' : payload.content }]);
    },
    onSuccess: (res) => {
      setResetNext(false);
      setTranscript(res.transcript);
      setStatus({ state: res.state, escalated: res.escalated, reason: res.escalationReason });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const submit = () => {
    const content = text.trim();
    if (!content || send.isPending) return;
    setText('');
    send.mutate({ content });
  };

  const shareLocation = () => {
    const fallback = () => send.mutate({ content: 'Ubicación de prueba', latitude: 6.2518, longitude: -75.5636 });
    if (!('geolocation' in navigator)) return fallback();
    navigator.geolocation.getCurrentPosition(
      (pos) => send.mutate({ content: 'Mi ubicación', latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      fallback,
      { timeout: 8000 },
    );
  };

  if (!integrationId) {
    return (
      <Card kicker="Simulador" title="Probar el asistente">
        <p className="text-sm text-ink-3">Asigna este asistente a una línea de WhatsApp (Integraciones) para probarlo aquí.</p>
      </Card>
    );
  }

  return (
    <Card
      kicker="Simulador · no envía nada por WhatsApp"
      title="Probar el asistente"
      actions={
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setTranscript([]);
            setStatus(null);
            setResetNext(true);
          }}
        >
          <RotateCcw size={12} /> Nueva conversación
        </Button>
      }
    >
      <div className="flex h-[420px] flex-col border-2 border-ink bg-bone">
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          {transcript.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-3">
              Escribe como lo haría un cliente: "¿qué tienen hoy?", "quiero 2 almuerzos", "¿dónde va mi pedido?"
            </p>
          )}
          {transcript.map((m, i) => {
            const mine = m.author === 'CONTACT';
            return (
              <div key={i} className={clsx('flex', mine ? 'justify-end' : 'justify-start')}>
                <p
                  className={clsx(
                    'max-w-[80%] whitespace-pre-wrap border-2 px-3 py-2 text-sm',
                    mine ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper',
                  )}
                >
                  {m.content}
                </p>
              </div>
            );
          })}
          {send.isPending && <p className="kicker animate-pulse">El asistente está pensando…</p>}
          <div ref={bottom} />
        </div>
        {status && (
          <div className={clsx('border-t-2 border-ink px-4 py-1.5 text-[11px] font-semibold', status.escalated ? 'bg-warn-soft text-warn' : 'bg-paper text-ink-3')}>
            {status.escalated ? `Pasó a una persona: ${status.reason ?? ''}` : `Estado: ${status.state}`}
          </div>
        )}
        <form
          className="flex gap-0 border-t-2 border-ink"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <button
            type="button"
            onClick={shareLocation}
            disabled={send.isPending}
            aria-label="Compartir ubicación"
            title="Compartir ubicación"
            className="cursor-pointer border-r-2 border-ink px-3 hover:bg-bone-2 disabled:opacity-40"
          >
            <MapPin size={16} />
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribe un mensaje…"
            className="min-w-0 flex-1 bg-paper px-3 py-2.5 text-sm focus:outline-none"
          />
          <button
            type="submit"
            disabled={!text.trim() || send.isPending}
            aria-label="Enviar"
            className="cursor-pointer bg-ink px-4 text-bone disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </form>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        Usa la IA real (consume tokens). Los pedidos que confirme quedan en el panel como de prueba: puedes cancelarlos.
      </p>
    </Card>
  );
}
