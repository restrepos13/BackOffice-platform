import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtNum, fmtUsd, timeAgo } from '../../lib/format';
import type { AuditEntry, PlatformMetrics } from '../../lib/types';
import { Badge, Button, Card, Loading, PageHeader, Stat } from '../../components/ui';
import { BarsChart, CostChart, MessagesChart } from '../../components/charts';

export default function PlatformOverview() {
  const { data, isLoading } = useQuery({
    queryKey: ['metrics-platform'],
    queryFn: () => api.get<PlatformMetrics>('/metrics/platform'),
  });
  const { data: audit } = useQuery({
    queryKey: ['audit-recent'],
    queryFn: () => api.get<AuditEntry[]>('/audit?take=8'),
  });

  if (isLoading || !data) return <Loading label="Cargando plataforma…" />;
  const { kpis } = data;

  return (
    <>
      <PageHeader
        kicker="Panel de plataforma"
        title="La operación"
        accent="completa."
        actions={
          <Link to="/platform/companies/new">
            <Button>+ Nueva empresa</Button>
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="MRR" value={fmtUsd(kpis.mrr)} hint="Suscripciones activas" tone="ok" />
        <Stat
          label="Empresas"
          value={kpis.companies}
          hint={`${kpis.activeCompanies} activas · ${kpis.trialCompanies} en trial`}
        />
        <Stat label="Mensajes 30d" value={fmtNum(kpis.messages30d)} hint="Todos los tenants" />
        <Stat label="Consumo 30d" value={fmtUsd(kpis.consumption30d)} hint="IA + WhatsApp + storage" />
        <Stat label="Bots" value={kpis.bots} hint={`${kpis.users} usuarios totales`} />
        <Stat
          label="Atención"
          value={kpis.attention}
          hint="Conversaciones marcadas"
          tone={kpis.attention > 0 ? 'bad' : 'ok'}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card kicker="Actividad global" title="Mensajes por día">
          <MessagesChart
            data={data.series}
            keys={[{ key: 'messages', name: 'Mensajes' }]}
          />
        </Card>
        <Card kicker="Consumo trasladado al costo" title="Gasto diario (USD)">
          <CostChart data={data.series} />
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card kicker="Top consumo 30d" title="Empresas más activas" className="lg:col-span-1">
          <BarsChart
            data={data.topCompanies}
            dataKey="messages"
            labelKey="name"
            name="Mensajes"
          />
        </Card>
        <Card kicker="Distribución" title="Empresas por plan">
          <BarsChart
            data={data.plansDistribution}
            dataKey="companies"
            labelKey="plan"
            name="Empresas"
          />
        </Card>
        <Card kicker="Trazabilidad" title="Última actividad">
          <ul className="space-y-3">
            {audit?.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">
                    {entry.detail ?? entry.action}
                  </p>
                  <p className="kicker mt-0.5">
                    {entry.actorName}
                    {entry.company ? ` · ${entry.company.name}` : ''}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-ink-3">{timeAgo(entry.createdAt)}</span>
              </li>
            ))}
            {(!audit || audit.length === 0) && (
              <p className="text-sm text-ink-3">Sin actividad registrada.</p>
            )}
          </ul>
        </Card>
      </div>
    </>
  );
}
