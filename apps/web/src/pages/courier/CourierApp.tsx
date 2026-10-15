import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Camera, LogOut, MapPin, Navigation, Phone, Power, Radio, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import LiveMap, { type MapPoint } from '../../components/LiveMap';
import { Button, Loading } from '../../components/ui';
import { api, getToken } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney, fmtTime, minutesUntil } from '../../lib/format';
import type { CourierRoute } from '../../lib/types';

/**
 * App del domiciliario (web móvil): turno, ruta del día, GPS en vivo,
 * "recogí" y "entregué" con foto. Mientras el turno está activo comparte la
 * ubicación cada ~10 s y pide mantener la pantalla encendida (Wake Lock).
 */

type GpsState = 'off' | 'waiting' | 'ok' | 'denied' | 'error';
const SEND_EVERY_MS = 10_000;

function useCourierGps(active: boolean) {
  const [state, setState] = useState<GpsState>('off');
  const [position, setPosition] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
  const lastSent = useRef(0);
  const wakeLock = useRef<any>(null);

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    if (!('geolocation' in navigator)) {
      setState('error');
      return;
    }
    setState('waiting');
    const send = (coords: GeolocationCoordinates) => {
      const now = Date.now();
      if (now - lastSent.current < SEND_EVERY_MS) return;
      lastSent.current = now;
      api
        .post('/delivery/me/location', {
          lat: coords.latitude, lng: coords.longitude,
          accuracy: coords.accuracy, speed: coords.speed ?? undefined, heading: coords.heading ?? undefined,
        })
        .catch(() => undefined);
    };
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setState('ok');
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        send(pos.coords);
      },
      (err) => setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'error'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    // Pantalla encendida mientras reparte (si el navegador lo soporta)
    const requestWakeLock = async () => {
      try {
        wakeLock.current = await (navigator as any).wakeLock?.request('screen');
      } catch {
        /* sin soporte o denegado: el GPS sigue mientras la app esté al frente */
      }
    };
    requestWakeLock();
    const onVisible = () => document.visibilityState === 'visible' && requestWakeLock();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.geolocation.clearWatch(watchId);
      document.removeEventListener('visibilitychange', onVisible);
      wakeLock.current?.release?.().catch?.(() => undefined);
      wakeLock.current = null;
    };
  }, [active]);

  return { state, position };
}

async function deliverWithPhoto(orderId: string, photo?: File) {
  const form = new FormData();
  if (photo) form.append('photo', photo);
  const res = await fetch(`/api/delivery/me/orders/${orderId}/deliver`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message ?? 'No se pudo marcar como entregado');
  return data;
}

