import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Bot, CalendarDays, List, Plus, Settings, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { ORDER_SOURCE_LABELS, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, fmtDateTime, orderStatusTone, paymentTone } from '../../lib/format';
import type { Customer, Order, OrdersCalendar, Product } from '../../lib/types';
import {
  Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Select,
  Switch, Table, Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/* ─── Pedido manual (teléfono / presencial) ──────────────────────────── */

function NewOrderModal({ customers, q, companyId, onClose }: {
  customers: Customer[];
  q: string;
  companyId: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const [deliveryAt, setDeliveryAt] = useState('');
  const [addressIdx, setAddressIdx] = useState('0');
  const [customAddress, setCustomAddress] = useState('');
  const [observations, setObservations] = useState('');
  const [confirm, setConfirm] = useState(true);
  const [items, setItems] = useState<Array<{ productId: string; quantity: number; specifications: string }>>([
    { productId: '', quantity: 1, specifications: '' },
  ]);

  const { data: products } = useQuery({
    queryKey: ['products', q],
    queryFn: () => api.get<Product[]>(withScope('/catalog/products', q)),
  });
  const customer = customers.find((c) => c.id === customerId);
  const addresses = customer?.addresses ?? [];

  const create = useMutation({
    mutationFn: () => {
      const chosen = addresses[Number(addressIdx)];
      return api.post<Order>('/orders', {
        customerId,
        deliveryAt: new Date(deliveryAt).toISOString(),
        deliveryAddress: customAddress
          ? { address: customAddress }
          : chosen ?? {},
        observations: observations || undefined,
        items: items
          .filter((i) => i.productId)
          .map((i) => ({
            productId: i.productId,
            quantity: i.quantity,
            specifications: i.specifications || undefined,
          })),
        confirm,
        ...(companyId ? { companyId } : {}),
      });
    },
    onSuccess: (order) => {
      toast.success(
        confirm
          ? 'Pedido creado y confirmado (distribuido y con recordatorios)'
          : 'Pedido creado en borrador',
      );
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
      navigate(`/app/orders/${order.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const valid = customerId && deliveryAt && items.some((i) => i.productId);

  return (
    <Modal open onClose={onClose} wide kicker="Operación" title="Nuevo pedido manual">
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Cliente" required>
            <Select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setAddressIdx('0'); }}>
              <option value="" disabled>Elegir…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Entrega" required>
            <Input type="datetime-local" value={deliveryAt} onChange={(e) => setDeliveryAt(e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Dirección registrada">
            <Select value={addressIdx} onChange={(e) => setAddressIdx(e.target.value)} disabled={!addresses.length || !!customAddress}>
              {addresses.map((a, i) => (
                <option key={i} value={i}>{a.label ? `${a.label} · ` : ''}{a.address}</option>
              ))}
              {!addresses.length && <option value="0">Sin direcciones registradas</option>}
            </Select>
          </Field>
          <Field label="…u otra dirección" hint="Si escribes aquí, manda esta">
            <Input value={customAddress} onChange={(e) => setCustomAddress(e.target.value)} placeholder="Cl 10 # 5-20…" />
          </Field>
        </div>

        <div>
          <p className="kicker mb-2">Ítems</p>
          <div className="space-y-2">
            {items.map((item, idx) => (
              <div key={idx} className="grid gap-2 md:grid-cols-[1fr_90px_1fr_auto]">
                <Select
                  value={item.productId}
                  onChange={(e) => setItems((p) => p.map((it, i) => (i === idx ? { ...it, productId: e.target.value } : it)))}
                  aria-label="Producto"
                >
                  <option value="" disabled>Producto…</option>
                  {products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
                <Input
                  type="number" min={1} value={item.quantity} aria-label="Cantidad"
                  onChange={(e) => setItems((p) => p.map((it, i) => (i === idx ? { ...it, quantity: Number(e.target.value) } : it)))}
                />
                <Input
                  value={item.specifications} placeholder="Especificaciones…" aria-label="Especificaciones"
                  onChange={(e) => setItems((p) => p.map((it, i) => (i === idx ? { ...it, specifications: e.target.value } : it)))}
                />
                <Button size="sm" variant="ghost" onClick={() => setItems((p) => p.filter((_, i) => i !== idx))}>
                  Quitar
                </Button>
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" className="mt-2"
            onClick={() => setItems((p) => [...p, { productId: '', quantity: 1, specifications: '' }])}>
            + Agregar ítem
          </Button>
        </div>

        <Field label="Observaciones">
          <Textarea rows={2} value={observations} onChange={(e) => setObservations(e.target.value)} />
        </Field>
        <div className="flex items-center gap-3">
          <Switch checked={confirm} onChange={setConfirm} label="Confirmar de una vez" />
          <span className="text-sm">
            {confirm
              ? 'Confirmar de una vez (distribuye a áreas, valida agenda y programa recordatorios)'
              : 'Dejar en borrador'}
          </span>
        </div>
        <Button className="w-full" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? 'Creando…' : 'Crear pedido'}
        </Button>
      </div>
    </Modal>
  );
}

function CalendarView({ q }: { q: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['orders-calendar', q],
    queryFn: () => api.get<OrdersCalendar>(withScope('/orders/calendar', q)),
  });
  const navigate = useNavigate();

  if (isLoading) return <Loading />;
  if (!data?.days.length) {
    return (
      <EmptyState
        title="Sin entregas programadas"
        hint="Las próximas 2 semanas no tienen pedidos con fecha de entrega."
      />
    );
  }
  return (
    <div className="space-y-4">
      {data.days.map((day) => (
        <section key={day.date} className="border-2 border-ink bg-paper">
          <header className="flex items-center justify-between border-b-2 border-ink bg-bone-2 px-4 py-2">
            <p className="display text-base capitalize">
              {new Intl.DateTimeFormat('es-CO', {
                weekday: 'long', day: 'numeric', month: 'long',
              }).format(new Date(`${day.date}T12:00:00`))}
            </p>
            <Badge tone={data.maxPerSlot && day.total >= data.maxPerSlot ? 'bad' : 'neutral'}>
              {day.total} entrega{day.total === 1 ? '' : 's'}
              {data.maxPerSlot ? ` · cap. ${data.maxPerSlot}/franja` : ''}
            </Badge>
          </header>
          <div className="divide-y divide-line">
            {day.orders.map((order) => (
              <button
                key={order.id}
                onClick={() => navigate(`/app/orders/${order.id}`)}
                className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-bone-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{order.customer.name}</p>
                  <p className="truncate text-xs text-ink-3">
                    {order.items?.map((i) => `${i.quantity} × ${i.productName}`).join(' · ') || 'Sin ítems'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs font-semibold">
                    {new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' })
                      .format(new Date(order.deliveryAt))}
                  </span>
                  <Badge tone={orderStatusTone(order.status)}>
                    {ORDER_STATUS_LABELS[order.status] ?? order.status}
                  </Badge>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function Orders() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [view, setView] = useState<'tabla' | 'calendario'>('tabla');
  const [status, setStatus] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data: customers } = useQuery({
    queryKey: ['customers', q],
    queryFn: () => api.get<Customer[]>(withScope('/customers', q)),
    enabled: ready,
  });

  const listPath = withScope(
    `/orders?x=1${status ? `&status=${status}` : ''}${customerId ? `&customerId=${customerId}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}T23:59:59` : ''}`,
    q,
  );
  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders', listPath],
    queryFn: () => api.get<Order[]>(listPath),
    enabled: ready,
    refetchInterval: 30_000,
  });

  if (!ready) return <PickCompany />;

  const attention = orders?.filter((o) => o.status === 'requiere_atencion').length ?? 0;

  return (
    <>
      <PageHeader
        kicker="Operación"
        title="Pedidos"
        actions={
          <>
            {canWrite && (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus size={13} /> Nuevo pedido
              </Button>
            )}
            <Button
              size="sm"
              variant={view === 'tabla' ? 'primary' : 'outline'}
              onClick={() => setView('tabla')}
            >
              <List size={13} /> Tabla
            </Button>
            <Button
              size="sm"
              variant={view === 'calendario' ? 'primary' : 'outline'}
              onClick={() => setView('calendario')}
            >
              <CalendarDays size={13} /> Calendario
            </Button>
            {canWrite && (
              <Link to="/app/orders/settings">
                <Button size="sm" variant="outline">
                  <Settings size={13} /> Configuración
                </Button>
              </Link>
            )}
          </>
        }
      />

      {attention > 0 && (
        <div className="mb-4 flex items-center gap-2 border-2 border-bad bg-bad-soft px-4 py-2.5">
          <AlertTriangle size={14} className="text-bad" />
          <p className="text-sm font-semibold text-bad">
            {attention} pedido{attention === 1 ? '' : 's'} requiere{attention === 1 ? '' : 'n'} atención humana
          </p>
        </div>
      )}

      {view === 'tabla' && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[190px]" aria-label="Filtrar por estado">
              <option value="">Todos los estados</option>
              {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className="max-w-[220px]" aria-label="Filtrar por cliente">
              <option value="">Todos los clientes</option>
              {customers?.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-[160px]" aria-label="Desde" />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[160px]" aria-label="Hasta" />
          </div>

          {isLoading ? (
            <Loading />
          ) : (orders?.length ?? 0) === 0 ? (
            <EmptyState
              title="Sin pedidos en el rango"
              hint="Los pedidos que tome la IA por WhatsApp (o que se creen a mano) aparecen aquí."
            />
          ) : (
            <Table head={['Entrega', 'Cliente', 'Ítems', 'Áreas', 'Tomado por', 'Estado']}>
              {orders?.map((order) => (
                <tr
                  key={order.id}
                  onClick={() => navigate(`/app/orders/${order.id}`)}
                  className={clsx(
                    'cursor-pointer hover:bg-bone-2',
                    order.status === 'requiere_atencion' && 'bg-bad-soft',
                  )}
                >
                  <td className="px-4 py-2.5 text-sm font-semibold whitespace-nowrap">
                    {fmtDateTime(order.deliveryAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="text-sm font-semibold">{order.customer.name}</p>
                    {order.contact && (
                      <p className="text-xs text-ink-3">{order.contact.name}</p>
                    )}
                  </td>
                  <td className="max-w-[260px] px-4 py-2.5 text-xs text-ink-2">
                    <p className="truncate">
                      {order.items?.map((i) => `${i.quantity} × ${i.productName}`).join(' · ') || '—'}
                    </p>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {[...new Set(order.items?.map((i) => i.productionArea?.name).filter(Boolean))].map(
                        (area) => (
                          <Badge key={area as string} tone="neutral">{area}</Badge>
                        ),
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <span className="inline-flex items-center gap-1.5">
                      {order.takenByType === 'IA' ? (
                        <Bot size={12} className="text-info" />
                      ) : (
                        <UserRound size={12} className="text-ink-3" />
                      )}
                      {order.takenByType === 'IA'
                        ? `IA${order.aiConfidence != null ? ` · ${Math.round(order.aiConfidence * 100)}%` : ''}`
                        : (order.takenByName ?? 'Humano')}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={orderStatusTone(order.status)}>
                        {ORDER_STATUS_LABELS[order.status] ?? order.status}
                      </Badge>
                      {order.paymentStatus && order.paymentStatus !== 'NONE' && (
                        <Badge tone={paymentTone(order.paymentStatus)}>{PAYMENT_STATUS_LABELS[order.paymentStatus]}</Badge>
                      )}
                      {order.source && !['WHATSAPP', 'MANUAL'].includes(order.source) && (
                        <Badge tone="neutral">{ORDER_SOURCE_LABELS[order.source] ?? order.source}</Badge>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}

      {view === 'calendario' && <CalendarView q={q} />}

      {creating && (
        <NewOrderModal
          customers={customers ?? []}
          q={q}
          companyId={companyId}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}
