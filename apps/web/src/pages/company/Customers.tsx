import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Phone, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { ORDER_STATUS_LABELS, fmtDateTime, orderStatusTone } from '../../lib/format';
import type { Customer, Order } from '../../lib/types';
import {
  Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Table, Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

interface AddressRow {
  label: string;
  address: string;
  city?: string;
  instructions?: string;
}

function CustomerModal({
  open, onClose, customer, q, companyId,
}: {
  open: boolean;
  onClose: () => void;
  customer: Customer | null; // null = crear
  q: string;
  companyId: string | null;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(customer?.name ?? '');
  const [taxId, setTaxId] = useState(customer?.taxId ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [addresses, setAddresses] = useState<AddressRow[]>(customer?.addresses ?? []);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, taxId, notes, addresses,
        ...(companyId ? { companyId } : {}),
      };
      return customer
        ? api.patch(`/customers/${customer.id}`, body)
        : api.post('/customers', body);
    },
    onSuccess: () => {
      toast.success(customer ? 'Cliente actualizado' : 'Cliente creado');
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const setAddress = (idx: number, patch: Partial<AddressRow>) =>
    setAddresses((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));

  return (
    <Modal
      open={open} onClose={onClose} wide
      kicker="Clientes" title={customer ? customer.name : 'Nuevo cliente'}
    >
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nombre / Razón social" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="NIT / Documento">
            <Input value={taxId ?? ''} onChange={(e) => setTaxId(e.target.value)} />
          </Field>
        </div>
        <Field label="Notas y preferencias" hint="La IA las usa al atender a este cliente (condiciones, gustos, restricciones)">
          <Textarea rows={2} value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        <div>
          <p className="kicker mb-2">Direcciones de entrega</p>
          <div className="space-y-2">
            {addresses.map((addr, idx) => (
              <div key={idx} className="grid gap-2 border-2 border-line p-2 md:grid-cols-[140px_1fr_120px_auto]">
                <Input
                  value={addr.label} placeholder="Etiqueta (Sede norte…)"
                  onChange={(e) => setAddress(idx, { label: e.target.value })}
                  aria-label="Etiqueta"
                />
                <Input
                  value={addr.address} placeholder="Dirección"
                  onChange={(e) => setAddress(idx, { address: e.target.value })}
                  aria-label="Dirección"
                />
                <Input
                  value={addr.city ?? ''} placeholder="Ciudad"
                  onChange={(e) => setAddress(idx, { city: e.target.value })}
                  aria-label="Ciudad"
                />
                <Button
                  size="sm" variant="ghost"
                  onClick={() => setAddresses((prev) => prev.filter((_, i) => i !== idx))}
                >
                  Quitar
                </Button>
              </div>
            ))}
          </div>
          <Button
            size="sm" variant="outline" className="mt-2"
            onClick={() => setAddresses((prev) => [...prev, { label: '', address: '' }])}
          >
            + Agregar dirección
          </Button>
        </div>

        <Button className="w-full" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar cliente'}
        </Button>
      </div>
    </Modal>
  );
}

function CustomerCard({ customer, canWrite, onEdit }: {
  customer: Customer;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const [showOrders, setShowOrders] = useState(false);
  const { data: orders, isLoading } = useQuery({
    queryKey: ['customer-orders', customer.id],
    queryFn: () =>
      api.get<Order[]>(`/orders?customerId=${customer.id}&from=2020-01-01&companyId=${customer.companyId}`),
    enabled: showOrders,
  });

  return (
    <article className="border-2 border-ink bg-paper">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink px-4 py-3">
        <div>
          <p className="display text-lg leading-tight">{customer.name}</p>
          <p className="text-xs text-ink-3">
            {customer.taxId ? `${customer.taxId} · ` : ''}
            {customer._count?.orders ?? 0} pedido{(customer._count?.orders ?? 0) === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowOrders(!showOrders)}>
            {showOrders ? 'Ocultar pedidos' : 'Historial'}
          </Button>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={onEdit}>Editar</Button>
          )}
        </div>
      </header>
      <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
        <div>
          <p className="kicker mb-1.5">Contactos que escriben</p>
          {(customer.contacts?.length ?? 0) === 0 ? (
            <p className="text-sm text-ink-3">Ninguno vinculado aún.</p>
          ) : (
            customer.contacts?.map((c) => (
              <p key={c.id} className="flex items-center gap-1.5 text-sm">
                <Phone size={12} className="text-ink-3" /> {c.name} · {c.phone}
              </p>
            ))
          )}
        </div>
        <div>
          <p className="kicker mb-1.5">Direcciones</p>
          {(customer.addresses?.length ?? 0) === 0 ? (
            <p className="text-sm text-ink-3">Sin direcciones registradas.</p>
          ) : (
            customer.addresses.map((a, i) => (
              <p key={i} className="flex items-start gap-1.5 text-sm">
                <MapPin size={12} className="mt-1 shrink-0 text-ink-3" />
                <span>
                  {a.label && <strong>{a.label} · </strong>}
                  {a.address}
                  {a.city ? `, ${a.city}` : ''}
                </span>
              </p>
            ))
          )}
        </div>
      </div>
      {customer.notes && (
        <p className="border-t border-line px-4 py-2.5 text-sm text-ink-2">
          <span className="kicker mr-2">Notas</span>
          {customer.notes}
        </p>
      )}
      {showOrders && (
        <div className="border-t-2 border-ink">
          {isLoading ? (
            <Loading />
          ) : (orders?.length ?? 0) === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-3">Sin pedidos registrados.</p>
          ) : (
            <div className="divide-y divide-line">
              {orders?.slice(0, 8).map((order) => (
                <Link
                  key={order.id}
                  to={`/app/orders/${order.id}`}
                  className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-bone-2"
                >
                  <p className="truncate text-sm">
                    {fmtDateTime(order.deliveryAt)} ·{' '}
                    {order.items?.map((i) => `${i.quantity} × ${i.productName}`).join(', ')}
                  </p>
                  <Badge tone={orderStatusTone(order.status)}>
                    {ORDER_STATUS_LABELS[order.status] ?? order.status}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function Customers() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);

  const listPath = withScope(`/customers?x=1${search ? `&search=${encodeURIComponent(search)}` : ''}`, q);
  const { data: customers, isLoading } = useQuery({
    queryKey: ['customers', listPath],
    queryFn: () => api.get<Customer[]>(listPath),
    enabled: ready,
  });

  if (!ready) return <PickCompany />;

  return (
    <>
      <PageHeader
        kicker="Módulo de pedidos"
        title="Clientes"
        actions={
          canWrite ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus size={13} /> Nuevo cliente
            </Button>
          ) : undefined
        }
      />

      <div className="mb-4 flex max-w-md items-center gap-2 border-2 border-ink bg-bone px-3">
        <Search size={14} className="shrink-0 text-ink-3" />
        <input
          className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-ink-3"
          placeholder="Buscar por nombre…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : (customers?.length ?? 0) === 0 ? (
        <EmptyState
          title="Sin clientes"
          hint="La IA crea la ficha automáticamente cuando un cliente nuevo hace su primer pedido, o créalos a mano."
          action={canWrite ? <Button onClick={() => setCreating(true)}>Crear el primero</Button> : undefined}
        />
      ) : (
        <div className="space-y-4">
          {customers?.map((customer) => (
            <CustomerCard
              key={customer.id}
              customer={customer}
              canWrite={canWrite}
              onEdit={() => setEditing(customer)}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <CustomerModal
          open
          onClose={() => { setCreating(false); setEditing(null); }}
          customer={editing}
          q={q}
          companyId={companyId}
        />
      )}
    </>
  );
}
