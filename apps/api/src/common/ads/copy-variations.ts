import type { ChatMessage } from '../../ai/types';
import { CLIENT_CTAS } from './client-launch';
import { LIMITS } from './launch';

/**
 * Variaciones de copy para anuncios de Meta (titular, texto principal,
 * descripción y botón). Funciones puras: límites, validación de lo que
 * devuelve la IA e instrucción. El servicio (modules/creative-copy.ts) decide
 * con qué IA se piden y les pasa el chequeo de políticas.
 */

/**
 * Lo que Meta muestra completo en el celular (más largo, se corta con «Ver
 * más»). Las sugerencias SIEMPRE caben aquí; nunca pasan de los máximos duros
 * de Meta que valida el lanzador (LIMITS).
 */
export const COPY_LIMITS = {
  headline: { min: 3, max: Math.min(40, LIMITS.headline) },
  primaryText: { min: 20, max: Math.min(125, LIMITS.primaryText) },
  description: { min: 3, max: Math.min(30, LIMITS.description) },
} as const;

export type CopyDestination = 'WHATSAPP' | 'WEBSITE';

/** Botones permitidos por Meta para cada destino (los mismos que usa el lanzador). */
export const META_CTAS: Record<CopyDestination, Record<string, string>> = {
  WHATSAPP: { WHATSAPP_MESSAGE: 'Enviar mensaje' },
  WEBSITE: CLIENT_CTAS,
};

export interface CopyVariation {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  ctaLabel: string;
  /** En qué se apoya (precio, beneficio, urgencia…): ayuda a elegir */
  angle: string;
}

const PLACEHOLDER = /\[(tel[eé]fono|correo|documento|credencial|contacto)\]/i;
const URL = /(https?:\/\/|www\.)\S+/i;

const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** El botón puede venir como clave (ORDER_NOW) o como texto («Pedir ahora»). */
function ctaKey(raw: string, destination: CopyDestination): string | null {
  const allowed = META_CTAS[destination];
  const up = raw.trim().toUpperCase().replace(/\s+/g, '_');
  if (up in allowed) return up;
  const byLabel = Object.entries(allowed).find(([, label]) => label.toLowerCase() === raw.trim().toLowerCase());
  if (byLabel) return byLabel[0];
  // WhatsApp solo tiene un botón: cualquier «escríbenos / mensaje» es ese
  if (destination === 'WHATSAPP' && /whats|mensaje|escr[ií]b/i.test(raw)) return 'WHATSAPP_MESSAGE';
  return null;
}

/** Valida UNA variación contra los límites de Meta y la lista de botones. */
export function validateCopyVariation(raw: unknown, destination: CopyDestination): { ok: true; value: CopyVariation } | { ok: false; errors: string[] } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const headline = clean(o.titular ?? o.headline);
  const primaryText = clean(o.texto ?? o.texto_principal ?? o.primaryText);
  const description = clean(o.descripcion ?? o.description);
  const ctaRaw = clean(o.cta ?? o.boton);
  const errors: string[] = [];
  const range = (name: string, v: string, l: { min: number; max: number }) => {
    if (v.length < l.min) errors.push(`${name}: muy corto (${v.length}; mínimo ${l.min})`);
    else if (v.length > l.max) errors.push(`${name}: ${v.length} caracteres (máximo ${l.max})`);
  };
  range('titular', headline, COPY_LIMITS.headline);
  range('texto', primaryText, COPY_LIMITS.primaryText);
  range('descripcion', description, COPY_LIMITS.description);
  const cta = ctaKey(ctaRaw, destination);
  if (!cta) errors.push(`cta: «${ctaRaw || 'vacío'}» no es un botón permitido (${Object.keys(META_CTAS[destination]).join(', ')})`);
  const all = `${headline} ${primaryText} ${description}`;
  if (PLACEHOLDER.test(all)) errors.push('incluye datos de contacto ocultos: no inventes teléfonos, correos ni nombres');
  if (URL.test(all)) errors.push('no pongas enlaces en el texto: el botón ya lleva al destino');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { headline, primaryText, description, cta: cta!, ctaLabel: META_CTAS[destination][cta!], angle: clean(o.enfoque ?? o.angle).slice(0, 40) },
  };
}

