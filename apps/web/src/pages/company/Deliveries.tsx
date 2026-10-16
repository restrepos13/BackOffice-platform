import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ExternalLink, MapPin, Radio } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import LiveMap, { type MapPoint } from '../../components/LiveMap';
import { Badge, Card, EmptyState, Loading, PageHeader, Select, Stat, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { useLiveEvents } from '../../lib/events';
import { ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, etaLabel, fmtMoney, fmtTime, orderStatusTone, paymentTone, timeAgo } from '../../lib/format';
import type { Company, DeliveryBoard } from '../../lib/types';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Domicilios en vivo: mapa con domiciliarios y destinos, pedidos por
 * despachar (con asignación), en ruta con hora estimada y entregados del día.
 * Se actualiza por eventos en vivo (GPS de cada domiciliario incluido).
 */

const TO_DISPATCH = ['programado', 'en_produccion', 'listo', 'empacado'];
const SIGNAL_FRESH_MS = 3 * 60_000;

export default function Deliveries() {
  const { companyId, q, ready, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'pendientes' | 'ruta' | 'entregados'>('pendientes');
  const [selected, setSelected] = useState<string | null>(null);
  const boardKey = ['delivery-board', q];

  // Mismo caché que el menú lateral: de aquí salen el color de marca y la moneda
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
    enabled: ready,
  });
  const company = companies?.find((c) => c.id === companyId) ?? (companyId ? undefined : companies?.[0]);
  const { data: board, isLoading } = useQuery({
    queryKey: boardKey,
    queryFn: () => api.get<DeliveryBoard>(withScope('/delivery/board', q)),
    enabled: ready,
    refetchInterval: 60_000,
  });

  // Eventos en vivo: el GPS mueve el punto sin recargar; los cambios de estado refrescan
  const refetchTimer = useRef<number | null>(null);
  const scheduleRefetch = () => {
    if (refetchTimer.current) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      queryClient.invalidateQueries({ queryKey: boardKey });
    }, 800);
  };
  useLiveEvents(
    companyId,
    (event: any) => {
      if (event.type === 'courier.location') {
        queryClient.setQueryData<DeliveryBoard>(boardKey, (prev) =>
          prev
            ? {
                ...prev,
                couriers: prev.couriers.map((c) =>
                  c.id === event.userId ? { ...c, lastLat: event.lat, lastLng: event.lng, lastLocAt: event.at, onShift: true } : c,
                ),
              }
            : prev,
        );
      }
      if (['delivery.updated', 'order.status', 'courier.shift', 'delivery.delay', 'delivery.unassigned', 'order.payment'].includes(event.type)) scheduleRefetch();
    },
    ready,
  );

  const assign = useMutation({
    mutationFn: ({ orderId, courierId }: { orderId: string; courierId: string | null }) =>
      api.post(withScope(`/delivery/orders/${orderId}/assign`, q), { courierId }),
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: boardKey });
      toast.success(vars.courierId ? 'Domiciliario asignado' : 'Domiciliario quitado');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const accent = company?.brandColor || '#1a1a1a';
  const orders = board?.orders ?? [];
  const pending = orders.filter((o) => TO_DISPATCH.includes(o.status));
  const inRoute = orders.filter((o) => o.status === 'despachado');
  const delivered = orders.filter((o) => o.status === 'entregado');
  const couriersOnShift = (board?.couriers ?? []).filter((c) => c.onShift);
  const courierName = (id: string | null) => board?.couriers.find((c) => c.id === id)?.name ?? null;
  const branchName = (id?: string | null) => (id ? board?.branches?.find((b) => b.id === id)?.name ?? null : null);
  const delayedCount = orders.filter((o) => o.delayed && o.status !== 'entregado').length;

  const points = useMemo<MapPoint[]>(() => {
    if (!board) return [];
    const out: MapPoint[] = [];
    if (board.origin) out.push({ id: 'origin', kind: 'origin', lat: board.origin.lat, lng: board.origin.lng, label: company?.name ?? 'Punto de despacho' });
    for (const b of board.branches ?? []) {
      if (b.active) out.push({ id: `branch-${b.id}`, kind: 'origin', lat: b.lat, lng: b.lng, label: `Sucursal ${b.name}` });
    }
    for (const o of [...pending, ...inRoute]) {
      if (o.destination.lat == null || o.destination.lng == null) continue;
      out.push({
        id: o.id, kind: 'destination', lat: o.destination.lat, lng: o.destination.lng,
        tag: o.code.slice(-3), label: `#${o.code} · ${o.customer}`,
        active: o.id === selected || o.status === 'despachado',
      });
    }
    for (const c of board.couriers) {
      if (!c.onShift || c.lastLat == null || c.lastLng == null) continue;
      const fresh = c.lastLocAt && Date.now() - new Date(c.lastLocAt).getTime() < SIGNAL_FRESH_MS;
      out.push({
        id: `courier-${c.id}`, kind: 'courier', lat: c.lastLat, lng: c.lastLng,
        tag: c.name.slice(0, 1).toUpperCase(), label: `${c.name}${fresh ? '' : ' · sin señal reciente'}`,
        muted: !fresh,
      });
    }
    return out;
  }, [board, pending, inRoute, selected, company?.name]);

  if (!ready) return <PickCompany />;
  if (isLoading || !board) return <Loading label="Cargando domicilios…" />;

  const list = tab === 'pendientes' ? pending : tab === 'ruta' ? inRoute : delivered;

  return (
    <>
      <PageHeader
        kicker="Operación"
        title="Domicilios"
        accent="en vivo"
        actions={
          <span className="flex items-center gap-2">
            <Badge tone={board?.autoAssign ? 'ok' : 'neutral'}>{board?.autoAssign ? 'Asignación automática' : 'Asignación manual'}</Badge>
            {canWrite && (
              <Link to="/app/orders/settings?tab=domicilios" className="text-xs font-semibold uppercase tracking-wider underline">Ajustes</Link>
            )}
          </span>
        }
      />

      {!board.deliveryEnabled && (
        <div className="mb-4 border-2 border-warn bg-warn-soft px-4 py-3 text-sm text-warn">
          Los domicilios no están configurados. Define el punto de despacho, la cobertura y las tarifas en{' '}
          <Link to="/app/orders/settings?tab=domicilios" className="font-semibold underline">Pedidos → Configuración → Domicilios</Link>.
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Por despachar" value={pending.length} tone={pending.some((o) => !o.courierId && ['listo', 'empacado'].includes(o.status)) ? 'warn' : undefined} hint="Programados o en cocina" />
        <Stat label="En ruta" value={inRoute.length} tone={delayedCount ? 'bad' : undefined} hint={delayedCount ? `${delayedCount} con retraso` : undefined} />
        <Stat label="Entregados hoy" value={delivered.length} tone="ok" />
        <Stat label="Domiciliarios en turno" value={`${couriersOnShift.length}/${board.couriers.length}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="border-2 border-ink bg-paper">
          <div className="h-[420px] xl:h-[640px]">
            {points.length ? (
              <LiveMap points={points} accent={accent} fitKey={selected ?? 'all'} onSelect={(id) => !id.startsWith('courier-') && id !== 'origin' && setSelected(id)} />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-3">
                Aún no hay pedidos con ubicación ni domiciliarios en turno.
              </div>
            )}
          </div>
        </section>

        <div className="space-y-4">
          <Tabs
            active={tab}
            onChange={(id) => setTab(id as typeof tab)}
            tabs={[
              { id: 'pendientes', label: 'Por despachar', badge: pending.length },
              { id: 'ruta', label: 'En ruta', badge: inRoute.length },
              { id: 'entregados', label: 'Entregados' },
            ]}
          />
          <div className="max-h-[560px] space-y-2 overflow-y-auto pr-1">
            {list.length === 0 && (
              <EmptyState
                title={tab === 'pendientes' ? 'Nada por despachar' : tab === 'ruta' ? 'Nadie en ruta' : 'Sin entregas hoy'}
              />
            )}
            {list.map((o) => {
              const eta = etaLabel(o.etaAt);
              return (
                <article
                  key={o.id}
                  onClick={() => setSelected(o.id)}
                  className={clsx(
                    'cursor-pointer border-2 bg-paper px-4 py-3 transition-shadow',
                    selected === o.id ? 'border-ink shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]' : 'border-ink/70 hover:border-ink',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        #{o.code} · <span className="font-normal">{o.customer}</span>
                      </p>
                      <p className="mt-0.5 flex items-start gap-1 text-xs text-ink-3">
                        <MapPin size={12} className="mt-0.5 shrink-0" />
                        <span className="truncate">{o.destination.address ?? 'Sin dirección'}</span>
                      </p>
                    </div>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge tone={orderStatusTone(o.status)}>{ORDER_STATUS_LABELS[o.status] ?? o.status}</Badge>
                      {o.delayed && o.status !== 'entregado' && <Badge tone="bad">Retrasado</Badge>}
                      {o.paymentStatus && o.paymentStatus !== 'NONE' && (
                        <Badge tone={paymentTone(o.paymentStatus)}>{PAYMENT_STATUS_LABELS[o.paymentStatus] ?? o.paymentStatus}</Badge>
                      )}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-ink-2">
                      {o.items} ítem{o.items === 1 ? '' : 's'}
                      {o.total != null && ` · ${fmtMoney(o.total, company?.currency ?? 'COP')}`}
                      {o.distanceKm != null && ` · ${o.distanceKm} km`}
                      {branchName(o.branchId) && ` · sale de ${branchName(o.branchId)}`}
                    </span>
                    <span className="font-semibold">
                      {o.status === 'despachado' && eta
                        ? eta
                        : o.status === 'entregado' && o.deliveredAt
                          ? `entregado ${fmtTime(o.deliveredAt)}`
                          : `para las ${fmtTime(o.deliveryAt)}`}
                    </span>
                  </div>
                  {o.destination.lat == null && o.status !== 'entregado' && (
                    <p className="mt-2 text-[11px] font-semibold text-warn">Sin ubicación exacta: el domiciliario se guiará por la dirección.</p>
                  )}
                  <div className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {o.status !== 'entregado' && canWrite ? (
                      <Select
                        aria-label="Domiciliario"
                        className="!py-1.5 text-xs"
                        value={o.courierId ?? ''}
                        disabled={assign.isPending}
                        onChange={(e) => assign.mutate({ orderId: o.id, courierId: e.target.value || null })}
                      >
                        <option value="">Sin domiciliario</option>
                        {board.couriers.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}{c.onShift ? ' · en turno' : ''}{c.activeOrders ? ` · ${c.activeOrders} activos` : ''}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="text-xs text-ink-3">{courierName(o.courierId) ? `Por ${courierName(o.courierId)}` : ''}</span>
                    )}
                    <Link
                      to={`/app/orders/${o.id}`}
                      aria-label="Abrir pedido"
                      className="border-2 border-ink p-1.5 hover:bg-ink hover:text-bone"
                    >
                      <ExternalLink size={13} />
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>

          <Card kicker="Equipo" title="Domiciliarios">
            {board.couriers.length === 0 ? (
              <p className="text-sm text-ink-3">
                Crea usuarios con el rol <strong>Domiciliario</strong> en{' '}
                <Link to="/app/team" className="font-semibold underline">Equipo</Link>. Entran desde el celular a la misma dirección del panel.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {board.couriers.map((c) => {
                  const fresh = c.lastLocAt && Date.now() - new Date(c.lastLocAt).getTime() < SIGNAL_FRESH_MS;
                  return (
                    <li key={c.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="font-semibold">{c.name}</span>
                      <span className="flex items-center gap-2 text-xs text-ink-3">
                        {c.activeOrders > 0 && <span>{c.activeOrders} activo{c.activeOrders === 1 ? '' : 's'}</span>}
                        {c.onShift ? (
                          <Badge tone={fresh ? 'ok' : 'warn'}>
                            <Radio size={10} className="mr-1" /> {fresh ? 'En turno' : `Señal ${c.lastLocAt ? timeAgo(c.lastLocAt) : 'pendiente'}`}
                          </Badge>
                        ) : (
                          <Badge tone="neutral">Fuera de turno</Badge>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
