import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy, Gift, Minus, Plus, UserRound, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import { Badge, Button, Card, Loading, Modal, PageHeader } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Mi plan: qué tengo contratado y cómo se cobra, mis complementos (pedir y
 * apagar), mi landing de regalo y mi enlace para invitar a otras empresas.
 */

interface PlanSummary {
  company: { name: string; status: string };
  plan: { name: string; line: string; maxLines: number; maxUsers: number; price: number; includedMetaUsd: number } | null;
  serviceMode: 'SELF' | 'MANAGED';
  mode: { name: string; summary: string; includes: string[]; youPay: string[] };
  billingCycle: string;
  nextBillingDay: string;
  notices: { humanOversight: string; numbers: string; meta: string };
}
interface AddonsView {
  deadline: string;
  nextBillingDay: string;
  addons: Array<{ key: string; name: string; description: string; price: number; perUnit?: string; status: 'AVAILABLE' | 'SOON'; active: boolean; requested: boolean; qty: number; monthly: number }>;
}
interface Referrals {
  code: string;
  rule: { discountPercent: number; months: number; minPaidMonths: number };
  referred: Array<{ name: string; joinedAt: string; paidMonths: number; status: 'PENDING' | 'REWARDED' }>;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' });

export default function MyPlan() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState<AddonsView['addons'][number] | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const { data: summary } = useQuery({ queryKey: ['my-plan', q], queryFn: () => api.get<PlanSummary>(withScope('/company/plan', q)), enabled: ready });
  const { data: addons } = useQuery({ queryKey: ['my-addons', q], queryFn: () => api.get<AddonsView>(withScope('/company/addons', q)), enabled: ready });
  const { data: landing } = useQuery({ queryKey: ['my-landing', q], queryFn: () => api.get<{ status: string | null; url: string | null; notice: string }>(withScope('/company/landing', q)), enabled: ready });
  const { data: referrals } = useQuery({ queryKey: ['my-referrals', q], queryFn: () => api.get<Referrals>(withScope('/company/referrals', q)), enabled: ready });

