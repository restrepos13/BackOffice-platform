import type { DesignDoc, DesignElement } from '../design-doc';

/**
 * Similitud ESTRUCTURAL entre composiciones. Ignora colores, textos,
 * tipografías y logos concretos: solo mira qué función cumple cada zona del
 * lienzo (foto, titular, texto secundario, precio, botón, logo, bloques) en
 * una retícula de 12×12. Dos piezas con la misma distribución y distinto
 * color dan similitud ~1: eso es un cambio cosmético, no un diseño distinto.
 */

export type Kind = 'PHOTO' | 'MAIN' | 'TEXT' | 'PRICE' | 'CTA' | 'LOGO' | 'BLOCK';
const KINDS: Kind[] = ['PHOTO', 'MAIN', 'TEXT', 'PRICE', 'CTA', 'LOGO', 'BLOCK'];
const WEIGHT: Record<Kind, number> = { PHOTO: 3, MAIN: 3, TEXT: 1.5, PRICE: 1.5, CTA: 1.5, LOGO: 1, BLOCK: 1.5 };
const G = 12;

export function kindOf(e: DesignElement, doc: DesignDoc): Kind | null {
  if (!e.visible) return null;
  if (e.role === 'logo') return 'LOGO';
  if (e.type === 'image') return 'PHOTO';
  if (e.type === 'text') {
    if (e.role === 'headline' || e.role === 'quote') return 'MAIN';
    if (e.role === 'price' || e.role === 'item-price') return 'PRICE';
    if (e.role === 'cta') return 'CTA';
    if (e.role === 'decoration') return null;
    return 'TEXT';
  }
  if (e.role === 'cta') return 'CTA';
  if (e.role === 'badge') return 'PRICE';
  // Formas: solo cuentan las que pesan en la composición (≥ 2 % del lienzo)
  if ((e.type === 'rect' || e.type === 'ellipse') && (e.width * e.height) / (doc.width * doc.height) >= 0.02 && e.opacity >= 0.3) return 'BLOCK';
  return null;
}

export interface Fingerprint {
  grids: Record<Kind, number[]>;
  /** Proporción del lienzo ocupada por fotos y por texto principal */
  photoShare: number;
  mainShare: number;
  /** Tamaño del titular respecto al lado corto */
  headlineScale: number;
  /** Cuadrante (0-8) del logo y del botón; -1 si no hay */
  logoCell: number;
  ctaCell: number;
  blocks: number;
}

export function fingerprint(doc: DesignDoc): Fingerprint {
  const grids = Object.fromEntries(KINDS.map((k) => [k, new Array(G * G).fill(0)])) as Record<Kind, number[]>;
  const area = doc.width * doc.height;
  let photo = 0;
  let main = 0;
  let headlineScale = 0;
  let logoCell = -1;
  let ctaCell = -1;
  let blocks = 0;
  const S = Math.min(doc.width, doc.height);
  const third = (v: number, max: number) => Math.min(2, Math.max(0, Math.floor((v / max) * 3)));
  for (const e of doc.elements) {
    const k = kindOf(e, doc);
    if (!k) continue;
    const x0 = Math.max(0, e.x);
    const y0 = Math.max(0, e.y);
    const x1 = Math.min(doc.width, e.x + e.width);
    const y1 = Math.min(doc.height, e.y + Math.max(e.height, 1));
    if (x1 <= x0 || y1 <= y0) continue;
    for (let gy = 0; gy < G; gy++) {
      for (let gx = 0; gx < G; gx++) {
        const cx0 = (gx / G) * doc.width;
        const cy0 = (gy / G) * doc.height;
        const cx1 = ((gx + 1) / G) * doc.width;
        const cy1 = ((gy + 1) / G) * doc.height;
        const ov = Math.max(0, Math.min(x1, cx1) - Math.max(x0, cx0)) * Math.max(0, Math.min(y1, cy1) - Math.max(y0, cy0));
        if (ov > 0) grids[k][gy * G + gx] = Math.min(1, grids[k][gy * G + gx] + ov / ((doc.width / G) * (doc.height / G)));
      }
    }
    const a = ((x1 - x0) * (y1 - y0)) / area;
    if (k === 'PHOTO') photo += a;
    if (k === 'MAIN') { main += a; headlineScale = Math.max(headlineScale, (e as any).fontSize ? (e as any).fontSize / S : 0); }
    if (k === 'LOGO' && logoCell < 0) logoCell = third(e.y + e.height / 2, doc.height) * 3 + third(e.x + e.width / 2, doc.width);
    if (k === 'CTA' && e.type !== 'text' && ctaCell < 0) ctaCell = third(e.y + e.height / 2, doc.height) * 3 + third(e.x + e.width / 2, doc.width);
    if (k === 'BLOCK') blocks++;
  }
  return { grids, photoShare: Math.min(1, photo), mainShare: Math.min(1, main), headlineScale, logoCell, ctaCell, blocks };
}

/** IoU suave entre dos retículas. */
function iou(a: number[], b: number[]) {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) { inter += Math.min(a[i], b[i]); uni += Math.max(a[i], b[i]); }
  return uni === 0 ? 1 : inter / uni;
}

/**
 * Similitud estructural 0..1 (1 = misma distribución). Combina la ocupación
 * por función, la proporción foto/texto, la escala del titular y dónde van
 * el logo y el botón.
 */
export function structuralSimilarity(a: Fingerprint, b: Fingerprint): number {
  let num = 0;
  let den = 0;
  for (const k of KINDS) {
    const empty = a.grids[k].every((v) => v === 0) && b.grids[k].every((v) => v === 0);
    if (empty) continue;
    num += WEIGHT[k] * iou(a.grids[k], b.grids[k]);
    den += WEIGHT[k];
  }
  const grid = den ? num / den : 1;
  const share = 1 - Math.min(1, Math.abs(a.photoShare - b.photoShare) * 2);
  const scale = 1 - Math.min(1, Math.abs(a.headlineScale - b.headlineScale) * 8);
  const anchors = (a.logoCell === b.logoCell ? 0.5 : 0) + (a.ctaCell === b.ctaCell ? 0.5 : 0);
  return Math.round((grid * 0.7 + share * 0.12 + scale * 0.1 + anchors * 0.08) * 1000) / 1000;
}

/** Umbral a partir del cual dos piezas se consideran la misma estructura (cambio solo cosmético). */
export const SAME_STRUCTURE = 0.8;

/** Qué rasgos explican la diferencia entre dos piezas (para informes legibles). */
export function differences(a: Fingerprint, b: Fingerprint): string[] {
  const out: string[] = [];
  const kinds: Array<[Kind, string]> = [['PHOTO', 'distribución de la foto'], ['MAIN', 'posición del titular'], ['BLOCK', 'estructura de fondos y formas'], ['TEXT', 'texto secundario'], ['PRICE', 'precio']];
  for (const [k, label] of kinds) if (iou(a.grids[k], b.grids[k]) < 0.5 && !(a.grids[k].every((v) => !v) && b.grids[k].every((v) => !v))) out.push(label);
  if (Math.abs(a.photoShare - b.photoShare) > 0.2) out.push('proporción imagen/texto');
  if (Math.abs(a.headlineScale - b.headlineScale) > 0.03) out.push('escala del titular');
  if (a.logoCell !== b.logoCell) out.push('posición del logo');
  if (a.ctaCell !== b.ctaCell) out.push('posición del botón');
  return out;
}
