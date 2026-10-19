import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Loading, PageHeader } from '../../components/ui';

/**
 * Incidentes 24/7: lo que hizo que un bot no respondiera o que un mensaje no
 * saliera. El equipo recibe un correo al instante; aquí se ve el detalle y se
 * marca como resuelto (o se cierra solo tras 30 minutos sin repetirse).
 */

export interface IncidentRow {
  id: string; companyId: string | null; companyName: string; kind: string; label: string; detail: string; count: number;
  firstAt: string; lastAt: string; notifiedAt: string | null; resolvedAt: string | null; resolvedBy: string | null;
}

export function useIncidents(enabled = true) {
  return useQuery({
    queryKey: ['incidents'],
    queryFn: () => api.get<{ open: IncidentRow[]; recent: IncidentRow[] }>('/platform/incidents'),
    refetchInterval: 60_000,
    enabled,
  });
}

function Row({ i, onResolve }: { i: IncidentRow; onResolve?: () => void }) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-b border-line py-3">
      <div className="min-w-0">
        <p className="font-semibold">{i.label}</p>
        <p className="text-sm">
          {i.companyId ? <Link to={`/platform/companies/${i.companyId}`} className="underline">{i.companyName}</Link> : i.companyName}
          {' · '}{i.count} {i.count === 1 ? 'vez' : 'veces'} · empezó {timeAgo(i.firstAt)} · última {timeAgo(i.lastAt)}
        </p>
        <p className="mt-1 break-words font-mono text-xs text-ink-3">{i.detail}</p>
        {i.resolvedAt && <p className="text-xs text-ink-3">Resuelto {timeAgo(i.resolvedAt)}{i.resolvedBy ? ` · ${i.resolvedBy}` : ''}</p>}
      </div>
      <div className="flex items-center gap-2">
        {!i.resolvedAt && <Badge tone={i.notifiedAt ? 'warn' : 'bad'}>{i.notifiedAt ? 'Equipo avisado' : 'Avisando…'}</Badge>}
        {onResolve && <Button size="sm" variant="outline" onClick={onResolve}>Marcar resuelto</Button>}
      </div>
    </li>
  );
}

export default function Incidents() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useIncidents();
  const resolve = useMutation({
    mutationFn: (id: string) => api.post(`/platform/incidents/${id}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['incidents'] });
      toast.success('Incidente resuelto');
    },
  });
  if (isLoading || !data) return <Loading />;
  return (
    <>
      <PageHeader kicker="Mantenimiento 24/7" title="Incidentes" />
      <p className="mb-6 border-2 border-line bg-bone px-4 py-3 text-sm text-ink-2">
        Si la IA no responde, el bot le dice al cliente que una persona lo atiende y deja la conversación marcada. Al mismo tiempo les llega un correo
        (a OPS_ALERT_EMAIL o, si no está, a SIGNUP_NOTIFY_EMAIL). Para que el aviso llegue de verdad a medianoche, configura el correo saliente (SMTP) en Dev Tools.
      </p>
      <Card kicker="Pasando ahora" title={`Abiertos (${data.open.length})`} className="mb-6">
        {data.open.length === 0 ? <EmptyState title="Todo en orden" hint="No hay incidentes abiertos." /> : (
          <ul>{data.open.map((i) => <Row key={i.id} i={i} onResolve={() => resolve.mutate(i.id)} />)}</ul>
        )}
      </Card>
      <Card kicker="Últimos 7 días" title="Resueltos">
        {data.recent.length === 0 ? <p className="text-sm text-ink-3">Nada en la última semana.</p> : <ul>{data.recent.map((i) => <Row key={i.id} i={i} />)}</ul>}
      </Card>
    </>
  );
}
