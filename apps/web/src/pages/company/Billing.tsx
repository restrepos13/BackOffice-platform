import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { INVOICE_STATUS_LABELS, fmtDate, fmtDateTime, fmtNum, fmtUsd, timeAgo } from '../../lib/format';
import type { BillingSummary, Invoice, Payment } from '../../lib/types';
import {
  Badge, Button, Card, Loading, PageHeader, Select, Table, statusTone,
} from '../../components/ui';
import { fmtPerM, useAiModels } from '../../components/media';
import { PickCompany, useCompanyScope, withScope } from './shared';

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobado',
  DECLINED: 'Rechazado',
  VOIDED: 'Anulado',
  ERROR: 'Error',
};

function lastPeriods(n: number): string[] {
  const periods: string[] = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    periods.push(d.toISOString().slice(0, 7));
  }
  return periods;
}

export default function Billing() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState(lastPeriods(1)[0]);
  const { data: aiModels } = useAiModels();

  const { data: summary, isLoading } = useQuery({
    queryKey: ['billing-summary', q, period],
    queryFn: () =>
      api.get<BillingSummary>(withScope(`/billing/summary?period=${period}`, q)),
    enabled: ready,
  });
  const { data: invoices } = useQuery({
    queryKey: ['invoices', q],
    queryFn: () => api.get<Invoice[]>(withScope('/billing/invoices', q)),
    enabled: ready,
  });
  const { data: payments } = useQuery({
    queryKey: ['payments', q],
    queryFn: () => api.get<Payment[]>(withScope('/payments', q)),
    enabled: ready,
  });

  const checkout = useMutation({
    mutationFn: (invoiceId: string) =>
      api.post<Payment>('/payments/checkout', { invoiceId }),
    onSuccess: (payment) => {
      queryClient.invalidateQueries({ queryKey: ['payments'] });
      if (!payment.configured) {
        toast.warning(
          'Wompi aún sin llaves de comercio: el checkout se generó en modo demostración.',
        );
      }
      if (payment.checkoutUrl) window.open(payment.checkoutUrl, '_blank');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !summary) return <Loading label="Calculando consumo…" />;

  return (
    <>
      <PageHeader
        kicker="Tu factura = plan + consumo"
        title="Facturación"
        actions={
          <Select value={period} onChange={(e) => setPeriod(e.target.value)} className="!w-auto">
            {lastPeriods(6).map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
        }
      />

      {/* Composición de la mensualidad, como en la landing */}
      <div className="grid items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr_auto_1fr]">
        <Card kicker="Tarifa fija mensual" title={summary.plan?.name ?? 'Sin plan'}>
          <p className="display text-4xl">
            {summary.plan ? fmtUsd(summary.plan.priceMonthly) : '—'}
          </p>
          <p className="mt-1 text-xs text-ink-3">
            Plataforma, panel, supervisión, analytics y soporte. Siempre el mismo monto.
          </p>
        </Card>

        <div className="hidden items-center lg:flex">
          <span className="display text-4xl">+</span>
        </div>

        <Card kicker="Consumo · al costo, variable" title="Tu operación">
          <ul className="space-y-2 text-sm">
            {summary.consumption.ai.mode && summary.consumption.ai.mode !== 'BYOK' && (
              <li className="flex justify-between border-b border-line pb-1.5">
                <span>
                  Conversaciones con IA
                  <span className="block text-[11px] text-ink-3">
                    {fmtNum(summary.consumption.ai.conversations ?? 0)} este mes
                    {(summary.consumption.ai.included ?? 0) > 0 && ` · ${fmtNum(summary.consumption.ai.included!)} incluidas`}
                    {(summary.consumption.ai.extra ?? 0) > 0 && ` · ${fmtNum(summary.consumption.ai.extra!)} adicionales`}
                  </span>
                </span>
                <strong>{fmtUsd(summary.consumption.ai.extraChargeUsd ?? 0)}</strong>
              </li>
            )}
            {summary.consumption.ai.mode !== 'PLATFORM' && (
              <li className="flex justify-between border-b border-line pb-1.5 text-ink-3">
                <span>
                  Recursos de IA (informativo)
                  <span className="block text-[11px]">
                    {fmtNum(summary.consumption.ai.tokens)} tokens · lo pagas directo a DeepInfra con tu llave
                  </span>
                </span>
                <span className="tabular-nums">{fmtUsd(summary.consumption.ai.costUsd)}</span>
              </li>
            )}
            <li className="flex justify-between border-b border-line pb-1.5">
              <span>
                API de WhatsApp
                <span className="block text-[11px] text-ink-3">{fmtNum(summary.consumption.whatsapp.conversations)} conversaciones Meta</span>
              </span>
              <strong>{fmtUsd(summary.consumption.whatsapp.costUsd)}</strong>
            </li>
            <li className="flex justify-between border-b border-line pb-1.5">
              <span>
                Almacenamiento
                <span className="block text-[11px] text-ink-3">{fmtNum(Math.round(summary.consumption.storage.mb))} MB</span>
              </span>
              <strong>{fmtUsd(summary.consumption.storage.costUsd)}</strong>
            </li>
            <li className="flex justify-between pt-1">
              <span className="font-semibold">Total consumo (sin IA)</span>
              <strong>{fmtUsd(summary.consumption.totalUsd)}</strong>
            </li>
          </ul>
        </Card>

        <div className="hidden items-center lg:flex">
          <span className="display text-4xl">=</span>
        </div>

        <section className="border-2 border-ink bg-ink text-bone">
          <header className="border-b-2 border-bone/30 px-5 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-line">
              Tu mensualidad · {summary.period}
            </p>
            <h2 className="display text-lg leading-tight">Un solo cobro</h2>
          </header>
          <div className="p-5">
            <p className="display text-5xl">{fmtUsd(summary.totalUsd)}</p>
            <p className="mt-2 text-xs text-line">
              Sin costos ocultos: el consumo se traslada al costo y lo ves desglosado
              aquí, en vivo. Nunca una factura sorpresa.
            </p>
          </div>
        </section>
      </div>

      {/* Historial */}
      <div className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="display text-2xl">Historial de facturas</h2>
          <p className="kicker">
            Pagos en Colombia vía Wompi · Internacional: próximamente
          </p>
        </div>
        <Table head={['Período', 'Plan', 'Consumo', 'Total', 'Estado', 'Pagada', '']}>
          {invoices?.map((invoice) => (
            <tr key={invoice.id}>
              <td className="px-4 py-3 font-mono text-sm">{invoice.period}</td>
              <td className="px-4 py-3 tabular-nums">{fmtUsd(invoice.planAmount)}</td>
              <td className="px-4 py-3 tabular-nums">{fmtUsd(invoice.consumptionAmount)}</td>
              <td className="px-4 py-3 font-semibold tabular-nums">{fmtUsd(invoice.totalAmount)}</td>
              <td className="px-4 py-3">
                <Badge tone={statusTone(invoice.status)}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>
              </td>
              <td className="px-4 py-3 text-xs text-ink-3">
                {invoice.paidAt ? fmtDate(invoice.paidAt) : '—'}
              </td>
              <td className="px-4 py-3 text-right">
                {canWrite && invoice.status !== 'PAID' && (
                  <Button
                    size="sm"
                    disabled={checkout.isPending}
                    onClick={() => checkout.mutate(invoice.id)}
                  >
                    Pagar con Wompi →
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {(invoices?.length ?? 0) === 0 && (
            <tr><td colSpan={7} className="px-4 py-10 text-center text-ink-3">Sin facturas todavía.</td></tr>
          )}
        </Table>
      </div>

      {/* Costos declarados de modelos IA */}
      <div className="mt-8">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 className="display text-2xl">Costos de los modelos IA</h2>
          <p className="kicker">Servidos por DeepInfra · trasladados al costo, sin margen</p>
        </div>
        <Table head={['Modelo', 'Entrada (USD / 1M tokens)', 'Salida (USD / 1M tokens)', 'Contexto', 'Nota']}>
          {aiModels?.filter((m) => m.active).map((model) => (
            <tr key={model.id}>
              <td className="px-4 py-3">
                <p className="font-semibold">{model.name}{model.recommended ? ' ★' : ''}</p>
                <p className="font-mono text-[11px] text-ink-3">{model.modelId}</p>
              </td>
              <td className="px-4 py-3 tabular-nums">{fmtPerM(model.inputCostPerMTok)}</td>
              <td className="px-4 py-3 tabular-nums">{fmtPerM(model.outputCostPerMTok)}</td>
              <td className="px-4 py-3 tabular-nums">{model.contextK}K</td>
              <td className="max-w-[280px] px-4 py-3 text-xs text-ink-3">{model.notes ?? '—'}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-ink-3">
          Estos son los precios que paga tu operación por cada millón de tokens —
          exactamente lo que cobra el proveedor. Los eliges por bot o por línea.
        </p>
      </div>

      {/* Pagos */}
      {(payments?.length ?? 0) > 0 && (
        <div className="mt-8">
          <h2 className="display mb-3 text-2xl">Pagos</h2>
          <Table head={['Fecha', 'Referencia', 'Período', 'Monto', 'Medio', 'Estado']}>
            {payments?.map((payment) => (
              <tr key={payment.id}>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-3">
                  {fmtDateTime(payment.createdAt)}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{payment.reference}</td>
                <td className="px-4 py-3 font-mono text-sm">{payment.invoice?.period ?? '—'}</td>
                <td className="px-4 py-3 tabular-nums">
                  {fmtUsd(payment.amountUsd)}
                  <span className="block text-[11px] text-ink-3">
                    {fmtNum(Math.round(payment.amountInCents / 100))} COP
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">{payment.paymentMethod ?? '—'}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Badge tone={statusTone(payment.status)}>
                      {PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}
                    </Badge>
                    {payment.status === 'PENDING' && payment.checkoutUrl && canWrite && (
                      <a
                        href={payment.checkoutUrl} target="_blank" rel="noreferrer"
                        className="text-xs font-semibold uppercase tracking-wider hover:underline"
                      >
                        Reintentar →
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </>
  );
}
