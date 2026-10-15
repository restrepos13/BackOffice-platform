import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtCop, fmtNum, fmtUsd, timeAgo } from '../../lib/format';
import type { AiQuota, CompanyAiUsage, MonthlyConsumption } from '../../lib/types';
import { Badge, Card, Loading, PageHeader, Select, Stat, Table } from '../../components/ui';
import { CostSeriesChart } from '../../components/charts';
import { useAiModels } from '../../components/media';
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

/** Conversaciones IA del mes vs. incluidas en el plan (modo IA de BackOffice). */
function QuotaBanner({ quota }: { quota: AiQuota }) {
  const pct = quota.included > 0 ? Math.min(100, Math.round((quota.conversations / quota.included) * 100)) : null;
  const over = quota.extra > 0;
  return (
    <section className="mb-4 border-2 border-ink bg-paper px-5 py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="kicker">Conversaciones con IA · {quota.period}</p>
          <p className="display mt-1 text-4xl">
            {fmtNum(quota.conversations)}
            {quota.included > 0 && <span className="text-ink-3"> / {fmtNum(quota.included)}</span>}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            {quota.included > 0 ? 'incluidas en tu plan este mes' : 'conversaciones atendidas por la IA este mes'}
          </p>
        </div>
        {over && (
          <div className="text-right">
            <Badge tone="warn">{fmtNum(quota.extra)} adicionales</Badge>
            {quota.extraChargeUsd > 0 && (
              <p className="mt-1 text-xs text-ink-2">
                {fmtUsd(quota.extraChargeUsd)} en la próxima factura ({fmtUsd(quota.extraPriceUsd)} c/u)
              </p>
            )}
          </div>
        )}
      </div>
      {pct != null && (
        <div className="mt-3 h-2.5 border-2 border-ink bg-bone" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className={over ? 'h-full bg-warn' : 'h-full bg-ink'} style={{ width: `${pct}%` }} />
        </div>
      )}
      {quota.capReached && (
        <p className="mt-3 text-sm font-semibold text-bad">
          Se alcanzó el tope de gasto del mes: la IA pasa las conversaciones al equipo hasta que se amplíe.
        </p>
      )}
    </section>
  );
}

export default function Usage() {
  const { ready, q } = useCompanyScope();
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

  return (
    <>
      <PageHeader
        kicker={platformAi ? 'IA de BackOffice · incluida en tu plan' : 'BYOK · pagado directo a DeepInfra con tu llave'}
        title="Consumo"
        accent="IA."
        actions={
          <p className="kicker self-center">
            En vivo · actualizado {timeAgo(data.generatedAt)}
          </p>
        }
      />

      {platformAi && data.quota && <QuotaBanner quota={data.quota} />}

      {!platformAi && !data.hasDeepinfraKey && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-2 border-warn bg-warn-soft px-4 py-2.5">
          <p className="text-sm text-warn">
            <strong>Sin llave de DeepInfra.</strong> Tu IA no podrá responder hasta
            conectarla — el costo lo pagas tú directo al proveedor, sin margen nuestro.
          </p>
          <Link to="/app/settings" className="text-xs font-semibold uppercase tracking-wider text-warn underline">
            Conectar llave →
          </Link>
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
          ? 'Con la IA de BackOffice pagas por conversación: las incluidas en tu plan y, si te pasas, el excedente en la factura del mes.'
          : 'Este gasto te lo cobra DeepInfra directamente con tu llave — BackOffice no le gana nada.'}
      </p>
    </>
  );
}
