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
  /** KM = base + por kilómetro · ZONES = tarifa fija por barrio/zona */
  pricingMode?: 'KM' | 'ZONES';
  zones?: DeliveryZone[];
  /** En ZONES: si el barrio no está en ninguna zona, cobrar por km (si hay ubicación) */
  zonesFallbackKm?: boolean;
  /** Asignar solo el domiciliario más cercano y libre cuando el pedido queda listo */
  autoAssign?: boolean;
  /** Alerta si un pedido en ruta pasa su hora estimada por más de N minutos */
  delayAlertMinutes?: number;
  /** Alerta si un pedido listo lleva N minutos sin domiciliario */
  unassignedAlertMinutes?: number;
  /** Avisar al cliente por WhatsApp cuando su pedido viene retrasado */
  notifyDelayToCustomer?: boolean;
}

export interface DeliveryZone {
  name: string;
  fee: number;
  /** Barrios o palabras que identifican la zona en la dirección */
  keywords: string[];
}

function normalizeAddress(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

/** Zona a la que pertenece una dirección (por barrio / palabra clave). */
export function matchZone(zones: DeliveryZone[] | undefined, addressText: string | null | undefined): DeliveryZone | null {
  if (!zones?.length || !addressText) return null;
  const address = normalizeAddress(addressText);
  for (const zone of zones) {
    for (const keyword of zone.keywords ?? []) {
      const k = normalizeAddress(String(keyword)).trim();
      if (k.length >= 3 && new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(address)) {
        return zone;
      }
    }
  }
  return null;
}

/** Sucursal activa más cercana al destino (o null si no hay sucursales). */
export function nearestBranch<T extends { lat: number; lng: number; active?: boolean }>(branches: T[], dest: LatLng | null): T | null {
  const active = branches.filter((b) => b.active !== false && isLatLng(b));
  if (!active.length) return null;
  if (!dest) return active[0];
  return active.reduce((best, b) => (haversineKm(b, dest) < haversineKm(best, dest) ? b : best));
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
  zone?: string | null;
}

/**
 * Cotiza un domicilio: cobertura, costo y tiempo estimado.
 * Origen: la sucursal que despacha (opts.origin) o el punto de despacho.
 * Precio: por km, o tarifa fija por zona/barrio (con km de respaldo opcional).
 */
export function quoteDelivery(
  cfg: DeliveryConfig | undefined,
  destination: LatLng | null,
  subtotal = 0,
  currency = 'COP',
  opts: { addressText?: string | null; origin?: LatLng | null } = {},
): DeliveryQuote {
  const empty = { km: null, fee: null, travelMinutes: null, etaMinutes: null };
  if (!cfg?.enabled) {
    return { covered: false, ...empty, reason: 'El negocio no tiene domicilios configurados' };
  }
  const origin = opts.origin && isLatLng(opts.origin) ? opts.origin : isLatLng(cfg.origin) ? (cfg.origin as LatLng) : null;
  const prep = Number(cfg.prepMinutes ?? 25);
  const hasDest = !!destination && isLatLng(destination);
  const km = origin && hasDest ? roadKm(origin, destination!, cfg.roadFactor ?? 1.35) : null;
  const minutes = km != null ? travelMinutes(km, cfg.avgSpeedKmh ?? 22) : null;
  const etaMinutes = minutes != null ? minutes + prep : null;
  const finish = (fee: number, zone: string | null = null): DeliveryQuote => {
    let value = fee;
    if (cfg.minFee && cfg.pricingMode !== 'ZONES') value = Math.max(value, Number(cfg.minFee));
    if (cfg.freeFromSubtotal && subtotal >= Number(cfg.freeFromSubtotal)) value = 0;
    return { covered: true, km, fee: roundMoney(value, currency), travelMinutes: minutes, etaMinutes: etaMinutes ?? prep + 30, zone };
  };

  if (cfg.pricingMode === 'ZONES') {
    const zone = matchZone(cfg.zones, opts.addressText);
    if (zone) return finish(Number(zone.fee), zone.name);
    if (!(cfg.zonesFallbackKm && km != null)) {
      return { covered: false, km, fee: null, travelMinutes: minutes, etaMinutes, reason: 'La dirección no está en ninguna de las zonas de entrega' };
    }
  }
  if (!origin) {
    return { covered: false, ...empty, reason: 'Falta la ubicación del punto de despacho' };
  }
  if (!hasDest || km == null) {
    return { covered: false, ...empty, reason: 'No tengo la ubicación de la dirección' };
  }
  if (cfg.maxKm && km > cfg.maxKm) {
    return {
      covered: false, km, fee: null, travelMinutes: minutes, etaMinutes,
      reason: `Queda a ${km} km y la cobertura llega hasta ${cfg.maxKm} km`,
    };
  }
  return finish(Number(cfg.baseFee ?? 0) + Number(cfg.perKm ?? 0) * km);
}

/**
 * Orden sugerido de entregas (vecino más cercano desde donde está el
 * domiciliario): suficiente para 3-10 paradas sin un optimizador externo.
 */
export function suggestRoute<T extends { lat: number | null; lng: number | null }>(start: LatLng | null, stops: T[]): T[] {
  const located = stops.filter((s) => isLatLng(s));
  const rest = stops.filter((s) => !isLatLng(s));
  if (!start || located.length < 2) return [...located, ...rest];
  const route: T[] = [];
  let current: LatLng = start;
  const pending = [...located];
  while (pending.length) {
    let bestIdx = 0;
    for (let i = 1; i < pending.length; i++) {
      if (haversineKm(current, pending[i] as any) < haversineKm(current, pending[bestIdx] as any)) bestIdx = i;
    }
    const [next] = pending.splice(bestIdx, 1);
    route.push(next);
    current = next as any;
  }
  return [...route, ...rest];
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

/**
 * Asignación automática: entre los domiciliarios en turno con señal reciente,
 * el de MENOS pedidos activos; a igual carga, el más cercano al punto de
 * despacho. Sin señal reciente no se asigna (mejor un humano que un error).
 */
export function pickCourier<T extends { id: string; onShift?: boolean; lastLat?: number | null; lastLng?: number | null; lastLocAt?: Date | string | null }>(
  couriers: T[],
  loads: Map<string, number>,
  origin: LatLng | null,
  now = new Date(),
  maxSignalAgeMs = 15 * 60e3,
): T | null {
  const ready = couriers.filter((c) =>
    c.onShift && c.lastLocAt && now.getTime() - new Date(c.lastLocAt).getTime() <= maxSignalAgeMs);
  if (!ready.length) return null;
  const distance = (c: T) =>
    origin && isLatLng({ lat: c.lastLat, lng: c.lastLng }) ? haversineKm(origin, { lat: Number(c.lastLat), lng: Number(c.lastLng) }) : 999;
  return [...ready].sort((a, b) => (loads.get(a.id) ?? 0) - (loads.get(b.id) ?? 0) || distance(a) - distance(b))[0];
}
