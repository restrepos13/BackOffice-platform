import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, MessageCircle, Plus, QrCode, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, getToken, uploadFile } from '../../lib/api';
import { fmtMoney, timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Switch, Tabs, Textarea } from '../../components/ui';

/**
 * Ventas (equipo): los pedidos de plan que hacen las empresas desde su panel y
 * los métodos de pago con los que se cobran (QR Bancolombia y cuentas de
 * ahorros). El cliente nunca ve estos datos en el panel: se los envía el
 * equipo por WhatsApp con un mensaje ya armado.
 */

interface Order {
  id: string;
  companyId: string;
  planName: string;
  billingCycle: string;
  planAmount: number;
  aiPackageName: string | null;
  aiPackageAmount: number;
  total: number;
  status: string;
  method: string | null;
  notes: string | null;
  recommendation: { plan?: string | null; followed?: boolean; aiPackage?: string | null };
  requestedBy: string | null;
  handledBy: string | null;
  createdAt: string;
  company: { id: string; name: string; status: string; email: string | null; contactName: string | null } | null;
  whatsapp: string | null;
}

interface Account { id: string; bank: string; type: string; number: string; holder: string; document: string; owner: string }
interface Methods {
  qr: { enabled: boolean; bank: string; holder: string; imageFile: string | null; note: string };
  accounts: Account[];
  wompi: { status: string };
  instructions: string;
}

const STATUS: Record<string, { label: string; tone: 'bad' | 'warn' | 'info' | 'ok' | 'neutral' }> = {
  REQUESTED: { label: 'Nuevo · sin contactar', tone: 'bad' },
  CONTACTED: { label: 'Contactado', tone: 'info' },
  AWAITING_PAYMENT: { label: 'Esperando pago', tone: 'warn' },
  PAID: { label: 'Pagado · falta activar', tone: 'warn' },
  ACTIVE: { label: 'Activo', tone: 'ok' },
  CANCELLED: { label: 'Cancelado', tone: 'neutral' },
};

function QrPreview({ version }: { version: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!version) return;
    let revoke: string | null = null;
    fetch('/api/platform/payment-methods/qr', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) {
          revoke = URL.createObjectURL(b);
          setUrl(revoke);
        }
      })
      .catch(() => undefined);
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [version]);
  if (!version) return <div className="flex aspect-square w-40 items-center justify-center border-2 border-dashed border-line text-xs text-ink-3">Sin QR</div>;
  return url ? (
    <div className="space-y-2">
      <img src={url} alt="QR de pagos" className="aspect-square w-40 border-2 border-ink bg-white object-contain p-1" />
      <a href={url} download="qr-backoffice.png" className="inline-flex items-center gap-1 text-xs font-semibold underline"><Download size={12} /> Descargar para enviar</a>
    </div>
  ) : <Loading />;
}

function MethodsTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['payment-methods'], queryFn: () => api.get<Methods>('/platform/payment-methods') });
  const [form, setForm] = useState<Methods | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.put<Methods>('/platform/payment-methods', form),
    onSuccess: (r) => {
      queryClient.setQueryData(['payment-methods'], r);
      toast.success('Métodos de pago guardados');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const upload = useMutation({
    mutationFn: (f: File) => uploadFile<Methods>('/platform/payment-methods/qr', 'file', f),
    onSuccess: (r) => {
      queryClient.setQueryData(['payment-methods'], r);
      setForm((x) => (x ? { ...x, qr: { ...x.qr, imageFile: r.qr.imageFile } } : r));
      toast.success('QR actualizado');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (isLoading || !form) return <Loading />;
  const setAccount = (i: number, patch: Partial<Account>) => setForm({ ...form, accounts: form.accounts.map((a, j) => (j === i ? { ...a, ...patch } : a)) });

  return (
    <div className="space-y-6">
      <p className="border-2 border-line bg-bone px-4 py-3 text-sm text-ink-2">
        Estos datos nunca aparecen en el panel del cliente. Cuando una empresa compra, le escriben ustedes por WhatsApp desde la pestaña Pedidos con el mensaje ya armado.
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card kicker="Código QR" title={`QR ${form.qr.bank}`} actions={<Switch checked={form.qr.enabled} onChange={(v) => setForm({ ...form, qr: { ...form.qr, enabled: v } })} label="QR activo" showLabel />}>
          <div className="flex flex-wrap gap-5">
            <div className="space-y-2">
              <QrPreview version={form.qr.imageFile} />
              <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
              <Button size="sm" variant="outline" disabled={upload.isPending} onClick={() => file.current?.click()}>
                <Upload size={12} /> {upload.isPending ? 'Subiendo…' : form.qr.imageFile ? 'Cambiar imagen' : 'Subir QR'}
              </Button>
            </div>
            <div className="min-w-[220px] flex-1 space-y-3">
              <Field label="Banco"><Input value={form.qr.bank} onChange={(e) => setForm({ ...form, qr: { ...form.qr, bank: e.target.value } })} /></Field>
              <Field label="A nombre de"><Input value={form.qr.holder} onChange={(e) => setForm({ ...form, qr: { ...form.qr, holder: e.target.value } })} /></Field>
              <Field label="Nota para el cliente" hint="Opcional. Ej.: Escribe tu NIT en la descripción del pago"><Input value={form.qr.note} onChange={(e) => setForm({ ...form, qr: { ...form.qr, note: e.target.value } })} /></Field>
            </div>
          </div>
        </Card>

        <Card kicker="Pago en línea" title="Wompi">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-ink-2">Tarjeta, PSE y Nequi. La integración sigue lista; por ahora el cliente lo ve como <b>Próximamente</b>.</p>
            <Badge tone="neutral">Próximamente</Badge>
          </div>
        </Card>
      </div>

      <Card
        kicker="Transferencia"
        title="Cuentas de ahorros"
        actions={form.accounts.length < 6 && (
          <Button size="sm" variant="outline" onClick={() => setForm({ ...form, accounts: [...form.accounts, { id: '', bank: 'Bancolombia', type: 'Ahorros', number: '', holder: '', document: '', owner: '' }] })}>
            <Plus size={12} /> Cuenta
          </Button>
        )}
      >
        {form.accounts.length === 0 && <p className="text-sm text-ink-3">Agrega la cuenta de alguno de ustedes dos para recibir transferencias.</p>}
        <div className="space-y-3">
          {form.accounts.map((a, i) => (
            <div key={i} className="grid gap-2 border-2 border-line p-3 sm:grid-cols-2 lg:grid-cols-[1fr_120px_1.2fr_1.2fr_1fr_1fr_auto]">
              <Input placeholder="Banco" value={a.bank} onChange={(e) => setAccount(i, { bank: e.target.value })} aria-label="Banco" />
              <Select value={a.type} onChange={(e) => setAccount(i, { type: e.target.value })} aria-label="Tipo de cuenta">
                <option>Ahorros</option>
                <option>Corriente</option>
              </Select>
              <Input placeholder="Número de cuenta" inputMode="numeric" value={a.number} onChange={(e) => setAccount(i, { number: e.target.value })} aria-label="Número" />
              <Input placeholder="Titular" value={a.holder} onChange={(e) => setAccount(i, { holder: e.target.value })} aria-label="Titular" />
              <Input placeholder="C.C. o NIT" value={a.document} onChange={(e) => setAccount(i, { document: e.target.value })} aria-label="Documento" />
              <Input placeholder="De quién (interno)" value={a.owner} onChange={(e) => setAccount(i, { owner: e.target.value })} aria-label="Dueño interno" />
              <button type="button" aria-label="Quitar cuenta" className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setForm({ ...form, accounts: form.accounts.filter((_, j) => j !== i) })}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <Field label="Mensaje final del cobro" hint="Va al final del mensaje de WhatsApp con los datos de pago">
          <Textarea rows={2} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
        </Field>
      </Card>

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar métodos de pago'}</Button>
      </div>
    </div>
  );
}

function OrdersTab() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('OPEN');
  const [activating, setActivating] = useState<Order | null>(null);
  const [notes, setNotes] = useState<{ order: Order; text: string } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['plan-orders', filter],
    queryFn: () => api.get<{ methods: { qr: boolean; accounts: number }; orders: Order[] }>(`/platform/plan-orders?status=${filter}`),
    refetchInterval: 60_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plan-orders'] });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: string; method?: string; notes?: string }) => api.patch(`/platform/plan-orders/${id}`, body),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const activate = useMutation({
    mutationFn: (id: string) => api.post(`/platform/plan-orders/${id}/activate`),
    onSuccess: () => {
      refresh();
      toast.success('Cuenta activada: plan, ciclo y paquete de IA aplicados');
      setActivating(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  async function sendPayment(o: Order, method: 'TRANSFER' | 'QR') {
    // La pestaña se abre ya (si no, el navegador la bloquea) y luego recibe el mensaje
    const win = window.open('about:blank', '_blank');
    try {
      const { text } = await api.get<{ text: string }>(`/platform/plan-orders/${o.id}/message?method=${method}`);
      if (win) win.location.href = `https://wa.me/${o.whatsapp}?text=${encodeURIComponent(text)}`;
      update.mutate({ id: o.id, status: 'AWAITING_PAYMENT', method });
      if (method === 'QR') toast.info('Envía también la imagen del QR (descárgala en Métodos de pago)');
    } catch (e) {
      win?.close();
      toast.error(e instanceof Error ? e.message : 'No se pudo armar el mensaje');
    }
  }

  if (isLoading || !data) return <Loading />;
  return (
    <div className="space-y-4">
      {!data.methods.accounts && !data.methods.qr && (
        <p className="border-2 border-warn bg-warn-soft px-4 py-3 text-sm">Configura una cuenta o el QR en "Métodos de pago" para poder enviar los datos de cobro.</p>
      )}
      <Tabs
        active={filter}
        onChange={setFilter}
        tabs={[
          { id: 'OPEN', label: 'Por atender', badge: filter === 'OPEN' ? data.orders.length : undefined },
          { id: 'ACTIVE', label: 'Activados' },
          { id: 'CANCELLED', label: 'Cancelados' },
          { id: 'ALL', label: 'Todos' },
        ]}
      />
      {data.orders.length === 0 ? (
        <EmptyState title="Sin pedidos aquí" hint={filter === 'OPEN' ? 'Cuando una empresa compre un plan aparecerá en esta lista.' : undefined} />
      ) : (
        <ul className="space-y-3">
          {data.orders.map((o) => (
            <li key={o.id} className="border-2 border-ink bg-paper p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold">{o.company?.name ?? 'Empresa eliminada'}</p>
                    <Badge tone={STATUS[o.status]?.tone ?? 'neutral'}>{STATUS[o.status]?.label ?? o.status}</Badge>
                    {o.recommendation.followed === false && <Badge tone="neutral">Eligió distinto a lo recomendado</Badge>}
                  </div>
                  <p className="mt-1 text-sm">
                    Plan <b>{o.planName}</b> · {o.billingCycle === 'ANNUAL' ? 'anual' : 'mensual'} ({fmtMoney(o.planAmount)})
                    {o.aiPackageName ? <> + {o.aiPackageName} ({fmtMoney(o.aiPackageAmount)})</> : null}
                  </p>
                  <p className="display mt-1 text-2xl">{fmtMoney(o.total)}</p>
                  <p className="text-xs text-ink-3">
                    {o.company?.contactName ?? o.requestedBy ?? ''}{o.company?.email ? ` · ${o.company.email}` : ''} · pidió {timeAgo(o.createdAt)}
                    {o.handledBy ? ` · atiende ${o.handledBy}` : ''}
                  </p>
                  {o.notes && <p className="mt-1 text-xs text-ink-2">Notas: {o.notes}</p>}
                </div>
                {o.status !== 'ACTIVE' && o.status !== 'CANCELLED' && (
                  <div className="flex flex-wrap items-center gap-2">
                    {o.whatsapp && (
                      <>
                        <Button size="sm" onClick={() => sendPayment(o, 'TRANSFER')} disabled={!data.methods.accounts}><MessageCircle size={13} /> Enviar cuentas</Button>
                        <Button size="sm" variant="outline" onClick={() => sendPayment(o, 'QR')} disabled={!data.methods.qr}><QrCode size={13} /> Enviar QR</Button>
                      </>
                    )}
                    <Select className="!w-44 !py-1.5 text-xs" value={o.status} aria-label="Estado" onChange={(e) => update.mutate({ id: o.id, status: e.target.value })}>
                      {['REQUESTED', 'CONTACTED', 'AWAITING_PAYMENT', 'PAID', 'CANCELLED'].map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
                    </Select>
                    <Button size="sm" variant="ghost" onClick={() => setNotes({ order: o, text: o.notes ?? '' })}>Notas</Button>
                    <Button size="sm" variant="outline" onClick={() => setActivating(o)}>Activar cuenta</Button>
                  </div>
                )}
                {o.company && <Link to={`/platform/companies/${o.company.id}`} className="text-xs underline">Ver empresa</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!activating} onClose={() => setActivating(null)} kicker="Pago confirmado" title={activating ? `Activar ${activating.company?.name ?? ''}` : ''}>
        {activating && (
          <div className="space-y-4 text-sm">
            <p>Al activar:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>La empresa queda <b>activa</b> con el plan <b>{activating.planName}</b> ({activating.billingCycle === 'ANNUAL' ? 'anual' : 'mensual'}).</li>
              {activating.aiPackageName && <li>Se le acredita el <b>{activating.aiPackageName}</b> de IA.</li>}
              <li>El pedido queda como pagado por {fmtMoney(activating.total)}.</li>
            </ul>
            <p className="text-ink-3">Hazlo solo cuando el pago esté confirmado en la cuenta.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActivating(null)}>Cancelar</Button>
              <Button disabled={activate.isPending} onClick={() => activate.mutate(activating.id)}>{activate.isPending ? 'Activando…' : 'Sí, ya pagó: activar'}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!notes} onClose={() => setNotes(null)} kicker="Pedido" title="Notas internas">
        {notes && (
          <div className="space-y-4">
            <Textarea rows={5} value={notes.text} onChange={(e) => setNotes({ ...notes, text: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setNotes(null)}>Cancelar</Button>
              <Button onClick={() => update.mutate({ id: notes.order.id, notes: notes.text }, { onSuccess: () => { setNotes(null); toast.success('Notas guardadas'); } })}>Guardar</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function Ventas() {
  const [tab, setTab] = useState('orders');
  return (
    <>
      <PageHeader kicker="Compras desde el panel" title="Ventas" />
      <div className="mb-5">
        <Tabs active={tab} onChange={setTab} tabs={[{ id: 'orders', label: 'Pedidos' }, { id: 'methods', label: 'Métodos de pago' }]} />
      </div>
      {tab === 'orders' ? <OrdersTab /> : <MethodsTab />}
    </>
  );
}
