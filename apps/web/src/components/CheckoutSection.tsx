import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, CreditCard, Landmark, MessageCircle, QrCode, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtMoney } from '../lib/format';
import { withScope } from '../pages/company/shared';
import { Badge, Button, Loading } from './ui';

/**
 * Compra del plan desde "Primeros pasos":
 *  - Arriba, lo que te recomendamos (calculado con tus datos) y por qué.
 *  - Puedes cambiar de plan, de forma de pago y del paquete de IA.
 *  - Al comprar no aparecen cuentas ni QR: una pantalla de "estamos preparando
 *    todo" y luego el aviso de que el equipo te contacta para terminar.
 */

interface CheckoutPlan {
  id: string; name: string; priceMonthly: number; annualPrice: number; maxUsers: number; maxLines: number;
  maxCouriers: number; highlight: boolean; minTermMonths: number; features: string[];
}
interface CheckoutData {
  plans: CheckoutPlan[];
  packages: Array<{ id: string; name: string; conversations: number; price: number; validityMonths: number }>;
  needs: { dailyChats: number; modules: string[]; users: number; lines: number };
  recommendation: {
    plan: { planId: string; planName: string; reasons: string[]; cheaper: { planId: string; planName: string; note: string } | null; upsell: { planId: string; planName: string; note: string } | null } | null;
    aiPackage: { packageId: string; name: string; conversations: number; price: number; monthsItLasts: number | null; reason: string } | null;
    aiNote: string;
  };
  paymentOptions: Array<{ id: string; label: string; available: boolean; comingSoon?: boolean }>;
  order: { id: string; planName: string; billingCycle: string; aiPackageName: string | null; total: number; status: string; createdAt: string } | null;
}

const ORDER_STATUS: Record<string, string> = {
  REQUESTED: 'Recibimos tu pedido. Un asesor te escribe por WhatsApp muy pronto.',
  CONTACTED: 'Tu asesor ya te contactó. Revisa tu WhatsApp.',
  AWAITING_PAYMENT: 'Esperando tu pago. Envía el comprobante por WhatsApp a tu asesor.',
  PAID: 'Recibimos tu pago. Estamos activando tu cuenta.',
  ACTIVE: '¡Tu plan está activo!',
};

const STEPS = ['Guardando tu pedido', 'Reservando tu plan', 'Preparando tu paquete de IA', 'Avisándole a tu asesor'];

const PAY_ICONS: Record<string, typeof Landmark> = { TRANSFER: Landmark, QR: QrCode, WOMPI: CreditCard };

