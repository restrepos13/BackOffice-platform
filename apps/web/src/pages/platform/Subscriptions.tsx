import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '../../components/ui';

/**
 * Suscripciones (solo plataforma): estado de cada empresa, problemas de pago
 * o configuración, historial, pagos manuales comprobados, cambios de estado
 * con motivo y la economía por empresa (medido vs. estimado).
 */

interface Row {
  id: string; name: string; status: string; statusLabel: string; legacy: boolean;
  plan: { id: string; name: string; line: string; active: boolean } | null; price: { monthly: number; currency: string; cycle: string; custom: boolean } | null;
  currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; problems: Array<{ key: string; label: string }>;
}
interface Policy { graceDays: number | null; dueDays: number | null }

const STATUSES: Record<string, string> = {
  PENDING_ACTIVATION: 'Pendiente de activación', TRIAL: 'En prueba', ACTIVE: 'Activa', PAYMENT_PENDING: 'Pago pendiente',
  GRACE: 'En gracia', SUSPENDED: 'Suspendida', CANCELED: 'Cancelada', ENDED: 'Finalizada',
};
const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  ACTIVE: 'ok', TRIAL: 'info', PENDING_ACTIVATION: 'info', PAYMENT_PENDING: 'warn', GRACE: 'warn', CANCELED: 'warn', SUSPENDED: 'bad', ENDED: 'neutral',
};

