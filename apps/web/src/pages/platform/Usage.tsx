import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtNum, fmtUsd, timeAgo } from '../../lib/format';
import type { Company, PlatformAiUsage } from '../../lib/types';
import { Badge, Card, Loading, PageHeader, Select, Stat, Table } from '../../components/ui';
import { CostSeriesChart } from '../../components/charts';

const RANGES = [
  { days: 7, label: 'Últimos 7 días' },
  { days: 30, label: 'Últimos 30 días' },
  { days: 90, label: 'Últimos 90 días' },
];

export default function PlatformUsage() {
  const navigate = useNavigate();
  const [days, setDays] = useState(30);
  const [companyId, setCompanyId] = useState('');

  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['ai-usage-platform', days, companyId],
    queryFn: () =>
      api.get<PlatformAiUsage>(
        `/ai-usage/platform?days=${days}${companyId ? `&companyId=${companyId}` : ''}`,
      ),
    refetchInterval: 30_000, // en vivo
  });

  if (isLoading || !data) return <Loading label="Calculando consumo de IA…" />;
  const { kpis } = data;

  return (
    <>
      <PageHeader
        kicker="BYOK · cada empresa paga su IA directo a DeepInfra"
        title="Consumo IA"
        accent="global."
        actions={
          <p className="kicker self-center">
            En vivo · actualizado {timeAgo(data.generatedAt)}
          </p>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="max-w-[180px]" aria-label="Rango">
          {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
        </Select>
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="max-w-[220px]" aria-label="Empresa">
          <option value="">Todas las empresas</option>
          {companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label={`Gasto (${days}d)`} value={fmtUsd(kpis.costRange)} hint={`${fmtNum(kpis.events)} respuestas`} />
        <Stat label="Mes en curso" value={fmtUsd(kpis.costMonth)} hint={`día ${kpis.dayOfMonth} de ${kpis.daysInMonth}`} />
        <Stat label="Proyección fin de mes" value={fmtUsd(kpis.projectedMonth)} hint="Al ritmo actual" />
        <Stat label="Tokens del mes" value={fmtNum(kpis.tokensMonth)} />
        <Stat
          label="Llaves conectadas"
          value={`${kpis.companiesWithKey}/${kpis.companies}`}
          tone={(kpis.companiesWithKey ?? 0) < (kpis.companies ?? 0) ? 'warn' : 'ok'}
          hint="Empresas con BYOK activo"
        />
      </div>

      <div className="mt-6">
        <Card kicker="Todas las empresas · costo diario (USD)" title="Gasto de IA por día">
          <CostSeriesChart data={data.series} />
        </Card>
      </div>

      <div className="mt-6">
        <div className="mb-3">
          <p className="kicker">Ranking por gasto en el rango</p>
          <h2 className="display text-2xl">Consumo por empresa</h2>
        </div>
        <Table head={['Empresa', 'Llave', 'Respuestas', 'Tokens', `Gasto (${days}d)`, 'Mes en curso', 'Proyección', '']}>
          {data.byCompany.map((row) => (
            <tr key={row.companyId}>
              <td className="px-4 py-3">
                <p className="font-semibold">{row.name}</p>
                <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'warn'}>{row.status}</Badge>
              </td>
              <td className="px-4 py-3">
                {row.hasKey ? <Badge tone="ok">Conectada</Badge> : <Badge tone="bad">Sin llave</Badge>}
              </td>
              <td className="px-4 py-3 tabular-nums">{fmtNum(row.events)}</td>
              <td className="px-4 py-3 tabular-nums">{fmtNum(row.tokens)}</td>
              <td className="px-4 py-3 font-semibold tabular-nums">{fmtUsd(row.costUsd)}</td>
              <td className="px-4 py-3 tabular-nums">{fmtUsd(row.costMonth)}</td>
              <td className="px-4 py-3 tabular-nums">{fmtUsd(row.projectedMonth)}</td>
              <td className="px-4 py-3 text-right">
                <button
                  className="cursor-pointer text-xs font-semibold uppercase tracking-wider hover:underline"
                  onClick={() => navigate(`/platform/companies/${row.companyId}`)}
                >
                  Ver empresa →
                </button>
              </td>
            </tr>
          ))}
          {data.byCompany.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-ink-3">Sin consumo en el rango.</td></tr>
          )}
        </Table>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Este gasto NO es facturación de BackOffice: cada empresa lo paga directo a
        DeepInfra con su propia llave. El panel sirve para monitorear la operación
        y detectar picos o llaves faltantes.
      </p>
    </>
  );
}
