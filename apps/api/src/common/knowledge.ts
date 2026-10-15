import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Base de conocimiento: fragmentación + búsqueda por relevancia (BM25 liviano,
 * sin embeddings ni servicios externos) + ingesta segura de páginas web.
 */

const STOPWORDS = new Set(
  ('de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si porque esta ' +
    'entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese ' +
    'eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho quienes nada muchos cual ' +
    'poco ella estar estas algunas algo nosotros tu te ti es son fue ser tiene tienen hace cuanto cual como cuales the and').split(' '),
);

export function normalizeText(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Fragmentos de ~maxChars respetando párrafos y frases. */
export function chunkText(text: string, maxChars = 900): string[] {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      push();
      const sentences = p.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if ((current + ' ' + s).length > maxChars) push();
        current = current ? `${current} ${s}` : s;
        if (current.length > maxChars) {
          // frase gigante sin puntos: corte duro
          for (let i = 0; i < current.length; i += maxChars) chunks.push(current.slice(i, i + maxChars));
          current = '';
        }
      }
      push();
    } else {
      if ((current + '\n\n' + p).length > maxChars) push();
      current = current ? `${current}\n\n${p}` : p;
    }
  }
  push();
  return chunks.slice(0, 500);
}

/** Ranking BM25 sobre los fragmentos de la empresa. */
export function searchChunks<T extends { text: string }>(chunks: T[], query: string, top = 3): Array<T & { score: number }> {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => tokenize(c.text));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const term of q) df.set(term, docs.filter((d) => d.includes(term)).length);
  const k1 = 1.4;
  const b = 0.75;
  const scored = chunks.map((chunk, i) => {
    const d = docs[i];
    let score = 0;
    for (const term of q) {
      const tf = d.filter((w) => w === term).length;
      if (!tf) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgLen)));
    }
    return { ...chunk, score };
  });
  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, top);
}

/* ─── Ingesta de páginas web (protección SSRF) ─────────────────────── */

function isPrivateAddress(ip: string): boolean {
  if (ip === '::1' || ip === '0.0.0.0') return true;
  if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
  if (isIP(ip) === 6) return /^(fc|fd|fe80)/i.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('URL inválida');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Solo se permiten páginas http(s)');
  if (url.username || url.password) throw new Error('La URL no puede llevar credenciales');
  const host = url.hostname;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('No se permiten direcciones internas');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new Error('No se permiten direcciones internas');
  return url;
}

export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ' };
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#?\w+);/g, (m, e) => entities[e.toLowerCase()] ?? (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Descarga una página pública (máx. 2 MB, 10 s, redirecciones revalidadas). */
export async function fetchPublicPage(raw: string, fetchImpl: typeof fetch = fetch): Promise<{ title: string; text: string }> {
  let url = await assertPublicUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'BackOffice-Knowledge/1.0', Accept: 'text/html,text/plain' },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirección sin destino');
        url = await assertPublicUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`La página respondió ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (!/text\/(html|plain)/.test(type)) throw new Error('La página no es texto ni HTML');
      const body = await res.text();
      if (body.length > 2_000_000) throw new Error('La página es demasiado grande');
      const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim() ?? url.hostname;
      return { title, text: type.includes('html') ? htmlToText(body) : body };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Demasiadas redirecciones');
}
