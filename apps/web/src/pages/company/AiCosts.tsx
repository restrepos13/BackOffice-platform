import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Info } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import { Badge, Card, Loading, PageHeader } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * "¿Cuánto me cuesta la IA?" con los números de SU negocio: cuántos clientes le
 * escriben, qué tan largas son las instrucciones de su asistente y su catálogo.
 * Todo lo calcula el servidor con código (no gasta IA). Pensado para que
 * cualquiera lo entienda: primero el resumen, después el detalle.
 */

export interface AiCostEstimate {
  assumptions: { turnsPerConversation: number; charsPerToken: number; daysPerMonth: number; reportQueriesPerDay: number; trm: number };
  inputs: { dailyChats: number; monthlyConversations: number; products: number; agentMode: boolean };
  tokens: { fixedPerMessage: number; input: number; output: number; breakdown: { engine: number; prompt: number; knowledge: number; catalog: number } };
  models: Array<{
    modelId: string;
    name: string;
    provider: string;
    recommended: boolean;
    current: boolean;
    notes: string | null;
    pricePerMTok: { input: number; output: number };
    perConversation: { usd: number; cop: number };
    perMonth: { usd: number; cop: number };
    creditsPerConversation: number;
    withPackage: { name: string; conversations: number; price: number; perConversation: number; monthsItLasts: number | null; monthlyCost: number } | null;
    report: { perQuery: { usd: number; cop: number }; perMonth: { usd: number; cop: number } };
  }>;
  company: { name: string; aiBillingMode: string; serviceMode: 'SELF' | 'MANAGED' };
  bot: { name: string; model: string } | null;
  dailyChatsSource: 'manual' | 'registro' | 'estimado';
}

const usd = (n: number) => (n < 0.01 ? `US$${n.toFixed(4)}` : `US$${n.toFixed(2)}`);
const cop = (n: number) => (n < 10 ? `$${n.toLocaleString('es-CO', { maximumFractionDigits: 1 })}` : fmtMoney(n));
const tier = (name: string) => (/haiku|deepseek-v3|deepseek v3/i.test(name) ? 'Premium' : /8b/i.test(name) ? 'Económico' : 'Equilibrado');

export function useAiCosts(q: string, dailyChats?: number) {
  return useQuery({
    queryKey: ['ai-costs', q, dailyChats ?? null],
    queryFn: () => api.get<AiCostEstimate>(withScope(`/ai-costs/estimate${dailyChats ? `?dailyChats=${dailyChats}` : ''}`, q)),
    placeholderData: (prev) => prev,
  });
}

/** Resumen para "Primeros pasos": una frase y el enlace al detalle. */
export function AiCostSummary({ q }: { q: string }) {
  const { data } = useAiCosts(q);
  if (!data) return null;
  const current = data.models.find((m) => m.current) ?? data.models.find((m) => m.recommended) ?? data.models[0];
  if (!current) return null;
  return (
    <section className="border-2 border-ink bg-paper p-5">
      <p className="kicker">Cuánto te cuesta la IA</p>
      <p className="mt-2 text-sm">
        Con unos <b>{data.inputs.dailyChats} clientes al día</b>, atender cada conversación con <b>{current.name}</b> cuesta cerca de{' '}
        <b>{cop(current.perConversation.cop)}</b> ({usd(current.perConversation.usd)}). Al mes serían unos <b>{fmtMoney(current.perMonth.cop)}</b> en IA.
      </p>
      <Link to="/app/costos-ia" className="mt-3 inline-block text-xs font-semibold uppercase tracking-wider underline">
        Ver la explicación completa y comparar modelos
      </Link>
    </section>
  );
}

