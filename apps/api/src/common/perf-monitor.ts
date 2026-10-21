import { randomBytes } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';

/**
 * Medidor interno del servidor (sin servicios externos): tiempo de cada
 * petición, errores 5xx, memoria y retraso del event loop. Guarda minutos en
 * un anillo de 60 y responde percentiles de la última hora. El vigilante de
 * salud lo fotografía cada 10 minutos para el historial de 30 días.
 */

/** Identifica este arranque: varios en 24 h = el servidor se reinició o se durmió. */
export const BOOT_ID = randomBytes(6).toString('hex');
export const BOOTED_AT = new Date();

interface Minute { at: number; durations: number[]; count: number; errors: number }

const MAX_SAMPLES_PER_MINUTE = 600;
const ring: Minute[] = [];
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

function bucket(now = Date.now()): Minute {
  const at = Math.floor(now / 60_000) * 60_000;
  let last = ring[ring.length - 1];
  if (!last || last.at !== at) {
    last = { at, durations: [], count: 0, errors: 0 };
    ring.push(last);
    while (ring.length > 60) ring.shift();
  }
  return last;
}

/** Registra una petición terminada. */
export function recordRequest(ms: number, status: number, now = Date.now()) {
  const b = bucket(now);
  b.count++;
  if (status >= 500) b.errors++;
  // Muestreo uniforme si hay mucho tráfico en el minuto
  if (b.durations.length < MAX_SAMPLES_PER_MINUTE) b.durations.push(ms);
  else b.durations[Math.floor(Math.random() * MAX_SAMPLES_PER_MINUTE)] = ms;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

export interface PerfSnapshot {
  windowMin: number;
  requests: number;
  errors5xx: number;
  p50Ms: number | null;
  p95Ms: number | null;
  rssMb: number;
  heapMb: number;
  loopP95Ms: number;
  uptimeMin: number;
  bootId: string;
}

/** Resumen de los últimos `minutes` minutos. */
export function perfSnapshot(minutes = 60, now = Date.now()): PerfSnapshot {
  const since = now - minutes * 60_000;
  const recent = ring.filter((m) => m.at >= since);
  const durations = recent.flatMap((m) => m.durations);
  const mem = process.memoryUsage();
  const snap: PerfSnapshot = {
    windowMin: minutes,
    requests: recent.reduce((n, m) => n + m.count, 0),
    errors5xx: recent.reduce((n, m) => n + m.errors, 0),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    rssMb: Math.round(mem.rss / 1048576),
    heapMb: Math.round(mem.heapUsed / 1048576),
    loopP95Ms: Math.round(loop.percentile(95) / 1e6),
    uptimeMin: Math.round(process.uptime() / 60),
    bootId: BOOT_ID,
  };
  return snap;
}

/** Reinicia la medición del event loop (cada foto mide su propio tramo). */
export function resetLoopMeter() {
  loop.reset();
}

/** Middleware de Express: mide todo /api menos el ping de salud. */
export function perfMiddleware(req: any, res: any, next: () => void) {
  const url: string = req.originalUrl ?? req.url ?? '';
  if (!url.startsWith('/api') || url.startsWith('/api/health')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    recordRequest(Number(process.hrtime.bigint() - start) / 1e6, res.statusCode);
  });
  next();
}

/** Solo para tests. */
export function resetPerf() {
  ring.length = 0;
}
