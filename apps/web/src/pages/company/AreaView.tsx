import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CheckCircle2, MapPin } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ORDER_STATUS_LABELS, fmtDateTime, orderStatusTone } from '../../lib/format';
import type { AreaViewData, ProductionArea } from '../../lib/types';
import {
  Badge, Button, EmptyState, Loading, PageHeader, Select,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

export default function AreaView() {
  const { user } = useAuth();
  const { ready, q } = useCompanyScope();
  const queryClient = useQueryClient();
  const isAreaUser = user?.role === 'COMPANY_AREA';
  const [areaId, setAreaId] = useState('');

  // Los admins eligen el área; un usuario de área queda clavado a la suya (API)
  const { data: areas } = useQuery({
    queryKey: ['areas', q],
    queryFn: () => api.get<ProductionArea[]>(withScope('/catalog/areas', q)),
    enabled: ready && !isAreaUser,
  });
  const effectiveAreaId = isAreaUser ? '' : (areaId || (areas?.[0]?.id ?? ''));

  const viewPath = withScope(
    `/orders/area-view?x=1${effectiveAreaId ? `&areaId=${effectiveAreaId}` : ''}`,
    q,
  );
  const { data, isLoading, error } = useQuery({
    queryKey: ['area-view', viewPath],
    queryFn: () => api.get<AreaViewData>(viewPath),
    enabled: ready && (isAreaUser || !!effectiveAreaId),
    refetchInterval: 30_000,
  });

  const markReady = useMutation({
    mutationFn: (itemId: string) => api.post(`/orders/items/${itemId}/ready`),
    onSuccess: () => {
      toast.success('Ítem marcado como listo');
      queryClient.invalidateQueries({ queryKey: ['area-view'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;

  const pending = data?.items.filter((i) => i.areaStatus !== 'listo') ?? [];
  const done = data?.items.filter((i) => i.areaStatus === 'listo') ?? [];

  return (
    <>
      <PageHeader
        kicker="Producción"
        title={data?.area?.name ? `Área · ${data.area.name}` : 'Vista por área'}
        actions={
          !isAreaUser && (areas?.length ?? 0) > 0 ? (
            <Select
              value={effectiveAreaId}
              onChange={(e) => setAreaId(e.target.value)}
              className="max-w-[220px]"
              aria-label="Área"
            >
              {areas?.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          ) : undefined
        }
      />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <EmptyState
          title="No se pudo cargar el área"
          hint={error instanceof Error ? error.message : 'Verifica que el área exista.'}
        />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          title="Sin trabajo pendiente"
          hint="Cuando un pedido se confirme y tenga ítems asignados a esta área, aparecen aquí."
        />
      ) : (
        <div className="space-y-6">
          <section>
            <p className="kicker mb-3">Pendientes ({pending.length})</p>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {pending.map((item) => (
                <article
                  key={item.id}
                  className="flex flex-col border-2 border-ink bg-paper"
                >
                  <header className="flex items-center justify-between gap-2 border-b-2 border-ink bg-bone-2 px-4 py-2">
                    <p className="text-sm font-semibold">{fmtDateTime(item.deliveryAt)}</p>
                    <Badge tone={orderStatusTone(item.orderStatus)}>
                      {ORDER_STATUS_LABELS[item.orderStatus] ?? item.orderStatus}
                    </Badge>
                  </header>
                  <div className="flex-1 px-4 py-3">
                    <p className="display text-xl leading-tight">
                      {item.quantity} × {item.productName}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {item.customer}
                      {item.presentation ? ` · ${item.presentation}` : ''}
                      {item.unit ? ` · ${item.unit}` : ''}
                    </p>
                    {item.specifications && (
                      <p className="mt-2 border-l-2 border-warn pl-2 text-sm">{item.specifications}</p>
                    )}
                    {item.observations && (
                      <p className="mt-1 text-xs text-ink-3">{item.observations}</p>
                    )}
                    {item.deliveryAddress?.address && (
                      <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-2">
                        <MapPin size={12} className="mt-0.5 shrink-0" />
                        {item.deliveryAddress.label && <strong>{item.deliveryAddress.label} · </strong>}
                        {item.deliveryAddress.address}
                        {item.deliveryAddress.city ? `, ${item.deliveryAddress.city}` : ''}
                      </p>
                    )}
                  </div>
                  <footer className="border-t border-line p-3">
                    <Button
                      className="w-full"
                      size="sm"
                      disabled={markReady.isPending}
                      onClick={() => markReady.mutate(item.id)}
                    >
                      <CheckCircle2 size={14} /> Marcar listo
                    </Button>
                  </footer>
                </article>
              ))}
              {pending.length === 0 && (
                <p className="text-sm text-ink-3">Todo lo de esta área está listo.</p>
              )}
            </div>
          </section>

          {done.length > 0 && (
            <section>
              <p className="kicker mb-3">Listos ({done.length})</p>
              <div className="divide-y divide-line border-2 border-line bg-paper">
                {done.map((item) => (
                  <div
                    key={item.id}
                    className={clsx('flex items-center justify-between gap-2 px-4 py-2.5 opacity-70')}
                  >
                    <p className="text-sm">
                      <CheckCircle2 size={13} className="mr-1.5 inline text-ok" />
                      {item.quantity} × {item.productName}
                      <span className="text-ink-3"> · {item.customer}</span>
                    </p>
                    <p className="text-xs text-ink-3">{fmtDateTime(item.deliveryAt)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