export default function CourierApp() {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['courier-route'],
    queryFn: () => api.get<CourierRoute>('/delivery/me/route'),
    refetchInterval: 20_000,
  });
  const onShift = !!data?.courier.onShift;
  const gps = useCourierGps(onShift);
  const accent = data?.company.brandColor || '#1a1a1a';
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['courier-route'] });

  const shift = useMutation({
    mutationFn: (on: boolean) => api.post('/delivery/me/shift', { on }),
    onSuccess: (_d, on) => {
      toast.success(on ? 'Turno iniciado: compartiendo ubicación' : 'Turno terminado');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const pickup = useMutation({
    mutationFn: (id: string) => api.post(`/delivery/me/orders/${id}/pickup`),
    onSuccess: () => {
      toast.success('En camino: el cliente ya recibió el link de seguimiento');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const deliver = useMutation({
    mutationFn: ({ id, photo }: { id: string; photo?: File }) => deliverWithPhoto(id, photo),
    onSuccess: () => {
      toast.success('Pedido entregado');
      setSelected(null);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const active = (data?.stops ?? []).filter((s) => s.status !== 'entregado');
  const done = (data?.stops ?? []).filter((s) => s.status === 'entregado');

  const points = useMemo<MapPoint[]>(() => {
    const out: MapPoint[] = [];
    if (data?.origin) out.push({ id: 'origin', kind: 'origin', lat: data.origin.lat, lng: data.origin.lng, label: data.company.name });
    for (const stop of active) {
      if (stop.destination.lat == null || stop.destination.lng == null) continue;
      out.push({
        id: stop.id, kind: 'destination', lat: stop.destination.lat, lng: stop.destination.lng,
        tag: stop.code.slice(-3), label: `#${stop.code} · ${stop.customer}`,
        active: stop.id === selected || stop.status === 'despachado',
      });
    }
    if (gps.position) {
      out.push({ id: 'me', kind: 'courier', ...gps.position, tag: 'YO', label: 'Tú' });
    }
    return out;
  }, [data, active, gps.position, selected]);

  if (isLoading || !data) return <Loading label="Cargando tu ruta…" />;

  return (
    <div className="min-h-screen bg-bone pb-10">
      <div className="h-1.5 w-full" style={{ background: accent }} aria-hidden />
      <header className="sticky top-0 z-[500] border-b-2 border-ink bg-bone px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="kicker truncate">{data.company.name} · Domicilios</p>
            <p className="display truncate text-2xl leading-none">{data.courier.name}</p>
          </div>
          <button
            onClick={logout}
            aria-label="Cerrar sesión"
            className="cursor-pointer border-2 border-ink p-2 hover:bg-ink hover:text-bone"
          >
            <LogOut size={15} />
          </button>
        </div>
        <button
          onClick={() => shift.mutate(!onShift)}
          disabled={shift.isPending}
          className={clsx(
            'mt-3 flex w-full cursor-pointer items-center justify-center gap-2 border-2 px-4 py-3 text-xs font-semibold uppercase tracking-[0.1em] transition-colors disabled:opacity-50',
            onShift ? 'border-ink bg-paper text-ink' : 'border-ink bg-ink text-bone',
          )}
        >
          <Power size={15} /> {onShift ? 'Terminar turno' : 'Iniciar turno'}
        </button>
        {onShift && <GpsStatus state={gps.state} />}
      </header>

      <main className="mx-auto max-w-lg px-4">
        {points.length > 0 && (
          <div className="mt-4 h-[260px] border-2 border-ink">
            <LiveMap points={points} accent={accent} fitKey={`${active.length}-${selected ?? ''}`} onSelect={(id) => setSelected(id)} scrollFriendly />
          </div>
        )}

        <p className="kicker mb-2 mt-5">Por entregar · {active.length}</p>
        {active.length === 0 && (
          <div className="border-2 border-dashed border-line bg-paper px-6 py-10 text-center">
            <p className="display text-xl text-ink-2">Sin pedidos asignados</p>
            <p className="mt-1 text-sm text-ink-3">Cuando te asignen uno aparece aquí.</p>
          </div>
        )}
        <div className="space-y-3">
          {active.map((stop) => (
            <StopCard
              key={stop.id}
              stop={stop}
              accent={accent}
              currency={data.company.currency ?? 'COP'}
              selected={selected === stop.id}
              onSelect={() => setSelected(stop.id)}
              onPickup={() => pickup.mutate(stop.id)}
              onDeliver={(photo) => deliver.mutate({ id: stop.id, photo })}
              busy={pickup.isPending || deliver.isPending}
              canWork={onShift}
            />
          ))}
        </div>

        {done.length > 0 && (
          <>
            <p className="kicker mb-2 mt-6">Entregados hoy · {done.length}</p>
            <ul className="divide-y divide-line border-2 border-ink bg-paper">
              {done.map((stop) => (
                <li key={stop.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span><span className="font-semibold">#{stop.code}</span> · {stop.customer}</span>
                  <span className="text-ink-3">{stop.destination.address?.slice(0, 26)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}

function GpsStatus({ state }: { state: GpsState }) {
  const map: Record<GpsState, { text: string; tone: string }> = {
    off: { text: 'GPS apagado', tone: 'text-ink-3' },
    waiting: { text: 'Buscando señal GPS…', tone: 'text-warn' },
    ok: { text: 'Compartiendo ubicación en vivo · deja esta pantalla abierta', tone: 'text-ok' },
    denied: { text: 'Permite la ubicación en el navegador para que el cliente te vea', tone: 'text-bad' },
    error: { text: 'No hay señal de GPS en este momento', tone: 'text-bad' },
  };
  const { text, tone } = map[state];
  return (
    <p className={clsx('mt-2 flex items-center gap-1.5 text-[11px] font-semibold', tone)}>
      {state === 'ok' ? <Radio size={12} /> : <TriangleAlert size={12} />} {text}
    </p>
  );
}

function StopCard({
  stop, accent, currency, selected, onSelect, onPickup, onDeliver, busy, canWork,
}: {
  stop: CourierRoute['stops'][number];
  accent: string;
  currency: string;
  selected: boolean;
  onSelect: () => void;
  onPickup: () => void;
  onDeliver: (photo?: File) => void;
  busy: boolean;
  canWork: boolean;
}) {
  const photoInput = useRef<HTMLInputElement>(null);
  const { destination: d } = stop;
  const hasCoords = d.lat != null && d.lng != null;
  const inRoute = stop.status === 'despachado';
  const ready = stop.status === 'listo' || stop.status === 'empacado';
  const eta = minutesUntil(stop.etaAt);
  const mapsUrl = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(d.address ?? '')}`;
  const wazeUrl = hasCoords ? `https://waze.com/ul?ll=${d.lat},${d.lng}&navigate=yes` : null;

  return (
    <article
      onClick={onSelect}
      className={clsx('border-2 bg-paper transition-shadow', selected ? 'border-ink shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]' : 'border-ink')}
    >
      <div className="flex items-start justify-between gap-3 border-b-2 border-ink px-4 py-3">
        <div className="min-w-0">
          <p className="kicker">#{stop.code} · {inRoute ? 'En camino' : ready ? 'Listo para recoger' : 'En preparación'}</p>
          <p className="truncate text-base font-semibold">{stop.customer}</p>
        </div>
        <div className="shrink-0 text-right">
          {stop.total != null && <p className="text-sm font-semibold">{fmtMoney(stop.total, currency)}</p>}
          <p className="text-xs text-ink-3">{inRoute && eta != null ? `llega en ${eta} min` : fmtTime(stop.deliveryAt)}</p>
        </div>
      </div>
      <div className="space-y-2 px-4 py-3 text-sm">
        <p className="flex items-start gap-2">
          <MapPin size={15} className="mt-0.5 shrink-0" style={{ color: accent }} />
          <span>
            {d.address ?? 'Sin dirección'}
            {d.instructions && <span className="block text-xs text-ink-3">{d.instructions}</span>}
          </span>
        </p>
        <p className="text-xs text-ink-2">
          {stop.items.map((i) => `${i.quantity} × ${i.productName}`).join(' · ')}
        </p>
        {stop.observations && <p className="border-l-2 border-warn pl-2 text-xs text-warn">{stop.observations}</p>}
      </div>
      <div className="grid grid-cols-3 border-t-2 border-ink text-[11px] font-semibold uppercase tracking-[0.06em]">
        <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 py-2.5 hover:bg-bone-2">
          <Navigation size={13} /> Maps
        </a>
        {wazeUrl ? (
          <a href={wazeUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-1.5 border-l-2 border-ink py-2.5 hover:bg-bone-2">
            <Navigation size={13} /> Waze
          </a>
        ) : <span className="border-l-2 border-ink" />}
        {stop.phone ? (
          <a href={`tel:${stop.phone}`} className="flex items-center justify-center gap-1.5 border-l-2 border-ink py-2.5 hover:bg-bone-2">
            <Phone size={13} /> Llamar
          </a>
        ) : <span className="border-l-2 border-ink" />}
      </div>
      <div className="border-t-2 border-ink p-3">
        {ready && (
          <Button className="w-full" disabled={busy || !canWork} onClick={(e) => { e.stopPropagation(); onPickup(); }}>
            Recogí el pedido · salgo a entregar
          </Button>
        )}
        {inRoute && (
          <>
            <input
              ref={photoInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onDeliver(file);
                e.target.value = '';
              }}
            />
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Button disabled={busy} onClick={(e) => { e.stopPropagation(); onDeliver(); }}>
                Entregado
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                aria-label="Entregado con foto"
                onClick={(e) => { e.stopPropagation(); photoInput.current?.click(); }}
              >
                <Camera size={14} /> Foto
              </Button>
            </div>
          </>
        )}
        {!ready && !inRoute && <p className="text-center text-xs text-ink-3">Te avisamos cuando esté listo en cocina.</p>}
        {!canWork && ready && <p className="mt-2 text-center text-xs text-ink-3">Inicia tu turno para recoger pedidos.</p>}
      </div>
    </article>
  );
}
