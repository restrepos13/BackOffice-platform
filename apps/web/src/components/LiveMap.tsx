import { useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import * as L from '../vendor/leaflet/leaflet.esm.js';
import '../vendor/leaflet/leaflet.css';

/**
 * Mapa en vivo (Leaflet + teselas de OpenStreetMap, sin llaves).
 * Los marcadores se actualizan por id: un domiciliario que se mueve desliza su
 * punto en lugar de redibujar el mapa. Encuadre automático la primera vez y
 * cada vez que cambia `fitKey`.
 */

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  kind: 'origin' | 'destination' | 'courier';
  label?: string;
  /** Texto corto dentro del marcador (código del pedido, inicial). */
  tag?: string;
  /** Resaltado (seleccionado / en ruta). */
  active?: boolean;
  /** Apagado (sin señal reciente / entregado). */
  muted?: boolean;
}

const STORE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"><path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></svg>';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function iconFor(point: MapPoint, accent: string) {
  const tag = escapeHtml(point.tag ?? '');
  if (point.kind === 'origin') {
    return L.divIcon({
      className: 'bo-pin',
      html: `<div class="bo-pin-origin">${STORE_SVG}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  }
  if (point.kind === 'courier') {
    return L.divIcon({
      className: 'bo-pin',
      html: `<div class="bo-pin-courier${point.muted ? ' is-muted' : ''}" style="--accent:${accent}"><span class="bo-pin-pulse"></span><span class="bo-pin-dot">${tag}</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }
  return L.divIcon({
    className: 'bo-pin',
    html: `<div class="bo-pin-dest${point.active ? ' is-active' : ''}${point.muted ? ' is-muted' : ''}" style="--accent:${accent}">${tag ? `<span>${tag}</span>` : ''}</div>`,
    iconSize: [24, 32],
    iconAnchor: [12, 32],
  });
}

export default function LiveMap({
  points,
  trail,
  fitKey,
  accent = '#1a1a1a',
  className,
  onSelect,
  interactive = true,
  scrollFriendly = false,
}: {
  points: MapPoint[];
  trail?: Array<{ lat: number; lng: number }>;
  fitKey?: string | number;
  accent?: string;
  className?: string;
  onSelect?: (id: string) => void;
  interactive?: boolean;
  /** En páginas que se recorren con el dedo: el mapa no "atrapa" el scroll
   *  (sin arrastre táctil ni zoom con la rueda; quedan los botones +/−). */
  scrollFriendly?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.LeafletMap | null>(null);
  const markers = useRef(new Map<string, { marker: L.LeafletMarker; sig: string }>());
  const trailRef = useRef<L.LeafletPolyline | null>(null);
  const fitted = useRef<string | number | undefined>(undefined);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // Crear el mapa una sola vez
  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
    const map = L.map(container.current, {
      zoomControl: interactive,
      attributionControl: true,
      scrollWheelZoom: interactive && !scrollFriendly,
      dragging: interactive && !(scrollFriendly && touch),
      tap: false,
    }).setView([6.2442, -75.5812], 12);
    // Teselas libres de OpenStreetMap; el filtro gris cálido (styles.css)
    // las lleva a la paleta hueso/tinta de la marca.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; colaboradores de OpenStreetMap',
    }).addTo(map);
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      markers.current.clear();
      trailRef.current = null;
    };
  }, [interactive, scrollFriendly]);

  // Sincronizar marcadores por id
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const point of points) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
      seen.add(point.id);
      const sig = `${point.kind}|${point.tag ?? ''}|${point.active ? 1 : 0}|${point.muted ? 1 : 0}|${accent}`;
      const existing = markers.current.get(point.id);
      if (existing) {
        existing.marker.setLatLng([point.lat, point.lng]);
        if (existing.sig !== sig) {
          existing.marker.setIcon(iconFor(point, accent));
          existing.sig = sig;
        }
        if (point.label) existing.marker.setTooltipContent(escapeHtml(point.label));
        continue;
      }
      const marker = L.marker([point.lat, point.lng], {
        icon: iconFor(point, accent),
        keyboard: false,
        zIndexOffset: point.kind === 'courier' ? 1000 : point.kind === 'origin' ? 500 : 0,
      }).addTo(map);
      if (point.label) {
        marker.bindTooltip(escapeHtml(point.label), { direction: 'top', offset: [0, -18], className: 'bo-tooltip' });
      }
      marker.on('click', () => selectRef.current?.(point.id));
      markers.current.set(point.id, { marker, sig });
    }
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
    // Encuadre: primera vez con datos o cuando cambia fitKey
    const valid = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const key = fitKey ?? 'auto';
    if (valid.length && fitted.current !== key) {
      fitted.current = key;
      if (valid.length === 1) map.setView([valid[0].lat, valid[0].lng], 15);
      else map.fitBounds(L.latLngBounds(valid.map((p) => [p.lat, p.lng] as L.LatLngTuple)), { padding: [40, 40], maxZoom: 16 });
    }
  }, [points, accent, fitKey]);

  // Recorrido del domiciliario
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const latlngs = (trail ?? []).map((p) => [p.lat, p.lng] as L.LatLngTuple);
    if (latlngs.length < 2) {
      trailRef.current?.remove();
      trailRef.current = null;
      return;
    }
    if (trailRef.current) trailRef.current.setLatLngs(latlngs);
    else trailRef.current = L.polyline(latlngs, { color: accent, weight: 3, opacity: 0.55, dashArray: '6 6' }).addTo(map);
  }, [trail, accent]);

  return <div ref={container} className={clsx('bo-map h-full w-full', className)} />;
}
