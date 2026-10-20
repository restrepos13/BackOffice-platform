/**
 * TRM en vivo (pesos por dólar) para todo lo que se cobra en dólares: IA,
 * Meta/Twilio, paquetes y facturas en USD.
 *
 * Fuente principal: TRM oficial vigente de la Superfinanciera (datos.gov.co),
 * cambia cada día hábil. Si no responde, el dólar de mercado del momento
 * (open.er-api, luego Coinbase). Se refresca cada 15 minutos y a la base
 * SIEMPRE se le suman $20 (TRM_MARKUP_COP, editable por devs).
 *
 * Si no hay internet se usa la última cotización buena guardada (TRM_LAST) y,
 * en último caso, la TRM de respaldo que escriben los devs (USD_COP_RATE).
 */

export const DEFAULT_TRM_MARKUP_COP = 20;
const REFRESH_MS = 15 * 60_000;
const FALLBACK_RATE = 4000;

export interface TrmQuote {
  /** TRM oficial vigente hoy (null si no se pudo leer). */
  official: number | null;
  /** Fecha de vigencia de la TRM oficial (AAAA-MM-DD). */
  officialDate: string | null;
  /** Dólar de mercado en este momento (referencia). */
  market: number | null;
  /** Base usada: oficial, o mercado si la oficial no respondió. */
  base: number;
  markup: number;
  /** Lo que se usa para cobrar: base + markup. */
  rate: number;
  source: 'OFICIAL' | 'MERCADO' | 'GUARDADA' | 'RESPALDO';
  fetchedAt: string;
}

type Fetch = typeof fetch;
let cache: { quote: TrmQuote; at: number } | null = null;
let inflight: Promise<TrmQuote> | null = null;

const round2 = (n: number) => Math.round(n * 100) / 100;
const sane = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 1000 && n < 20000 ? n : null);

async function getJson(fetchImpl: Fetch, url: string): Promise<any> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(6000) } as any);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** TRM oficial vigente hoy en Bogotá (la de mañana ya se publica antes: se ignora). */
export async function fetchOfficialTrm(fetchImpl: Fetch, now = new Date()): Promise<{ rate: number; date: string } | null> {
  const rows = await getJson(fetchImpl, 'https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=5');
  const today = new Date(now.getTime() - 5 * 3600e3).toISOString().slice(0, 10); // America/Bogota (UTC-5, sin horario de verano)
  for (const r of Array.isArray(rows) ? rows : []) {
    const from = String(r.vigenciadesde ?? '').slice(0, 10);
    const to = String(r.vigenciahasta ?? from).slice(0, 10);
    const rate = sane(Number(r.valor));
    if (rate && from <= today && today <= to) return { rate, date: from };
  }
  // Fin de semana o festivo sin fila exacta: la más reciente que ya empezó
  const started = (Array.isArray(rows) ? rows : []).find((r: any) => String(r.vigenciadesde ?? '').slice(0, 10) <= today && sane(Number(r.valor)));
  return started ? { rate: Number(started.valor), date: String(started.vigenciadesde).slice(0, 10) } : null;
}

export async function fetchMarketRate(fetchImpl: Fetch): Promise<number | null> {
  try {
    const d = await getJson(fetchImpl, 'https://open.er-api.com/v6/latest/USD');
    const r = sane(Number(d?.rates?.COP));
    if (r) return r;
  } catch { /* siguiente fuente */ }
  try {
    const d = await getJson(fetchImpl, 'https://api.coinbase.com/v2/exchange-rates?currency=USD');
    return sane(Number(d?.data?.rates?.COP));
  } catch {
    return null;
  }
}

async function setting(prisma: any, key: string): Promise<string | null> {
  try {
    return (await prisma.platformSetting.findUnique({ where: { key } }))?.value ?? null;
  } catch {
    return null;
  }
}

export async function trmMarkup(prisma: any): Promise<number> {
  const raw = await setting(prisma, 'TRM_MARKUP_COP');
  const n = raw == null || raw === '' ? DEFAULT_TRM_MARKUP_COP : Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 500 ? n : DEFAULT_TRM_MARKUP_COP;
}

/** Cotización actual (cacheada 15 min). `force` ignora la caché. */
export async function currentTrm(prisma: any, opts: { fetchImpl?: Fetch; force?: boolean; now?: Date } = {}): Promise<TrmQuote> {
  if (!opts.force && cache && Date.now() - cache.at < REFRESH_MS) {
    // El margen puede cambiar en Dev Tools: se aplica siempre al día
    const markup = await trmMarkup(prisma);
    return { ...cache.quote, markup, rate: round2(cache.quote.base + markup) };
  }
  if (inflight && !opts.force) return inflight;
  inflight = refresh(prisma, opts).finally(() => { inflight = null; });
  return inflight;
}

async function refresh(prisma: any, opts: { fetchImpl?: Fetch; now?: Date }): Promise<TrmQuote> {
  const markup = await trmMarkup(prisma);
  const now = opts.now ?? new Date();
  // En tests no se sale a internet salvo que el test pase su propio fetch
  const fetchImpl = opts.fetchImpl ?? (process.env.JEST_WORKER_ID ? null : fetch);
  let official: { rate: number; date: string } | null = null;
  let market: number | null = null;
  if (fetchImpl) {
    [official, market] = await Promise.all([
      fetchOfficialTrm(fetchImpl, now).catch(() => null),
      fetchMarketRate(fetchImpl).catch(() => null),
    ]);
  }
  let quote: TrmQuote | null = null;
  if (official || market) {
    const base = official?.rate ?? market!;
    quote = {
      official: official?.rate ?? null, officialDate: official?.date ?? null, market,
      base, markup, rate: round2(base + markup), source: official ? 'OFICIAL' : 'MERCADO', fetchedAt: now.toISOString(),
    };
    try {
      await prisma.platformSetting.upsert({ where: { key: 'TRM_LAST' }, create: { key: 'TRM_LAST', value: JSON.stringify(quote) }, update: { value: JSON.stringify(quote) } });
    } catch { /* no bloquea */ }
  } else {
    const raw = await setting(prisma, 'TRM_LAST');
    const saved = raw ? (() => { try { return JSON.parse(raw) as TrmQuote; } catch { return null; } })() : null;
    if (saved && sane(saved.base)) {
      quote = { ...saved, markup, rate: round2(saved.base + markup), source: 'GUARDADA' };
    } else {
      const manual = sane(Number(await setting(prisma, 'USD_COP_RATE'))) ?? FALLBACK_RATE;
      quote = { official: null, officialDate: null, market: null, base: manual, markup, rate: round2(manual + markup), source: 'RESPALDO', fetchedAt: now.toISOString() };
    }
  }
  // Sin conexión se reintenta al minuto, no a los 15
  cache = { quote, at: quote.source === 'OFICIAL' || quote.source === 'MERCADO' ? Date.now() : Date.now() - REFRESH_MS + 60_000 };
  return quote;
}

/** Atajo: pesos por dólar para cobrar (TRM + margen). */
export async function usdCopRate(prisma: any): Promise<number> {
  return (await currentTrm(prisma)).rate;
}

/** Solo para tests. */
export function resetTrmCache() {
  cache = null;
  inflight = null;
}
