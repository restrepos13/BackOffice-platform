import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bike, Check, ChefHat, CircleAlert, MapPin, MessageCircle, PackageCheck, Receipt } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import LiveMap, { type MapPoint } from '../../components/LiveMap';
import { fmtMoney, fmtTime, minutesUntil, timeAgo } from '../../lib/format';
import type { PublicTracking } from '../../lib/types';

/**
 * Seguimiento del pedido para el cliente final — con la marca del negocio,
 * sin login. Se refresca solo cada 10 s mientras el pedido está en curso.
 */

class TrackingError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function fetchTracking(token: string): Promise<PublicTracking> {
  const res = await fetch(`/api/public/track/${encodeURIComponent(token)}`);
  if (!res.ok) throw new TrackingError(res.status);
  return res.json();
}

/** Hora del paso; si no fue hoy, con el día ("lun 13 · 2:00 p. m."). */
function stepTime(at: string): string {
  const d = new Date(at);
  if (d.toDateString() === new Date().toDateString()) return fmtTime(d);
  const day = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric' }).format(d);
  return `${day} · ${fmtTime(d)}`;
}

const STEP_ICONS = { recibido: Receipt, preparando: ChefHat, en_camino: Bike, entregado: PackageCheck } as const;

export default function Tracking() {
  const { token = '' } = useParams();
  const { data, error, isLoading } = useQuery({
    queryKey: ['public-tracking', token],
    queryFn: () => fetchTracking(token),
    retry: (count, err) => !(err instanceof TrackingError && err.status === 404) && count < 2,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d || d.expired || d.order.cancelled || d.order.status === 'entregado') return false;
      return 10_000;
    },
    refetchOnWindowFocus: true,
  });

  const accent = data?.company.brandColor || '#1a1a1a';
  useEffect(() => {
    if (data) document.title = `Pedido #${data.order.code} · ${data.company.name}`;
  }, [data]);

  const points = useMemo<MapPoint[]>(() => {
    if (!data?.map) return [];
    const out: MapPoint[] = [];
    if (data.map.origin) out.push({ id: 'origin', kind: 'origin', ...data.map.origin, label: data.company.name });
    if (data.map.destination) {
      out.push({ id: 'dest', kind: 'destination', ...data.map.destination, label: 'Tu dirección', active: true });
    }
    if (data.map.courier) {
      out.push({
        id: 'courier', kind: 'courier', ...data.map.courier,
        label: data.courier?.name ?? 'Domiciliario',
        tag: (data.courier?.name ?? 'D').slice(0, 1).toUpperCase(),
      });
    }
    return out;
  }, [data]);

  if (isLoading) {
    return (
      <Shell accent={accent}>
        <div className="flex items-center justify-center gap-3 py-24 text-ink-3">
          <span className="h-3 w-3 animate-pulse bg-ink" aria-hidden />
          <span className="kicker">Buscando tu pedido…</span>
        </div>
      </Shell>
    );
  }
  if (error || !data) {
    const notFound = error instanceof TrackingError && error.status === 404;
    return (
      <Shell accent={accent}>
        <div className="border-2 border-ink bg-paper px-6 py-12 text-center">
          <CircleAlert className="mx-auto mb-3 text-ink-3" size={28} />
          <p className="display text-2xl">{notFound ? 'Link no válido' : 'Sin conexión'}</p>
          <p className="mx-auto mt-2 max-w-xs text-sm text-ink-3">
            {notFound
              ? 'No encontramos este pedido. Revisa que el link esté completo o escríbele al negocio.'
              : 'No pudimos cargar el seguimiento. Intenta de nuevo en un momento.'}
          </p>
        </div>
      </Shell>
    );
  }

  const { order, company } = data;
  const currency = company.currency ?? 'COP';
  const eta = minutesUntil(order.etaAt);
  const inRoute = order.status === 'despachado';
  const delivered = order.status === 'entregado';
  const whatsapp = company.whatsapp?.replace(/[^\d]/g, '');

  const headline = order.cancelled
    ? 'Pedido cancelado'
    : order.needsReview
      ? 'Lo estamos revisando'
      : order.statusLabel;
  const subline = order.cancelled
    ? 'Si fue un error, escríbenos y lo resolvemos.'
    : order.needsReview
      ? 'Alguien del equipo te confirma en un momento.'
      : delivered
        ? `Entregado ${order.deliveredAt ? `a las ${fmtTime(order.deliveredAt)}` : ''}. ¡Buen provecho!`
        : inRoute && eta != null
          ? eta <= 1 ? 'Está llegando' : `Llega en aproximadamente ${eta} min`
          : eta != null
            ? `Entrega estimada: ${fmtTime(order.etaAt!)}`
            : `Entrega: ${new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(order.deliveryAt))}`;

  return (
    <Shell accent={accent} company={company.name} logo={company.logoUrl}>
      {/* ─── Estado ─── */}
      <section className="border-2 border-ink bg-paper">
        <div className="border-b-2 border-ink px-5 pb-4 pt-5">
          <p className="kicker">Pedido #{order.code}</p>
          <h1 className="display mt-1 text-[2.6rem] leading-[0.9]">{headline}</h1>
          <p className="serif-accent mt-2 text-lg" style={{ color: order.cancelled ? undefined : accent }}>
            {subline}
          </p>
        </div>
        {!order.cancelled && (
          <ol className="grid grid-cols-4" aria-label="Progreso del pedido">
            {order.timeline.map((step, i) => {
              const Icon = STEP_ICONS[step.key as keyof typeof STEP_ICONS] ?? Check;
              const current = step.done && !order.timeline[i + 1]?.done;
              return (
                <li
                  key={step.key}
                  className={clsx('flex flex-col items-center gap-1.5 px-1 py-3 text-center', i > 0 && 'border-l-2 border-ink')}
                  aria-current={current ? 'step' : undefined}
                >
                  <span
                    className={clsx(
                      'flex h-9 w-9 items-center justify-center border-2 transition-colors duration-300',
                      step.done ? 'border-ink text-white' : 'border-line bg-bone text-ink-3',
                    )}
                    style={step.done ? { background: accent, borderColor: accent } : undefined}
                  >
                    <Icon size={16} strokeWidth={2.2} />
                  </span>
                  <span className={clsx('text-[10px] font-semibold uppercase leading-tight tracking-[0.06em]', step.done ? 'text-ink' : 'text-ink-3')}>
                    {step.label}
                  </span>
                  {step.at && step.done && <span className="text-[10px] text-ink-3">{stepTime(step.at)}</span>}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ─── Mapa ─── */}
      {points.length > 0 && !delivered && !order.cancelled && (
        <section className="mt-4 border-2 border-ink bg-paper">
          <div className="h-[300px] sm:h-[360px]">
            <LiveMap points={points} accent={accent} fitKey={data.map?.courier ? 'with-courier' : 'static'} scrollFriendly />
          </div>
          {data.courier && inRoute && (
            <div className="flex items-center justify-between gap-3 border-t-2 border-ink px-4 py-3">
              <div className="flex items-center gap-3">
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-full font-display text-lg text-white"
                  style={{ background: accent }}
                  aria-hidden
                >
                  {data.courier.name.slice(0, 1)}
                </span>
                <div>
                  <p className="text-sm font-semibold">{data.courier.name} lleva tu pedido</p>
                  <p className="text-xs text-ink-3">
                    {data.map?.courier ? `Ubicación actualizada ${timeAgo(data.map.courier.updatedAt)}` : 'Esperando señal del GPS…'}
                  </p>
                </div>
              </div>
              {eta != null && (
                <div className="text-right">
                  <p className="display text-3xl leading-none">{Math.max(eta, 1)}</p>
                  <p className="kicker">min</p>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ─── Resumen ─── */}
      {!data.expired && (
        <section className="mt-4 border-2 border-ink bg-paper">
          <header className="border-b-2 border-ink px-5 py-3">
            <p className="kicker">Tu pedido</p>
          </header>
          <ul className="divide-y divide-line px-5">
            {order.items.map((item, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
                <span>
                  <span className="font-semibold">{item.quantity} ×</span> {item.productName}
                  {item.presentation && <span className="text-ink-3"> · {item.presentation}</span>}
                </span>
              </li>
            ))}
          </ul>
          {order.total != null && (
            <dl className="space-y-1 border-t-2 border-ink px-5 py-3 text-sm">
              {order.subtotal != null && (
                <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd>{fmtMoney(order.subtotal, currency)}</dd></div>
              )}
              {order.deliveryFee != null && (
                <div className="flex justify-between">
                  <dt className="text-ink-3">Domicilio</dt>
                  <dd>{order.deliveryFee === 0 ? 'Gratis' : fmtMoney(order.deliveryFee, currency)}</dd>
                </div>
              )}
              <div className="flex justify-between pt-1 text-base font-semibold">
                <dt>Total</dt><dd>{fmtMoney(order.total, currency)}</dd>
              </div>
            </dl>
          )}
          {order.address && (
            <p className="flex items-start gap-2 border-t-2 border-ink px-5 py-3 text-sm">
              <MapPin size={15} className="mt-0.5 shrink-0" style={{ color: accent }} />
              {order.address}
            </p>
          )}
        </section>
      )}

      {whatsapp && (
        <a
          href={`https://wa.me/${whatsapp}?text=${encodeURIComponent(`Hola, escribo por mi pedido #${order.code}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 flex w-full items-center justify-center gap-2 border-2 border-ink bg-ink px-5 py-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-bone transition-colors hover:bg-transparent hover:text-ink"
        >
          <MessageCircle size={15} /> Escribir a {company.name}
        </a>
      )}
    </Shell>
  );
}

function Shell({
  children, accent, company, logo,
}: { children: React.ReactNode; accent: string; company?: string; logo?: string | null }) {
  return (
    <div className="min-h-screen bg-bone">
      <div className="h-1.5 w-full" style={{ background: accent }} aria-hidden />
      <div className="mx-auto max-w-lg px-4 pb-10 pt-5">
        {company && (
          <header className="mb-4 flex items-center gap-3">
            {logo ? (
              <img src={logo} alt="" className="h-10 w-10 border-2 border-ink object-cover" />
            ) : (
              <span
                className="flex h-10 w-10 items-center justify-center border-2 border-ink font-display text-xl text-white"
                style={{ background: accent }}
                aria-hidden
              >
                {company.slice(0, 1)}
              </span>
            )}
            <p className="display text-2xl leading-none">{company}</p>
          </header>
        )}
        {children}
        <p className="kicker mt-8 text-center !text-[9px]">
          Seguimiento en vivo · BackOffice
        </p>
      </div>
    </div>
  );
}
