/**
 * «Pega el link de tu Instagram o tu web (opcional)» del registro.
 *
 * - Instagram, Facebook y TikTok no se leen (piden iniciar sesión): se guarda
 *   el usuario para que el equipo lo vea y la IA solo sabe que existe.
 * - Una web propia sí: se lee el título y la descripción (nada más) para que la
 *   IA saque de ahí el rubro y lo que vende.
 *
 * Seguridad: es una petición que el servidor hace a una URL que escribe un
 * visitante. Solo https, sin IPs escritas, el nombre debe resolver a
 * direcciones públicas, sin seguir redirecciones, 4 s y 300 KB como máximo.
 */
import { lookup } from 'dns/promises';
import { isIP } from 'net';

const SOCIAL: Array<[RegExp, string]> = [
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/i, 'Facebook'],
  [/(^|\.)tiktok\.com$/i, 'TikTok'],
];

export interface PeekResult {
  /** Lo que se guarda y ve el equipo (link normalizado o @usuario) */
  link: string;
  kind: 'social' | 'web';
  network?: string;
  handle?: string;
  title?: string;
  description?: string;
}

/** Texto del visitante → URL https (acepta «@usuario» como Instagram). */
export function normalizeLink(raw: unknown): URL | null {
  let text = String(raw ?? '').trim().slice(0, 200);
  if (!text) return null;
  if (/^@[\w.]{2,30}$/.test(text)) text = `https://instagram.com/${text.slice(1)}`;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const u = new URL(text);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.') || u.username || u.password) return null;
    u.protocol = 'https:';
    u.port = '';
    return u;
  } catch {
    return null;
  }
}

/** ¿Es una dirección privada, local o reservada? (no se le pide nada) */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

function meta(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']{1,400})["']|<meta[^>]+content=["']([^"']{1,400})["'][^>]*(?:name|property)=["']${name}["']`, 'i');
  const m = html.match(re);
  return (m?.[1] ?? m?.[2])?.trim();
}

const decode = (s?: string) => s?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export async function peekLink(raw: unknown, fetchImpl: typeof fetch = fetch, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<PeekResult | null> {
  const u = normalizeLink(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const social = SOCIAL.find(([re]) => re.test(host));
  if (social) {
    const handle = u.pathname.split('/').filter(Boolean)[0];
    return { link: `${host.replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, '').slice(0, 120), kind: 'social', network: social[1], ...(handle ? { handle: `@${handle.slice(0, 40)}` } : {}) };
  }
  const base: PeekResult = { link: `${host}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 120), kind: 'web' };
  if (isIP(host)) return base;
  try {
    const addresses = await resolve(host);
    if (!addresses.length || addresses.some(privateAddress)) return base;
    const res = await fetchImpl(u.toString(), {
      redirect: 'manual',
      headers: { 'User-Agent': 'BackOfficeBot/1.0 (+https://www.backoffice.store)', Accept: 'text/html' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') ?? '') || !res.body) return base;
    // Solo el comienzo de la página (ahí están el título y la descripción)
    const reader = res.body.getReader();
    let html = '';
    const decoder = new TextDecoder();
    while (html.length < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    void reader.cancel().catch(() => undefined);
    const title = decode(meta(html, 'og:title') ?? html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]);
    const description = decode(meta(html, 'og:description') ?? meta(html, 'description'));
    return { ...base, ...(title ? { title: title.slice(0, 160) } : {}), ...(description ? { description: description.slice(0, 300) } : {}) };
  } catch {
    return base;
  }
}

/** Línea para la conversación que lee la IA. */
export function peekLine(p: PeekResult | null): string {
  if (!p) return '';
  if (p.kind === 'social') return `Su ${p.network}: ${p.handle ?? p.link} (no se pudo leer; no inventes nada de ahí).`;
  if (!p.title && !p.description) return `Su web: ${p.link} (no se pudo leer).`;
  return `Lo que dice su web (${p.link}): ${[p.title, p.description].filter(Boolean).join(' — ')}`;
}
