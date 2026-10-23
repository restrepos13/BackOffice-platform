import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Stat } from '../../../components/ui';
import { PickCompany, useCompanyScope } from '../shared';
import { NewProductionModal } from './List';
import { type ProductionSummary, type TeamResponse, StatusBadge, fmtDate, prodApi } from './shared';

interface Overview {
  counts: { open: number; unassigned: number; briefIncomplete: number; quotesPendingApproval: number; overdueTasks: number; upcoming: number; openIssues: number; testRecords: number };
  byStatus: Array<{ status: string; label: string; count: number }>;
  upcoming: ProductionSummary[];
  overdueTasks: Array<{ id: string; title: string; dueAt: string; productionId: string; productionCode?: string; assigneeName: string | null }>;
  openIssues: Array<{ id: string; kind: string; severity: string; description: string; productionId: string; productionCode?: string }>;
}

/** Inicio de producciones: solo conteos reales del servidor. Sin datos, estados vacíos. */
export default function ProductionsHome() {
  const { ready, q } = useCompanyScope();
  const [creating, setCreating] = useState(false);
  const ov = useQuery({ queryKey: ['productions-overview', q], queryFn: () => prodApi.get<Overview>(q, '/overview'), enabled: ready });
  const team = useQuery({ queryKey: ['production-team', q], queryFn: () => prodApi.get<TeamResponse>(q, '/team'), enabled: ready });
  const can = new Set(team.data?.me.permissions ?? []);
  if (!ready) return <PickCompany />;
  if (ov.isLoading) return <Loading />;
  if (ov.isError) return <EmptyState title="No se pudo cargar" hint={(ov.error as Error).message} />;
  const c = ov.data!.counts;
  const link = (to: string, n: number, label: string, tone?: 'ok' | 'warn' | 'bad') => (
    <Link to={to} className="block"><Stat label={label} value={n} tone={n ? tone : undefined} /></Link>
  );
  return (
    <>
      <PageHeader
        kicker="Automation · Producciones"
        title="Inicio de producciones"
        actions={can.has('edit') ? <Button onClick={() => setCreating(true)}>+ Nueva solicitud</Button> : undefined}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {link('/app/productions/list', c.open, 'Solicitudes abiertas')}
        {link('/app/productions/list?ownerId=none', c.unassigned, 'Sin responsable', 'warn')}
        {link('/app/productions/list?status=NUEVA,BRIEF_INCOMPLETO', c.briefIncomplete, 'Briefs incompletos', 'warn')}
        {link('/app/productions/list?status=COTIZACION_PENDIENTE_APROBACION', c.quotesPendingApproval, 'Cotizaciones por aprobar', 'warn')}
        <Stat label="Tareas vencidas" value={c.overdueTasks} tone={c.overdueTasks ? 'bad' : undefined} />
        <Stat label="Producciones en 14 días" value={c.upcoming} />
        <Stat label="Incidencias abiertas" value={c.openIssues} tone={c.openIssues ? 'bad' : undefined} />
        <Stat label="Registros de prueba" value={c.testRecords} hint="No cuentan en estas cifras" />
      </div>

      {c.open === 0 && (
        <div className="mt-6">
          <EmptyState title="Aún no hay solicitudes" hint="Registra la primera solicitud a mano. Cuando WhatsApp e Instagram estén conectados, también podrán crearse desde la conversación." action={can.has('edit') ? <Button onClick={() => setCreating(true)}>Registrar una solicitud</Button> : undefined} />
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card kicker="Por estado" title="Solicitudes abiertas">
          {ov.data!.byStatus.length ? (
            <ul className="divide-y divide-line text-sm">
              {ov.data!.byStatus.map((s) => <li key={s.status} className="flex items-center justify-between py-1.5"><StatusBadge status={s.status} label={s.label} /><b>{s.count}</b></li>)}
            </ul>
          ) : <p className="text-sm text-ink-3">Nada abierto.</p>}
        </Card>
        <Card kicker="Próximas" title="Producciones de los próximos 14 días">
          {ov.data!.upcoming.length ? (
            <ul className="divide-y divide-line text-sm">
              {ov.data!.upcoming.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                  <Link to={`/app/productions/${p.id}`} className="hover:underline"><span className="font-mono">{p.code}</span> · {p.clientName}</Link>
                  <span className="text-xs">{fmtDate(p.requestedDate, true)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-3">Ninguna con fecha registrada.</p>}
        </Card>
        <Card kicker="Atención" title="Tareas vencidas">
          {ov.data!.overdueTasks.length ? (
            <ul className="divide-y divide-line text-sm">
              {ov.data!.overdueTasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 py-1.5">
                  <Link to={`/app/productions/${t.productionId}`} className="hover:underline">{t.productionCode} · {t.title}</Link>
                  <span className="text-xs text-bad">{fmtDate(t.dueAt, true)}{t.assigneeName ? ` · ${t.assigneeName}` : ''}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-3">Ninguna vencida.</p>}
        </Card>
        <Card kicker="Atención" title="Incidencias abiertas">
          {ov.data!.openIssues.length ? (
            <ul className="divide-y divide-line text-sm">
              {ov.data!.openIssues.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2 py-1.5">
                  <Link to={`/app/productions/${i.productionId}`} className="hover:underline">{i.productionCode} · {i.description.slice(0, 80)}</Link>
                  <Badge tone={i.severity === 'HIGH' ? 'bad' : 'warn'}>{i.severity === 'HIGH' ? 'Alta' : i.severity === 'MEDIUM' ? 'Media' : 'Baja'}</Badge>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-ink-3">Ninguna abierta.</p>}
        </Card>
      </div>
      <NewProductionModal q={q} open={creating} onClose={() => setCreating(false)} canAssign={can.has('assign')} />
    </>
  );
}
