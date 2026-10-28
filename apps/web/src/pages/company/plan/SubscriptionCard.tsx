import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { fmtDate, fmtDateTime, fmtMoney } from '../../../lib/format';
import { Badge, Button, Card, Field, Loading, Modal, Textarea } from '../../../components/ui';

/**
 * Suscripción de la empresa (portal): estado, plan, periodo, uso y límites,
 * historial de pagos y de cambios. Solo lo de la empresa de la sesión. Lo que
 * no está determinado (p. ej. la próxima fecha de cobro) se dice, no se inventa.
 */

export interface MySubscription {
  companyId: string; name: string; status: string; statusLabel: string; access: 'FULL' | 'READ_ONLY'; legacy: boolean;
  plan: { id: string; name: string; description: string | null; currency: string; features: string[]; includedProducts: string[] | null; maxUsers: number; maxBots: number; maxLines: number; includedAiConversations: number } | null;
  price: { monthly: number; currency: string; cycle: string; custom: boolean } | null;
  period: { start: string | null; end: string | null };
  nextCharge: { date: string | null; note: string };
  cancelAtPeriodEnd: boolean; canceledAt: string | null; trialEndsAt: string | null;
  usage: {
    users: { used: number; max: number | null }; bots: { used: number; max: number | null }; whatsappLines: { used: number; max: number | null };
    ai: { mode: string; period: string; includedMonthly: number; includedUsed: number; prepaidBalance: number };
  };
  invoices: Array<{ id: string; period: string; total: number; currency: string; status: string; issuedAt: string; paidAt: string | null }>;
  payments: Array<{ id: string; reference: string; provider: string; status: string; purpose: string; method: string | null; amount: number; currency: string; createdAt: string }>;
  events: Array<{ id: string; type: string; from: string | null; to: string | null; source: string; actor: string | null; reason: string | null; at: string }>;
  actions: string[];
}

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  ACTIVE: 'ok', TRIAL: 'info', PENDING_ACTIVATION: 'info', PAYMENT_PENDING: 'warn', GRACE: 'warn', CANCELED: 'warn', SUSPENDED: 'bad', ENDED: 'neutral',
};
const EVENT_LABEL: Record<string, string> = {
  ACTIVATE: 'Activación', TRIAL_START: 'Inicio de prueba', PAYMENT_PENDING: 'Factura por pagar', GRACE: 'Pasó a gracia', SUSPEND: 'Suspensión', REACTIVATE: 'Reactivación',
  CANCEL_REQUEST: 'Cancelación pedida', CANCEL_UNDO: 'Cancelación deshecha', END: 'Finalización', PLAN_CHANGE: 'Cambio de plan', PAYMENT_APPROVED: 'Pago aprobado', PAYMENT_FAILED: 'Pago rechazado',
};
const PAY_STATUS: Record<string, string> = { APPROVED: 'Aprobado', PENDING: 'Pendiente', DECLINED: 'Rechazado', VOIDED: 'Anulado', ERROR: 'Error', REVIEW: 'En revisión' };

const limit = (u: { used: number; max: number | null }) => (u.max === null ? `${u.used} (sin límite)` : `${u.used} de ${u.max}`);

