import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Check, CreditCard, Gift, Landmark, MessageCircle, Minus, Plus, QrCode, RotateCcw, Sparkles, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtMoney } from '../lib/format';
import { withScope } from '../pages/company/shared';
import { Badge, Button, Loading } from './ui';

/**
 * Compra del plan "Automatización humanizada de WhatsApp":
 *  1. Plan (Básico 1 número · Intermedio 2 · Max hasta 5).
 *  2. Modalidad: "Tu IA" o "Todo incluido" (mes vencido), explicadas sin letra pequeña.
 *  3. Complementos (los "próximamente" se ven pero no se compran).
 *  4. Comprar → pantalla de "preparando todo" → el equipo te contacta.
 */

type Mode = 'SELF' | 'MANAGED';

interface CheckoutPlan {
  id: string; name: string; tier: string | null; priceSelf: number; priceManaged: number; annualSelf: number; annualManaged: number;
  maxUsers: number; maxLines: number; maxCouriers: number; highlight: boolean; minTermMonths: number; includedMetaUsd: number; features: string[];
}
interface Addon { key: string; name: string; description: string; price: number; perUnit?: string; status: 'AVAILABLE' | 'SOON'; active: boolean; requested: boolean }
interface CheckoutData {
  plans: CheckoutPlan[];
  modes: Record<Mode, { name: string; short: string; summary: string; includes: string[]; youPay: string[] }>;
  needs: { dailyChats: number; modules: string[]; users: number; lines: number };
  recommendation: {
    plan: { planId: string; planName: string; reasons: string[]; cheaper: { planId: string; note: string } | null; upsell: { planId: string; note: string } | null } | null;
    serviceMode: Mode;
    modeReason: string;
    aiEstimate: { model: string; monthly: number } | null;
  };
  addons: Addon[];
  landingGift: boolean;
  notices: { humanOversight: string; numbers: string; meta: string; landing: string; implementation: string; metaFree: string };
  paymentOptions: Array<{ id: string; label: string; available: boolean; comingSoon?: boolean }>;
  order: { id: string; planName: string; billingCycle: string; serviceMode: Mode; addons: Array<{ name: string; qty: number }>; total: number; status: string } | null;
}

const ORDER_STATUS: Record<string, string> = {
  REQUESTED: 'Recibimos tu pedido. Un asesor te escribe por WhatsApp muy pronto.',
  CONTACTED: 'Tu asesor ya te contactó. Revisa tu WhatsApp.',
  AWAITING_PAYMENT: 'Esperando tu pago. Envía el comprobante por WhatsApp a tu asesor.',
  PAID: 'Recibimos tu pago. Estamos activando tu cuenta.',
  ACTIVE: '¡Tu plan está activo!',
};
const STEPS = ['Guardando tu pedido', 'Reservando tu plan', 'Preparando tus complementos', 'Avisándole a tu asesor'];
const PAY_ICONS: Record<string, typeof Landmark> = { TRANSFER: Landmark, QR: QrCode, WOMPI: CreditCard };