  const request = useMutation({
    mutationFn: (a: { key: string; qty: number }) => api.post<AddonsView>(withScope(`/company/addons/${a.key}/request`, q), { qty: a.qty }),
    onSuccess: (r) => {
      queryClient.setQueryData(['my-addons', q], r);
      toast.success('Listo. Tu asesor lo configura y te avisa cuando quede activo.');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const cancel = useMutation({
    mutationFn: (key: string) => api.post<AddonsView>(withScope(`/company/addons/${key}/cancel`, q), {}),
    onSuccess: (r) => {
      queryClient.setQueryData(['my-addons', q], r);
      setCancelling(null);
      toast.success('Complemento apagado');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (!summary || !addons) return <Loading />;
  const link = referrals ? `${window.location.origin}/registro?ref=${referrals.code}` : '';
  const monthlyAddons = addons.addons.reduce((s, a) => s + a.monthly, 0);

  return (
    <>
      <PageHeader kicker="Lo que tienes contratado" title="Mi" accent="plan" />

      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card kicker="Automatización humanizada de WhatsApp" title={summary.plan ? `Plan ${summary.plan.name} · ${summary.mode.name}` : 'Aún sin plan'}>
          {summary.plan ? (
            <div className="space-y-4 text-sm">
              <div className="flex flex-wrap gap-6">
                <div>
                  <p className="kicker">Mensualidad</p>
                  <p className="display text-3xl">{fmtMoney(summary.plan.price)}</p>
                  <p className="text-xs text-ink-3">IVA incluido · {summary.billingCycle === 'ANNUAL' ? 'pago anual' : 'pago mensual'}</p>
                </div>
                <div>
                  <p className="kicker">Números de WhatsApp</p>
                  <p className="display text-3xl">{summary.plan.maxLines}</p>
                  <p className="text-xs text-ink-3">Hasta {summary.plan.maxUsers} personas del equipo</p>
                </div>
                {monthlyAddons > 0 && (
                  <div>
                    <p className="kicker">Complementos</p>
                    <p className="display text-3xl">{fmtMoney(monthlyAddons)}</p>
                    <p className="text-xs text-ink-3">al mes</p>
                  </div>
                )}
              </div>
              <p className="text-ink-2">{summary.mode.summary}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="kicker mb-1">Incluye</p>
                  <ul className="space-y-1">{summary.mode.includes.map((i) => <li key={i} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-ok" />{i}</li>)}</ul>
                </div>
                <div>
                  <p className="kicker mb-1">Tú pagas</p>
                  <ul className="space-y-1">{summary.mode.youPay.map((i) => <li key={i}>— {i}</li>)}</ul>
                </div>
              </div>
              <p className="text-xs text-ink-3">{summary.notices.meta}</p>
              <p className="text-xs text-ink-3">Próximo cobro: {day(summary.nextBillingDay)}. ¿Necesitas más números u otros canales? Escríbele a tu asesor.</p>
            </div>
          ) : (
            <p className="text-sm">Todavía no tienes un plan activo. <Link to="/app/bienvenida#planes" className="font-semibold underline">Elegir mi plan</Link></p>
          )}
        </Card>

        <div className="space-y-4">
          <p className="flex items-start gap-2 border-2 border-warn bg-warn-soft px-4 py-3 text-sm"><UserRound size={16} className="mt-0.5 shrink-0" /> {summary.notices.humanOversight}</p>
          {landing?.status && (
            <div className="border-2 border-ink bg-paper p-4 text-sm">
              <p className="flex items-center gap-2 font-semibold"><Gift size={16} /> Tu landing de regalo</p>
              {landing.status === 'DELIVERED' && landing.url ? (
                <p className="mt-1">Ya está lista: <a href={landing.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline">{landing.url.replace(/^https:\/\//, '')}</a></p>
              ) : (
                <p className="mt-1 text-ink-2">{landing.status === 'BUILDING' ? 'La estamos construyendo.' : 'La preparamos y te avisamos cuando esté lista.'}</p>
              )}
              <p className="mt-2 text-xs text-ink-3">{landing.notice}</p>
            </div>
          )}
        </div>
      </div>

      <Card kicker={`Puedes apagarlos hasta el ${day(addons.deadline)} para que no se cobren el próximo mes`} title="Complementos" className="mb-6">
        <div className="grid gap-3 md:grid-cols-2">
          {addons.addons.filter((a) => a.status === 'AVAILABLE').map((a) => {
            const n = qty[a.key] ?? 1;
            return (
              <div key={a.key} className={clsx('flex flex-col justify-between border-2 p-4', a.active ? 'border-ink bg-ok-soft' : 'border-line bg-bone')}>
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold">{a.name}</p>
                    {a.active ? <Badge tone="ok">Activo</Badge> : a.requested ? <Badge tone="warn">Pedido</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-ink-2">{a.description}</p>
                  <p className="mt-2 text-sm font-semibold">
                    {fmtMoney(a.price)}/mes{a.perUnit ? ` por ${a.perUnit}` : ''}{a.active && a.perUnit ? ` · tienes ${a.qty}` : ''}
                  </p>
                </div>
                {canWrite && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {a.active ? (
                      <Button size="sm" variant="outline" onClick={() => setCancelling(a)}>Apagar</Button>
                    ) : a.requested ? (
                      <>
                        <span className="text-xs text-ink-3">Tu asesor lo está configurando.</span>
                        <Button size="sm" variant="ghost" onClick={() => cancel.mutate(a.key)}>Ya no lo quiero</Button>
                      </>
                    ) : (
                      <>
                        {a.perUnit && (
                          <span className="flex items-center gap-2 text-sm">
                            <button type="button" aria-label="Menos" className="cursor-pointer border-2 border-ink p-0.5" onClick={() => setQty((x) => ({ ...x, [a.key]: Math.max(1, n - 1) }))}><Minus size={12} /></button>
                            <span className="w-5 text-center tabular-nums">{n}</span>
                            <button type="button" aria-label="Más" className="cursor-pointer border-2 border-ink p-0.5" onClick={() => setQty((x) => ({ ...x, [a.key]: Math.min(10, n + 1) }))}><Plus size={12} /></button>
                          </span>
                        )}
                        <Button size="sm" disabled={request.isPending} onClick={() => request.mutate({ key: a.key, qty: n })}>Lo quiero</Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {addons.addons.filter((a) => a.status === 'SOON').map((a) => (
            <span key={a.key} title={a.description} className="inline-flex items-center gap-1.5 border-2 border-line bg-bone px-2.5 py-1 text-xs text-ink-3">
              {a.name} <Badge tone="neutral">Próximamente</Badge>
            </span>
          ))}
        </div>
      </Card>

      {referrals && (
        <Card kicker="Programa de referidos" title={`Invita y gana ${referrals.rule.discountPercent}% por ${referrals.rule.months} meses`}>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-3 text-sm">
              <p>
                Comparte tu enlace con otro negocio. Si se suscribe y paga al menos {referrals.rule.minPaidMonths} meses, te descontamos el{' '}
                <b>{referrals.rule.discountPercent}% de tu mensualidad durante {referrals.rule.months} meses</b>. Sin límite de invitados.
              </p>
              <div className="flex items-center gap-2 border-2 border-ink bg-bone px-3 py-2 text-xs">
                <span className="truncate font-mono">{link}</span>
                <button type="button" aria-label="Copiar enlace" className="cursor-pointer text-ink-3 hover:text-ink" onClick={() => navigator.clipboard?.writeText(link).then(() => toast.success('Enlace copiado'))}><Copy size={13} /></button>
              </div>
              <a href={`https://wa.me/?text=${encodeURIComponent(`Te recomiendo BackOffice: automatiza tu WhatsApp con IA y vende 24/7. Crea tu cuenta aquí: ${link}`)}`} target="_blank" rel="noopener noreferrer">
                <Button size="sm" variant="outline">Compartir por WhatsApp</Button>
              </a>
            </div>
            <div>
              <p className="kicker mb-2 flex items-center gap-1"><Users size={13} /> Tus invitados</p>
              {referrals.referred.length === 0 ? <p className="text-sm text-ink-3">Todavía nadie se ha registrado con tu enlace.</p> : (
                <ul className="divide-y divide-line text-sm">
                  {referrals.referred.map((r) => (
                    <li key={r.name + r.joinedAt} className="flex items-center justify-between gap-2 py-2">
                      <span>{r.name}</span>
                      {r.status === 'REWARDED' ? <Badge tone="ok">Premio aplicado</Badge> : <span className="text-xs text-ink-3">{r.paidMonths} de {referrals.rule.minPaidMonths} meses pagos</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      )}

      <Modal open={!!cancelling} onClose={() => setCancelling(null)} kicker="Complementos" title={cancelling ? `¿Apagar ${cancelling.name}?` : ''}>
        {cancelling && (
          <div className="space-y-4 text-sm">
            <p>Deja de funcionar desde ahora. Se cobra solo el mes en curso: si lo apagas antes del {day(addons.nextBillingDay)}, el mes siguiente ya no aparece en tu factura.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCancelling(null)}>Mejor no</Button>
              <Button variant="danger" disabled={cancel.isPending} onClick={() => cancel.mutate(cancelling.key)}>Sí, apagar</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
