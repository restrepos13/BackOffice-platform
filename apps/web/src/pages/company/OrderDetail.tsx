import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowLeft, Bike, Bot, Check, Copy, ExternalLink, FileCheck2, Image as ImageIcon, MapPin, MessageSquare, Pencil, Printer, Receipt, Star, UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, getToken, openPdf } from '../../lib/api';
import {
  ORDER_SOURCE_LABELS, ORDER_STATUS_LABELS, PAYMENT_STATUS_LABELS, REMINDER_STATUS_LABELS, fmtDateTime, fmtMoney, fmtTime,
  etaLabel, orderStatusTone, paymentTone,
} from '../../lib/format';
import type { Order, Product, UserRow } from '../../lib/types';
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

/* ─── Domicilio: seguimiento público, domiciliario, totales y prueba ─── */

function DeliveryCard({ order, q, canWrite }: { order: Order; q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data: users } = useQuery({
    queryKey: ['users', q],
    queryFn: () => api.get<UserRow[]>(withScope('/users', q)),
    enabled: canWrite,
  });
  const couriers = (users ?? []).filter((u) => u.role === 'COMPANY_COURIER' && u.active);
  const assign = useMutation({
    mutationFn: (courierId: string | null) =>
      api.post(withScope(`/delivery/orders/${order.id}/assign`, q), { courierId }),
    onSuccess: () => {
      toast.success('Domiciliario actualizado');
      queryClient.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const openProof = async () => {
    const res = await fetch(`/api/delivery/orders/${order.id}/proof${q ? `?${q}` : ''}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) return toast.error('No se pudo abrir la foto');
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const eta = etaLabel(order.etaAt);
  const closed = ['entregado', 'cancelado'].includes(order.status);
  const hasMoney = order.total != null || order.subtotal != null;
  if (!order.trackingUrl && !order.courierId && !hasMoney && couriers.length === 0) return null;

  return (
    <section className="border-2 border-ink bg-paper p-5">
      <p className="kicker mb-3 flex items-center gap-1.5"><Bike size={12} /> Domicilio</p>
      {hasMoney && (
        <dl className="mb-3 space-y-1 text-sm">
          {order.subtotal != null && <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd>{fmtMoney(order.subtotal)}</dd></div>}
          {order.deliveryFee != null && (
            <div className="flex justify-between">
              <dt className="text-ink-3">Envío{order.distanceKm != null ? ` · ${order.distanceKm} km` : ''}</dt>
              <dd>{order.deliveryFee === 0 ? 'Gratis' : fmtMoney(order.deliveryFee)}</dd>
            </div>
          )}
          {order.total != null && <div className="flex justify-between font-semibold"><dt>Total</dt><dd>{fmtMoney(order.total)}</dd></div>}
        </dl>
      )}
      {canWrite && !closed && (
        <Field label="Domiciliario">
          <Select value={order.courierId ?? ''} disabled={assign.isPending} onChange={(e) => assign.mutate(e.target.value || null)}>
            <option value="">Sin asignar</option>
            {couriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      )}
      {order.courier && (
        <p className="mt-2 text-sm">
          <strong>{order.courier.name}</strong>
          <span className="text-ink-3"> · {order.courier.onShift ? 'en turno' : 'fuera de turno'}</span>
        </p>
      )}
      {order.status === 'despachado' && (
        <p className="mt-1 text-sm">
          Salió {order.dispatchedAt ? `a las ${fmtTime(order.dispatchedAt)}` : ''}
          {eta && <> · <strong>{eta}</strong></>}
        </p>
      )}
      {order.deliveredAt && <p className="mt-1 text-sm text-ok">Entregado a las {fmtTime(order.deliveredAt)}</p>}
      {order.hasDeliveryProof && (
        <Button size="sm" variant="outline" className="mt-2" onClick={openProof}>
          <ImageIcon size={12} /> Foto de la entrega
        </Button>
      )}
      {order.trackingUrl && (
        <div className="mt-3 border-t-2 border-line pt-3">
          <p className="kicker mb-1">Seguimiento del cliente</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(order.trackingUrl!).then(() => toast.success('Link copiado'))}
            >
              <Copy size={12} /> Copiar link
            </Button>
            <a href={order.trackingUrl} target="_blank" rel="noopener noreferrer">
              <Button size="sm" variant="ghost"><ExternalLink size={12} /> Ver como cliente</Button>
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

const PAY_METHODS = [
  ['EFECTIVO', 'Efectivo'], ['TRANSFERENCIA', 'Transferencia'], ['NEQUI', 'Nequi'],
  ['DAVIPLATA', 'Daviplata'], ['DATAFONO', 'Datáfono'], ['OTRO', 'Otro'],
] as const;

/** Cobro del pedido: link Wompi, comprobante leído por IA, pago manual y factura DIAN. */
function PaymentCard({ order, canWrite }: { order: Order; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState(order.paymentMethod ?? 'TRANSFERENCIA');
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['order', order.id] });
    queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const link = useMutation({
    mutationFn: () => api.post<{ url: string; reused?: boolean }>(`/payments/orders/${order.id}/link`),
    onSuccess: async (r) => {
      await navigator.clipboard?.writeText(r.url).catch(() => undefined);
      toast.success(r.reused ? 'Link vigente copiado' : 'Link de pago creado y copiado');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const mark = useMutation({
    mutationFn: (verified: boolean) => api.post(`/payments/orders/${order.id}/mark-paid`, { method, verified }),
    onSuccess: (_d, verified) => { toast.success(verified ? 'Pedido marcado como pagado' : 'Comprobante rechazado'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const einvoice = useMutation({
    mutationFn: () => api.post<{ ok: boolean; number?: string; error?: string }>(`/orders/${order.id}/einvoice`),
    onSuccess: (r) => {
      if (r.ok) toast.success(`Factura ${r.number ?? ''} emitida`);
      else toast.error(r.error ?? 'No se pudo emitir');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const receipt = (() => {
    try { return order.receiptJson ? JSON.parse(order.receiptJson) : null; } catch { return null; }
  })() as { amount?: number | null; bank?: string | null; reference?: string | null; date?: string | null; matches?: boolean } | null;
  const status = order.paymentStatus ?? 'NONE';
  const open = !['cancelado', 'borrador'].includes(order.status);

  return (
    <section className="border-2 border-ink bg-paper p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="kicker">Cobro</p>
        <Badge tone={paymentTone(status)}>{PAYMENT_STATUS_LABELS[status] ?? status}</Badge>
      </div>
      <dl className="space-y-1 text-sm">
        {order.subtotal != null && (
          <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd className="tabular-nums">{fmtMoney(order.subtotal)}</dd></div>
        )}
        {(order.discount ?? 0) > 0 && (
          <div className="flex justify-between text-ok">
            <dt>Descuento{order.couponCode && <span className="ml-1 font-mono text-xs">{order.couponCode}</span>}</dt>
            <dd className="tabular-nums">−{fmtMoney(order.discount)}</dd>
          </div>
        )}
        {(order.deliveryFee ?? 0) > 0 && (
          <div className="flex justify-between"><dt className="text-ink-3">Domicilio</dt><dd className="tabular-nums">{fmtMoney(order.deliveryFee)}</dd></div>
        )}
        <div className="flex justify-between border-t-2 border-ink pt-1 font-semibold">
          <dt>Total</dt><dd className="display text-xl tabular-nums">{order.total != null ? fmtMoney(order.total) : '—'}</dd>
        </div>
      </dl>
      {status === 'PAID' && (
        <p className="mt-2 text-xs text-ink-3">
          Pagado{order.paymentMethod ? ` · ${PAY_METHODS.find(([k]) => k === order.paymentMethod)?.[1] ?? order.paymentMethod}` : ''}
          {order.paidAt ? ` · ${fmtDateTime(order.paidAt)}` : ''}
        </p>
      )}
      {status === 'REPORTED' && receipt && (
        <div className="mt-3 border-2 border-warn bg-warn-soft p-3 text-sm">
          <p className="flex items-center gap-1.5 font-semibold"><Receipt size={14} /> El cliente envió un comprobante</p>
          <p className="mt-1 tabular-nums">
            {receipt.amount != null ? fmtMoney(receipt.amount) : 'Monto ilegible'}
            {receipt.bank && ` · ${receipt.bank}`}{receipt.reference && ` · ref ${receipt.reference}`}
          </p>
          {receipt.matches === false && <p className="mt-1 text-xs font-semibold text-bad">El monto no coincide con el total</p>}
          <p className="mt-1 text-[11px] text-ink-3">La IA lee el comprobante, pero el pago se confirma en tu banco.</p>
          {canWrite && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => mark.mutate(true)} disabled={mark.isPending}>Confirmar pago</Button>
              <Button size="sm" variant="outline" onClick={() => mark.mutate(false)} disabled={mark.isPending}>Rechazar</Button>
            </div>
          )}
        </div>
      )}
      {order.paymentLinkUrl && status !== 'PAID' && (
        <div className="mt-3 flex items-center gap-2 border-2 border-line bg-bone-2 px-2 py-1.5 text-xs">
          <span className="truncate">{order.paymentLinkUrl}</span>
          <button
            className="cursor-pointer text-ink-3 hover:text-ink"
            aria-label="Copiar link de pago"
            onClick={() => navigator.clipboard?.writeText(order.paymentLinkUrl!).then(() => toast.success('Link copiado'))}
          >
            <Copy size={12} />
          </button>
        </div>
      )}
      {canWrite && open && status !== 'PAID' && (
        <div className="mt-3 space-y-2">
          <Button size="sm" variant="outline" className="w-full" onClick={() => link.mutate()} disabled={link.isPending || !order.total}>
            {link.isPending ? 'Generando…' : order.paymentLinkUrl ? 'Copiar link de pago' : 'Generar link de pago (Wompi)'}
          </Button>
          <div className="flex gap-2">
            <Select value={method} onChange={(e) => setMethod(e.target.value)} className="!py-1.5 text-xs" aria-label="Medio de pago">
              {PAY_METHODS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
            <Button size="sm" onClick={() => mark.mutate(true)} disabled={mark.isPending}>Marcar pagado</Button>
          </div>
        </div>
      )}
      {/* Factura electrónica DIAN */}
      <div className="mt-4 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider"><FileCheck2 size={13} /> Factura electrónica</p>
          {order.einvoiceStatus === 'EMITIDA' && <Badge tone="ok">{order.einvoiceNumber}</Badge>}
          {order.einvoiceStatus === 'ERROR' && <Badge tone="bad">Error</Badge>}
        </div>
        {order.einvoiceError && order.einvoiceStatus === 'ERROR' && <p className="mt-1 text-xs text-bad">{order.einvoiceError}</p>}
        {canWrite && open && order.einvoiceStatus !== 'EMITIDA' && (
          <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={() => einvoice.mutate()} disabled={einvoice.isPending}>
            {einvoice.isPending ? 'Emitiendo…' : order.einvoiceStatus === 'ERROR' ? 'Reintentar factura' : 'Emitir factura electrónica'}
          </Button>
        )}
      </div>
    </section>
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
        kicker={`Pedido${order.code ? ` #${order.code}` : ''} · ${order.customer.name}${order.source && order.source !== 'WHATSAPP' ? ` · ${ORDER_SOURCE_LABELS[order.source] ?? order.source}` : ''}`}
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
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                openPdf(`/orders/${order.id}/pdf`).catch((e) =>
                  toast.error(e instanceof Error ? e.message : 'Error'),
                )
              }
            >
              PDF
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.open(`/print/order/${order.id}`, '_blank', 'noopener,width=420,height=720')}>
              <Printer size={13} /> Comanda
            </Button>
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

          <PaymentCard order={order} canWrite={canWrite} />

          <DeliveryCard order={order} q={q} canWrite={canWrite} />

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
