import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtNum, fmtUsd, STAGE_LABELS } from '../../lib/format';
import type { CompanyMetrics } from '../../lib/types';
import { Badge, Button, Card, Loading, PageHeader, Stat, statusTone } from '../../components/ui';
import { BarsChart, MessagesChart } from '../../components/charts';
import { PickCompany, useCompanyScope, withScope } from './shared';

export default function Dashboard() {
  const { ready, q } = useCompanyScope();
  const { data, isLoading } = useQuery({
    queryKey: ['metrics-company', q],
    queryFn: () => api.get<CompanyMetrics>(withScope('/metrics/company', q)),
    enabled: ready,
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading label="Cargando dashboard…" />;
  const { kpis } = data;

  return (
    <>
      <PageHeader
        kicker="Panel de empresa"
        title="Tu operación,"
        accent="en vivo."
        actions={
          kpis.attention > 0 ? (
            <Link to="/app/inbox?attention=1">
              <Button variant="danger">
                {kpis.attention} conversación{kpis.attention > 1 ? 'es' : ''} necesita atención →
              </Button>
            </Link>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Conversaciones hoy" value={kpis.conversationsToday} hint={`${kpis.conversations7d} esta semana`} />
        <Stat label="Abiertas" value={kpis.openConversations} hint="Sin resolver" />
        <Stat
          label="Necesitan atención" value={kpis.attention}
          tone={kpis.attention > 0 ? 'bad' : 'ok'} hint="Supervisión humana"
        />
        <Stat label="Leads calientes" value={kpis.hotLeads} tone="warn" hint={`${kpis.newContacts7d} contactos nuevos 7d`} />
        <Stat label="Mensajes 30d" value={fmtNum(kpis.messages30d)} hint={`${kpis.activeBots} bots activos`} />
        <Stat label="Consumo 30d" value={fmtUsd(kpis.consumption30d)} hint="IA + WhatsApp + storage" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card kicker="Actividad" title="Mensajes por día" className="lg:col-span-2">
          <MessagesChart
            data={data.series}
            keys={[
              { key: 'messagesIn', name: 'Recibidos' },
              { key: 'messagesOut', name: 'Respondidos' },
            ]}
          />
        </Card>
        <Card kicker="CRM" title="Embudo de leads">
          <BarsChart
            data={data.funnel.map((f) => ({ ...f, label: STAGE_LABELS[f.stage] }))}
            dataKey="count"
            labelKey="label"
            name="Contactos"
          />
        </Card>
      </div>

      {/* Líneas más activas (perfiles / números) */}
      {data.lines.length > 0 && (
        <div className="mt-6">
          <Card
            kicker="Mensajes 30d por número"
            title="Tus líneas"
            actions={
              <Link to="/app/analytics">
                <Button size="sm" variant="outline">Ranking completo →</Button>
              </Link>
            }
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {data.lines.slice(0, 4).map((line) => (
                <Link
                  key={line.id}
                  to={`/app/lines/${line.id}`}
                  className="block border-2 border-line bg-bone px-3 py-2 transition-colors hover:border-ink"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{line.name}</p>
                    {line.attention > 0 && <Badge tone="bad">{line.attention}</Badge>}
                  </div>
                  <p className="display mt-1 text-2xl">{fmtNum(line.messages30d)}</p>
                  <p className="text-[11px] text-ink-3">
                    {line.conversations} conversaciones · {line.promptMode === 'CUSTOM' ? 'personalidad propia' : 'hereda del bot'}
                  </p>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card kicker="Asistentes" title="Tus bots">
          <ul className="space-y-3">
            {data.bots.map((bot) => (
              <li key={bot.id} className="flex items-center justify-between border-b border-line pb-2 last:border-0">
                <Link to={`/app/bots/${bot.id}`} className="text-sm font-semibold hover:underline">
                  {bot.name}
                </Link>
                <Badge tone={statusTone(bot.status)}>
                  {bot.status === 'ACTIVE' ? 'Activo' : bot.status === 'PAUSED' ? 'Pausado' : 'Borrador'}
                </Badge>
              </li>
            ))}
            {data.bots.length === 0 && <p className="text-sm text-ink-3">Sin bots todavía.</p>}
          </ul>
        </Card>
        <Card kicker="Canales" title="Conversaciones por canal">
          <BarsChart
            data={data.channelBreakdown}
            dataKey="count"
            labelKey="channel"
            name="Conversaciones"
            height={180}
          />
        </Card>
        <Card kicker="Resumen" title="Base de clientes">
          <div className="grid grid-cols-2 gap-3">
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Contactos</p>
              <p className="display text-2xl">{kpis.contacts}</p>
            </div>
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Clientes</p>
              <p className="display text-2xl text-ok">{kpis.clients}</p>
            </div>
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Automatizaciones</p>
              <p className="display text-2xl">{kpis.activeAutomations}</p>
            </div>
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Bots activos</p>
              <p className="display text-2xl">{kpis.activeBots}</p>
            </div>
          </div>
          <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
            Tu base de datos de clientes es 100% tuya: cada conversación la
            alimenta y queda lista para tus campañas.
          </p>
        </Card>
      </div>
    </>
  );
}