/** Todas las variaciones de una respuesta: las válidas y los errores de las demás (para el reintento). */
export function parseVariations(raw: unknown, destination: CopyDestination): { valid: CopyVariation[]; errors: string[] } {
  const list = Array.isArray((raw as any)?.variaciones) ? (raw as any).variaciones : Array.isArray(raw) ? raw : [];
  const valid: CopyVariation[] = [];
  const errors: string[] = [];
  list.slice(0, 10).forEach((v: unknown, i: number) => {
    const r = validateCopyVariation(v, destination);
    if (r.ok) {
      const key = `${r.value.headline.toLowerCase()}|${r.value.primaryText.toLowerCase()}`;
      if (!valid.some((x) => `${x.headline.toLowerCase()}|${x.primaryText.toLowerCase()}` === key)) valid.push(r.value);
    } else {
      errors.push(`variación ${i + 1}: ${r.errors.join('; ')}`);
    }
  });
  if (!list.length) errors.push('la respuesta no trae la lista "variaciones"');
  return { valid, errors };
}

/**
 * Lo que la IA puede saber para escribir: SOLO datos del negocio y de la pieza
 * (nada de clientes ni conversaciones). Va igual a la IA de la empresa y a la
 * genérica (que además lo sanitiza).
 */
export interface CopyBrief {
  business: string;
  sector: string;
  tone?: string;
  audience?: string;
  product?: string;
  goalLabel: string;
  destination: CopyDestination;
  pieceText?: string;
  avoid?: string[];
  count: number;
}

export function copyMessages(brief: CopyBrief, fix?: string[]): ChatMessage[] {
  const ctas = Object.entries(META_CTAS[brief.destination]).map(([k, v]) => `${k} (${v})`).join(', ');
  const L = COPY_LIMITS;
  const system = [
    'Eres redactora de anuncios de Meta (Facebook e Instagram) para negocios en Colombia. Escribes en español neutro colombiano, cercano y concreto.',
    `Devuelve SOLO un JSON: {"variaciones":[{"titular":"…","texto":"…","descripcion":"…","cta":"CLAVE","enfoque":"…"}]} con ${brief.count} variaciones DISTINTAS entre sí (cambia el enfoque: beneficio, precio u oferta si la hay, urgencia, confianza, curiosidad).`,
    `Límites ESTRICTOS (cuenta los caracteres): titular ${L.headline.min}-${L.headline.max}; texto ${L.primaryText.min}-${L.primaryText.max}; descripcion ${L.description.min}-${L.description.max}.`,
    // Los modelos cuentan mal los caracteres y bien las palabras: el texto se pide corto en ambas medidas
    `El "texto" es corto como un mensaje de celular: 1 o 2 frases, máximo ${Math.floor(L.primaryText.max / 7)} palabras y nunca más de ${L.primaryText.max} caracteres. El "titular" va en máximo ${Math.floor(L.headline.max / 7)} palabras y la "descripcion" en máximo ${Math.floor(L.description.max / 7)} palabras.`,
    `"cta" debe ser una de estas claves: ${ctas}.`,
    brief.destination === 'WHATSAPP' ? 'El anuncio abre WhatsApp: termina el texto invitando a escribir.' : 'El anuncio lleva a la web del negocio: invita a la acción del botón.',
    'Reglas de Meta: no afirmes ni insinúes atributos personales de quien lee (salud, peso, deudas, religión…); nada de «garantizado», «cura», «milagroso» ni «antes y después»; máximo dos emojis; sin mayúsculas sostenidas.',
    'No inventes precios, descuentos, fechas, teléfonos, enlaces ni nombres: usa solo los datos que te doy.',
  ].join('\n');
  const user = [
    `Negocio: ${brief.business} (${brief.sector}).`,
    brief.tone ? `Tono de la marca: ${brief.tone}.` : '',
    brief.audience ? `Público: ${brief.audience}.` : '',
    brief.product ? `Producto o servicio: ${brief.product}.` : '',
    `Objetivo de la pieza: ${brief.goalLabel}.`,
    brief.pieceText ? `Textos de la pieza: ${brief.pieceText}` : '',
    brief.avoid?.length ? `Nunca menciones: ${brief.avoid.join(', ')}.` : '',
    fix?.length ? `Tu respuesta anterior no cumplió: ${fix.slice(0, 6).join(' | ')}. Corrige y vuelve a enviar el JSON completo; si un texto quedó largo, escríbelo de nuevo más corto (no lo cortes a la mitad).` : '',
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Textos de una pieza de Creative (los elementos de texto del diseño). */
export function pieceTextOf(docJson: string | null | undefined, max = 400): string {
  try {
    const doc = JSON.parse(docJson ?? '{}');
    const texts: string[] = (Array.isArray(doc?.elements) ? doc.elements : [])
      .filter((e: any) => e?.type === 'text' && typeof e.text === 'string')
      .map((e: any) => e.text.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    return texts.join(' · ').slice(0, max);
  } catch {
    return '';
  }
}