export default function Subscriptions() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(problem ? { problem } : {}) }).toString();
  const { data, isLoading } = useQuery({ queryKey: ['subscriptions', qs], queryFn: () => api.get<{ policy: Policy; items: Row[] }>(`/subscriptions${qs ? `?${qs}` : ''}`) });
  if (isLoading || !data) return <Loading />;
  const withProblems = data.items.filter((r) => r.problems.length).length;
  return (
    <>
      <PageHeader kicker="Clientes y ventas" title="Suscripciones" />
      <PolicyCard policy={data.policy} onSaved={() => queryClient.invalidateQueries({ queryKey: ['subscriptions'] })} />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-56">
            <option value="">Todos</option>
            {Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Problema">
          <Select value={problem} onChange={(e) => setProblem(e.target.value)} className="!w-72">
            <option value="">Cualquiera</option>
            <option value="PAYMENT_FAILED">Último pago rechazado</option>
            <option value="PAYMENT_PENDING">Pago pendiente</option>
            <option value="OVERDUE_NO_POLICY">Vencida sin política de gracia</option>
            <option value="NO_PERIOD">Activa sin periodo registrado</option>
            <option value="ACTIVE_WITHOUT_PLAN">Activa sin plan</option>
            <option value="OVER_LIMIT">Sobre su límite</option>
            <option value="TRIAL_EXPIRED">Prueba vencida</option>
          </Select>
        </Field>
        <p className="pb-2 text-xs text-ink-3">{data.items.length} empresas · {withProblems} con algo por revisar</p>
      </div>
      <div className="overflow-x-auto border-2 border-ink bg-paper">
        <table className="w-full min-w-[820px] text-sm" data-testid="subscriptions-table">
          <thead><tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-wider text-ink-3"><th className="p-2">Empresa</th><th className="p-2">Estado</th><th className="p-2">Plan</th><th className="p-2 text-right">Precio</th><th className="p-2">Fin del periodo</th><th className="p-2">Por revisar</th><th className="p-2" /></tr></thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} className="border-b border-line align-top">
                <td className="p-2 font-semibold">{r.name}{r.legacy && <span className="block text-[10px] font-normal text-ink-3">estado heredado (sin historial previo)</span>}</td>
                <td className="p-2"><Badge tone={TONE[r.status] ?? 'neutral'}>{r.statusLabel}</Badge></td>
                <td className="p-2">{r.plan ? `${r.plan.name}${r.plan.active ? '' : ' (ya no se vende)'}` : '—'}</td>
                <td className="p-2 text-right tabular-nums">{r.price ? `${fmtMoney(r.price.monthly, r.price.currency)}${r.price.custom ? ' · pactado' : ''}` : '—'}</td>
                <td className="p-2">{r.currentPeriodEnd ? fmtDate(r.currentPeriodEnd) : <span className="text-ink-3">sin registrar</span>}{r.cancelAtPeriodEnd ? ' · no renueva' : ''}</td>
                <td className="p-2 text-xs">{r.problems.length ? r.problems.map((p) => <span key={p.key} className="block text-warn">{p.label}</span>) : <span className="text-ink-3">—</span>}</td>
                <td className="p-2 text-right"><Button size="sm" variant="outline" onClick={() => setOpen(r.id)}>Ver</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <Detail companyId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function PolicyCard({ policy, onSaved }: { policy: Policy; onSaved: () => void }) {
  const [f, setF] = useState({ dueDays: policy.dueDays ?? '', graceDays: policy.graceDays ?? '' });
  const save = useMutation({
    mutationFn: () => api.put('/subscriptions/policy', { dueDays: f.dueDays === '' ? null : Number(f.dueDays), graceDays: f.graceDays === '' ? null : Number(f.graceDays) }),
    onSuccess: () => { toast.success('Política guardada'); onSaved(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const pending = policy.dueDays === null || policy.graceDays === null;
  return (
    <Card kicker="Política de cobro" title={pending ? 'Pendiente de definir' : `Vence a los ${policy.dueDays} días · ${policy.graceDays} días de gracia`} className="mb-6">
      <p className="mb-3 text-sm text-ink-2">{pending ? 'Sin estos días, BackOffice no suspende a nadie automáticamente: las facturas vencidas solo se marcan para revisar.' : 'Una factura sin pagar pasa a gracia al vencer y a suspendida al terminar la gracia (solo lectura; se reactiva al registrar el pago).'}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Días para pagar una factura"><Input type="number" min={0} max={365} value={f.dueDays} onChange={(e) => setF({ ...f, dueDays: e.target.value })} className="!w-40" /></Field>
        <Field label="Días de gracia"><Input type="number" min={0} max={365} value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: e.target.value })} className="!w-40" /></Field>
        <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>Guardar</Button>
      </div>
    </Card>
  );
}

function Detail({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['subscription', companyId], queryFn: () => api.get<any>(`/subscriptions/${companyId}`) });
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const { data: eco } = useQuery({ queryKey: ['subscription-eco', companyId, period], queryFn: () => api.get<any>(`/subscriptions/${companyId}/economics?period=${period}`) });
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [manual, setManual] = useState<{ id: string; method: string; note: string } | null>(null);
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['subscription', companyId] }); queryClient.invalidateQueries({ queryKey: ['subscriptions'] }); };
  const move = useMutation({
    mutationFn: () => api.post(`/subscriptions/${companyId}/transition`, { to, reason, confirm: true, ...(days ? { periodDays: Number(days) } : {}) }),
    onSuccess: () => { toast.success('Estado actualizado'); setTo(''); setReason(''); setDays(''); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const pay = useMutation({
    mutationFn: () => api.post(`/subscriptions/invoices/${manual!.id}/manual-payment`, { method: manual!.method, note: manual!.note, confirm: true }),
    onSuccess: () => { toast.success('Pago registrado'); setManual(null); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open onClose={onClose} kicker="Suscripción" title={data?.name ?? 'Cargando…'} wide>
      {!data ? <Loading /> : (
        <div className="space-y-5 text-sm" data-testid="subscription-detail">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[data.status] ?? 'neutral'}>{data.statusLabel}</Badge>
            {data.plan && <span>{data.plan.name} · {data.price ? fmtMoney(data.price.monthly, data.price.currency) : '—'}</span>}
            {data.problems.map((p: any) => <Badge key={p.key} tone="warn">{p.label}</Badge>)}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="kicker mb-1">Cambiar el estado</p>
              <div className="grid gap-2">
                <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Nuevo estado">
                  <option value="">Elegir…</option>
                  {Object.entries(STATUSES).filter(([k]) => k !== data.status).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                {(to === 'ACTIVE' || to === 'TRIAL') && <Input type="number" min={1} placeholder={to === 'TRIAL' ? 'Días de prueba' : 'Días del periodo pagado (opcional)'} value={days} onChange={(e) => setDays(e.target.value)} />}
                <Textarea rows={2} placeholder="Motivo (queda en el historial)" value={reason} onChange={(e) => setReason(e.target.value)} />
                <Button size="sm" variant={to === 'SUSPENDED' || to === 'ENDED' ? 'danger' : 'primary'} disabled={!to || reason.trim().length < 5 || move.isPending} onClick={() => { if (confirm(`¿Pasar a «${STATUSES[to]}»? Afecta el acceso de la empresa.`)) move.mutate(); }}>Aplicar</Button>
                <p className="text-xs text-ink-3">Solo se permiten los cambios válidos desde el estado actual; el servidor rechaza los demás.</p>
              </div>
            </div>
            <div>
              <p className="kicker mb-1">Uso y límites</p>
              <ul className="space-y-0.5 text-xs">
                <li>Personas: {data.usage.users.used} de {data.usage.users.max ?? 'sin límite'}</li>
                <li>Asistentes: {data.usage.bots.used} de {data.usage.bots.max ?? 'sin límite'}</li>
                <li>Números de WhatsApp: {data.usage.whatsappLines.used} de {data.usage.whatsappLines.max ?? 'sin límite'}</li>
                <li>IA {data.usage.ai.period}: {data.usage.ai.includedUsed} de {data.usage.ai.includedMonthly} incluidas · saldo prepago {data.usage.ai.prepaidBalance}</li>
              </ul>
            </div>
          </div>
          <div>
            <p className="kicker mb-1">Facturas</p>
            {!data.invoices.length ? <p className="text-xs text-ink-3">Sin facturas.</p> : (
              <ul className="divide-y divide-line text-xs">
                {data.invoices.map((i: any) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>{i.period} · {fmtMoney(i.total, i.currency)} · {i.status === 'PAID' ? `pagada ${i.paidAt ? fmtDate(i.paidAt) : ''}` : 'pendiente'}</span>
                    {i.status !== 'PAID' && <Button size="sm" variant="outline" onClick={() => setManual({ id: i.id, method: 'TRANSFER', note: '' })}>Registrar pago manual</Button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {eco && (
            <div>
              <div className="mb-1 flex items-center gap-2"><p className="kicker">Economía</p><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} className="!w-40 !py-1" /></div>
              <ul className="space-y-0.5 text-xs" data-testid="economics">
                <li>Ingresos cobrados: {Object.entries(eco.revenue.measured).map(([c, v]) => fmtMoney(v as number, c)).join(' + ') || '—'} <Badge tone="ok">medido</Badge></li>
                <li>IA pagada por BackOffice: US$ {eco.costs.aiProviderUsd.value} <Badge tone="ok">medido</Badge></li>
                <li>Mensajería: US$ {eco.costs.messagingUsd.value} <Badge tone="warn">estimado</Badge></li>
                <li>Infraestructura: {eco.costs.infrastructure.note} <Badge tone="neutral">desconocido</Badge></li>
                <li>Créditos regalados: {eco.costs.promotionalCredits.conversations} conversaciones</li>
                <li>Margen: {eco.margin.valueCop === null ? eco.margin.note : <>{fmtMoney(eco.margin.valueCop, 'COP')} <Badge tone="warn">estimado</Badge> <span className="text-ink-3">{eco.margin.note}</span></>}</li>
              </ul>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-ink-2">Historial ({data.events.length})</summary>
            <ul className="mt-2 space-y-1 text-xs">{data.events.map((e: any) => <li key={e.id}>{fmtDateTime(e.at)} · <b>{e.type}</b> {e.from && e.to && e.from !== e.to ? `${e.from} → ${e.to}` : ''} · {e.source}{e.actor ? ` · ${e.actor}` : ''}{e.reason ? ` · ${e.reason}` : ''}</li>)}</ul>
          </details>
        </div>
      )}
      <Modal open={!!manual} onClose={() => setManual(null)} kicker="Solo con el soporte en la mano" title="Registrar pago manual">
        {manual && (
          <div className="space-y-3 text-sm">
            <Field label="Cómo se pagó">
              <Select value={manual.method} onChange={(e) => setManual({ ...manual, method: e.target.value })}>
                <option value="TRANSFER">Transferencia</option><option value="QR">QR</option><option value="CASH">Efectivo</option><option value="OTHER">Otro</option>
              </Select>
            </Field>
            <Field label="Soporte (número de comprobante)"><Input value={manual.note} onChange={(e) => setManual({ ...manual, note: e.target.value })} /></Field>
            <p className="text-xs text-ink-3">Confirmas que verificaste el dinero en la cuenta. Queda auditado con tu nombre.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setManual(null)}>Cancelar</Button>
              <Button disabled={pay.isPending} onClick={() => pay.mutate()}>Verifiqué el pago: registrar</Button>
            </div>
          </div>
        )}
      </Modal>
    </Modal>
  );
}
