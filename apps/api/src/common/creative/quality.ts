import { DesignDoc, DesignElement, FORMATS, ImageElement, TextElement } from '../design-doc';
import { contrastRatio } from './identity';
import { textHeight } from './text-fit';
import type { Family } from './compose';
import { Fingerprint, SAME_STRUCTURE, fingerprint, structuralSimilarity } from './similarity';

/**
 * Control de calidad antes de exportar. Diferencia:
 *  - BLOCK: el archivo saldría roto (texto cortado por el borde, recursos de otra empresa).
 *  - WARN: problema probable que conviene revisar (no impide exportar).
 *  - INFO: observación.
 * Y además si la comprobación es VERIFIED (medida) o HEURISTIC (estimada o
 * basada en una guía no oficial). Nunca modifica el documento.
 */

export type Severity = 'BLOCK' | 'WARN' | 'INFO';
export interface Issue { code: string; severity: Severity; kind: 'VERIFIED' | 'HEURISTIC'; message: string; elementId?: string; elementName?: string }

export interface QualityContext {
  /** Altura real medida en el navegador por id de texto (si llega, manda sobre la estimación) */
  measured?: Record<string, number>;
  brandLogoIds: string[];
  confirmedPrices: number[];
  confirmedOffers: string[];
  assetDims: Record<string, { width: number | null; height: number | null }>;
  ownedAssetIds: Set<string>;
  family?: Family | null;
  recentFamilies?: Family[];
  /** Huellas estructurales de piezas recientes (la repetición se mide por estructura, no por nombre de familia) */
  recentPrints?: Fingerprint[];
  /** Zonas de las historias que tapa la interfaz (píxeles sobre 1920 de alto) */
  storySafe?: { top: number; bottom: number };
}

interface Rect { x: number; y: number; w: number; h: number }

function bbox(e: DesignElement, measured?: number): Rect {
  const h = e.type === 'text' ? Math.max(e.height, measured ?? 0) : e.type === 'line' ? Math.max(1, (e as any).strokeWidth) : e.height;
  if (!e.rotation) return { x: e.x, y: e.y, w: e.width, h };
  const rad = (e.rotation * Math.PI) / 180;
  const pts = [[0, 0], [e.width, 0], [0, h], [e.width, h]].map(([px, py]) => [e.x + px * Math.cos(rad) - py * Math.sin(rad), e.y + px * Math.sin(rad) + py * Math.cos(rad)]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}
const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function inter(a: Rect, b: Rect): number {
  return area({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) });
}
const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** Color sólido detrás del centro de un texto (null si hay una foto debajo: no medible). */
function behind(doc: DesignDoc, idx: number, cx: number, cy: number): string | null | 'IMAGE' {
  for (let i = idx - 1; i >= 0; i--) {
    const e = doc.elements[i];
    if (!e.visible || !contains(bbox(e), cx, cy)) continue;
    if (e.type === 'image') return 'IMAGE';
    // Transparente = color de 8 dígitos con alfa 00 (un #FF3D00 es naranja, no transparente)
    const fill: string = (e as any).fill ?? '';
    if ((e.type === 'rect' || e.type === 'ellipse') && fill && !(fill.length === 9 && fill.endsWith('00'))) {
      if (e.opacity >= 0.75) return (e as any).fill.slice(0, 7);
      // Semitransparente sobre foto: se considera el velo si es oscuro y denso
      const under = behind(doc, i, cx, cy);
      if (under === 'IMAGE') return e.opacity >= 0.45 ? (e as any).fill.slice(0, 7) : 'IMAGE';
      return e.opacity >= 0.5 ? (e as any).fill.slice(0, 7) : (under ?? doc.background.color);
    }
  }
  return doc.background.assetId ? 'IMAGE' : doc.background.color;
}

const MONEY = /\$\s?(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\d%])/g;
const PCT = /(\d{1,2})\s?%/g;

