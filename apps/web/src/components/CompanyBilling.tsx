import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Gift, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { ADJUSTMENT_LABELS, LINE_KIND_LABELS, fmtDate, fmtMoney, fmtNum, fmtPeriod, ivaIncluido } from '../lib/format';
import type { SocialStatus } from '../lib/types';
import type {
  AiCreditsStatus, BillingAdjustment, BillingSummaryV2, Company, InvoiceLine, InvoiceRow,
} from '../lib/types';
import { Badge, Button, Card, Field, Input, Modal, Select, Switch, Textarea } from './ui';

/**
 * Cobro de una empresa (solo plataforma): lo que se le cobra este mes y los
 * siguientes, totalmente personalizable — precio pactado, ajustes por mes o
 * rango, facturas editables, permanencia y saldo de IA prepago.
 */

const thisPeriod = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function CompanyBilling({ company }: { company: Company }) {
  const queryClient = useQueryClient();
  const q = `companyId=${company.id}`;
  const [adjOpen, setAdjOpen] = useState(false);
  const [editing, setEditing] = useState<InvoiceRow | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const refresh = () => {
    for (const key of ['billing-summary', 'billing-forecast', 'adjustments', 'invoices', 'ai-credits', 'company']) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  const { data: summary } = useQuery({
    queryKey: ['billing-summary', company.id],
    queryFn: () => api.get<BillingSummaryV2>(`/billing/summary?${q}`),
  });
  const { data: forecast } = useQuery({
    queryKey: ['billing-forecast', company.id],
    queryFn: () => api.get<{ currency: string; months: Array<{ period: string; total: number; lines: InvoiceLine[] }> }>(`/billing/forecast?${q}&months=4`),
  });
  const { data: adjustments } = useQuery({
    queryKey: ['adjustments', company.id],
    queryFn: () => api.get<BillingAdjustment[]>(`/billing/adjustments?${q}`),
  });
  const { data: invoices } = useQuery({
    queryKey: ['invoices', company.id],
    queryFn: () => api.get<InvoiceRow[]>(`/billing/invoices?${q}`),
  });
  const { data: credits } = useQuery({
    queryKey: ['ai-credits', company.id],
    queryFn: () => api.get<AiCreditsStatus>(`/ai-credits/status?${q}`),
  });

  const updateCompany = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/companies/${company.id}`, patch),
    onSuccess: () => {
      toast.success('Guardado');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const toggleAdj = useMutation({
    mutationFn: (a: BillingAdjustment) => api.patch(`/billing/adjustments/${a.id}`, { active: !a.active }),
    onSuccess: refresh,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const removeAdj = useMutation({
    mutationFn: (id: string) => api.delete(`/billing/adjustments/${id}`),
    onSuccess: () => {
      toast.success('Ajuste eliminado');
      refresh();
    },
  });
  const issue = useMutation({
    mutationFn: (period: string) => api.post<InvoiceRow>('/billing/invoices/issue', { companyId: company.id, period }),
    onSuccess: (inv) => {
      toast.success(`Factura de ${fmtPeriod(inv.period)} lista`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const currency = summary?.currency ?? 'COP';
  const contract = summary?.contract;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <div className="space-y-6">
        {/* ─── Este mes y los próximos ─── */}
        <Card kicker="Lo que se le cobra" title={summary ? `${fmtPeriod(summary.period)} · ${fmtMoney(summary.total, currency)}` : 'Cargando…'}>
          {summary && <Lines lines={summary.lines} currency={currency} />}
          {forecast && (
            <div className="mt-5 grid grid-cols-2 gap-3 border-t-2 border-line pt-4 md:grid-cols-4">
              {forecast.months.map((m) => (
                <div key={m.period} className="border-2 border-line bg-bone px-3 py-2">
                  <p className="kicker">{fmtPeriod(m.period)}</p>
                  <p className="text-lg font-semibold">{fmtMoney(m.total, forecast.currency)}</p>
                  {m.lines.some((l) => l.kind !== 'PLAN') && (
                    <p className="text-[11px] text-ink-3">{m.lines.filter((l) => l.kind !== 'PLAN').map((l) => l.concept).join(' · ')}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ─── Ajustes ─── */}
        <Card
          kicker="Personalizado por mes"
          title="Ajustes de cobro"
          actions={<Button size="sm" onClick={() => setAdjOpen(true)}><Plus size={12} /> Nuevo ajuste</Button>}
        >
          <p className="mb-3 text-sm text-ink-2">
            Cambia lo que se le cobra un mes, un rango o de un mes en adelante: precio especial, cargo extra o descuento.
          </p>
          {(adjustments?.length ?? 0) === 0 ? (
            <p className="text-sm text-ink-3">Sin ajustes: se cobra el plan {company.customPriceMonthly != null ? '(con precio pactado)' : ''}.</p>
          ) : (
            <ul className="divide-y divide-line border-2 border-ink bg-bone">
              {adjustments!.map((a) => (
                <li key={a.id} className={clsx('flex flex-wrap items-center justify-between gap-3 px-4 py-2.5', !a.active && 'opacity-50')}>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {a.concept} <Badge tone={a.kind === 'DISCOUNT' ? 'ok' : a.kind === 'PRICE' ? 'info' : 'warn'}>{ADJUSTMENT_LABELS[a.kind]}</Badge>
                    </p>
                    <p className="text-xs text-ink-3">
                      {a.percent != null ? `${a.percent}% del plan` : fmtMoney(a.amount, currency)} ·{' '}
                      {fmtPeriod(a.startPeriod)}
                      {a.endPeriod ? ` → ${fmtPeriod(a.endPeriod)}` : a.recurring ? ' en adelante' : ' (solo ese mes)'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={a.active} onChange={() => toggleAdj.mutate(a)} label="Activo" />
                    <Button size="sm" variant="ghost" aria-label="Eliminar ajuste" onClick={() => removeAdj.mutate(a.id)}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ─── Facturas ─── */}
        <Card
          kicker="Historial"
          title="Facturas"
          actions={
            <Button size="sm" variant="outline" disabled={issue.isPending} onClick={() => issue.mutate(thisPeriod())}>
              Emitir / recalcular este mes
            </Button>
          }
        >
          {(invoices?.length ?? 0) === 0 ? (
            <p className="text-sm text-ink-3">Todavía no hay facturas.</p>
          ) : (
            <ul className="divide-y divide-line border-2 border-ink bg-bone">
              {invoices!.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="font-semibold">{fmtPeriod(inv.period)}</span>
                  <span className="flex items-center gap-3">
                    <span>{fmtMoney(inv.totalAmount, inv.currency)}</span>
                    <Badge tone={inv.status === 'PAID' ? 'ok' : 'warn'}>{inv.status === 'PAID' ? 'Pagada' : 'Pendiente'}</Badge>
                    {inv.status !== 'PAID' && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(inv)} aria-label="Editar factura">
                        <Pencil size={12} />
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="space-y-6">
        {/* ─── Contrato ─── */}
        <ExtrasCard company={company} onSaved={() => queryClient.invalidateQueries()} />

        <Card kicker="Contrato" title="Precio y permanencia">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Forma de pago">
                <Select
                  value={company.billingCycle ?? 'MONTHLY'}
                  onChange={(e) => updateCompany.mutate({ billingCycle: e.target.value })}
                >
                  <option value="MONTHLY">Mensual</option>
                  <option value="ANNUAL">Anual (12 meses por 10)</option>
                </Select>
              </Field>
              {company.billingCycle === 'ANNUAL' && (
                <Field label="Mes del cobro anual" hint="Se repite cada 12 meses">
                  <Input
                    type="month"
                    key={company.annualStartPeriod ?? ''}
                    defaultValue={company.annualStartPeriod ?? ''}
                    onBlur={(e) => e.target.value && e.target.value !== company.annualStartPeriod && updateCompany.mutate({ annualStartPeriod: e.target.value })}
                  />
                </Field>
              )}
            </div>
            <Field label="Precio pactado mensual" hint={`Vacío = precio del plan (${summary?.plan ? fmtMoney(summary.plan.priceMonthly, summary.plan.currency) : '—'})`}>
              <Input
                type="number" min={0} step={1000}
                defaultValue={company.customPriceMonthly ?? ''}
                onBlur={(e) => updateCompany.mutate({ customPriceMonthly: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Inicio del contrato">
                <Input
                  type="date"
                  defaultValue={company.contractStartAt ? company.contractStartAt.slice(0, 10) : ''}
                  onBlur={(e) => updateCompany.mutate({ contractStartAt: e.target.value || null })}
                />
              </Field>
              <Field label="Permanencia (meses)" hint="Vacío = la del plan">
                <Input
                  type="number" min={0}
                  defaultValue={company.minTermMonths ?? ''}
                  onBlur={(e) => updateCompany.mutate({ minTermMonths: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </Field>
            </div>
            <Field label="Valor de referencia del montaje" hint="Se cobra proporcional si se va antes de cumplir la permanencia">
              <Input
                type="number" min={0} step={10000}
                defaultValue={company.setupFeeValue ?? ''}
                onBlur={(e) => updateCompany.mutate({ setupFeeValue: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </Field>
            {contract && (
              <p className={clsx('border-2 px-3 py-2 text-xs', contract.inForce ? 'border-warn bg-warn-soft text-warn' : 'border-line bg-bone text-ink-3')}>
                {contract.inForce
                  ? `Permanencia vigente hasta ${fmtDate(contract.endsAt!)}. Si se va hoy: ${fmtMoney(contract.earlyExit.amount, currency)} (${contract.earlyExit.remainingMonths} meses).`
                  : contract.contractStartAt ? 'Permanencia cumplida.' : 'Sin contrato de permanencia.'}
              </p>
            )}
          </div>
        </Card>

        {/* ─── IA prepaga ─── */}
        <Card
          kicker="IA de BackOffice"
          title={credits ? `${fmtNum(credits.credits.available)} conversaciones disponibles` : 'Saldo de IA'}
          actions={<Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}><Gift size={12} /> Regalar</Button>}
        >
          {credits && (
            <div className="space-y-2 text-sm">
              <p className="text-ink-2">
                Incluidas este mes: <strong>{fmtNum(credits.credits.includedLeft)}</strong> de {fmtNum(credits.credits.includedMonthly)} ·
                prepagas: <strong>{fmtNum(credits.credits.balance)}</strong>
              </p>
              <ul className="divide-y divide-line border-2 border-line bg-bone text-xs">
                {credits.lots.slice(0, 8).map((lot) => (
                  <li key={lot.id} className="flex justify-between px-3 py-1.5">
                    <span>{lot.source === 'GRANT' ? 'Regalo' : 'Compra'}{lot.note ? ` · ${lot.note}` : ''}</span>
                    <span className={lot.expired ? 'text-bad' : ''}>
                      {fmtNum(lot.remaining)}/{fmtNum(lot.total)} · {lot.expired ? 'venció' : `vence ${fmtDate(lot.expiresAt)}`}
                    </span>
                  </li>
                ))}
                {credits.lots.length === 0 && <li className="px-3 py-2 text-ink-3">Sin paquetes</li>}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <AdjustmentModal open={adjOpen} onClose={() => setAdjOpen(false)} companyId={company.id} currency={currency} onSaved={refresh} />
      {editing && <InvoiceEditor invoice={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <GrantModal open={grantOpen} onClose={() => setGrantOpen(false)} companyId={company.id} onSaved={refresh} />
    </div>
  );
}

export function Lines({ lines, currency }: { lines: InvoiceLine[]; currency: string }) {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return (
    <dl className="space-y-1.5 text-sm">
      {lines.map((l, i) => (
        <div key={i} className="flex justify-between gap-3">
          <dt className={clsx(l.kind === 'DISCOUNT' && 'text-ok')}>
            {l.concept} <span className="kicker !text-[9px]">{LINE_KIND_LABELS[l.kind]}</span>
          </dt>
          <dd className={clsx('tabular-nums', l.kind === 'DISCOUNT' && 'text-ok')}>{fmtMoney(l.amount, currency)}</dd>
        </div>
      ))}
      {lines.length === 0 && <p className="text-ink-3">Sin cobro este mes.</p>}
      <div className="flex justify-between border-t-2 border-ink pt-2 text-base font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{fmtMoney(Math.max(0, total), currency)}</dd>
      </div>
      {ivaIncluido(total, currency) > 0 && (
        <div className="flex justify-between text-xs text-ink-3">
          <dt>Incluye IVA (19 %)</dt>
          <dd className="tabular-nums">{fmtMoney(ivaIncluido(total, currency), currency)}</dd>
        </div>
      )}
    </dl>
  );
}

function AdjustmentModal({ open, onClose, companyId, currency, onSaved }: {
  open: boolean; onClose: () => void; companyId: string; currency: string; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    kind: 'DISCOUNT', concept: '', amount: '', percent: '', usePercent: false,
    startPeriod: thisPeriod(), endPeriod: '', recurring: false,
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const save = useMutation({
    mutationFn: () =>
      api.post('/billing/adjustments', {
        companyId, kind: form.kind, concept: form.concept,
        ...(form.kind === 'DISCOUNT' && form.usePercent ? { percent: Number(form.percent) } : { amount: Number(form.amount) }),
        startPeriod: form.startPeriod, endPeriod: form.endPeriod || null, recurring: form.recurring,
      }),
    onSuccess: () => {
      toast.success('Ajuste creado');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Cobro personalizado" title="Nuevo ajuste">
      <div className="space-y-4">
        <Field label="Tipo">
          <Select value={form.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="DISCOUNT">Descuento</option>
            <option value="CHARGE">Cargo extra</option>
            <option value="PRICE">Precio del mes (reemplaza el plan)</option>
          </Select>
        </Field>
        <Field label="Concepto" required hint="Lo ve la empresa en su factura">
          <Input value={form.concept} onChange={(e) => set({ concept: e.target.value })} placeholder="Ej: descuento de lanzamiento, capacitación extra…" />
        </Field>
        {form.kind === 'DISCOUNT' && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={form.usePercent} onChange={(v) => set({ usePercent: v })} label="Porcentaje" /> Porcentaje del plan
          </label>
        )}
        {form.kind === 'DISCOUNT' && form.usePercent ? (
          <Field label="Porcentaje">
            <Input type="number" min={1} max={100} value={form.percent} onChange={(e) => set({ percent: e.target.value })} />
          </Field>
        ) : (
          <Field label={`Valor (${currency})`}>
            <Input type="number" min={0} step={1000} value={form.amount} onChange={(e) => set({ amount: e.target.value })} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Desde (mes)">
            <Input type="month" value={form.startPeriod} onChange={(e) => set({ startPeriod: e.target.value })} />
          </Field>
          <Field label="Hasta (opcional)">
            <Input type="month" value={form.endPeriod} disabled={form.recurring} onChange={(e) => set({ endPeriod: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={form.recurring} onChange={(v) => set({ recurring: v, endPeriod: v ? '' : form.endPeriod })} label="Recurrente" />
          Todos los meses desde el inicio (hasta que lo desactives)
        </label>
        <Button className="w-full" disabled={!form.concept.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Crear ajuste'}
        </Button>
      </div>
    </Modal>
  );
}

function InvoiceEditor({ invoice, onClose, onSaved }: { invoice: InvoiceRow; onClose: () => void; onSaved: () => void }) {
  const [lines, setLines] = useState<InvoiceLine[]>(invoice.lines.length ? invoice.lines : [{ kind: 'PLAN', concept: 'Plan', amount: invoice.totalAmount }]);
  const [notes, setNotes] = useState(invoice.notes ?? '');
  const save = useMutation({
    mutationFn: () => api.patch(`/billing/invoices/${invoice.id}`, { lines, notes }),
    onSuccess: () => {
      toast.success('Factura actualizada');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const setLine = (i: number, patch: Partial<InvoiceLine>) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (l.kind === 'DISCOUNT' ? -Math.abs(Number(l.amount)) : Math.abs(Number(l.amount))), 0);
  return (
    <Modal open onClose={onClose} kicker={`Factura ${fmtPeriod(invoice.period)}`} title="Editar líneas" wide>
      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[140px_1fr_140px_auto] gap-2">
            <Select value={l.kind} onChange={(e) => setLine(i, { kind: e.target.value as InvoiceLine['kind'] })}>
              {Object.entries(LINE_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Input value={l.concept} onChange={(e) => setLine(i, { concept: e.target.value })} />
            <Input type="number" value={Math.abs(l.amount)} onChange={(e) => setLine(i, { amount: Number(e.target.value) })} />
            <Button size="sm" variant="ghost" aria-label="Quitar línea" onClick={() => setLines(lines.filter((_, idx) => idx !== i))}>
              <Trash2 size={12} />
            </Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={() => setLines([...lines, { kind: 'CHARGE', concept: 'Concepto', amount: 0 }])}>
          <Plus size={12} /> Agregar línea
        </Button>
        <Field label="Nota (la ve la empresa)">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <p className="text-right text-lg font-semibold">Total: {fmtMoney(Math.max(0, total), invoice.currency)}</p>
        <Button className="w-full" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar factura'}
        </Button>
      </div>
    </Modal>
  );
}

function GrantModal({ open, onClose, companyId, onSaved }: { open: boolean; onClose: () => void; companyId: string; onSaved: () => void }) {
  const [conversations, setConversations] = useState('200');
  const [months, setMonths] = useState('12');
  const [note, setNote] = useState('');
  const grant = useMutation({
    mutationFn: () => api.post('/ai-credits/grant', { companyId, conversations: Number(conversations), validityMonths: Number(months), note }),
    onSuccess: () => {
      toast.success('Saldo acreditado');
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="IA de BackOffice" title="Regalar conversaciones">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Conversaciones"><Input type="number" min={1} value={conversations} onChange={(e) => setConversations(e.target.value)} /></Field>
          <Field label="Vigencia (meses)"><Input type="number" min={1} max={36} value={months} onChange={(e) => setMonths(e.target.value)} /></Field>
        </div>
        <Field label="Motivo"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Cortesía, compensación, pago por fuera…" /></Field>
        <Button className="w-full" disabled={grant.isPending || Number(conversations) < 1} onClick={() => grant.mutate()}>
          {grant.isPending ? 'Acreditando…' : 'Acreditar'}
        </Button>
      </div>
    </Modal>
  );
}

/** Extras con sobrecosto mensual: hoy, Redes sociales con IA. */
function ExtrasCard({ company, onSaved }: { company: Company; onSaved: () => void }) {
  const { data: st } = useQuery({
    queryKey: ['social-status', `companyId=${company.id}`],
    queryFn: () => api.get<SocialStatus>(`/social/status?companyId=${company.id}`),
  });
  const [form, setForm] = useState<{ price: string; credits: string } | null>(null);
  const save = useMutation({
    mutationFn: (social: Record<string, unknown>) => api.patch(`/companies/${company.id}`, { addons: { social } }),
    onSuccess: () => { toast.success('Extra actualizado'); setForm(null); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (!st) return null;
  const rate = 3200;
  const costCop = Math.round(st.usage.costUsd * rate);
  const net = Math.round(st.addon.price / 1.19);
  const f = form ?? { price: String(st.addon.price), credits: String(st.addon.credits) };
  return (
    <Card kicker="Extras" title="Redes sociales con IA">
      <div className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span>{st.addon.enabled ? 'Activo' : st.requested ? 'La empresa lo pidió' : 'Inactivo'}</span>
          <Switch
            checked={st.addon.enabled}
            label="Extra Redes sociales con IA"
            onChange={(v) => save.mutate({ enabled: v, price: Number(f.price), credits: Number(f.credits) })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Precio mensual" hint="IVA incluido">
            <Input type="number" min={0} step={10000} value={f.price} onChange={(e) => setForm({ ...f, price: e.target.value })} />
          </Field>
          <Field label="Créditos al mes" hint="Imagen 1 · video 4">
            <Input type="number" min={0} value={f.credits} onChange={(e) => setForm({ ...f, credits: e.target.value })} />
          </Field>
        </div>
        {form && (
          <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ price: Number(f.price), credits: Number(f.credits) })}>Guardar extra</Button>
        )}
        {st.addon.enabled && (
          <dl className="space-y-1 border-t border-line pt-2 text-xs">
            <div className="flex justify-between"><dt>Usado este mes</dt><dd>{st.usage.credits} / {st.addon.credits} créditos ({st.usage.images} imágenes, {st.usage.videos} videos)</dd></div>
            <div className="flex justify-between"><dt>Costo real de la IA</dt><dd>US${st.usage.costUsd.toFixed(3)} ≈ {fmtMoney(costCop)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>Margen (sin IVA)</dt><dd>{fmtMoney(net - costCop)}</dd></div>
            <div className="flex justify-between text-ink-3"><dt>Imágenes con</dt><dd>{st.imageProvider === 'SIMULADO' ? 'modo prueba' : st.imageProvider}</dd></div>
          </dl>
        )}
      </div>
    </Card>
  );
}