export function SubscriptionCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['my-subscription'], queryFn: () => api.get<MySubscription>('/subscriptions/me'), retry: false });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['my-subscription'] });
  const cancel = useMutation({
    mutationFn: () => api.post('/subscriptions/me/cancel', { confirm: true, reason }),
    onSuccess: () => { toast.success('Renovación cancelada. Sigues con acceso hasta el fin del periodo.'); setCancelOpen(false); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const undo = useMutation({
    mutationFn: () => api.post('/subscriptions/me/undo-cancel'),
    onSuccess: () => { toast.success('Listo: tu suscripción sigue activa'); refresh(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (isLoading) return <Loading />;
  if (error || !data) return null;
  const cur = data.price?.currency ?? 'COP';
  return (
    <Card kicker="Suscripción" title={data.plan ? `Plan ${data.plan.name}` : 'Sin plan asignado'} className="mb-6">
      <div data-testid="subscription-card" className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={TONE[data.status] ?? 'neutral'}>{data.statusLabel}</Badge>
          {data.price && <span><b>{fmtMoney(data.price.monthly, cur)}</b> al mes{data.price.cycle === 'ANNUAL' ? ' · ciclo anual' : ''}{data.price.custom ? ' · precio pactado' : ''}</span>}
        </div>
        {data.access === 'READ_ONLY' && (
          <p role="alert" className="border-2 border-bad bg-bad-soft px-3 py-2 text-bad">Tu cuenta está en solo lectura: puedes consultar tu información y regularizar el pago, pero no hacer cambios. Escríbenos para reactivarla.</p>
        )}
        {data.status === 'CANCELED' && (
          <p className="border-2 border-warn bg-paper px-3 py-2">Pediste cancelar la renovación{data.period.end ? `. Sigues con acceso hasta el ${fmtDate(data.period.end)}.` : '. El equipo confirmará la fecha de fin (tu periodo no tiene una fecha registrada).'}</p>
        )}
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div><dt className="kicker">Periodo vigente</dt><dd>{data.period.start && data.period.end ? `${fmtDate(data.period.start)} a ${fmtDate(data.period.end)}` : 'Sin fecha registrada'}</dd></div>
          <div><dt className="kicker">Próximo cobro</dt><dd>{data.nextCharge.date ? fmtDate(data.nextCharge.date) : data.nextCharge.note}</dd></div>
          {data.trialEndsAt && <div><dt className="kicker">Prueba hasta</dt><dd>{fmtDate(data.trialEndsAt)}</dd></div>}
        </dl>
        <div>
          <p className="kicker mb-1">Uso y límites</p>
          <ul className="grid gap-1 sm:grid-cols-2" data-testid="usage">
            <li>Personas del equipo: <b>{limit(data.usage.users)}</b></li>
            <li>Asistentes: <b>{limit(data.usage.bots)}</b></li>
            <li>Números de WhatsApp: <b>{limit(data.usage.whatsappLines)}</b></li>
            <li>IA este mes: <b>{data.usage.ai.includedUsed} de {data.usage.ai.includedMonthly}</b> incluidas · saldo prepago {data.usage.ai.prepaidBalance}</li>
          </ul>
        </div>
        {data.plan?.features.length ? <p className="text-xs text-ink-3">Incluye: {data.plan.features.join(' · ')}</p> : null}
        <div>
          <p className="kicker mb-1">Pagos</p>
          {!data.payments.length ? <p className="text-xs text-ink-3">Aún no hay pagos registrados.</p> : (
            <ul className="divide-y divide-line text-xs">
              {data.payments.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5">
                  <span>{fmtDateTime(p.createdAt)} · {p.purpose === 'AI_CREDITS' ? 'Paquete de IA' : 'Mensualidad'} · {p.provider === 'MANUAL' ? `pago manual (${p.method ?? '—'})` : p.provider}</span>
                  <span><b>{fmtMoney(p.amount, p.currency)}</b> · {PAY_STATUS[p.status] ?? p.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {data.events.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-ink-2">Historial de la suscripción</summary>
            <ul className="mt-2 space-y-1 text-xs">
              {data.events.map((e) => <li key={e.id}>{fmtDateTime(e.at)} · <b>{EVENT_LABEL[e.type] ?? e.type}</b>{e.reason ? ` · ${e.reason}` : ''}</li>)}
            </ul>
          </details>
        )}
        <div className="flex flex-wrap gap-2 border-t-2 border-line pt-3">
          {data.actions.includes('CANCEL') && <Button size="sm" variant="outline" onClick={() => setCancelOpen(true)}>Cancelar la renovación</Button>}
          {data.actions.includes('UNDO_CANCEL') && <Button size="sm" disabled={undo.isPending} onClick={() => undo.mutate()}>Seguir con mi suscripción</Button>}
          <p className="text-xs text-ink-3">Para cambiar de plan elige uno abajo: el equipo confirma el pago y lo activa (no hay cobro automático).</p>
        </div>
      </div>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} kicker="Suscripción" title="¿Cancelar la renovación?">
        <div className="space-y-3 text-sm">
          <p>No pierdes el acceso ahora: sigues hasta el fin del periodo{data.period.end ? ` (${fmtDate(data.period.end)})` : ''}. Puedes deshacerlo antes de esa fecha.</p>
          <Field label="¿Por qué cancelas? (opcional)"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>Volver</Button>
            <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Sí, cancelar la renovación</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