export default function CheckoutSection({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['checkout', q], queryFn: () => api.get<CheckoutData>(withScope('/onboarding/checkout', q)) });
  const [cycle, setCycle] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const [planId, setPlanId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [addons, setAddons] = useState<Record<string, number>>({});
  const [changing, setChanging] = useState(false);
  const [experience, setExperience] = useState<{ step: number; done: boolean; error: string | null } | null>(null);

  useEffect(() => {
    if (!data) return;
    if (planId === null) setPlanId(data.recommendation.plan?.planId ?? data.plans[0]?.id ?? null);
    if (mode === null) setMode(data.recommendation.serviceMode);
  }, [data, planId, mode]);

  const buy = useMutation({
    mutationFn: () => api.post(withScope('/onboarding/checkout', q), {
      planId, billingCycle: cycle, serviceMode: mode,
      addons: Object.entries(addons).map(([key, qty]) => ({ key, qty })),
    }),
  });

  async function start() {
    setExperience({ step: 0, done: false, error: null });
    const request = buy.mutateAsync();
    for (let i = 1; i <= STEPS.length; i++) {
      await new Promise((r) => setTimeout(r, 1100));
      setExperience((e) => (e ? { ...e, step: i } : e));
    }
    try {
      await request;
      setExperience({ step: STEPS.length, done: true, error: null });
      setChanging(false);
      queryClient.invalidateQueries({ queryKey: ['checkout'] });
      queryClient.invalidateQueries({ queryKey: ['onboarding'] });
    } catch (e) {
      setExperience({ step: 0, done: false, error: e instanceof Error ? e.message : 'No pudimos guardar tu pedido' });
    }
  }

  if (isLoading || !data || !mode) return <Loading label="Buscando el plan ideal para ti…" />;

  const rec = data.recommendation;
  const plan = data.plans.find((p) => p.id === planId) ?? null;
  const monthly = plan ? (mode === 'MANAGED' ? plan.priceManaged : plan.priceSelf) : 0;
  const planAmount = plan ? (cycle === 'ANNUAL' ? (mode === 'MANAGED' ? plan.annualManaged : plan.annualSelf) : monthly) : 0;
  const available = data.addons.filter((a) => a.status === 'AVAILABLE');
  const soon = data.addons.filter((a) => a.status === 'SOON');
  const addonsTotal = Object.entries(addons).reduce((s, [key, qty]) => s + (data.addons.find((a) => a.key === key)?.price ?? 0) * qty, 0);
  const total = planAmount + addonsTotal;
  const openOrder = data.order && data.order.status !== 'CANCELLED' ? data.order : null;
  const toggleAddon = (a: Addon) => setAddons((x) => {
    const next = { ...x };
    if (next[a.key]) delete next[a.key];
    else next[a.key] = 1;
    return next;
  });

  return (
    <section id="planes" className="space-y-4">
      <div>
        <p className="kicker">Automatización humanizada de WhatsApp · vende 24/7</p>
        <h2 className="display text-3xl">Tu plan</h2>
      </div>

      {openOrder && !changing ? (
        <div className="border-2 border-ink bg-paper p-5 shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="kicker">Tu pedido</p>
              <p className="display mt-1 text-2xl">{openOrder.planName} · {data.modes[openOrder.serviceMode]?.name ?? 'Tu IA'}</p>
              <p className="text-sm text-ink-2">{openOrder.billingCycle === 'ANNUAL' ? 'Pago anual' : 'Pago mensual'}{openOrder.addons.length ? ` · ${openOrder.addons.map((a) => a.name).join(', ')}` : ''}</p>
              <p className="mt-1 text-sm">Total: <b>{fmtMoney(openOrder.total)}</b> (IVA incluido){openOrder.serviceMode === 'MANAGED' ? ' + la IA que uses en el mes' : ''}</p>
            </div>
            <Badge tone={openOrder.status === 'ACTIVE' ? 'ok' : 'warn'}>{openOrder.status === 'ACTIVE' ? 'Activo' : 'En proceso'}</Badge>
          </div>
          <p className="mt-4 flex items-start gap-2 border-2 border-ok bg-ok-soft px-3 py-2 text-sm">
            <MessageCircle size={16} className="mt-0.5 shrink-0" /> {ORDER_STATUS[openOrder.status] ?? 'Estamos procesando tu pedido.'}
          </p>
          {openOrder.status !== 'ACTIVE' && canWrite && (
            <button type="button" onClick={() => setChanging(true)} className="mt-3 cursor-pointer text-xs font-semibold underline">Quiero cambiar mi pedido</button>
          )}
        </div>
      ) : (
        <>
          {/* 1. Plan */}
          <p className="text-sm text-ink-2">{data.notices.numbers}</p>
          {rec.plan && (
            <div className="border-2 border-ink bg-paper p-4">
              <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} /> Te recomendamos el plan {rec.plan.planName}</p>
              <ul className="mt-2 space-y-1 text-sm text-ink-2">
                {rec.plan.reasons.map((r) => <li key={r} className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-ok" />{r}</li>)}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Forma de pago del plan">
            {(['MONTHLY', 'ANNUAL'] as const).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={cycle === c} onClick={() => setCycle(c)}
                className={clsx('cursor-pointer border-2 px-4 py-2 text-sm font-semibold', cycle === c ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink')}>
                {c === 'MONTHLY' ? 'Pago mensual' : 'Pago anual · 2 meses gratis'}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {data.plans.map((p) => {
              const selected = p.id === planId;
              const price = mode === 'MANAGED' ? p.priceManaged : p.priceSelf;
              const annual = mode === 'MANAGED' ? p.annualManaged : p.annualSelf;
              return (
                <button key={p.id} type="button" onClick={() => setPlanId(p.id)} aria-pressed={selected}
                  className={clsx('flex cursor-pointer flex-col border-2 p-4 text-left transition-colors', selected ? 'border-ink bg-paper shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]' : 'border-line bg-bone hover:border-ink')}>
                  <span className="flex items-start justify-between gap-2">
                    <span className="display text-2xl">{p.name}</span>
                    {p.id === rec.plan?.planId && <Badge tone="ink">Para ti</Badge>}
                  </span>
                  <span className="mt-1 text-sm font-semibold">{p.maxLines === 1 ? '1 número de WhatsApp' : p.tier === 'MAX' ? `Hasta ${p.maxLines} números` : `${p.maxLines} números de WhatsApp`}</span>
                  <span className="display mt-2 text-2xl">
                    {fmtMoney(cycle === 'ANNUAL' ? annual : price)}<span className="text-sm text-ink-3">{cycle === 'ANNUAL' ? '/año' : '/mes'}</span>
                  </span>
                  <span className="text-[11px] text-ink-3">
                    IVA incluido · {mode === 'MANAGED' ? 'Todo incluido' : 'Tu IA'}{cycle === 'ANNUAL' ? ` · equivale a ${fmtMoney(annual / 12)}/mes` : ''}
                    {p.minTermMonths ? ` · montaje gratis con permanencia de ${p.minTermMonths} meses` : ''}
                  </span>
                  <ul className="mt-2 space-y-0.5 text-[13px]">{p.features.map((f) => <li key={f}>— {f}</li>)}</ul>
                  {rec.plan?.cheaper?.planId === p.id && <span className="mt-2 text-[11px] font-semibold text-warn">{rec.plan.cheaper.note}</span>}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-ink-3">¿Necesitas más de 5 números u otros canales? El precio cambia: tu asesor te arma una propuesta a la medida.</p>

          {/* 2. Modalidad */}
          <div className="border-2 border-ink bg-paper p-4">
            <p className="kicker">¿Cómo quieres pagar la IA y los mensajes?</p>
            <p className="mt-1 text-sm text-ink-2">{rec.modeReason}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {(['MANAGED', 'SELF'] as const).map((m) => {
                const info = data.modes[m];
                const on = mode === m;
                return (
                  <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={on}
                    className={clsx('cursor-pointer border-2 p-4 text-left', on ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink')}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="display text-xl">{info.name}</span>
                      {rec.serviceMode === m && <Badge tone={on ? 'neutral' : 'ink'}>Recomendado</Badge>}
                    </span>
                    <span className={clsx('mt-1 block text-sm', on ? 'text-line' : 'text-ink-2')}>{info.short}</span>
                    <span className={clsx('mt-2 block text-xs font-semibold uppercase tracking-wider', on ? 'text-line' : 'text-ink-3')}>Incluye</span>
                    <ul className="mt-1 space-y-0.5 text-[13px]">{info.includes.map((i) => <li key={i} className="flex gap-1.5"><Check size={13} className="mt-0.5 shrink-0" />{i}</li>)}</ul>
                    <span className={clsx('mt-2 block text-xs font-semibold uppercase tracking-wider', on ? 'text-line' : 'text-ink-3')}>Tú pagas</span>
                    <ul className="mt-1 space-y-0.5 text-[13px]">{info.youPay.map((i) => <li key={i}>— {i}</li>)}</ul>
                  </button>
                );
              })}
            </div>
            {mode === 'MANAGED' && rec.aiEstimate && (
              <p className="mt-3 border-l-2 border-ink pl-3 text-sm">
                Con unos {data.needs.dailyChats} clientes al día, la IA te saldría cerca de <b>{fmtMoney(rec.aiEstimate.monthly)} al mes</b>, que se suman a tu mensualidad a fin de mes.
              </p>
            )}
            <p className="mt-2 text-xs text-ink-3">{data.notices.meta} {data.notices.metaFree}</p>
          </div>

          {/* 3. Complementos */}
          <div className="border-2 border-ink bg-paper p-4">
            <p className="kicker">Complementos (opcionales)</p>
            <p className="mt-1 text-xs text-ink-3">Los apagas cuando quieras desde tu panel; si lo haces antes del día de pago, el mes siguiente ya no se cobran.</p>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {available.map((a) => {
                const qty = addons[a.key] ?? 0;
                const on = qty > 0;
                return (
                  <div key={a.key} className={clsx('border-2 p-3', on ? 'border-ink bg-ok-soft' : 'border-line bg-bone')}>
                    <div className="flex items-start justify-between gap-3">
                      <button type="button" onClick={() => toggleAddon(a)} disabled={a.active} aria-pressed={on} className="flex cursor-pointer items-start gap-2 text-left disabled:cursor-default">
                        <span className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2', on || a.active ? 'border-ink bg-ink text-bone' : 'border-ink')}>{(on || a.active) && <Check size={12} />}</span>
                        <span>
                          <span className="block text-sm font-semibold">{a.name}{a.active && <Badge tone="ok"> Ya lo tienes</Badge>}</span>
                          <span className="block text-xs text-ink-2">{a.description}</span>
                        </span>
                      </button>
                      <span className="shrink-0 text-right text-sm font-semibold">{fmtMoney(a.price)}<span className="block text-[11px] font-normal text-ink-3">/mes{a.perUnit ? ` por ${a.perUnit}` : ''}</span></span>
                    </div>
                    {on && a.perUnit && (
                      <div className="mt-2 flex items-center gap-2 pl-7 text-sm">
                        <button type="button" aria-label="Menos" className="cursor-pointer border-2 border-ink p-0.5" onClick={() => setAddons((x) => ({ ...x, [a.key]: Math.max(1, qty - 1) }))}><Minus size={12} /></button>
                        <span className="w-6 text-center tabular-nums">{qty}</span>
                        <button type="button" aria-label="Más" className="cursor-pointer border-2 border-ink p-0.5" onClick={() => setAddons((x) => ({ ...x, [a.key]: Math.min(10, qty + 1) }))}><Plus size={12} /></button>
                        <span className="text-xs text-ink-3">{a.perUnit}s</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {soon.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {soon.map((a) => (
                  <span key={a.key} title={a.description} className="inline-flex items-center gap-1.5 border-2 border-line bg-bone px-2.5 py-1 text-xs text-ink-3">
                    {a.name} <Badge tone="neutral">Próximamente</Badge>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Regalo y avisos */}
          {data.landingGift && (
            <p className="flex items-start gap-2 border-2 border-ok bg-ok-soft px-4 py-3 text-sm"><Gift size={16} className="mt-0.5 shrink-0" /> {data.notices.landing}</p>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            <p className="flex items-start gap-2 border-2 border-warn bg-warn-soft px-4 py-3 text-sm"><UserRound size={16} className="mt-0.5 shrink-0" /> {data.notices.humanOversight}</p>
            <p className="flex items-start gap-2 border-2 border-line bg-paper px-4 py-3 text-sm"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> {data.notices.implementation} El número de WhatsApp lo pones tú.</p>
          </div>

          <div className="border-2 border-ink bg-paper p-4">
            <p className="kicker">Formas de pago</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-3">
              {data.paymentOptions.map((o) => {
                const Icon = PAY_ICONS[o.id] ?? Landmark;
                return (
                  <li key={o.id} className={clsx('flex items-center gap-2 border-2 border-line px-3 py-2 text-sm', !o.available && 'text-ink-3')}>
                    <Icon size={16} className="shrink-0" /> {o.label}{o.comingSoon && <Badge tone="neutral">Próximamente</Badge>}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-ink-3">Tu asesor te envía los datos de pago por WhatsApp. Nunca te pediremos datos de tarjeta por chat.</p>
          </div>

          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-ink px-4 py-2.5 text-bone">
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="text-[11px] uppercase tracking-[0.1em] text-line">{mode === 'MANAGED' ? 'Hoy pagas' : 'Total'}</span>
                <span className="display text-2xl">{fmtMoney(total)}</span>
              </p>
              <p className="truncate text-[11px] text-line">
                {plan?.name ?? '—'} · {data.modes[mode].name} · {cycle === 'ANNUAL' ? 'anual' : 'mensual'}
                {addonsTotal ? ` + complementos ${fmtMoney(addonsTotal)}` : ''} · IVA incluido
                {mode === 'MANAGED' ? ' · la IA se suma a fin de mes' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              {changing && <Button variant="outline" className="!border-bone !text-bone" onClick={() => setChanging(false)}>Cancelar</Button>}
              <Button className="!bg-bone !px-6 !text-ink" disabled={!canWrite || !plan} onClick={start}>Comprar</Button>
            </div>
          </div>
          {!canWrite && <p className="text-xs text-ink-3">Solo el administrador de la empresa puede comprar.</p>}
        </>
      )}

      {experience && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-4" role="dialog" aria-modal="true" aria-label="Procesando tu compra">
          <div className="w-full max-w-md border-2 border-ink bg-paper p-6 shadow-[10px_10px_0_0_rgba(0,0,0,0.6)]">
            {experience.error ? (
              <>
                <p className="display text-3xl">Algo falló</p>
                <p className="mt-2 text-sm text-bad">{experience.error}</p>
                <p className="mt-2 text-sm text-ink-2">Tu información sigue aquí. Intenta otra vez o escríbenos por WhatsApp.</p>
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setExperience(null)}>Cerrar</Button>
                  <Button onClick={start}><RotateCcw size={14} /> Intentar otra vez</Button>
                </div>
              </>
            ) : experience.done ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center border-2 border-ok bg-ok text-white"><Check size={32} /></div>
                <p className="display mt-4 text-center text-3xl">¡Listo, gracias!</p>
                <p className="mt-3 text-center text-[15px] leading-relaxed">
                  Recibimos tu pedido. <b>El equipo de BackOffice ya te contactará por WhatsApp</b> para terminar de configurar tu empresa y enviarte los datos de pago.
                </p>
                <p className="mt-3 text-center text-xs text-ink-3">Mientras tanto puedes seguir completando tus primeros pasos.</p>
                <Button className="mt-5 w-full" onClick={() => setExperience(null)}>Entendido</Button>
              </>
            ) : (
              <>
                <p className="display text-3xl">Preparando todo…</p>
                <ol className="mt-4 space-y-3">
                  {STEPS.filter((s) => Object.keys(addons).length || !s.includes('complementos')).map((label, i) => (
                    <li key={label} className={clsx('flex items-center gap-3 text-sm', i > experience.step && 'text-ink-3')}>
                      <span className={clsx('flex h-6 w-6 items-center justify-center border-2', i < experience.step ? 'border-ok bg-ok text-white' : i === experience.step ? 'animate-pulse border-ink' : 'border-line')}>
                        {i < experience.step && <Check size={13} />}
                      </span>
                      {label}
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
