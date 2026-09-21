import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtNum, fmtUsd, INTEGRATION_STATUS_LABELS, STAGE_LABELS } from '../../lib/format';
import type { CompanyMetrics } from '../../lib/types';
import { Badge, Card, Loading, PageHeader, Stat, Table, statusTone } from '../../components/ui';
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

      {/* Ranking por línea — el "analytics por modelo" */}
      {data.lines.length > 0 && (
        <div className="mt-6">
          <div className="mb-3">
            <p className="kicker">Analytics por línea / perfil</p>
            <h2 className="display text-2xl">Ranking de líneas</h2>
          </div>
          <Table head={['#', 'Línea', 'Estado', 'IA', 'Mensajes 30d', 'Conversaciones', 'Abiertas', 'Atención', '']}>
            {data.lines.map((line, index) => (
              <tr key={line.id}>
                <td className="px-4 py-3 font-display text-lg">{String(index + 1).padStart(2, '0')}</td>
                <td className="px-4 py-3">
                  <p className="font-semibold">{line.name}</p>
                  <p className="font-mono text-xs text-ink-3">{line.displayPhone || '—'}</p>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={statusTone(line.status)}>
                    {INTEGRATION_STATUS_LABELS[line.status]}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={line.promptMode === 'CUSTOM' ? 'ink' : 'neutral'}>
                    {line.promptMode === 'CUSTOM' ? 'Propia' : 'Hereda'}
                  </Badge>
                </td>
                <td className="px-4 py-3 font-semibold tabular-nums">{fmtNum(line.messages30d)}</td>
                <td className="px-4 py-3 tabular-nums">{line.conversations}</td>
                <td className="px-4 py-3 tabular-nums">{line.open}</td>
                <td className="px-4 py-3">
                  {line.attention > 0 ? (
                    <Badge tone="bad">{line.attention}</Badge>
                  ) : (
                    <span className="text-ink-3">0</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link to={`/app/lines/${line.id}`} className="text-xs font-semibold uppercase tracking-wider hover:underline">
                    Configurar →
                  </Link>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

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
