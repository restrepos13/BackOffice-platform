import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtCop, fmtMoney, fmtNum, fmtUsd, timeAgo } from '../../lib/format';
import type { AiCreditsStatus, CompanyAiUsage, MonthlyConsumption, Payment } from '../../lib/types';
import { Badge, Card, Loading, PageHeader, Select, Stat, Table } from '../../components/ui';
import { CostSeriesChart } from '../../components/charts';
import { useAiModels } from '../../components/media';
import ScheduleCall from '../../components/ScheduleCall';
import { PickCompany, useCompanyScope, withScope } from './shared';
import { useState } from 'react';

const RANGES = [
  { days: 7, label: 'Últimos 7 días' },
  { days: 30, label: 'Últimos 30 días' },
  { days: 90, label: 'Últimos 90 días' },
];

const CATEGORY_LABELS: Record<string, string> = {
  SERVICIO: 'Servicio (ventana 24 h — sin costo)',
  UTILIDAD: 'Utilidad (plantillas)',
  MARKETING: 'Marketing',
};

/** Consumo del mes en la moneda de la empresa: mensajes Meta + IA + comparativo. */
function MonthlySection({ q }: { q: string }) {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const path = withScope(`/ai-usage/consumption?month=${month}`, q);
  const { data, isLoading } = useQuery({
    queryKey: ['consumption', path],
    queryFn: () => api.get<MonthlyConsumption>(path),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <Loading label="Calculando consumo del mes…" />;
  const { current, previous, deltaPct } = data;
  const inCop = data.currency === 'COP';
  const money = (usd: number, cop?: number) => (inCop && cop != null ? fmtCop(cop) : fmtUsd(usd));

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b-2 border-ink pb-3">
        <div>
          <p className="kicker">Mensajes de WhatsApp + IA · en {data.currency}</p>
          <h2 className="display text-2xl">Consumo del mes</h2>
        </div>
        <div className="flex items-center gap-3">
          {inCop && (
            <p className="kicker self-center">TRM usada: {fmtCop(data.usdCopRate)}/USD</p>
          )}
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border-2 border-ink bg-bone px-3 py-2 text-sm"
            aria-label="Mes"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Total del mes"
          value={money(current.totalUsd, current.totalCop)}
          hint={previous.totalUsd > 0 ? `Mes anterior: ${money(previous.totalUsd, previous.totalCop)}` : 'Sin datos del mes anterior'}
          tone={deltaPct != null && deltaPct > 25 ? 'warn' : undefined}
        />
        <Stat
          label="Vs. mes anterior"
          value={deltaPct == null ? '—' : `${deltaPct > 0 ? '+' : ''}${deltaPct}%`}
          tone={deltaPct == null ? undefined : deltaPct > 0 ? 'warn' : 'ok'}
        />
        <Stat
          label="Mensajes Meta"
          value={fmtNum(current.meta.totalMessages)}
          hint={money(current.meta.costUsd, current.meta.costCop)}
        />
        <Stat
          label="IA (tokens)"
          value={fmtNum(current.ai.inputTokens + current.ai.outputTokens)}
          hint={`${fmtNum(current.ai.events)} respuestas · ${money(current.ai.costUsd, current.ai.costCop)}`}
        />
      </div>

      <div className="mt-5 max-w-2xl">
        <Table head={['Categoría Meta', 'Mensajes', 'Costo']}>
          {current.meta.byCategory.map((row) => (
            <tr key={row.category}>
              <td className="px-4 py-2.5 text-sm">{CATEGORY_LABELS[row.category] ?? row.category}</td>
              <td className="px-4 py-2.5 tabular-nums">{fmtNum(row.count)}</td>
              <td className="px-4 py-2.5 font-semibold tabular-nums">{money(row.costUsd, row.costCop)}</td>
            </tr>
          ))}
          {current.meta.byCategory.length === 0 && (
            <tr><td colSpan={3} className="px-4 py-6 text-center text-ink-3">Sin mensajes salientes este mes.</td></tr>
          )}
        </Table>
      </div>
      <p className="mt-3 text-xs text-ink-3">
        Las respuestas dentro de la ventana de 24 h (Servicio) no tienen costo por
        mensaje. Las tarifas por categoría son configurables por organización.
      </p>
    </section>
  );
}

/** Saldo de IA de BackOffice: incluidas del mes + paquetes prepagos, y compra. */
function CreditsPanel({ q, canBuy }: { q: string; canBuy: boolean }) {
  const { data } = useQuery({
    queryKey: ['ai-credits', q],
    queryFn: () => api.get<AiCreditsStatus>(withScope('/ai-credits/status', q)),
    refetchInterval: 30_000,
  });
  const buy = useMutation({
    mutationFn: (packageId: string) => api.post<Payment>(withScope('/ai-credits/checkout', q), { packageId }),
    onSuccess: (payment) => {
      if (!payment.configured) toast.warning('Wompi aún sin llaves de comercio: el pago se generó en modo demostración.');
      if (payment.checkoutUrl) window.open(payment.checkoutUrl, '_blank', 'noopener');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (!data) return null;
  const { credits } = data;
  const empty = credits.available <= 0;
  return (
    <section className="mb-6 border-2 border-ink bg-paper">
      <div className="grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="border-b-2 border-ink p-5 md:border-b-0 md:border-r-2">
          <p className="kicker">Conversaciones con IA disponibles</p>
          <p className={`display mt-1 text-5xl ${empty ? 'text-bad' : credits.lowBalance ? 'text-warn' : ''}`}>{fmtNum(credits.available)}</p>
          <p className="mt-1 text-xs text-ink-3">
            {fmtNum(credits.includedLeft)} incluidas este mes · {fmtNum(credits.balance)} prepagas
            {credits.nextExpiry ? ` · el paquete más viejo vence ${new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(credits.nextExpiry))}` : ''}
          </p>
          {(empty || credits.lowBalance) && (
            <p className={`mt-3 border-2 px-3 py-2 text-xs font-semibold ${empty ? 'border-bad bg-bad-soft text-bad' : 'border-warn bg-warn-soft text-warn'}`}>
              {empty
                ? 'Sin saldo: las conversaciones pasan a tu equipo (o a tu cuenta de DeepInfra si estás en híbrido).'
                : 'Te queda poco saldo: recarga para que tu asistente no se detenga.'}
            </p>
          )}
          <p className="mt-3 text-xs text-ink-3">1 conversación = un cliente atendido por la IA en 24 h, sin importar cuántos mensajes.</p>
        </div>
        <div className="p-5">
          <p className="kicker mb-3">Recargar</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.packages.map((pkg) => (
              <button
                key={pkg.id}
                type="button"
                disabled={!canBuy || buy.isPending}
                onClick={() => buy.mutate(pkg.id)}
                className="cursor-pointer border-2 border-ink bg-bone px-4 py-3 text-left transition-colors hover:bg-ink hover:text-bone disabled:cursor-not-allowed disabled:opacity-50"
              >
                <p className="text-sm font-semibold">{fmtNum(pkg.conversations)} conversaciones</p>
                <p className="text-xs opacity-80">
                  {fmtMoney(pkg.price, pkg.currency)} · {fmtMoney(Math.round(pkg.price / pkg.conversations), pkg.currency)} c/u · vigencia {pkg.validityMonths} meses
                </p>
              </button>
            ))}
            {data.packages.length === 0 && <p className="text-sm text-ink-3">No hay paquetes disponibles.</p>}
          </div>
          {data.lots.length > 0 && (
            <details className="mt-4 text-xs">
              <summary className="kicker cursor-pointer">Historial de paquetes</summary>
              <ul className="mt-2 divide-y divide-line border-2 border-line">
                {data.lots.map((lot) => (
                  <li key={lot.id} className="flex justify-between px-3 py-1.5">
                    <span>{lot.source === 'GRANT' ? 'Cortesía' : 'Compra'}{lot.note ? ` · ${lot.note}` : ''}</span>
                    <span className={lot.expired ? 'text-bad' : ''}>
                      {fmtNum(lot.remaining)}/{fmtNum(lot.total)} · {lot.expired ? 'vencido' : `vence ${new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(lot.expiresAt))}`}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Usage() {
  const { ready, q, canWrite } = useCompanyScope();
  const [days, setDays] = useState(30);
  const [lineId, setLineId] = useState('');
  const [model, setModel] = useState('');
  const { data: models } = useAiModels();

  const path = withScope(
    `/ai-usage/company?days=${days}${lineId ? `&integrationId=${lineId}` : ''}${model ? `&model=${encodeURIComponent(model)}` : ''}`,
    q,
  );
  const { data, isLoading } = useQuery({
    queryKey: ['ai-usage', path],
    queryFn: () => api.get<CompanyAiUsage>(path),
    enabled: ready,
    refetchInterval: 30_000, // en vivo
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading label="Calculando consumo de IA…" />;
  const { kpis } = data;
  const platformAi = data.aiBillingMode === 'PLATFORM';
  const hybridAi = data.aiBillingMode === 'HYBRID';
  const usesPlatform = platformAi || hybridAi || (data.byBilling?.PLATFORM.events ?? 0) > 0;

  return (
    <>
      <PageHeader
        kicker={
          platformAi ? 'IA de BackOffice · incluida en tu plan'
            : hybridAi ? 'Híbrido · tu cuenta de DeepInfra + IA de BackOffice'
              : 'BYOK · pagado directo a DeepInfra con tu llave'
        }
        title="Consumo"
        accent="IA."
        actions={
          <p className="kicker self-center">
            En vivo · actualizado {timeAgo(data.generatedAt)}
          </p>
        }
      />

      {usesPlatform && <CreditsPanel q={q} canBuy={canWrite} />}

      {hybridAi && data.byBilling && (
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <Stat
            label="Con tu cuenta DeepInfra"
            value={fmtUsd(data.byBilling.BYOK.costUsd)}
            hint={`${fmtNum(data.byBilling.BYOK.events)} respuestas · lo pagas directo al proveedor`}
          />
          <Stat
            label="Con la IA de BackOffice"
            value={fmtNum(data.byBilling.PLATFORM.events)}
            hint="respuestas · descuentan de tu saldo prepago"
          />
        </div>
      )}

      {!platformAi && !data.hasDeepinfraKey && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-2 border-warn bg-warn-soft px-4 py-2.5">
          <p className="text-sm text-warn">
            <strong>Tu inteligencia artificial aún no está conectada.</strong>{' '}
            {hybridAi
              ? 'Mientras tanto responde la IA de BackOffice. La conectamos contigo en una llamada.'
              : 'La conectamos nosotros contigo en una llamada corta: tú no tienes que hacer nada técnico.'}
          </p>
          <ScheduleCall q={q} topic="AI" size="sm" label="Agéndame con un agente" />
        </div>
      )}

      {/* Filtros */}
      <div className="mb-4 flex flex-wrap gap-3">
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="max-w-[180px]" aria-label="Rango">
          {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
        </Select>
        {data.lines.length > 1 && (
          <Select value={lineId} onChange={(e) => setLineId(e.target.value)} className="max-w-[220px]" aria-label="Línea">
            <option value="">Todas las líneas</option>
            {data.lines.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
          </Select>
        )}
        <Select value={model} onChange={(e) => setModel(e.target.value)} className="max-w-[240px]" aria-label="Modelo">
          <option value="">Todos los modelos</option>
          {models?.map((m) => <option key={m.id} value={m.modelId}>{m.name}</option>)}
        </Select>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={`Gasto (${days}d)`} value={fmtUsd(kpis.costRange)} hint={`${fmtNum(kpis.events)} respuestas`} />
        <Stat label="Mes en curso" value={fmtUsd(kpis.costMonth)} hint={`día ${kpis.dayOfMonth} de ${kpis.daysInMonth}`} />
        <Stat
          label="Proyección fin de mes"
          value={fmtUsd(kpis.projectedMonth)}
          tone={kpis.projectedMonth > kpis.costMonth * 2 ? 'warn' : undefined}
          hint="Al ritmo actual"
        />
        <Stat label="Promedio diario" value={fmtUsd(kpis.avgDaily ?? 0)} />
        <Stat label="Tokens entrada" value={fmtNum(kpis.tokensIn ?? 0)} />
        <Stat label="Tokens salida" value={fmtNum(kpis.tokensOut ?? 0)} hint={`~${fmtUsd(kpis.avgCostPerEvent ?? 0)}/respuesta`} />
      </div>

      {/* Serie */}
      <div className="mt-6">
        <Card kicker="Costo diario (USD)" title="Gasto de IA por día">
          <CostSeriesChart data={data.series} />
        </Card>
      </div>

      {/* Desgloses */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-3">
            <p className="kicker">Desglose</p>
            <h2 className="display text-2xl">Por modelo</h2>
          </div>
          <Table head={['Modelo', 'Respuestas', 'Tokens', 'Costo']}>
            {data.byModel.map((row) => (
              <tr key={row.model}>
                <td className="px-4 py-3 font-mono text-xs">{row.model}</td>
                <td className="px-4 py-3 tabular-nums">{fmtNum(row.events)}</td>
                <td className="px-4 py-3 tabular-nums">{fmtNum(row.tokens)}</td>
                <td className="px-4 py-3 font-semibold tabular-nums">{fmtUsd(row.costUsd)}</td>
              </tr>
            ))}
            {data.byModel.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-3">Sin consumo en el rango.</td></tr>
            )}
          </Table>
        </div>
        <div>
          <div className="mb-3">
            <p className="kicker">Desglose</p>
            <h2 className="display text-2xl">Por línea</h2>
          </div>
          <Table head={['Línea', 'Respuestas', 'Tokens', 'Costo', '']}>
            {data.byLine.map((row) => (
              <tr key={row.integrationId ?? 'none'}>
                <td className="px-4 py-3 font-semibold">{row.name}</td>
                <td className="px-4 py-3 tabular-nums">{fmtNum(row.events)}</td>
                <td className="px-4 py-3 tabular-nums">{fmtNum(row.tokens)}</td>
                <td className="px-4 py-3 font-semibold tabular-nums">{fmtUsd(row.costUsd)}</td>
                <td className="px-4 py-3 text-right">
                  {row.integrationId && (
                    <Link to={`/app/lines/${row.integrationId}`} className="text-xs font-semibold uppercase tracking-wider hover:underline">
                      Configurar →
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {data.byLine.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-3">Sin consumo en el rango.</td></tr>
            )}
          </Table>
        </div>
      </div>

      <MonthlySection q={q} />

      <p className="mt-4 text-xs text-ink-3">
        Los costos usan los precios declarados del catálogo (
        <Link to="/app/billing" className="underline">Facturación → Costos de los modelos IA</Link>
        ).{' '}
        {platformAi
          ? 'Con la IA de BackOffice usas tus conversaciones incluidas y luego tus paquetes prepagos (vencen a los 12 meses).'
          : hybridAi
            ? 'Lo que responde tu cuenta te lo cobra DeepInfra directo; lo que responde la IA de BackOffice se cobra por conversación según tu plan.'
            : 'Este gasto te lo cobra DeepInfra directamente con tu llave — BackOffice no le gana nada.'}
      </p>
    </>
  );
}