export default function CheckoutSection({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['checkout', q],
    queryFn: () => api.get<CheckoutData>(withScope('/onboarding/checkout', q)),
  });
  const [cycle, setCycle] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY');
  const [planId, setPlanId] = useState<string | null>(null);
  const [packageId, setPackageId] = useState<string | null | undefined>(undefined);
  const [changing, setChanging] = useState(false);
  const [experience, setExperience] = useState<{ step: number; done: boolean; error: string | null } | null>(null);

  useEffect(() => {
    if (!data) return;
    if (planId === null) setPlanId(data.recommendation.plan?.planId ?? data.plans[0]?.id ?? null);
    if (packageId === undefined) setPackageId(data.recommendation.aiPackage?.packageId ?? null);
  }, [data, planId, packageId]);

  const buy = useMutation({
    mutationFn: () => api.post(withScope('/onboarding/checkout', q), { planId, billingCycle: cycle, aiPackageId: packageId }),
  });

  async function start() {
    setExperience({ step: 0, done: false, error: null });
    const request = buy.mutateAsync();
    // La experiencia dura lo mismo aunque el servidor responda rápido
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

  if (isLoading || !data) return <Loading label="Buscando el plan ideal para ti…" />;

  const rec = data.recommendation;
  const plan = data.plans.find((p) => p.id === planId) ?? null;
  const pkg = data.packages.find((p) => p.id === packageId) ?? null;
  const planAmount = plan ? (cycle === 'ANNUAL' ? plan.annualPrice : plan.priceMonthly) : 0;
  const total = planAmount + (pkg?.price ?? 0);
  const openOrder = data.order && !['CANCELLED'].includes(data.order.status) ? data.order : null;

  return (
    <section id="planes" className="space-y-4">
      <div>
        <p className="kicker">Tu plan</p>
        <h2 className="display text-3xl">Elige cómo seguir</h2>
      </div>

      {openOrder && !changing ? (
        <div className="border-2 border-ink bg-paper p-5 shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="kicker">Tu pedido</p>
              <p className="display mt-1 text-2xl">
                {openOrder.planName} · {openOrder.billingCycle === 'ANNUAL' ? 'anual' : 'mensual'}
              </p>
              {openOrder.aiPackageName && <p className="text-sm text-ink-2">+ {openOrder.aiPackageName}</p>}
              <p className="mt-1 text-sm">Total: <b>{fmtMoney(openOrder.total)}</b> (IVA incluido)</p>
            </div>
            <Badge tone={openOrder.status === 'ACTIVE' ? 'ok' : 'warn'}>{openOrder.status === 'ACTIVE' ? 'Activo' : 'En proceso'}</Badge>
          </div>
          <p className="mt-4 flex items-start gap-2 border-2 border-ok bg-ok-soft px-3 py-2 text-sm">
            <MessageCircle size={16} className="mt-0.5 shrink-0" /> {ORDER_STATUS[openOrder.status] ?? 'Estamos procesando tu pedido.'}
          </p>
          {openOrder.status !== 'ACTIVE' && canWrite && (
            <button type="button" onClick={() => setChanging(true)} className="mt-3 cursor-pointer text-xs font-semibold underline">
              Quiero cambiar mi pedido
            </button>
          )}
        </div>
      ) : (
        <>
          {rec.plan && (
            <div className="border-2 border-ink bg-paper p-5 shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
              <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} /> Te recomendamos el plan {rec.plan.planName}</p>
              <ul className="mt-2 space-y-1 text-sm text-ink-2">
                {rec.plan.reasons.map((r) => <li key={r} className="flex gap-2"><Check size={15} className="mt-0.5 shrink-0 text-ok" />{r}</li>)}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Forma de pago del plan">
            {(['MONTHLY', 'ANNUAL'] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cycle === c}
                onClick={() => setCycle(c)}
                className={clsx('cursor-pointer border-2 px-4 py-2 text-sm font-semibold', cycle === c ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink')}
              >
                {c === 'MONTHLY' ? 'Pago mensual' : 'Pago anual · 2 meses gratis'}
              </button>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.plans.map((p) => {
              const selected = p.id === planId;
              const recommended = p.id === rec.plan?.planId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPlanId(p.id)}
                  aria-pressed={selected}
                  className={clsx('flex cursor-pointer flex-col border-2 p-4 text-left transition-colors', selected ? 'border-ink bg-paper shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]' : 'border-line bg-bone hover:border-ink')}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="display text-2xl">{p.name}</span>
                    {recommended && <Badge tone="ink">Para ti</Badge>}
                  </span>
                  <span className="display mt-1 text-2xl">
                    {fmtMoney(cycle === 'ANNUAL' ? p.annualPrice : p.priceMonthly)}
                    <span className="text-sm text-ink-3">{cycle === 'ANNUAL' ? '/año' : '/mes'}</span>
                  </span>
                  <span className="text-[11px] text-ink-3">
                    IVA incluido{cycle === 'ANNUAL' ? ` · equivale a ${fmtMoney(p.annualPrice / 12)}/mes` : ''}
                    {p.minTermMonths ? ` · montaje gratis con permanencia de ${p.minTermMonths} meses` : ''}
                  </span>
                  <span className="mt-2 block text-xs text-ink-2">
                    {p.maxUsers >= 999 ? 'Personas sin límite' : `Hasta ${p.maxUsers} personas`} · {p.maxLines} {p.maxLines === 1 ? 'línea' : 'líneas'} de WhatsApp
                    {p.maxCouriers ? ` · ${p.maxCouriers >= 999 ? 'domiciliarios sin límite' : `${p.maxCouriers} domiciliarios`}` : ''}
                  </span>
                  <ul className="mt-2 space-y-0.5 text-[13px]">
                    {p.features.slice(0, 4).map((f) => <li key={f}>— {f}</li>)}
                  </ul>
                  {rec.plan?.cheaper?.planId === p.id && <span className="mt-2 text-[11px] font-semibold text-warn">{rec.plan.cheaper.note}</span>}
                  {rec.plan?.upsell?.planId === p.id && <span className="mt-2 text-[11px] text-ink-3">{rec.plan.upsell.note}</span>}
                </button>
              );
            })}
          </div>

          <div className="border-2 border-ink bg-paper p-4">
            <p className="kicker">Inteligencia artificial</p>
            <p className="mt-1 text-sm text-ink-2">{rec.aiPackage?.reason ?? rec.aiNote}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <button
                type="button"
                onClick={() => setPackageId(null)}
                aria-pressed={!packageId}
                className={clsx('cursor-pointer border-2 p-3 text-left text-sm', !packageId ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink')}
              >
                <span className="font-semibold">Sin paquete por ahora</span>
                <span className={clsx('block text-xs', !packageId ? 'text-line' : 'text-ink-3')}>Lo agregas cuando quieras</span>
              </button>
              {data.packages.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setPackageId(k.id)}
                  aria-pressed={packageId === k.id}
                  className={clsx('cursor-pointer border-2 p-3 text-left text-sm', packageId === k.id ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink')}
                >
                  <span className="font-semibold">{k.conversations.toLocaleString('es-CO')} conversaciones</span>
                  <span className={clsx('block text-xs', packageId === k.id ? 'text-line' : 'text-ink-3')}>
                    {fmtMoney(k.price)}{rec.aiPackage?.packageId === k.id ? ' · recomendado' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="border-2 border-ink bg-paper p-4">
            <p className="kicker">Formas de pago</p>
            <ul className="mt-2 grid gap-2 sm:grid-cols-3">
              {data.paymentOptions.map((o) => {
                const Icon = PAY_ICONS[o.id] ?? Landmark;
                return (
                  <li key={o.id} className={clsx('flex items-center gap-2 border-2 px-3 py-2 text-sm', o.available ? 'border-line' : 'border-line text-ink-3')}>
                    <Icon size={16} className="shrink-0" /> {o.label}
                    {o.comingSoon && <Badge tone="neutral">Próximamente</Badge>}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-xs text-ink-3">Tu asesor te envía los datos de pago por WhatsApp. Nunca te pediremos datos de tarjeta por chat.</p>
          </div>

          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-ink px-5 py-4 text-bone">
            <div>
              <p className="text-xs uppercase tracking-[0.1em] text-line">Total</p>
              <p className="display text-3xl">{fmtMoney(total)}</p>
              <p className="text-xs text-line">
                {plan?.name ?? '—'} {cycle === 'ANNUAL' ? 'anual' : 'mensual'}{pkg ? ` + ${pkg.conversations.toLocaleString('es-CO')} conversaciones de IA` : ''} · IVA incluido
              </p>
            </div>
            <div className="flex gap-2">
              {changing && <Button variant="outline" className="!border-bone !text-bone" onClick={() => setChanging(false)}>Cancelar</Button>}
              <Button className="!bg-bone !text-ink !px-6 !py-3" disabled={!canWrite || !plan} onClick={start}>
                Comprar
              </Button>
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
                <div className="mx-auto flex h-16 w-16 items-center justify-center border-2 border-ok bg-ok text-white">
                  <Check size={32} />
                </div>
                <p className="display mt-4 text-center text-3xl">¡Listo, gracias!</p>
                <p className="mt-3 text-center text-[15px] leading-relaxed">
                  Recibimos tu pedido. <b>El equipo de BackOffice ya te contactará por WhatsApp</b> para terminar de configurar tu empresa y
                  enviarte los datos de pago.
                </p>
                <p className="mt-3 text-center text-xs text-ink-3">Mientras tanto puedes seguir completando tus primeros pasos.</p>
                <Button className="mt-5 w-full" onClick={() => setExperience(null)}>Entendido</Button>
              </>
            ) : (
              <>
                <p className="display text-3xl">Preparando todo…</p>
                <ol className="mt-4 space-y-3">
                  {STEPS.filter((s) => pkg || !s.includes('IA')).map((label, i) => (
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
