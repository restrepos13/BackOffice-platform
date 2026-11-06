import type { ChatMessage } from '../../ai/types';
import { DesignDoc, DesignElement, FormatKey, validateDesignDoc } from '../design-doc';
import type { Issue } from './quality';
import { fitSize } from './text-fit';

/**
 * Creative con IA: el motor arma las propuestas y la IA las corrige según lo
 * que pidió el cliente (redacción, orden, tamaños, posiciones y colores de la
 * paleta). La IA PROPONE cambios en un JSON; el código decide qué se aplica:
 *  - Textos: solo los de mensaje (titular, cuerpo, antetítulo, botón, etiqueta,
 *    puntos). Nunca precios, fechas, lugares, testimonios ni nombres del
 *    catálogo, y nunca una cifra que no estuviera ya en la pieza.
 *  - Tamaños: la letra entre 75 % y 135 % de la original (la IA lo manda como
 *    factor o en píxeles). Si un texto ya no cabe en su caja, la letra se
 *    ajusta sola; si ni así cabe, ese cambio no entra.
 *  - Posiciones: dentro del lienzo; nada bloqueado se mueve.
 *  - Colores: solo los de la paleta de la marca o los que ya usa la pieza.
 *  - Cada cambio se prueba contra el control de calidad: el que empeora la
 *    pieza (texto que se sale, elementos encimados, poco contraste…) se
 *    descarta y los demás se quedan. La pieza nunca queda peor que la del motor.
 */

export interface ReviewableProposal { doc: DesignDoc; family: string; [k: string]: unknown }

export interface ReviewInput {
  request: string;
  business: string;
  tone?: string;
  format: FormatKey;
  palette: string[];
  proposals: ReviewableProposal[];
}

export interface ProposalReview { changes: number; note: string | null; reverted: boolean }

const TEXT_ROLES = new Set(['headline', 'body', 'kicker', 'cta', 'badge', 'point']);
const FIXED_ROLES = new Set(['decoration', 'overlay']);
const HEX = /^#[0-9A-Fa-f]{6}$/;
const MAX_CHANGES_PER_PROPOSAL = 24;

const round = (n: number) => Math.round(n);
const up = (c: string) => c.toUpperCase();

/** Lo que la IA necesita ver de una pieza, compacto. */
function compact(doc: DesignDoc) {
  return {
    fondo: doc.background.color,
    elementos: doc.elements.filter((e) => e.visible !== false && !FIXED_ROLES.has(e.role ?? '')).map((e) => ({
      id: e.id,
      rol: e.role ?? e.name,
      tipo: e.type,
      x: round(e.x), y: round(e.y), ancho: round(e.width), alto: round(e.height),
      ...(e.type === 'text' ? { texto: e.text, tam: round(e.fontSize), color: e.fill } : e.type !== 'image' ? { color: (e as any).fill } : {}),
      ...(e.locked ? { fijo: true } : {}),
    })),
  };
}

export function reviewMessages(input: ReviewInput): ChatMessage[] {
  const { width, height } = input.proposals[0]?.doc ?? { width: 1080, height: 1080 };
  const system = [
    'Eres director de arte de una agencia en Colombia. Recibes piezas publicitarias que armó un motor de diseño y las corriges para que cumplan lo que pidió el cliente.',
    'Puedes: reescribir textos de mensaje (titular, cuerpo, antetítulo, botón, etiqueta, puntos) para que sean claros y vendedores, con un largo parecido al original (cada texto vive en una caja de tamaño fijo); cambiar el tamaño de la letra ("tam" es un factor entre 0.75 y 1.35, no píxeles); mover elementos (x, y) sin salirte del lienzo ni encimarlos; cambiar colores usando SOLO la paleta que te doy; y ordenar las piezas de la mejor a la peor para este pedido.',
    'Nunca: inventes precios, descuentos, fechas, cifras, lugares ni nombres; cambies testimonios, precios o nombres de productos; muevas lo marcado como fijo; agregues o borres elementos.',
    'Cuida la jerarquía (el titular se lee primero), el contraste del texto con el fondo y que nada se tape ni se salga.',
    `El lienzo mide ${width}x${height} px.`,
    'Devuelve SOLO un JSON: {"orden":[índices de mejor a peor],"propuestas":[{"indice":0,"motivo":"una frase de qué mejoraste","cambios":[{"id":"…","texto":"…","tam":1.1,"x":0,"y":0,"color":"#RRGGBB"}]}]}. En cada cambio pon solo los campos que cambias. Para el color del fondo usa "id":"fondo". Si una pieza ya está bien, déjala sin cambios.',
  ].join('\n');
  const user = [
    `Negocio: ${input.business}.`,
    input.tone ? `Tono de la marca: ${input.tone}.` : '',
    `Lo que pidió el cliente: ${input.request || '(no lo escribió: usa el contenido de las piezas)'}`,
    `Paleta permitida: ${input.palette.join(', ') || '(usa solo los colores que ya tienen las piezas)'}`,
    `Piezas: ${JSON.stringify(input.proposals.map((p, i) => ({ indice: i, estructura: p.family, ...compact(p.doc) })))}`,
  ].filter(Boolean).join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Cifras de un texto (precios, fechas, cantidades). */
const numbersOf = (t: string) => (String(t).match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]/g, ''));

