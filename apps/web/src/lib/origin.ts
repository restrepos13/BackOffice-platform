/**
 * De dónde llegó la visita (utm_*, ?g= de grupos de Facebook por ciudad, fbclid
 * de Meta y el sitio que la trajo). Se captura al llegar a CUALQUIER página y
 * se conserva 30 días en este navegador, así la fuente no se pierde aunque la
 * persona pase por la portada antes de registrarse. El servidor guarda el
 * primer toque de cada registro y no lo reemplaza.
 */

export interface VisitOrigin {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmId?: string;
  fbclid?: string;
  /** Grupo de Facebook por ciudad (?g=manizales) */
  g?: string;
  /** Sitio externo que la trajo (Google, Instagram…); navegar dentro de la web no cuenta */
  referrer?: string;
  landingPath?: string;
}

const KEY = 'bo_origin';
const LEGACY_KEY = 'bo_utm';
const TTL_MS = 30 * 86400e3;

const PARAMS: Array<[string, keyof VisitOrigin, number]> = [
  ['utm_source', 'utmSource', 120], ['utm_medium', 'utmMedium', 120], ['utm_campaign', 'utmCampaign', 120],
  ['utm_content', 'utmContent', 120], ['utm_id', 'utmId', 120], ['fbclid', 'fbclid', 255],
];

const OWN_SITE = /(^|\.)backoffice\.store$|^localhost$|^127\.0\.0\.1$|\.vercel\.app$|\.onrender\.com$/i;

/** El referrer solo cuenta si es otro sitio. */
export function externalReferrer(ref: string): string | undefined {
  try {
    const u = new URL(ref);
    return OWN_SITE.test(u.hostname) ? undefined : `${u.protocol}//${u.hostname}${u.pathname}`.slice(0, 200);
  } catch {
    return undefined;
  }
}

function read(now: number): VisitOrigin | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const { at, ...o } = JSON.parse(raw) as VisitOrigin & { at?: number };
      if (at && now - at < TTL_MS) return o;
    }
    // Registros que empezaron antes de este cambio (sessionStorage)
    const legacy = sessionStorage.getItem(LEGACY_KEY);
    return legacy ? (JSON.parse(legacy) as VisitOrigin) : null;
  } catch {
    return null;
  }
}

function write(o: VisitOrigin, now: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...o, at: now }));
  } catch {
    /* sin almacenamiento: igual se manda en esta página */
  }
}

/**
 * Lee la URL actual: si trae parámetros de campaña, es un toque nuevo y se
 * guarda; si no, se devuelve lo guardado. Los valores sin reemplazar de Meta
 * ({{ad.name}}) se descartan.
 */
export function captureOrigin(
  search = typeof window !== 'undefined' ? window.location.search : '',
  path = typeof window !== 'undefined' ? window.location.pathname : '',
  referrer = typeof document !== 'undefined' ? document.referrer : '',
  now = Date.now(),
): VisitOrigin {
  let qs: URLSearchParams;
  try {
    qs = new URLSearchParams(search);
  } catch {
    return {};
  }
  const fresh: VisitOrigin = {};
  for (const [param, key, max] of PARAMS) {
    const v = qs.get(param)?.trim();
    if (v && !/\{\{.*\}\}/.test(v)) (fresh as Record<string, string>)[key] = v.slice(0, max);
  }
  const g = qs.get('g')?.trim().toLowerCase();
  if (g && /^[a-z0-9-]{1,40}$/.test(g)) fresh.g = g;
  const ext = referrer ? externalReferrer(referrer) : undefined;
  const saved = read(now);
  if (Object.keys(fresh).length) {
    const o: VisitOrigin = { ...fresh, ...(ext ? { referrer: ext } : {}), landingPath: `${path}${search}`.slice(0, 200) };
    write(o, now);
    return o;
  }
  if (saved) return saved;
  // Sin campaña: si vino de otro sitio (Google, Instagram…) se recuerda eso
  if (ext) {
    const o: VisitOrigin = { referrer: ext, landingPath: path.slice(0, 200) };
    write(o, now);
    return o;
  }
  return {};
}
