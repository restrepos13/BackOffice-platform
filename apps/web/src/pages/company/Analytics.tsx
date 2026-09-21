import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtNum, fmtUsd, STAGE_LABELS } from '../../lib/format';
import type { CompanyMetrics } from '../../lib/types';
import { Card, Loading, PageHeader, Stat } from '../../components/ui';
import { BarsChart, CostChart, MessagesChart } from '../../components/charts';
import { PickCompany, useCompanyScope, withScope } from './shared';

export default function Analytics() {
  const { ready, q } = useCompanyScope();
  const { data, isLoading } = useQuery({
    queryKey: ['metrics-company', q],
    queryFn: () => api.get<CompanyMetrics>(withScope('/metrics/company', q)),
    enabled: ready,
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading label="Calculando métricas…" />;

  const totalTokens = data.series.reduce((s, r) => s + r.aiTokens, 0);
  const totalIn = data.series.reduce((s, r) => s + r.messagesIn, 0);
  const totalOut = data.series.reduce((s, r) => s + r.messagesOut, 0);
  const responseRate = totalIn > 0 ? Math.min(100, (totalOut / totalIn) * 100) : 0;

  return (
    <>
      <PageHeader kicker="Últimos 30 días" title="Analytics" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Mensajes recibidos" value={fmtNum(totalIn)} />
        <Stat label="Respondidos por IA" value={fmtNum(totalOut)} />
        <Stat label="Tasa de respuesta" value={`${responseRate.toFixed(0)}%`} tone={responseRate >= 95 ? 'ok' : 'warn'} />
        <Stat label="Tokens IA" value={fmtNum(totalTokens)} />
        <Stat label="Consumo 30d" value={fmtUsd(data.kpis.consumption30d)} />
        <Stat label="Leads calientes" value={data.kpis.hotLeads} tone="warn" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card kicker="Volumen" title="Mensajes por día">
          <MessagesChart
            data={data.series}
            keys={[
              { key: 'messagesIn', name: 'Recibidos' },
              { key: 'messagesOut', name: 'Respondidos' },
            ]}
          />
        </Card>
        <Card kicker="Trasladado al costo, sin margen" title="Consumo diario (USD)">
          <CostChart data={data.series} />
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card kicker="CRM" title="Embudo de leads">
          <BarsChart
            data={data.funnel.map((f) => ({ ...f, label: STAGE_LABELS[f.stage] }))}
            dataKey="count" labelKey="label" name="Contactos"
          />
        </Card>
        <Card kicker="Origen" title="Conversaciones por canal">
          <BarsChart
            data={data.channelBreakdown}
            dataKey="count" labelKey="channel" name="Conversaciones"
          />
        </Card>
      </div>
    </>
  );
}