/** Lo que permite un cambio de la IA sobre la pieza (lo que ya estaba, para no inventar). */
interface ChangeCtx { knownNumbers: Set<string>; allowedColors: Set<string> }

function changeCtx(doc: DesignDoc, palette: Set<string>): ChangeCtx {
  return {
    knownNumbers: new Set(doc.elements.flatMap((e) => (e.type === 'text' ? numbersOf(e.text) : []))),
    allowedColors: new Set([...palette, up(doc.background.color), ...doc.elements.flatMap((e) => [(e as any).fill].filter((c) => typeof c === 'string' && HEX.test(c)).map(up))]),
  };
}

/** Letra que hace caber el texto en su caja (sin pasar del tamaño pedido). null = no cabe ni en el mínimo. */
function fitted(el: Extract<DesignElement, { type: 'text' }>, wanted: number, original: number): number | null {
  const fit = fitSize(el.text, {
    width: el.width, maxHeight: el.height * 1.15, font: el.fontFamily, lineHeight: el.lineHeight,
    max: wanted, min: Math.max(12, Math.round(original * 0.75)), bold: /bold/.test(el.fontStyle),
  });
  return fit.fits ? fit.size : null;
}

/** Aplica UN cambio de la IA (si está permitido). Devuelve la pieza nueva y cuántas cosas cambió. */
export function applyChange(doc: DesignDoc, change: unknown, ctx: ChangeCtx): { doc: DesignDoc; applied: number } {
  if (!change || typeof change !== 'object') return { doc, applied: 0 };
  const ch = change as Record<string, unknown>;
  const next: DesignDoc = JSON.parse(JSON.stringify(doc));
  let applied = 0;
  if (ch.id === 'fondo') {
    if (typeof ch.color === 'string' && HEX.test(ch.color) && ctx.allowedColors.has(up(ch.color)) && !next.background.gradient && !next.background.assetId && up(next.background.color) !== up(ch.color)) {
      next.background.color = up(ch.color);
      applied++;
    }
    return applied ? { doc: next, applied } : { doc, applied: 0 };
  }
  const el = next.elements.find((e) => e.id === ch.id) as DesignElement | undefined;
  if (!el || el.locked || FIXED_ROLES.has(el.role ?? '')) return { doc, applied: 0 };
  if (el.type === 'text') {
    const original = el.fontSize;
    let wanted = original;
    let touched = false;
    if (typeof ch.texto === 'string' && TEXT_ROLES.has(el.role ?? '')) {
      const text = ch.texto.replace(/\s+/g, ' ').trim();
      const maxLen = Math.min(280, Math.max(el.text.length * 1.5, el.text.length + 30));
      const inventsNumbers = numbersOf(text).some((n) => !ctx.knownNumbers.has(n));
      if (text.length >= 2 && text.length <= maxLen && !inventsNumbers && text !== el.text) {
        el.text = text;
        // El resaltado apuntaba a una frase del texto viejo: si ya no está, se quita
        if (el.accent && !text.includes(el.accent.text)) delete el.accent;
        applied++;
        touched = true;
      }
    }
    if (typeof ch.tam === 'number' && Number.isFinite(ch.tam) && ch.tam > 0) {
      // Factor (1.2) o píxeles (72): las dos formas llegan de los modelos
      const factor = Math.min(1.35, Math.max(0.75, ch.tam > 3 ? ch.tam / original : ch.tam));
      if (Math.abs(factor - 1) >= 0.02) {
        wanted = Math.max(8, Math.min(400, Math.round(original * factor)));
        applied++;
        touched = true;
      }
    }
    if (touched) {
      const size = fitted(el, wanted, original);
      if (size === null) return { doc, applied: 0 }; // no cabe: este cambio no entra
      el.fontSize = size;
    }
  }
  const nx = typeof ch.x === 'number' && Number.isFinite(ch.x) ? Math.round(ch.x) : el.x;
  const ny = typeof ch.y === 'number' && Number.isFinite(ch.y) ? Math.round(ch.y) : el.y;
  if ((nx !== el.x || ny !== el.y) && nx >= 0 && ny >= 0 && nx + el.width <= next.width && ny + el.height <= next.height) {
    el.x = nx;
    el.y = ny;
    applied++;
  }
  if (typeof ch.color === 'string' && HEX.test(ch.color) && ctx.allowedColors.has(up(ch.color)) && el.type !== 'image' && !(el as any).gradient) {
    if (up((el as any).fill ?? '') !== up(ch.color)) {
      (el as any).fill = up(ch.color);
      applied++;
    }
  }
  return applied ? { doc: next, applied } : { doc, applied: 0 };
}

