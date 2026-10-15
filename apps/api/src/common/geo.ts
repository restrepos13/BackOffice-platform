import { Logger } from '@nestjs/common';

/**
 * Geolocalización de domicilios — funciones puras + geocodificación.
 *
 * Distancia: línea recta (haversine) × factor de calle (~1,35 en ciudad), sin
 * depender de un proveedor de rutas. Suficiente para cobrar el envío y estimar
 * la llegada; si algún día hace falta la ruta exacta se enchufa OSRM/Google aquí.
 *
 * Config por empresa en orderConfig.delivery:
 * { enabled, origin: {lat, lng, address}, maxKm, baseFee, perKm, minFee,
 *   freeFromSubtotal, roadFactor, avgSpeedKmh, prepMinutes }
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DeliveryConfig {
  enabled?: boolean;
  origin?: { lat?: number; lng?: number; address?: string };
  maxKm?: number;
  baseFee?: number;
  perKm?: number;
  minFee?: number;
  freeFromSubtotal?: number;
  roadFactor?: number;
  avgSpeedKmh?: number;
  prepMinutes?: number;
}

export function isLatLng(value: any): value is LatLng {
  return (
    value != null &&
    Number.isFinite(Number(value.lat)) &&
    Number.isFinite(Number(value.lng)) &&
    Math.abs(Number(value.lat)) <= 90 &&
    Math.abs(Number(value.lng)) <= 180 &&
    !(Number(value.lat) === 0 && Number(value.lng) === 0)
  );
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Distancia estimada por calle (km, 1 decimal). */
export function roadKm(a: LatLng, b: LatLng, roadFactor = 1.35): number {
  return Math.round(haversineKm(a, b) * roadFactor * 10) / 10;
}

/** Minutos de viaje a la velocidad promedio configurada (moto en ciudad ≈ 22 km/h). */
export function travelMinutes(km: number, avgSpeedKmh = 22): number {
  return Math.max(1, Math.round((km / Math.max(avgSpeedKmh, 5)) * 60));
}

/** Redondeo amable para cobrar: COP a la centena; otras monedas a 2 decimales. */
export function roundMoney(value: number, currency = 'COP'): number {
  if (currency === 'COP') return Math.round(value / 100) * 100;
  return Math.round(value * 100) / 100;
}

export interface DeliveryQuote {
  covered: boolean;
  km: number | null;
  fee: number | null;
  travelMinutes: number | null;
  etaMinutes: number | null; // preparación + viaje
  reason?: string;
}

/** Cotiza un domicilio: cobertura, costo y tiempo estimado. */
export function quoteDelivery(
  cfg: DeliveryConfig | undefined,
  destination: LatLng | null,
  subtotal = 0,
  currency = 'COP',
): DeliveryQuote {
  const empty = { km: null, fee: null, travelMinutes: null, etaMinutes: null };
  if (!cfg?.enabled) {
    return { covered: false, ...empty, reason: 'El negocio no tiene domicilios configurados' };
  }
  if (!isLatLng(cfg.origin)) {
    return { covered: false, ...empty, reason: 'Falta la ubicación del punto de despacho' };
  }
  if (!destination || !isLatLng(destination)) {
    return { covered: false, ...empty, reason: 'No tengo la ubicación de la dirección' };
  }
  const km = roadKm(cfg.origin as LatLng, destination, cfg.roadFactor ?? 1.35);
  const minutes = travelMinutes(km, cfg.avgSpeedKmh ?? 22);
  const etaMinutes = minutes + Number(cfg.prepMinutes ?? 25);
  if (cfg.maxKm && km > cfg.maxKm) {
    return {
      covered: false, km, fee: null, travelMinutes: minutes, etaMinutes,
      reason: `Queda a ${km} km y la cobertura llega hasta ${cfg.maxKm} km`,
    };
  }
  let fee = Number(cfg.baseFee ?? 0) + Number(cfg.perKm ?? 0) * km;
  if (cfg.minFee) fee = Math.max(fee, Number(cfg.minFee));
  if (cfg.freeFromSubtotal && subtotal >= Number(cfg.freeFromSubtotal)) fee = 0;
  return { covered: true, km, fee: roundMoney(fee, currency), travelMinutes: minutes, etaMinutes };
}

/* ─── Geocodificación (dirección en texto → coordenadas) ─────────────── */

const logger = new Logger('Geo');

/**
 * Google Geocoding si hay GOOGLE_MAPS_API_KEY; si no, OpenStreetMap
 * (Nominatim, uso moderado y con User-Agent identificable). Nunca lanza:
 * si falla devuelve null y el agente pide la ubicación por WhatsApp.
 */
export async function geocodeAddress(
  address: string,
  opts: { city?: string | null; country?: string | null } = {},
): Promise<(LatLng & { formatted: string }) | null> {
  const query = [address, opts.city, opts.country ?? 'Colombia'].filter(Boolean).join(', ');
  if (!address?.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const googleKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    if (googleKey) {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${googleKey}&language=es`;
      const res = await fetch(url, { signal: controller.signal });
      const data: any = await res.json();
      const hit = data?.results?.[0];
      if (!hit) return null;
      return {
        lat: hit.geometry.location.lat,
        lng: hit.geometry.location.lng,
        formatted: hit.formatted_address,
      };
    }
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'BackOffice-Platform/1.0 (domicilios)', 'Accept-Language': 'es' },
    });
    const data: any = await res.json();
    const hit = Array.isArray(data) ? data[0] : null;
    if (!hit) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon), formatted: hit.display_name };
  } catch (err: any) {
    logger.warn(`geocodificación falló (${query.slice(0, 60)}): ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
