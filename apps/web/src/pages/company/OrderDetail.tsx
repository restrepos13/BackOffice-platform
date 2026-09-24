import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowLeft, Bot, Check, MapPin, MessageSquare, Pencil, Star, UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import {
  ORDER_STATUS_LABELS, REMINDER_STATUS_LABELS, fmtDateTime, orderStatusTone,
} from '../../lib/format';
import type { Order, Product } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/** Mismo mapa de transiciones que el backend (la fuente de verdad es el API). */
const TRANSITIONS: Record<string, string[]> = {
  borrador: ['confirmado', 'cancelado', 'requiere_atencion'],
  confirmado: ['programado', 'cancelado', 'requiere_atencion'],
  programado: ['en_produccion', 'cancelado', 'requiere_atencion'],
  en_produccion: ['listo', 'cancelado', 'requiere_atencion'],
  listo: ['empacado', 'requiere_atencion'],
  empacado: ['despachado', 'requiere_atencion'],
  despachado: ['entregado'],
  entregado: [],
  cancelado: [],
  requiere_atencion: ['borrador', 'confirmado', 'cancelado'],
};

interface EditableItem {
  productId?: string | null;
  productName: string;
  quantity: number;
  unit?: string;
  presentation?: string | null;
  specifications?: string | null;
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditModal({
  order, open, onClose, q,
}: {
  order: Order; open: boolean; onClose: () => void; q: string;
}) {
  const queryClient = useQueryClient();
  const [deliveryAt, setDeliveryAt] = useState(toLocalInput(order.deliveryAt));
  const [address, setAddress] = useState(() => {
    try {
      return JSON.parse(order.deliveryAddressJson ?? '{}')?.address ?? '';
    } catch {
      return '';
    }
  });
  const [observations, setObservations] = useState(order.observations ?? '');
  const [items, setItems] = useState<EditableItem[]>(
    order.items.map((i) => ({
      productId: i.productId, productName: i.productName, quantity: i.quantity,
      unit: i.unit, presentation: i.presentation, specifications: i.specifications,
    })),
  );

  const { data: products } = useQuery({
    queryKey: ['products', q],
    queryFn: () => api.get<Product[]>(withScope('/catalog/products', q)),
    enabled: open,
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/orders/${order.id}`, {
        deliveryAt: new Date(deliveryAt).toISOString(),
        deliveryAddress: { address },
        observations,
        items,
        // Si el pedido lo tomó la IA, la corrección manual alimenta el indicador
        ...(order.takenByType === 'IA' ? { correctedAfterAi: true } : {}),
      }),
    onSuccess: () => {
      toast.success('Pedido actualizado (queda en el historial)');
      queryClient.invalidateQueries({ queryKey: ['order', order.id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const setItem = (idx: number, patch: Partial<EditableItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  return (
    <Modal open={open} onClose={onClose} kicker="Edición manual" title="Editar pedido" wide>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Fecha y hora de entrega" required>
            <Input type="datetime-local" value={deliveryAt} onChange={(e) => setDeliveryAt(e.target.value)} />
          </Field>
          <Field label="Dirección de entrega">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Calle 10 # 43A-25…" />
          </Field>
        </div>
        <Field label="Observaciones">
          <Textarea rows={2} value={observations} onChange={(e) => setObservations(e.target.value)} />
        </Field>

        <div>
          <p className="kicker mb-2">Ítems del pedido</p>
          <div className="space-y-2">
            {items.map((item, idx) => (
              <div key={idx} className="grid gap-2 border-2 border-line p-2 md:grid-cols-[1fr_90px_1fr_auto]">
                <Select
                  value={item.productId ?? ''}
                  onChange={(e) => {
                    const product = products?.find((p) => p.id === e.target.value);
                    setItem(idx, {
                      productId: e.target.value || null,
                      productName: product?.name ?? item.productName,
                      unit: product?.unit ?? item.unit,
                    });
                  }}
                  aria-label="Producto"
                >
                  <option value="">{item.productName || 'Producto…'}</option>
                  {products?.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
                <Input
                  type="number" min={1} value={item.quantity}
                  onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })}
                  aria-label="Cantidad"
                />
                <Input
                  value={item.specifications ?? ''}
                  onChange={(e) => setItem(idx, { specifications: e.target.value })}
                  placeholder="Especificaciones…"
                  aria-label="Especificaciones"
                />
                <Button
                  size="sm" variant="ghost"
                  onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                >
                  Quitar
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm" variant="outline" className="mt-2"
            onClick={() => setItems((prev) => [...prev, { productName: '', quantity: 1 }])}
          >
            + Agregar ítem
          </Button>
        </div>

        <Button
          className="w-full"
          disabled={save.isPending || items.some((i) => !i.productName && !i.productId)}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </div>
    </Modal>
  );
}

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { ready, q, canWrite } = useCompanyScope();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [statusTarget, setStatusTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const { data: order, isLoading } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<Order>(`/orders/${id}`),
    enabled: !!id && ready,
  });

  const changeStatus = useMutation({
    mutationFn: (payload: { status: string; reason?: string }) =>
      api.post(`/orders/${id}/status`, payload),
    onSuccess: (_data, vars) => {
      toast.success(`Pedido → ${ORDER_STATUS_LABELS[vars.status] ?? vars.status}`);
      setStatusTarget(null);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['order', id] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !order) return <Loading label="Cargando pedido…" />;

  const address = (() => {
    try {
      return JSON.parse(order.deliveryAddressJson ?? '{}');
    } catch {
      return {};
    }
  })();
  const nextStatuses = TRANSITIONS[order.status] ?? [];

  return (
    <>
      <PageHeader
        kicker={`Pedido · ${order.customer.name}`}
        title={ORDER_STATUS_LABELS[order.status] ?? order.status}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => navigate('/app/orders')}>
              <ArrowLeft size={13} /> Pedidos
            </Button>
            {order.conversationId && (
              <Link to={`/app/inbox?open=${order.conversationId}`}>
                <Button size="sm" variant="outline">
                  <MessageSquare size={13} /> Ver conversación
                </Button>
              </Link>
            )}
            {canWrite && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Pencil size={13} /> Editar
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          {/* ─── Datos de entrega ─── */}
          <section className="border-2 border-ink bg-paper p-5">
            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <p className="kicker">Entrega</p>
                <p className="mt-1 text-lg font-semibold">{fmtDateTime(order.deliveryAt)}</p>
              </div>
              <div>
                <p className="kicker">Dirección</p>
                <p className="mt-1 flex items-start gap-1.5 text-sm">
                  <MapPin size={14} className="mt-0.5 shrink-0 text-ink-3" />
                  <span>
                    {address.label && <strong>{address.label} · </strong>}
                    {address.address ?? 'Sin dirección'}
                    {address.city ? `, ${address.city}` : ''}
                    {address.instructions && (
                      <span className="block text-xs text-ink-3">{address.instructions}</span>
                    )}
                  </span>
                </p>
              </div>
              <div>
                <p className="kicker">Tomado por</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                  {order.takenByType === 'IA' ? (
                    <><Bot size={14} className="text-info" /> IA
                      {order.aiConfidence != null && (
                        <Badge tone={order.aiConfidence >= 0.8 ? 'ok' : 'warn'}>
                          {Math.round(order.aiConfidence * 100)}% confianza
                        </Badge>
                      )}
                    </>
                  ) : (
                    <><UserRound size={14} /> {order.takenByName ?? 'Humano'}</>
                  )}
                </p>
                {order.correctedAfterAi && (
                  <p className="mt-1 text-xs text-warn">Corregido después de la IA</p>
                )}
              </div>
            </div>
            {order.observations && (
              <p className="mt-4 border-t border-line pt-3 text-sm">
                <span className="kicker mr-2">Observaciones</span>
                {order.observations}
              </p>
            )}
          </section>

          {/* ─── Ítems ─── */}
          <section className="border-2 border-ink bg-paper">
            <header className="border-b-2 border-ink px-5 py-3">
              <p className="kicker">Ítems y áreas</p>
            </header>
            <div className="divide-y divide-line">
              {order.items.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {item.quantity} × {item.productName}
                      {item.presentation && <span className="font-normal text-ink-3"> · {item.presentation}</span>}
                    </p>
                    {item.specifications && (
                      <p className="text-xs text-ink-3">{item.specifications}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.productionArea && <Badge tone="neutral">{item.productionArea.name}</Badge>}
                    <Badge tone={item.areaStatus === 'listo' ? 'ok' : 'warn'}>
                      {item.areaStatus === 'listo' ? 'Listo' : 'Pendiente'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ─── Historial (trazabilidad completa) ─── */}
          <section className="border-2 border-ink bg-paper">
            <header className="border-b-2 border-ink px-5 py-3">
              <p className="kicker">Historial del pedido</p>
            </header>
            <div className="space-y-0 divide-y divide-line">
              {(order.statusHistory ?? []).map((h) => (
                <div key={h.id} className="flex items-start gap-3 px-5 py-2.5">
                  <span
                    className={clsx(
                      'mt-1 h-2 w-2 shrink-0',
                      h.authorType === 'IA' ? 'bg-info' : h.authorType === 'SISTEMA' ? 'bg-ink-3' : 'bg-ink',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {h.fromStatus && h.fromStatus !== h.toStatus ? (
                        <>
                          <span className="text-ink-3">{ORDER_STATUS_LABELS[h.fromStatus] ?? h.fromStatus}</span>
                          {' → '}
                          <strong>{ORDER_STATUS_LABELS[h.toStatus] ?? h.toStatus}</strong>
                        </>
                      ) : (
                        <strong>{h.reason ?? ORDER_STATUS_LABELS[h.toStatus] ?? h.toStatus}</strong>
                      )}
                    </p>
                    {h.fromStatus !== h.toStatus && h.reason && (
                      <p className="text-xs text-ink-3">{h.reason}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-semibold">{h.authorName ?? h.authorType}</p>
                    <p className="text-[11px] text-ink-3">{fmtDateTime(h.createdAt)}</p>
                  </div>
                </div>
              ))}
              {(order.statusHistory?.length ?? 0) === 0 && (
                <p className="px-5 py-4 text-sm text-ink-3">Sin movimientos registrados.</p>
              )}
            </div>
          </section>
        </div>

        {/* ─── Columna lateral ─── */}
        <div className="space-y-5">
          {canWrite && nextStatuses.length > 0 && (
            <section className="border-2 border-ink bg-paper p-5">
              <p className="kicker mb-3">Avanzar estado</p>
              <div className="flex flex-wrap gap-2">
                {nextStatuses.map((next) => (
                  <Button
                    key={next}
                    size="sm"
                    variant={next === 'cancelado' || next === 'requiere_atencion' ? 'danger' : 'primary'}
                    onClick={() =>
                      next === 'cancelado' || next === 'requiere_atencion'
                        ? setStatusTarget(next)
                        : changeStatus.mutate({ status: next })
                    }
                    disabled={changeStatus.isPending}
                  >
                    <Check size={12} /> {ORDER_STATUS_LABELS[next] ?? next}
                  </Button>
                ))}
              </div>
            </section>
          )}

          <section className="border-2 border-ink bg-paper p-5">
            <p className="kicker mb-2">Cliente</p>
            <p className="font-semibold">{order.customer.name}</p>
            {order.contact && (
              <p className="text-sm text-ink-2">
                {order.contact.name} · {order.contact.phone}
              </p>
            )}
            <Link to="/app/customers" className="mt-2 inline-block text-xs font-semibold underline">
              Ver ficha del cliente
            </Link>
          </section>

          {order.feedback && (
            <section className="border-2 border-ink bg-paper p-5">
              <p className="kicker mb-2">Feedback del cliente</p>
              <p className="flex items-center gap-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star
                    key={i} size={16}
                    className={i < order.feedback!.rating ? 'fill-ink text-ink' : 'text-line'}
                  />
                ))}
              </p>
              {order.feedback.comment && (
                <p className="mt-2 text-sm text-ink-2">"{order.feedback.comment}"</p>
              )}
            </section>
          )}

          <section className="border-2 border-ink bg-paper">
            <header className="border-b-2 border-ink px-5 py-3">
              <p className="kicker">Recordatorios</p>
            </header>
            <div className="divide-y divide-line">
              {(order.reminders ?? []).map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 px-5 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold capitalize">
                      {r.kind.replaceAll('_', ' ')}
                    </p>
                    <p className="text-xs text-ink-3">
                      {fmtDateTime(r.scheduledAt)} · {r.channel}
                    </p>
                  </div>
                  <Badge
                    tone={
                      r.status === 'ENVIADO' ? 'ok'
                        : r.status === 'FALLIDO' ? 'bad'
                          : r.status === 'CANCELADO' ? 'neutral' : 'warn'
                    }
                  >
                    {REMINDER_STATUS_LABELS[r.status] ?? r.status}
                  </Badge>
                </div>
              ))}
              {(order.reminders?.length ?? 0) === 0 && (
                <p className="px-5 py-4 text-sm text-ink-3">
                  Sin recordatorios (se programan al confirmar).
                </p>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Motivo obligatorio para cancelar / marcar atención */}
      <Modal
        open={!!statusTarget}
        onClose={() => setStatusTarget(null)}
        kicker="Cambio de estado"
        title={statusTarget ? (ORDER_STATUS_LABELS[statusTarget] ?? statusTarget) : ''}
      >
        <div className="space-y-4">
          <Field label="Motivo" hint="Queda en el historial del pedido" required>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button
            className="w-full"
            variant="danger"
            disabled={!reason.trim() || changeStatus.isPending}
            onClick={() => changeStatus.mutate({ status: statusTarget!, reason })}
          >
            Confirmar cambio
          </Button>
        </div>
      </Modal>

      {editing && <EditModal order={order} open={editing} onClose={() => setEditing(false)} q={q} />}
    </>
  );
}