export default function AiCosts() {
  const { ready, q } = useCompanyScope();
  const [daily, setDaily] = useState<number | null>(null);
  const [debounced, setDebounced] = useState<number | undefined>(undefined);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(daily ?? undefined), 350);
    return () => clearTimeout(t);
  }, [daily]);
  const { data, isLoading } = useAiCosts(q, debounced);
  useEffect(() => {
    if (data && daily === null) setDaily(data.inputs.dailyChats);
  }, [data, daily]);

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading label="Calculando con tus datos…" />;

  const managed = data.company.serviceMode === 'MANAGED';
  const current = data.models.find((m) => m.current);
  const cheapest = data.models[0];
  const words = Math.round((data.tokens.fixedPerMessage * data.assumptions.charsPerToken) / 6);

  return (
    <>
      <PageHeader kicker="Transparencia total" title="Cuánto cuesta" accent="tu IA" />

      <Card className="mb-6">
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3 text-[15px] leading-relaxed">
            <p>
              Tu asistente usa inteligencia artificial para leer lo que escribe tu cliente y responderle. Los proveedores de IA cobran por
              <b> tokens</b>: pedacitos de palabras (más o menos 4 letras cada uno).
            </p>
            <p>
              En <b>cada respuesta</b>, el asistente vuelve a leer tus instrucciones, tu catálogo y lo que se ha hablado: hoy son unas
              <b> {words.toLocaleString('es-CO')} palabras</b>. Por eso lee mucho más de lo que escribe, y por eso un catálogo o unas instrucciones
              muy largas hacen que cada conversación cueste un poco más.
            </p>
            <p>
              Contamos una <b>conversación</b> como un cliente atendido en 24 horas, unos {data.assumptions.turnsPerConversation} mensajes de ida y vuelta.
            </p>
          </div>
          <div className="border-2 border-ink bg-bone p-4">
            <label className="block">
              <span className="kicker">¿Cuántos clientes te escriben al día?</span>
              <input
                type="range"
                min={1}
                max={300}
                value={daily ?? data.inputs.dailyChats}
                onChange={(e) => setDaily(Number(e.target.value))}
                className="mt-3 w-full accent-[#1a1a1a]"
              />
            </label>
            <p className="display mt-1 text-4xl">{daily ?? data.inputs.dailyChats}</p>
            <p className="text-xs text-ink-3">
              al día · {(daily ?? data.inputs.dailyChats) * 30} conversaciones al mes
              {data.dailyChatsSource === 'registro' && daily === data.inputs.dailyChats ? ' · lo que nos contaste al registrarte' : ''}
            </p>
          </div>
        </div>
      </Card>

      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <div className="border-2 border-ink bg-paper p-4">
          <p className="kicker">{current ? `Tu modelo: ${current.name}` : 'Por conversación'}</p>
          <p className="display mt-1 text-3xl">{cop((current ?? cheapest).perConversation.cop)}</p>
          <p className="text-xs text-ink-3">{usd((current ?? cheapest).perConversation.usd)} por conversación</p>
        </div>
        <div className="border-2 border-ink bg-paper p-4">
          <p className="kicker">Al mes, con tu volumen</p>
          <p className="display mt-1 text-3xl">{fmtMoney((current ?? cheapest).perMonth.cop)}</p>
          <p className="text-xs text-ink-3">{usd((current ?? cheapest).perMonth.usd)}{managed ? ' · se suma a tu factura a fin de mes' : ' · lo pagas directo a tu proveedor'}</p>
        </div>
        <div className="border-2 border-ink bg-paper p-4">
          <p className="kicker">Preguntas a tus reportes</p>
          <p className="display mt-1 text-3xl">{cop((current ?? cheapest).report.perQuery.cop)}</p>
          <p className="text-xs text-ink-3">por pregunta · {fmtMoney((current ?? cheapest).report.perMonth.cop)} al mes con 3 diarias</p>
        </div>
      </div>

      <Card kicker="Compara modelos con tus números" title="Modelos disponibles" className="mb-6">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <th className="py-2">Modelo</th>
                <th className="py-2 text-right">Por conversación</th>
                <th className="py-2 text-right">Al mes</th>
                <th className="py-2 text-right">Pregunta al reporte</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((m) => (
                <tr key={m.modelId} className={clsx('border-b border-line align-top', m.current && 'bg-ok-soft')}>
                  <td className="py-3 pr-3">
                    <p className="font-semibold">
                      {m.name}{' '}
                      {m.current && <Badge tone="ok">Tu asistente</Badge>}{' '}
                      {m.recommended && !m.current && <Badge tone="ink">Recomendado</Badge>}{' '}
                      <Badge tone={tier(m.name) === 'Premium' ? 'warn' : 'neutral'}>{tier(m.name)}</Badge>
                    </p>
                    {m.notes && <p className="mt-0.5 max-w-md text-xs text-ink-3">{m.notes}</p>}
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      US${m.pricePerMTok.input} por millón de tokens leídos · US${m.pricePerMTok.output} por millón escritos
                    </p>
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    <b>{cop(m.perConversation.cop)}</b>
                    <span className="block text-[11px] text-ink-3">{usd(m.perConversation.usd)}</span>
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {fmtMoney(m.perMonth.cop)}
                    <span className="block text-[11px] text-ink-3">{usd(m.perMonth.usd)}</span>
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {cop(m.report.perQuery.cop)}
                    <span className="block text-[11px] text-ink-3">{usd(m.report.perQuery.usd)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card kicker="Dos formas de pagar la IA" title="¿Cuál te conviene?">
          <div className="space-y-4 text-sm">
            <div className={clsx('border-2 p-3', managed ? 'border-ink bg-ok-soft' : 'border-line')}>
              <p className="font-semibold">Todo incluido {managed && <Badge tone="ok">La que usas</Badge>}</p>
              <p className="mt-1 text-ink-2">
                Nosotros gestionamos la IA y los mensajes. A fin de mes pagas tu mensualidad más la IA que usaste, en pesos y en la misma factura.
                Tu mensualidad ya trae US$10 de mensajes de Meta; si usas más, el excedente sale en la factura. Incluye mantenimiento 24/7.
              </p>
            </div>
            <div className={clsx('border-2 p-3', !managed ? 'border-ink bg-ok-soft' : 'border-line')}>
              <p className="font-semibold">Tu IA {!managed && <Badge tone="ok">La que usas</Badge>}</p>
              <p className="mt-1 text-ink-2">
                Pagas la IA directo al proveedor (DeepInfra u OpenRouter) con tu tarjeta, en dólares, y los mensajes de WhatsApp directo a Meta vía Twilio.
                La mensualidad es más baja. Los modelos premium de Anthropic solo están en Todo incluido.
              </p>
            </div>
          </div>
        </Card>

        <Card kicker="Cómo lo calculamos" title="Sin letra pequeña">
          <ul className="space-y-2 text-sm text-ink-2">
            <li>
              <b>Lo que lee el asistente en cada mensaje:</b> reglas fijas ({data.tokens.breakdown.engine.toLocaleString('es-CO')} tokens), tus instrucciones (
              {data.tokens.breakdown.prompt.toLocaleString('es-CO')}), tu catálogo ({data.tokens.breakdown.catalog.toLocaleString('es-CO')})
              {data.tokens.breakdown.knowledge ? ` y tu base de conocimiento (${data.tokens.breakdown.knowledge.toLocaleString('es-CO')})` : ''}.
            </li>
            <li>
              <b>Una conversación completa:</b> lee {data.tokens.input.toLocaleString('es-CO')} tokens y escribe {data.tokens.output.toLocaleString('es-CO')}
              {data.inputs.agentMode ? ' (tu asistente hace tareas como tomar pedidos, por eso consulta un poco más)' : ''}.
            </li>
            <li><b>Dólar:</b> usamos una TRM de {fmtMoney(data.assumptions.trm)}. Los proveedores cobran en dólares.</li>
            <li>
              <b>Reportes:</b> el reporte diario se arma con cálculos normales y <b>no gasta IA</b>. Solo cuando le preguntas algo con tus palabras
              ("¿cuánto vendí esta semana?") se usa IA: 2 consultas cortas por pregunta.
            </li>
            <li className="flex gap-2 border-t border-line pt-2 text-xs">
              <Info size={14} className="mt-0.5 shrink-0" />
              Son estimaciones con tus datos de hoy. El valor real depende de cuánto conversen tus clientes. En Consumo IA ves lo que gastas de verdad, día a día.
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