export function checkQuality(doc: DesignDoc, ctx: QualityContext): Issue[] {
  const out: Issue[] = [];
  const { width: W, height: H } = FORMATS[doc.format];
  const S = Math.min(W, H);
  const push = (i: Issue) => out.push(i);
  const textual = (e: DesignElement) => e.type === 'text' || e.role === 'logo' || e.role === 'cta';
  const visible = doc.elements.filter((e) => e.visible);

  visible.forEach((e) => {
    const idx = doc.elements.indexOf(e);
    const measured = ctx.measured?.[e.id];
    const r = bbox(e, measured);
    const name = e.name;

    // Recursos que no son de la empresa (el servidor ya los rechaza al guardar; aquí se avisa antes)
    if (e.type === 'image' && !ctx.ownedAssetIds.has((e as ImageElement).assetId)) push({ code: 'FOREIGN_ASSET', severity: 'BLOCK', kind: 'VERIFIED', message: `«${name}» usa una imagen que no está en tus recursos.`, elementId: e.id, elementName: name });

    // Fuera del lienzo: texto cortado bloquea; decoración a sangre es intencional
    // Lo decorativo puede salir a sangre a propósito (comillas gigantes, bloques): no es un corte
    if (textual(e) && e.role !== 'decoration') {
      const outside = area(r) - inter(r, { x: 0, y: 0, w: W, h: H });
      if (outside > area(r) * 0.02 && area(r) > 0) push({ code: 'OFF_CANVAS', severity: e.type === 'text' ? 'BLOCK' : 'WARN', kind: 'VERIFIED', message: `«${name}» se sale del lienzo y quedaría cortado.`, elementId: e.id, elementName: name });
    }

    if (e.type === 'text') {
      const t = e as TextElement;
      if (!t.text.trim()) { push({ code: 'EMPTY_TEXT', severity: 'INFO', kind: 'VERIFIED', message: `«${name}» está vacío.`, elementId: e.id, elementName: name }); return; }
      // Desborde: el texto ocupa más de lo previsto y puede pisar lo de abajo
      const real = measured ?? textHeight(t.text, t.fontSize, t.width, t.fontFamily, t.lineHeight, /bold/.test(t.fontStyle));
      if (real > t.height * 1.2 + 4 && t.role !== 'decoration') push({ code: 'TEXT_OVERFLOW', severity: 'WARN', kind: measured !== undefined ? 'VERIFIED' : 'HEURISTIC', message: `«${name}» necesita más espacio del que tiene; puede encimarse con otros elementos.`, elementId: e.id, elementName: name });
      // Tamaño mínimo legible en el teléfono (heurística: 2,4 % del lado corto ≈ 26 px en 1080)
      if (t.fontSize < S * 0.024 && t.role !== 'decoration') push({ code: 'SMALL_TEXT', severity: 'WARN', kind: 'HEURISTIC', message: `«${name}» es muy pequeño (${t.fontSize}px) para leerse en un teléfono.`, elementId: e.id, elementName: name });
      // Contraste (WCAG): 3:1 para texto grande, 4,5:1 para el resto
      const bg = behind(doc, idx, r.x + r.w / 2, r.y + Math.min(r.h, t.fontSize) / 2);
      if (bg === 'IMAGE') push({ code: 'CONTRAST_UNKNOWN', severity: 'INFO', kind: 'HEURISTIC', message: `«${name}» está sobre una foto: revisa a ojo que se lea bien.`, elementId: e.id, elementName: name });
      else if (bg && t.role !== 'decoration') {
        const large = t.fontSize >= S * 0.045 || (/bold/.test(t.fontStyle) && t.fontSize >= S * 0.035);
        const ratio = contrastRatio(t.fill.slice(0, 7), bg);
        if (ratio < (large ? 3 : 4.5) && t.opacity > 0.5) push({ code: 'LOW_CONTRAST', severity: 'WARN', kind: 'VERIFIED', message: `«${name}» tiene poco contraste con su fondo (${ratio.toFixed(1)}:1; mínimo ${large ? 3 : 4.5}:1).`, elementId: e.id, elementName: name });
      }
      // Información comercial que no está confirmada en la marca
      for (const m of t.text.matchAll(MONEY)) {
        const value = Number(m[1].replace(/[.,]/g, ''));
        if (!ctx.confirmedPrices.includes(value)) push({ code: 'UNCONFIRMED_PRICE', severity: 'WARN', kind: 'VERIFIED', message: `El precio ${m[0]} no figura entre los precios confirmados de tu marca o catálogo.`, elementId: e.id, elementName: name });
      }
      for (const m of t.text.matchAll(PCT)) {
        if (!ctx.confirmedOffers.some((o) => o.includes(`${m[1]}%`) || o.includes(`${m[1]} %`))) push({ code: 'UNCONFIRMED_DISCOUNT', severity: 'WARN', kind: 'VERIFIED', message: `El descuento ${m[0]} no está entre tus ofertas confirmadas.`, elementId: e.id, elementName: name });
      }
    }

    // Resolución: la imagen se muestra más grande que su tamaño real
    if (e.type === 'image') {
      const img = e as ImageElement;
      const d = ctx.assetDims[img.assetId];
      const srcW = img.crop?.width ?? d?.width ?? null;
      if (srcW && e.width > srcW * 1.15) push({ code: 'LOW_RES', severity: 'WARN', kind: 'VERIFIED', message: `«${name}» se amplía ${Math.round((e.width / srcW) * 100)} %: puede verse borrosa. Usa una foto más grande.`, elementId: e.id, elementName: name });
    }

    // Historias: zonas que tapa la interfaz (guía de la comunidad, no oficial)
    if (doc.format === 'STORY' && textual(e) && e.role !== 'decoration') {
      const top = ((ctx.storySafe?.top ?? 250) / 1920) * H;
      const bottom = H - ((ctx.storySafe?.bottom ?? 320) / 1920) * H;
      // Medio píxel de tolerancia (los bordes exactos no cuentan como invasión)
      if (r.y < top - 0.5 || r.y + r.h > bottom + 0.5) push({ code: 'STORY_SAFE_ZONE', severity: 'WARN', kind: 'HEURISTIC', message: `«${name}» queda en una zona que la interfaz de historias puede tapar.`, elementId: e.id, elementName: name });
    }
  });

  // Encimados entre textos (los que están dentro de su propio botón o sello no cuentan)
  const texts = visible.filter((e) => e.type === 'text' && e.role !== 'decoration') as TextElement[];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = bbox(texts[i], ctx.measured?.[texts[i].id]);
      const b = bbox(texts[j], ctx.measured?.[texts[j].id]);
      const ov = inter(a, b);
      if (ov > Math.min(area(a), area(b)) * 0.15) push({ code: 'OVERLAP', severity: 'WARN', kind: ctx.measured ? 'VERIFIED' : 'HEURISTIC', message: `«${texts[i].name}» y «${texts[j].name}» se enciman.`, elementId: texts[j].id, elementName: texts[j].name });
    }
  }

  // Logo
  if (ctx.brandLogoIds.length) {
    const logos = visible.filter((e) => e.role === 'logo' && e.type === 'image') as ImageElement[];
    if (!logos.length) push({ code: 'NO_LOGO', severity: 'WARN', kind: 'VERIFIED', message: 'La pieza no lleva el logo de tu marca.' });
    else if (logos.some((l) => !ctx.brandLogoIds.includes(l.assetId))) push({ code: 'WRONG_LOGO', severity: 'WARN', kind: 'VERIFIED', message: 'El logo usado no es el que está en tu marca.' });
  }

  // Repetición: misma DISTRIBUCIÓN que piezas recientes (colores y textos no cuentan)
  if (ctx.recentPrints?.length) {
    const fp = fingerprint(doc);
    const same = ctx.recentPrints.slice(0, 5).filter((r) => structuralSimilarity(fp, r) >= SAME_STRUCTURE).length;
    if (same >= 2) push({ code: 'REPETITION', severity: 'INFO', kind: 'VERIFIED', message: `Tiene la misma distribución que ${same} de tus últimas 5 piezas (cambian colores o textos, no la estructura). Si no es una campaña, prueba otra dirección.` });
  } else if (ctx.family && ctx.recentFamilies) {
    const n = ctx.recentFamilies.slice(0, 5).filter((f) => f === ctx.family).length;
    if (n >= 3) push({ code: 'REPETITION', severity: 'INFO', kind: 'HEURISTIC', message: `Usaste esta misma dirección en ${n} de tus últimas 5 piezas. Si no es una campaña, prueba otra.` });
  }

  // Espacio vacío: el contenido ocupa poco del lienzo y no hay foto a sangre (heurística de composición)
  const contentEls = visible.filter((e) => e.type === 'text' || e.type === 'image' || e.role === 'cta' || e.role === 'badge');
  if (contentEls.length) {
    const fullBleed = visible.some((e) => (e.type === 'image' || e.role === 'brand-color') && e.width * e.height >= W * H * 0.35);
    const ys = contentEls.map((e) => bbox(e, ctx.measured?.[e.id]));
    const spanY = Math.max(...ys.map((r) => r.y + r.h)) - Math.min(...ys.map((r) => r.y));
    if (!fullBleed && spanY < H * 0.5) push({ code: 'EMPTY_SPACE', severity: 'INFO', kind: 'HEURISTIC', message: 'El contenido ocupa menos de la mitad del alto: puede verse vacío. Agranda el texto o agrega una foto.' });
  }

  // Ofertas: el precio o descuento tiene que verse más que el texto de apoyo
  const price = visible.find((e) => e.type === 'text' && e.role === 'price') as TextElement | undefined;
  const headlineEl = visible.find((e) => e.type === 'text' && e.role === 'headline') as TextElement | undefined;
  if (price && headlineEl && price.fontSize < headlineEl.fontSize * 0.5 && !visible.some((e) => e.role === 'badge')) push({ code: 'PRICE_NOT_PROMINENT', severity: 'INFO', kind: 'HEURISTIC', message: `El precio (${price.text}) es mucho más pequeño que el titular: si es una oferta, dale más peso.`, elementId: price.id, elementName: price.name });

  // Jerarquía: el titular debería destacar claramente sobre el resto del texto (heurística)
  if (headlineEl) {
    const others = visible.filter((e) => e.type === 'text' && e !== headlineEl && !['decoration', 'price', 'logo', 'cta'].includes(e.role ?? '') && !(e.role === 'headline')) as TextElement[];
    const biggest = Math.max(0, ...others.map((e) => e.fontSize));
    if (biggest && headlineEl.fontSize < biggest * 1.3) push({ code: 'WEAK_HIERARCHY', severity: 'INFO', kind: 'HEURISTIC', message: 'El titular casi no se distingue del resto del texto: agrándalo o acorta el texto de apoyo.', elementId: headlineEl.id, elementName: headlineEl.name });
  }


  // Ordenar: bloqueantes primero; sin duplicar el mismo aviso para el mismo elemento
  const seen = new Set<string>();
  const rank = { BLOCK: 0, WARN: 1, INFO: 2 };
  return out.filter((i) => { const k = `${i.code}:${i.elementId ?? ''}:${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}