/** Aplica los cambios permitidos de UNA propuesta, en orden (sin control de calidad: lo hace applyReview). */
export function applyChanges(doc: DesignDoc, rawChanges: unknown, palette: Set<string>): { doc: DesignDoc; applied: number } {
  if (!Array.isArray(rawChanges)) return { doc, applied: 0 };
  const ctx = changeCtx(doc, palette);
  let current = doc;
  let applied = 0;
  for (const c of rawChanges.slice(0, MAX_CHANGES_PER_PROPOSAL)) {
    const r = applyChange(current, c, ctx);
    current = r.doc;
    applied += r.applied;
  }
  return { doc: current, applied };
}

const blockers = (issues: Issue[]) => issues.filter((i) => i.severity === 'BLOCK').length;
const warnings = (issues: Issue[]) => issues.filter((i) => i.severity === 'WARN').length;

/**
 * Aplica la respuesta de la IA a todas las propuestas: cambios validados,
 * reversión si la pieza quedó peor y el orden que sugirió la IA.
 */
export function applyReview<P extends ReviewableProposal>(
  proposals: P[],
  raw: unknown,
  ctx: { format: FormatKey; palette: string[]; quality: (doc: DesignDoc, p: P) => Issue[] },
): { proposals: Array<P & { aiReview: ProposalReview }>; used: boolean } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  const palette = new Set(ctx.palette.filter((c) => HEX.test(c)).map(up));
  const byIndex = new Map<number, any>();
  for (const it of Array.isArray(r.propuestas) ? r.propuestas : []) {
    const i = Number(it?.indice);
    if (Number.isInteger(i) && i >= 0 && i < proposals.length && !byIndex.has(i)) byIndex.set(i, it);
  }
  const reviewed = proposals.map((p, i) => {
    const it = byIndex.get(i);
    const note = typeof it?.motivo === 'string' ? it.motivo.replace(/\s+/g, ' ').trim().slice(0, 160) || null : null;
    const changes: unknown[] = Array.isArray(it?.cambios) ? it.cambios.slice(0, MAX_CHANGES_PER_PROPOSAL) : [];
    if (!changes.length) return { ...p, aiReview: { changes: 0, note, reverted: false } };
    // Cambio por cambio: solo se queda el que no empeora la pieza según el control de calidad
    const cctx = changeCtx(p.doc, palette);
    let current = p.doc;
    let issues = ctx.quality(current, p);
    let kept = 0;
    for (const c of changes) {
      const r = applyChange(current, c, cctx);
      if (!r.applied) continue;
      let valid: DesignDoc;
      try { valid = validateDesignDoc(r.doc, ctx.format); } catch { continue; }
      const after = ctx.quality(valid, p);
      if (blockers(after) > blockers(issues) || warnings(after) > warnings(issues)) continue;
      current = valid;
      issues = after;
      kept += r.applied;
    }
    if (!kept) return { ...p, aiReview: { changes: 0, note: null, reverted: true } };
    // El motivo de la IA describe todo lo que propuso: si algo se descartó, se dice
    const partial = kept < changes.length ? ' (aplicamos solo los cambios que no afectaban la calidad de la pieza)' : '';
    return { ...p, doc: current, aiReview: { changes: kept, note: note ? `${note}${partial}`.slice(0, 220) : null, reverted: false } };
  });

  // Orden sugerido: solo si es una permutación válida; lo que falte queda al final en su orden
  const order: number[] = Array.isArray(r.orden) ? r.orden.map(Number).filter((n: number, k: number, all: number[]) => Number.isInteger(n) && n >= 0 && n < proposals.length && all.indexOf(n) === k) : [];
  const rest = reviewed.map((_, i) => i).filter((i) => !order.includes(i));
  const sorted = [...order, ...rest].map((i) => reviewed[i]);
  return { proposals: sorted, used: byIndex.size > 0 || order.length > 0 };
}
