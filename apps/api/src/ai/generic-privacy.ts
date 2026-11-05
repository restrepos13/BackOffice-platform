import type { ChatMessage } from './types';

/**
 * Privacidad de la IA GENÉRICA (Gemini, Groq, Cerebras, OpenRouter gratis).
 * Los planes gratis de esos proveedores pueden usar lo que reciben para
 * entrenar modelos, así que:
 *  1. Solo reciben descripciones del negocio, productos, métricas agregadas y
 *     textos de marketing. NUNCA conversaciones de WhatsApp, datos de clientes
 *     finales ni credenciales (eso va por la IA de cada empresa: DeepInfra).
 *  2. Aun así, TODO lo que se les manda pasa por sanitizeForGenericAi: quita
 *     teléfonos, correos, documentos (NIT, cédula…), llaves o contraseñas y
 *     los nombres de contactos conocidos que pase quien llama.
 * GeminiPool.tryEntry lo aplica a cada mensaje: no hay forma de saltárselo.
 */

const PLACEHOLDER = {
  phone: '[teléfono]',
  email: '[correo]',
  doc: '[documento]',
  secret: '[credencial]',
  contact: '[contacto]',
};

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** Documento con su palabra clave: NIT, C.C., cédula, T.I., C.E., pasaporte, RUT… */
const DOC_WITH_KEYWORD = /\b(nit|rut|c\.\s?c\.?|cc|c[eé]dula(?:\s+de\s+(?:ciudadan[ií]a|extranjer[ií]a))?|t\.\s?i\.?|tarjeta\s+de\s+identidad|c\.\s?e\.?|pasaporte|documento(?:\s+de\s+identidad)?|identificaci[oó]n)(\s*(?:n[oº°]\.?|n[uú]mero|#)?\s*[:.#]?\s*)[A-Z]{0,2}\d[\d.\s-]{3,}\d(?:\s?-\s?\d)?/giu;
/** NIT con su formato típico, aunque no diga "NIT": 900.123.456-7 */
const NIT_SHAPE = /(?<![\d.])\d{3}\.?\d{3}\.?\d{3}\s?-\s?\d(?![\d])/g;

/** Llaves y contraseñas: formatos conocidos de proveedores y "clave: xxx". */
const SECRETS: RegExp[] = [
  /\b(?:sk|pk|rk)-(?:or-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bEAA[A-Za-z0-9]{20,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bcsk-[A-Za-z0-9]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const SECRET_LABELED = /\b(contrase[ñn]a|password|passwd|clave|pin|token|api[\s_-]?key|secret[oa]?|usuario\s+y\s+clave)(\s*(?:es|:|=)\s*)\S+/giu;
/** Cadenas largas con letras y números mezclados (tokens sin formato conocido). */
const LONG_TOKEN = /(?<![\p{L}\p{N}/._-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![\p{L}\p{N}])/gu;

/** Secuencias que PUEDEN ser teléfonos; luego se decide con sus dígitos. */
const PHONE_CANDIDATE = /(?<![\p{L}\p{N}$.,])\+?\(?\d[\d\s().-]{5,18}\d(?![\p{L}\p{N}])/gu;
const PRICE_GROUPS = /^\d{1,3}(?:[.,]\d{3})+$/;

function looksLikePhone(raw: string): boolean {
  const s = raw.trim();
  const digits = s.replace(/\D/g, '');
  if (PRICE_GROUPS.test(s)) return false; // 1.250.000 es un precio
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15;
  if (digits.length >= 10 && digits.length <= 13) return true; // celular (3xx…), fijo con indicativo, con 57
  // Fijo de 7 dígitos con separadores: 444 12 34 · 444-1234
  return digits.length === 7 && /^\d{3}[\s-]\d{2}[\s-]?\d{2}$|^\d{3}[\s-]\d{4}$/.test(s);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Nombres a buscar: el completo y, si son de varias palabras, cada palabra de 4+ letras. */
function nameVariants(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const full = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (full.length < 3 || /^\d+$/.test(full)) continue;
    out.add(full);
    const parts = full.split(' ').filter((p) => p.length >= 4);
    if (parts.length > 1) for (const p of parts) out.add(p);
  }
  // Primero los más largos: "Ana María Pérez" antes que "María"
  return [...out].sort((a, b) => b.length - a.length).slice(0, 2000);
}

/** Reemplaza nombres sin importar mayúsculas ni tildes, solo palabras completas. */
function redactNames(text: string, names: string[]): string {
  const variants = nameVariants(names);
  if (!variants.length) return text;
  const folded = fold(text);
  // Se busca sobre el texto sin tildes y se recorta en las mismas posiciones (la longitud no cambia)
  const marks: Array<[number, number]> = [];
  for (const v of variants) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(fold(v))}(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of folded.matchAll(re)) {
      const start = m.index!;
      const end = start + m[0].length;
      if (!marks.some(([a, b]) => start < b && end > a)) marks.push([start, end]);
    }
  }
  if (!marks.length) return text;
  marks.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [a, b] of marks) out = `${out.slice(0, a)}${PLACEHOLDER.contact}${out.slice(b)}`;
  return out;
}

export interface SanitizeOptions {
  /** Nombres de contactos o clientes conocidos de la empresa */
  names?: string[];
}

/**
 * Deja un texto listo para la IA genérica: sin teléfonos, correos, documentos,
 * credenciales ni nombres de contactos conocidos. Los precios y cantidades se
 * conservan (60.000, $28.000, 5000 no son teléfonos).
 */
export function sanitizeForGenericAi(text: string, opts: SanitizeOptions = {}): string {
  if (!text) return text ?? '';
  // NFC: el mismo texto puede llegar con tildes "partidas" y los nombres no coincidirían
  let out = String(text).normalize('NFC');
  for (const re of SECRETS) out = out.replace(re, PLACEHOLDER.secret);
  out = out.replace(SECRET_LABELED, (_m, label: string, sep: string) => `${label}${sep}${PLACEHOLDER.secret}`);
  out = out.replace(EMAIL, PLACEHOLDER.email);
  out = out.replace(DOC_WITH_KEYWORD, (_m, label: string, sep: string) => `${label}${sep}${PLACEHOLDER.doc}`);
  out = out.replace(NIT_SHAPE, PLACEHOLDER.doc);
  out = out.replace(LONG_TOKEN, PLACEHOLDER.secret);
  out = out.replace(PHONE_CANDIDATE, (m) => (looksLikePhone(m) ? PLACEHOLDER.phone : m));
  if (opts.names?.length) out = redactNames(out, opts.names);
  return out;
}

/** Cada mensaje (texto o partes de texto) pasa por el sanitizador; las imágenes no viajan a la cadena genérica. */
export function sanitizeMessages(messages: ChatMessage[], opts: SanitizeOptions = {}): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { ...m, content: sanitizeForGenericAi(m.content, opts) };
    if (Array.isArray(m.content)) {
      const text = m.content
        .map((p: any) => (p?.type === 'text' ? sanitizeForGenericAi(String(p.text ?? ''), opts) : ''))
        .filter(Boolean)
        .join('\n');
      return { ...m, content: text } as ChatMessage;
    }
    return m;
  });
}
