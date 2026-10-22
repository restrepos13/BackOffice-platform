import { DESIGN_SCHEMA_VERSION, DesignDoc, DesignElement, ElementRole, FORMATS, FormatKey } from '../design-doc';
import { ResolvedIdentity, contrastRatio, luminance } from './identity';
import { fitSize } from './text-fit';

/**
 * Motor de composición. Recibe una familia (dirección de arte), el formato,
 * los tokens de estilo de la marca y el contenido, y devuelve un documento
 * EDITABLE del editor (mismos tipos de siempre: texto, imagen, rectángulo,
 * elipse, línea). Cada elemento lleva su rol y su "slot" para que la
 * adaptación a otro formato pueda recomponer sin perder lo que la persona
 * escribió. Determinista: misma entrada → mismo documento.
 *
 * Limitaciones del documento actual (y cómo se resuelven aquí):
 *  - Sin degradados ni máscaras → legibilidad sobre foto con un rectángulo
 *    semitransparente ("overlay"); recortes circulares con el radio de la imagen.
 *  - Sin fondo de texto ni sombras → bloques de color detrás del texto.
 *  - Sin estilos mixtos dentro de un texto → el énfasis es un segundo texto.
 */

export const FAMILIES = [
  'HERO_PHOTO', 'EDITORIAL', 'TYPE_DOMINANT', 'CATALOG', 'OFFER', 'BENEFITS',
  'TESTIMONIAL', 'TIPS', 'STEPS', 'EVENT', 'MODULAR', 'CORPORATE_INFO',
] as const;
export type Family = (typeof FAMILIES)[number];

export interface Content {
  kicker?: string;
  headline: string;
  body?: string;
  price?: string;
  cta?: string;
  validity?: string;
  date?: { day: string; month: string };
  place?: string;
  quote?: string;
  author?: string;
  items?: Array<{ name: string; price?: string; assetId?: string }>;
  points?: string[];
  photos: string[];
}

export type AssetDims = Record<string, { width: number | null; height: number | null }>;

type Orient = 'wide' | 'square' | 'portrait' | 'tall';
type Motif = 'RULE' | 'BLOCK' | 'ORGANIC' | 'BAR' | 'DOTS' | 'NONE';

export interface Tokens {
  format: FormatKey; W: number; H: number; S: number; orient: Orient;
  m: number; safeTop: number; safeBottom: number;
  title: string; body: string; titleBold: boolean; upper: boolean;
  radius: number; motif: Motif; align: 'left' | 'center'; asym: boolean;
  c: ResolvedIdentity['colors'];
  photoStyle: ResolvedIdentity['photoStyle']['value'];
  logoAssetId: string | null; logoPlacement: ResolvedIdentity['logoPlacement']['value']; brandName: string;
  /** Carácter de la marca que decide la estructura dentro de cada familia */
  mood: Mood;
  /** Composiciones partidas en espejo (foto/panel a la derecha). Lo decide la alineación de la marca o su semilla. */
  mirror: boolean;
  companySeed: number;
}

/**
 * Carácter de la marca. Decide QUÉ estructura usa cada familia (no solo
 * colores): una marca refinada y una enérgica no reciben el mismo
 * testimonio con otra paleta, sino composiciones distintas.
 */
export type Mood = 'REFINED' | 'BOLD' | 'WARM' | 'CLEAR';
export function moodOf(id: ResolvedIdentity): Mood {
  const p = id.personality.value;
  if (p[0] === 'ENERGICA' || p[0] === 'AUDAZ') return 'BOLD';
  if (p[0] === 'ELEGANTE' || p[0] === 'MINIMALISTA' || (id.positioning.value === 'PREMIUM' && !p.includes('ENERGICA'))) return 'REFINED';
  if (p[0] === 'PROFESIONAL') return 'CLEAR';
  return 'WARM';
}

/** Cuántas estructuras tiene cada familia y cuál prefiere cada carácter de marca. */
export const LAYOUTS: Record<Family, { count: number; prefer: Partial<Record<Mood, number | number[]>> }> = {
  HERO_PHOTO: { count: 2, prefer: { BOLD: 1, REFINED: 1 } },
  EDITORIAL: { count: 2, prefer: { REFINED: 1 } },
  TYPE_DOMINANT: { count: 2, prefer: { REFINED: 1, CLEAR: 1 } },
  CATALOG: { count: 1, prefer: {} },
  OFFER: { count: 4, prefer: { WARM: [0, 1], CLEAR: 1, BOLD: 2, REFINED: 3 } },
  BENEFITS: { count: 1, prefer: {} },
  TESTIMONIAL: { count: 4, prefer: { REFINED: 1, WARM: [2, 0], BOLD: 3, CLEAR: [0, 1] } },
  TIPS: { count: 4, prefer: { REFINED: 1, WARM: [2, 0], BOLD: 3, CLEAR: [0, 1] } },
  STEPS: { count: 1, prefer: {} },
  EVENT: { count: 2, prefer: { REFINED: 1, CLEAR: 1 } },
  MODULAR: { count: 2, prefer: { BOLD: 1, REFINED: 1 } },
  CORPORATE_INFO: { count: 3, prefer: { BOLD: 1, WARM: [1, 0], REFINED: 2 } },
};
/**
 * Estructura preferida de una familia para una marca. Si el carácter admite
 * varias, la semilla de la EMPRESA elige una (reproducible): dos marcas con el
 * mismo carácter no terminan con la misma distribución. No usa datos de otras empresas.
 */
export function preferredLayout(family: Family, mood: Mood, companySeed = 0) {
  const p = LAYOUTS[family].prefer[mood];
  if (Array.isArray(p)) return p[companySeed % p.length];
  return p ?? 0;
}

/* ── Semillas reproducibles ── */

export function seedHash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
export function rng(seed: number) {
  let h = seed || 1;
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const SINGLE_WEIGHT = ['Anton', 'Bebas Neue', 'Archivo Black', 'Pacifico', 'DM Serif Display'];
const CONDENSED = ['Anton', 'Bebas Neue', 'Oswald'];

const MOTIFS: Record<string, Motif[]> = {
  ELEGANTE: ['RULE'], MINIMALISTA: ['RULE', 'NONE'], ENERGICA: ['BLOCK', 'BAR'], AUDAZ: ['BLOCK'],
  CALIDA: ['ORGANIC', 'RULE'], NATURAL: ['ORGANIC'], PROFESIONAL: ['BAR', 'RULE'], DIVERTIDA: ['DOTS', 'ORGANIC'],
};

/**
 * Tokens de estilo de una marca para un formato. La semilla de la empresa
 * solo desempata entre opciones compatibles con su identidad (dos marcas
 * parecidas no terminan idénticas); no usa datos de otras empresas.
 */
export function tokensFor(id: ResolvedIdentity, format: FormatKey, companySeed: number, brandName: string): Tokens {
  const { width: W, height: H } = FORMATS[format];
  const S = Math.min(W, H);
  const ratio = W / H;
  const orient: Orient = ratio > 1.4 ? 'wide' : H / W > 1.5 ? 'tall' : H / W > 1.1 ? 'portrait' : 'square';
  const density = id.density.value;
  const m = Math.round(S * (density === 'AIREADA' ? 0.09 : density === 'COMPACTA' ? 0.058 : 0.072));
  const pers = id.personality.value;
  const r = rng(companySeed);
  const motifs = MOTIFS[pers[0]] ?? ['NONE'];
  const motif = motifs[Math.floor(r() * motifs.length)];
  const rounded = pers.some((p) => ['CALIDA', 'DIVERTIDA', 'NATURAL'].includes(p));
  const upper = CONDENSED.includes(id.fonts.title) || ((pers.includes('ENERGICA') || pers.includes('AUDAZ')) && !pers.includes('ELEGANTE'));
  return {
    format, W, H, S, orient, m,
    // Historias: zonas cubiertas por la interfaz (guía de la comunidad, no especificación oficial de Meta)
    safeTop: orient === 'tall' ? Math.max(m, Math.round((250 / 1920) * H)) : m,
    safeBottom: orient === 'tall' ? Math.max(m, Math.round((320 / 1920) * H)) : m,
    title: id.fonts.title, body: id.fonts.body, titleBold: !SINGLE_WEIGHT.includes(id.fonts.title), upper,
    radius: rounded ? Math.round(S * 0.028) : 0, motif,
    align: id.alignment.value === 'CENTRADA' ? 'center' : 'left', asym: id.alignment.value === 'ASIMETRICA',
    c: id.colors, photoStyle: id.photoStyle.value, logoAssetId: id.logoAssetId, logoPlacement: id.logoPlacement.value, brandName,
    mood: moodOf(id),
    mirror: id.alignment.value === 'ASIMETRICA' ? (companySeed >> 3) % 2 === 1 : id.alignment.value === 'IZQUIERDA' ? false : (companySeed >> 5) % 2 === 1,
    companySeed,
  };
}

/* ── Constructor de documentos ── */

interface Box { x: number; y: number; w: number; h: number }

class Builder {
  els: DesignElement[] = [];
  /** Bloques que no entraron (se informan; nunca se dejan fuera del lienzo) */
  omitted: string[] = [];
  private n = 0;
  constructor(readonly t: Tokens, readonly dims: AssetDims) {}

  private id(p: string) { return `${p}${(++this.n).toString(36)}`; }
  private base(name: string, role: ElementRole | undefined, slot: string | undefined, b: Box, rotation = 0, opacity = 1) {
    return {
      name: name.slice(0, 60), x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.w)), height: Math.max(1, Math.round(b.h)),
      rotation, opacity, visible: true, locked: false, ...(role ? { role } : {}), ...(slot ? { slot } : {}),
    };
  }

  rect(name: string, b: Box, fill: string, o: { role?: ElementRole; slot?: string; radius?: number; opacity?: number; rotation?: number; stroke?: string; strokeWidth?: number } = {}) {
    this.els.push({ id: this.id('r'), type: 'rect', ...this.base(name, o.role, o.slot, b, o.rotation ?? 0, o.opacity ?? 1), fill, stroke: o.stroke ?? '#00000000', strokeWidth: o.strokeWidth ?? 0, cornerRadius: Math.round(o.radius ?? 0) } as DesignElement);
  }
  ellipse(name: string, b: Box, fill: string, o: { role?: ElementRole; slot?: string; opacity?: number } = {}) {
    this.els.push({ id: this.id('e'), type: 'ellipse', ...this.base(name, o.role ?? 'decoration', o.slot, b, 0, o.opacity ?? 1), fill, stroke: '#00000000', strokeWidth: 0, cornerRadius: 0 } as DesignElement);
  }
  line(name: string, x: number, y: number, w: number, color: string, width = 3) {
    this.els.push({ id: this.id('l'), type: 'line', ...this.base(name, 'decoration', undefined, { x, y, w, h: 0 }), height: 0, fill: '#00000000', stroke: color, strokeWidth: width, cornerRadius: 0 } as DesignElement);
  }

  /** Texto con tamaño ajustado a su caja. Devuelve la altura que ocupa. */
  text(name: string, text: string, b: Box, o: { role: ElementRole; slot?: string; font: string; color: string; max: number; min: number; lh?: number; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; upper?: boolean; maxLines?: number; opacity?: number }) {
    const shown = o.upper ? text.toUpperCase() : text;
    const lh = o.lh ?? 1.15;
    const bold = !!o.bold && !SINGLE_WEIGHT.includes(o.font);
    const fit = fitSize(shown, { width: b.w, maxHeight: b.h, font: o.font, lineHeight: lh, max: o.max, min: o.min, bold, upper: o.upper, maxLines: o.maxLines });
    const style = bold && o.italic ? 'bold italic' : bold ? 'bold' : o.italic ? 'italic' : 'normal';
    this.els.push({
      id: this.id('t'), type: 'text', ...this.base(name, o.role, o.slot, { x: b.x, y: b.y, w: b.w, h: fit.height }, 0, o.opacity ?? 1),
      text: shown, fontFamily: o.font, fontSize: fit.size, fontStyle: style, align: o.align ?? this.t.align, lineHeight: lh, letterSpacing: o.upper ? Math.round(fit.size * 0.04) : 0,
      fill: o.color, textDecoration: '',
    } as DesignElement);
    return fit.height;
  }

  image(name: string, assetId: string, b: Box, o: { role?: ElementRole; slot?: string; radius?: number } = {}) {
    const d = this.dims[assetId];
    let crop: { x: number; y: number; width: number; height: number } | null = null;
    if (d?.width && d?.height) {
      // Recorte "rellenar" centrado: la foto cubre la caja sin deformarse
      const r = b.w / b.h;
      const ir = d.width / d.height;
      crop = ir > r
        ? { x: Math.round((d.width - d.height * r) / 2), y: 0, width: Math.round(d.height * r), height: d.height }
        : { x: 0, y: Math.round((d.height - d.width / r) / 2), width: d.width, height: Math.round(d.width / r) };
    }
    this.els.push({ id: this.id('i'), type: 'image', ...this.base(name, o.role ?? 'photo', o.slot, b), assetId, crop, cornerRadius: Math.round(o.radius ?? 0) } as DesignElement);
  }

  /** Botón de llamada a la acción. Devuelve su altura. */
  cta(text: string, x: number, y: number, maxW: number, bgIn: string, align: 'left' | 'center') {
    let bg = bgIn;
    const t = this.t;
    const h = Math.round(t.S * 0.09);
    const size = Math.round(t.S * 0.036);
    // Si ningún color de texto se lee sobre el color de la marca, el botón va en el color oscuro
    if (contrastRatio(bg, textOn(bg, t)) < 3) bg = t.c.dark;
    const w = Math.min(maxW, Math.round(text.length * size * 0.62 + h * 1.2));
    const left = align === 'center' ? x + (maxW - w) / 2 : x;
    this.rect('Botón', { x: left, y, w, h }, bg, { role: 'cta', radius: t.radius ? h / 2 : 0 });
    this.text('Llamada a la acción', text, { x: left + h * 0.3, y: y + (h - size * 1.2) / 2, w: w - h * 0.6, h: size * 1.3 }, { role: 'cta', font: t.body, color: textOn(bg, t), max: size, min: Math.round(size * 0.7), bold: true, align: 'center', lh: 1.2, maxLines: 1 });
    return h;
  }

  logo(onBg: string) {
    const t = this.t;
    const s = Math.round(t.S * 0.12);
    const left = t.logoPlacement === 'ARRIBA_IZQUIERDA';
    const bottom = t.logoPlacement === 'ABAJO_DERECHA' || t.logoPlacement === 'ABAJO_CENTRO';
    const x = t.logoPlacement === 'ABAJO_CENTRO' ? (t.W - s) / 2 : left ? t.m : t.W - t.m - s;
    const y = bottom ? t.H - t.safeBottom - s : t.safeTop;
    if (t.logoAssetId) this.image('Logo', t.logoAssetId, { x, y, w: s, h: s }, { role: 'logo' });
    else this.text('Nombre de la marca', t.brandName, { x: left ? t.m : x - s * 2, y: y + s * 0.3, w: s * 3, h: s * 0.5 }, { role: 'logo', font: t.title, color: textOn(onBg, t), max: Math.round(t.S * 0.032), min: Math.round(t.S * 0.024), bold: true, align: left ? 'left' : t.logoPlacement === 'ABAJO_CENTRO' ? 'center' : 'right', maxLines: 1 });
    return { x, y, s, bottom };
  }

  /** Decoración según el motivo de la marca (detrás del contenido). */
  motif(scheme: string) {
    const t = this.t;
    const accent = t.c.accent;
    if (t.motif === 'BLOCK') this.rect('Bloque decorativo', { x: t.W * 0.62, y: -t.S * 0.12, w: t.S * 0.55, h: t.S * 0.28 }, accent, { role: 'decoration', rotation: -12, opacity: scheme === 'LIGHT' ? 0.9 : 0.75 });
    else if (t.motif === 'ORGANIC') this.ellipse('Forma orgánica', { x: t.W - t.S * 0.38, y: t.H - t.S * 0.42, w: t.S * 0.62, h: t.S * 0.62 }, accent, { opacity: 0.16 });
    else if (t.motif === 'BAR') this.rect('Franja', { x: 0, y: 0, w: t.W, h: Math.round(t.S * 0.018) }, accent, { role: 'decoration' });
    else if (t.motif === 'DOTS') [0, 1, 2].forEach((i) => this.ellipse('Punto', { x: t.W - t.m - t.S * (0.05 + i * 0.06), y: t.H - t.safeBottom - t.S * 0.04, w: t.S * 0.035, h: t.S * 0.035 }, accent, { opacity: 0.8 }));
  }

  /**
   * Apila bloques en una caja. Si no entran, achica los tamaños máximos y
   * vuelve a intentar (jamás deja texto fuera de la caja sin avisar: la
   * altura real queda en el elemento y la revisa el control de calidad).
   */
  stack(blocks: Block[], box: Box, valign: 'top' | 'center' | 'bottom', align: 'left' | 'center' = this.t.align): number {
    let list = blocks;
    // Orden en que se resigna contenido si no entra: texto secundario, etiqueta, vigencia, precio
    // (los puntos se resignan de a uno, empezando por el último)
    const dropOrder: ElementRole[] = ['body', 'kicker', 'validity', 'place', 'point', 'point', 'point', 'price'];
    for (let round = 0; round <= dropOrder.length; round++) {
      let scale = 1;
      for (let attempt = 0; attempt < 5; attempt++) {
        const h = list.reduce((sum, b) => sum + measure(b, box.w, scale, this.t) + (b.gap ?? 0), 0);
        if (h <= box.h) return this.place(list, box, valign, align, scale, h);
        scale *= 0.88;
      }
      if (round === dropOrder.length) break;
      const role = dropOrder[round];
      const victim = [...list].reverse().find((b) => b.kind === 'text' && b.role === role);
      // Si ese tipo de bloque no está, se pasa al siguiente de la lista (no se rinde)
      if (!victim) continue;
      this.omitted.push((victim as TextBlock).name);
      list = list.filter((b) => b !== victim);
    }
    // Ni así entra: se dibuja reducido al mínimo y el control de calidad lo señalará
    const h = list.reduce((sum, b) => sum + measure(b, box.w, 0.6, this.t) + (b.gap ?? 0), 0);
    return this.place(list, box, valign, align, 0.6, h);
  }

  private place(list: Block[], box: Box, valign: 'top' | 'center' | 'bottom', align: 'left' | 'center', scale: number, h: number) {
    let y = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - h : box.y + (box.h - h) / 2;
    // En formatos altos, un bloque arriba con mucho espacio libre debajo se ve abandonado: se baja un poco
    if (valign === 'top' && this.t.orient === 'tall' && box.h - h > box.h * 0.4) y += (box.h - h) * 0.3;
    y = Math.max(box.y, y);
    for (const b of list) {
      if (b.kind === 'text') y += this.text(b.name, b.text, { x: box.x, y, w: box.w, h: box.h }, { ...b, align, max: b.max * scale, min: Math.min(b.min, b.max * scale) }) + (b.gap ?? 0);
      else if (b.kind === 'cta') y += this.cta(b.text, box.x, y, box.w, b.bg, align) + (b.gap ?? 0);
      else if (b.kind === 'rule') { this.line('Línea', align === 'center' ? box.x + box.w / 2 - this.t.S * 0.06 : box.x, y, this.t.S * 0.12, b.color, Math.max(2, Math.round(this.t.S * 0.004))); y += b.gap ?? 0; }
      else y += b.h;
    }
    return y;
  }
}

type Block =
  | ({ kind: 'text'; name: string; text: string; gap?: number } & { role: ElementRole; slot?: string; font: string; color: string; max: number; min: number; lh?: number; bold?: boolean; italic?: boolean; upper?: boolean; maxLines?: number })
  | { kind: 'cta'; text: string; bg: string; gap?: number }
  | { kind: 'rule'; color: string; gap?: number }
  | { kind: 'space'; h: number; gap?: number };

type TextBlock = Extract<Block, { kind: 'text' }>;

function measure(b: Block, w: number, scale: number, t: Tokens) {
  if (b.kind === 'text') return fitSize(b.upper ? b.text.toUpperCase() : b.text, { width: w, maxHeight: 1e9, font: b.font, lineHeight: b.lh ?? 1.15, max: b.max * scale, min: b.min, bold: b.bold, upper: b.upper, maxLines: b.maxLines }).height;
  if (b.kind === 'cta') return Math.round(t.S * 0.09);
  if (b.kind === 'rule') return 0;
  return b.h;
}

export function textOn(bg: string, t: Tokens) {
  const opts = [t.c.dark, '#FFFFFF', t.c.light];
  return opts.sort((a, b) => contrastRatio(bg, b) - contrastRatio(bg, a))[0];
}
const isDark = (hex: string) => luminance(hex) < 0.18;

/** Fondo de color de marca solo si algún color de texto se lee bien encima (4,5:1); si no, el oscuro. */
function solidBg(t: Tokens, preferred: string) {
  return contrastRatio(preferred, textOn(preferred, t)) >= 4.5 ? preferred : t.c.dark;
}

/** Color de marca para un texto solo si se lee sobre ese fondo (WCAG); si no, el de mejor contraste. */
const ink0 = (bg: string, t: Tokens) => textOn(bg, t);

export function brandInk(bg: string, preferred: string, t: Tokens, large = false) {
  return contrastRatio(bg, preferred) >= (large ? 3 : 4.5) ? preferred : textOn(bg, t);
}

/* ── Bloques de texto frecuentes ── */

function kicker(t: Tokens, text: string, color: string, gap = t.S * 0.025, bg?: string): TextBlock {
  if (bg) color = brandInk(bg, color, t);
  return { kind: 'text', name: 'Etiqueta', text, role: 'kicker', font: t.body, color, max: t.S * 0.032, min: t.S * 0.024, bold: true, upper: true, maxLines: 2, gap };
}
function headline(t: Tokens, text: string, color: string, size: number, gap = t.S * 0.03, o: { italic?: boolean; maxLines?: number } = {}): TextBlock {
  return { kind: 'text', name: 'Titular', text, role: 'headline', font: t.title, color, max: size, min: t.S * 0.05, bold: t.titleBold, upper: t.upper, lh: t.upper ? 1.02 : 1.1, gap, maxLines: o.maxLines ?? 5, italic: o.italic };
}
function body(t: Tokens, text: string, color: string, gap = t.S * 0.035, role: ElementRole = 'body', slot?: string): TextBlock {
  return { kind: 'text', name: role === 'validity' ? 'Vigencia' : role === 'place' ? 'Lugar y hora' : 'Texto', text, role, slot, font: t.body, color, max: t.S * 0.04, min: t.S * 0.026, lh: 1.35, gap, maxLines: 6 };
}
function priceBlock(t: Tokens, text: string, color: string, gap = t.S * 0.03, bg?: string): TextBlock {
  if (bg) color = brandInk(bg, color, t, true);
  return { kind: 'text', name: 'Precio', text, role: 'price', font: t.title, color, max: t.S * 0.075, min: t.S * 0.045, bold: true, gap, maxLines: 1 };
}

/* ── Familias ── */

type Compose = (b: Builder, c: Content, t: Tokens, variant: number) => string;

function contentBox(t: Tokens, top = t.safeTop, bottom = t.safeBottom): Box {
  return { x: t.m, y: top, w: t.W - 2 * t.m, h: t.H - top - bottom };
}

/** Sello de precio/descuento (círculo de acento). Devuelve su diámetro. */
function priceBadge(b: Builder, t: Tokens, text: string, cx: number, cy: number, d: number) {
  const bg = contrastRatio(t.c.accent, textOn(t.c.accent, t)) >= 3 ? t.c.accent : t.c.dark;
  b.ellipse('Sello', { x: cx - d / 2, y: cy - d / 2, w: d, h: d }, bg, { role: 'badge' });
  b.text('Precio', text, { x: cx - d * 0.4, y: cy - d * 0.22, w: d * 0.8, h: d * 0.44 }, { role: 'price', font: t.title, color: textOn(bg, t), max: d * 0.3, min: d * 0.12, bold: true, align: 'center', maxLines: text.includes(' ') ? 2 : 1, lh: 1 });
}

const heroPhoto: Compose = (b, c, t, v) => {
  const ink = isDark(t.c.primary) ? t.c.primary : t.c.dark;
  const textCol = textOn(ink, t);
  // Si hay precio corto (oferta), va en un sello visible: no como texto chico
  const badge = c.price && c.price.length <= 12 ? c.price : null;
  const blocks = textBlocks(badge ? { ...c, price: undefined } : c, t, textCol);
  const d = t.S * 0.26;
  if (t.orient === 'wide') {
    b.image('Foto', c.photos[0], { x: t.W * 0.45, y: 0, w: t.W * 0.55, h: t.H }, { slot: '0' });
    b.rect('Panel', { x: 0, y: 0, w: t.W * 0.45, h: t.H }, ink, { role: 'brand-color' });
    const lg = b.logo(ink);
    b.stack(blocks, { x: t.m, y: t.m + (lg.bottom ? 0 : lg.s * 0.6), w: t.W * 0.45 - 2 * t.m, h: t.H - 2 * t.m - lg.s * 0.6 }, 'center', 'left');
    // El sello va entero sobre la foto (no sobre la columna de texto)
    if (badge) priceBadge(b, t, badge, t.W * 0.45 + d / 2 + t.m * 0.4, t.m + d / 2, d);
    return ink;
  }
  b.image('Foto', c.photos[0], { x: 0, y: 0, w: t.W, h: t.H }, { slot: '0' });
  if (v % 2 === 0) {
    const top = t.H * 0.5;
    b.rect('Banda', { x: 0, y: top, w: t.W, h: t.H - top }, ink, { role: 'overlay', opacity: 0.86 });
    b.logo(ink);
    const left = badge ? d * 0.75 : 0;
    b.stack(blocks, { x: t.m, y: top + t.m * 0.8, w: t.W - 2 * t.m - left, h: t.H - top - t.m * 0.8 - t.safeBottom }, 'center');
    if (badge) priceBadge(b, t, badge, t.W - t.m - d / 2, top, d);
  } else {
    b.rect('Velo', { x: 0, y: 0, w: t.W, h: t.H }, t.c.dark, { role: 'overlay', opacity: 0.45 });
    b.logo(t.c.dark);
    if (badge) priceBadge(b, t, badge, t.m + d / 2, t.safeTop + d / 2, d);
    b.stack(blocks, contentBox(t, t.safeTop + Math.max(t.S * 0.16, badge ? d + t.m * 0.5 : 0)), 'bottom', 'left');
  }
  return ink;
};

function textBlocks(c: Content, t: Tokens, color: string, size = t.S * 0.1): Block[] {
  return [
    ...(c.kicker ? [kicker(t, c.kicker, color)] : []),
    headline(t, c.headline, color, size),
    ...(c.body ? [body(t, c.body, color)] : []),
    ...(c.validity ? [body(t, c.validity, color, t.S * 0.03, 'validity')] : []),
    ...(c.price ? [priceBlock(t, c.price, color)] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: t.c.accent }] : []),
  ];
}

const editorial: Compose = (b, c, t, v) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const blocks: Block[] = [
    ...(c.kicker ? [kicker(t, c.kicker, t.c.primary, t.S * 0.018, bg), { kind: 'rule' as const, color: brandInk(bg, t.c.primary, t, true), gap: t.S * 0.035 }] : []),
    headline(t, c.headline, ink, t.S * 0.085, t.S * 0.03, { maxLines: 4 }),
    ...(c.body ? [body(t, c.body, ink)] : []),
    // Los puntos que escribió la persona no se pierden: van como lista editorial
    ...(c.points ?? []).slice(0, 4).map((pt, i, all) => ({ ...body(t, `— ${pt}`, ink, i === all.length - 1 ? t.S * 0.035 : t.S * 0.012, 'point', String(i)), name: `Punto ${i + 1}`, maxLines: 2 })),
    ...(c.price ? [priceBlock(t, c.price, t.c.primary, t.S * 0.03, bg)] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: t.c.primary }] : []),
  ];
  const photo = c.photos[0];
  if (t.orient === 'wide') {
    if (photo) b.image('Foto', photo, { x: t.m, y: t.m, w: t.W * 0.42, h: t.H - 2 * t.m }, { slot: '0', radius: t.radius });
    b.logo(bg);
    b.stack(blocks, { x: photo ? t.W * 0.42 + 2 * t.m : t.m, y: t.m, w: photo ? t.W * 0.58 - 3 * t.m : t.W * 0.7, h: t.H - 2 * t.m }, 'center', 'left');
    return bg;
  }
  if (photo && (v % 2 === 0 || t.orient === 'tall')) {
    // La foto cede alto según cuánto texto hay: así el titular conserva su jerarquía
    const extra = [c.kicker, c.body, c.price, c.cta].filter(Boolean).length + Math.min(2, (c.points ?? []).length);
    const ph = t.H * Math.max(0.3, (t.orient === 'tall' ? 0.42 : t.orient === 'portrait' ? 0.46 : 0.44) - extra * 0.025);
    b.image('Foto', photo, { x: t.m, y: t.safeTop, w: t.W - 2 * t.m, h: ph }, { slot: '0', radius: t.radius });
    b.logo(bg);
    b.stack(blocks, contentBox(t, t.safeTop + ph + t.m * 0.8), 'top', 'left');
  } else if (photo) {
    b.image('Foto', photo, { x: t.W * 0.5, y: t.m, w: t.W * 0.5 - t.m, h: t.H - 2 * t.m }, { slot: '0', radius: t.radius });
    b.logo(bg);
    b.stack(blocks, { x: t.m, y: t.m + t.S * 0.1, w: t.W * 0.5 - 2 * t.m, h: t.H - 2 * t.m - t.S * 0.1 }, 'center', 'left');
  } else {
    b.logo(bg);
    b.stack(blocks, contentBox(t, t.safeTop + t.S * 0.12), 'center', 'left');
  }
  return bg;
};

const STOP = new Set(['de', 'la', 'el', 'en', 'con', 'y', 'a', 'para', 'del', 'al', 'los', 'las', 'por', 'tu', 'tus', 'su', 'sus', 'un', 'una', 'que']);
const OFFER_TOKEN = /(\d+\s?x\s?\d+|\d+(?:[.,]\d+)?\s?%(?:\s+(?:menos|off|de descuento))?|\$\s?[\d.,]+|gratis|sin costo)/i;

/**
 * Divide el titular para el énfasis. Prioridad: la oferta ("2x1", "20 %
 * menos", "gratis", "$9.500"). Si no hay, el final del titular, pero jamás
 * dejando una preposición o artículo colgando ni una palabra suelta corta.
 */
export function emphasisSplit(headline: string): { first: boolean; a: string; emph: string } {
  const h = headline.trim().replace(/\s+/g, ' ');
  const m = h.match(OFFER_TOKEN);
  if (m && m.index !== undefined) {
    const before = h.slice(0, m.index).trim();
    const after = h.slice(m.index + m[0].length).trim();
    if (!before) return { first: true, a: after, emph: m[0] };
    return { first: false, a: before, emph: `${m[0]}${after ? ` ${after}` : ''}` };
  }
  const words = h.split(' ');
  if (words.length < 3) return { first: false, a: h, emph: '' };
  let cut = words.length - (words.at(-1)!.length <= 4 ? 2 : 1);
  while (cut > 1 && STOP.has(words[cut - 1].toLowerCase())) cut--;
  const emph = words.slice(cut).join(' ');
  if (emph.length < 5) return { first: false, a: h, emph: '' };
  return { first: false, a: words.slice(0, cut).join(' '), emph };
}

const typeDominant: Compose = (b, c, t, v) => {
  const bg = solidBg(t, (v + (t.motif === 'BLOCK' ? 1 : 0)) % 2 === 0 ? t.c.primary : t.c.dark);
  const inkC = textOn(bg, t);
  const accent = contrastRatio(bg, t.c.accent) >= 3 ? t.c.accent : inkC;
  b.motif(isDark(bg) ? 'DARK' : 'LIGHT');
  b.logo(bg);
  const { first, a, emph } = emphasisSplit(c.headline);
  const size = t.S * (t.orient === 'wide' ? 0.12 : 0.15);
  const blocks: Block[] = [
    ...(c.kicker ? [kicker(t, c.kicker, accent, t.S * 0.025, bg)] : []),
    ...(first && emph ? [{ ...headline(t, emph, accent, size * 1.15, t.S * 0.005), name: 'Énfasis', slot: 'emphasis' }] : []),
    ...(a ? [{ ...headline(t, a, inkC, size, first || !emph ? t.S * 0.04 : t.S * 0.005), name: 'Titular' }] : []),
    ...(!first && emph ? [{ ...headline(t, emph, accent, size, t.S * 0.04), name: 'Énfasis', slot: 'emphasis' }] : []),
    ...(c.body ? [body(t, c.body, inkC)] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: accent === inkC ? t.c.light : accent }] : []),
  ];
  const box = t.orient === 'wide' ? { x: t.m, y: t.m, w: t.W * 0.7, h: t.H - 2 * t.m } : contentBox(t, t.safeTop + t.S * 0.14);
  b.stack(blocks, box, t.orient === 'wide' ? 'center' : 'bottom', t.align);
  return bg;
};

const catalog: Compose = (b, c, t) => {
  const bg = t.c.light;
  const inkC = textOn(bg, t);
  const items = (c.items ?? []).slice(0, 4);
  b.logo(bg);
  const head = b.stack([...(c.kicker ? [kicker(t, c.kicker, t.c.primary, t.S * 0.025, bg)] : []), headline(t, c.headline, inkC, t.S * 0.07, 0, { maxLines: 2 })],
    { x: t.m, y: t.safeTop + (t.logoPlacement.startsWith('ARRIBA') ? t.S * 0.13 : 0), w: t.W - 2 * t.m, h: t.S * 0.25 }, 'top', 'left');
  const ctaH = c.cta ? t.S * 0.09 + t.m * 0.6 : 0;
  // 2 o 3 productos: una fila de tarjetas altas; 4: retícula 2×2 (en vertical, 2 columnas)
  const n = items.length;
  const cols = t.orient === 'wide' ? n : t.orient === 'tall' ? (n === 3 ? 1 : 2) : n <= 3 ? n : 2;
  const rows = Math.ceil(n / cols);
  const gap = t.S * 0.03;
  const area = { x: t.m, y: head + t.m * 0.6, w: t.W - 2 * t.m, h: t.H - t.safeBottom - (head + t.m * 0.6) - ctaH };
  const cw = (area.w - gap * (cols - 1)) / cols;
  const ch = (area.h - gap * (rows - 1)) / rows;
  const pad = Math.round(t.S * 0.018);
  const nameSize = Math.min(t.S * 0.04, cw * 0.11);
  items.forEach((it, i) => {
    const x = area.x + (i % cols) * (cw + gap);
    // Zona de foto lo más cuadrada posible (las fotos de producto suelen ser cuadradas)
    const textH = nameSize * 1.2 * 2 + nameSize * 1.4 + pad * 2;
    const ph = Math.max(ch * 0.35, Math.min(cw - pad * 2, ch - textH - pad));
    // La tarjeta mide lo que su contenido (sin blanco sobrante) y el conjunto queda centrado en el área
    const cardH = Math.min(ch, pad + ph + textH);
    const yOff = Math.max(0, (area.h - (rows * cardH + gap * (rows - 1))) / 2);
    const y = area.y + yOff + Math.floor(i / cols) * (cardH + gap);
    b.rect('Tarjeta', { x, y, w: cw, h: cardH }, '#FFFFFF', { role: 'decoration', slot: String(i), radius: t.radius, stroke: brandInk('#FFFFFF', t.c.primary, t, true), strokeWidth: 2 });
    if (it.assetId) b.image(`Foto ${i + 1}`, it.assetId, { x: x + pad, y: y + pad, w: cw - pad * 2, h: ph }, { role: 'item-photo', slot: String(i), radius: t.radius });
    else b.rect(`Color ${i + 1}`, { x: x + pad, y: y + pad, w: cw - pad * 2, h: ph }, i % 2 ? t.c.accent : t.c.primary, { role: 'decoration', slot: String(i), radius: t.radius, opacity: 0.85 });
    const ty = y + pad + ph + pad * 0.8;
    const nh = b.text(`Producto ${i + 1}`, it.name, { x: x + pad, y: ty, w: cw - pad * 2, h: nameSize * 2.4 }, { role: 'item-name', slot: String(i), font: t.body, color: textOn('#FFFFFF', t), max: nameSize, min: t.S * 0.026, bold: true, lh: 1.15, maxLines: 2, align: 'left' });
    if (it.price) b.text(`Precio ${i + 1}`, it.price, { x: x + pad, y: ty + nh + pad * 0.3, w: cw - pad * 2, h: nameSize * 1.5 }, { role: 'item-price', slot: String(i), font: t.title, color: brandInk('#FFFFFF', t.c.primary, t), max: nameSize * 1.15, min: t.S * 0.028, bold: true, maxLines: 1, align: 'left' });
  });
  if (c.cta) b.cta(c.cta, t.m, t.H - t.safeBottom - t.S * 0.09, t.W - 2 * t.m, t.c.primary, 'center');
  return bg;
};

const offerBadge: Compose = (b, c, t, v) => {
  const photo = c.photos[0];
  const bg = photo ? t.c.light : t.c.primary;
  const inkO = textOn(bg, t);
  const badgeBg = contrastRatio(bg, t.c.accent) >= 1.5 ? t.c.accent : t.c.dark;
  const d = t.S * (t.orient === 'wide' ? 0.42 : 0.34);
  const badge = (cx: number, cy: number) => {
    b.ellipse('Sello', { x: cx - d / 2, y: cy - d / 2, w: d, h: d }, badgeBg, { role: 'badge' });
    b.text('Precio', c.price ?? '', { x: cx - d * 0.4, y: cy - d * 0.22, w: d * 0.8, h: d * 0.44 }, { role: 'price', font: t.title, color: textOn(badgeBg, t), max: d * 0.3, min: d * 0.14, bold: true, align: 'center', maxLines: 2, lh: 1 });
  };
  const blocks: Block[] = [
    ...(c.kicker ? [kicker(t, c.kicker, photo ? t.c.primary : inkO, t.S * 0.025, bg)] : []),
    headline(t, c.headline, inkO, t.S * 0.085, t.S * 0.025, { maxLines: 3 }),
    ...(c.validity ? [body(t, c.validity, inkO, t.S * 0.035, 'validity')] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: photo ? t.c.primary : t.c.dark }] : []),
  ];
  if (t.orient === 'wide') {
    if (photo) b.image('Foto', photo, { x: 0, y: 0, w: t.W * 0.48, h: t.H }, { slot: '0' });
    else b.motif('BRAND');
    b.logo(bg);
    badge(photo ? t.W * 0.48 : t.W * 0.78, photo ? t.H * 0.32 : t.H / 2);
    b.stack(blocks, { x: photo ? t.W * 0.48 + d * 0.6 : t.m, y: t.m, w: photo ? t.W * 0.52 - d * 0.6 - t.m : t.W * 0.5, h: t.H - 2 * t.m }, 'center', 'left');
    return bg;
  }
  if (photo) {
    const ph = t.H * (t.orient === 'tall' ? 0.46 : t.orient === 'portrait' ? 0.44 : 0.4);
    b.image('Foto', photo, { x: 0, y: 0, w: t.W, h: ph }, { slot: '0' });
    b.logo(bg);
    // El sello monta el borde de la foto; el texto va en la columna libre a su lado (no debajo)
    const right = v % 2 === 0;
    badge(right ? t.W - t.m - d / 2 : t.m + d / 2, ph);
    const colX = right ? t.m : t.m + d + t.m * 0.5;
    const colW = t.W - 2 * t.m - d - t.m * 0.5;
    if (t.orient === 'tall') b.stack(blocks, contentBox(t, ph + d / 2 + t.m), 'top', 'left');
    else b.stack(blocks, { x: colX, y: ph + t.m * 0.7, w: colW, h: t.H - ph - t.m * 0.7 - t.safeBottom }, 'top', 'left');
  } else {
    b.motif('BRAND');
    b.logo(bg);
    const top = b.stack(blocks.slice(0, c.kicker ? 2 : 1), contentBox(t, t.safeTop + t.S * 0.14), 'top', 'center');
    badge(t.W / 2, top + d * 0.65);
    b.stack(blocks.slice(c.kicker ? 2 : 1), contentBox(t, top + d * 1.25), 'top', 'center');
  }
  return bg;
};

/** Oferta 2 (marcas enérgicas): el precio o descuento ES el diseño, enorme y arriba. */
const offerPrice: Compose = (b, c, t) => {
  const bg = isDark(t.c.primary) ? t.c.primary : t.c.dark;
  const ink = textOn(bg, t);
  const hot = brandInk(bg, t.c.accent, t, true);
  b.motif('DARK');
  b.logo(bg);
  const photo = c.photos[0];
  const wide = t.orient === 'wide';
  if (photo) {
    if (wide) b.image('Foto', photo, { x: t.W * 0.62, y: 0, w: t.W * 0.38, h: t.H }, { slot: '0' });
    else b.image('Foto', photo, { x: 0, y: t.H - t.safeBottom - t.H * 0.26 + t.safeBottom, w: t.W, h: t.H * 0.26 }, { slot: '0' });
  }
  const box = wide ? { x: t.m, y: t.m, w: t.W * (photo ? 0.55 : 0.8), h: t.H - 2 * t.m } : contentBox(t, t.safeTop + t.S * 0.15, photo ? t.H * 0.26 + t.m * 0.6 : t.safeBottom);
  b.stack([
    ...(c.kicker ? [kicker(t, c.kicker, hot, t.S * 0.02, bg)] : []),
    { kind: 'text' as const, name: 'Precio', text: c.price ?? '', role: 'price' as ElementRole, font: t.title, color: hot, max: t.S * (wide ? 0.24 : 0.3), min: t.S * 0.12, bold: true, upper: t.upper, lh: 0.95, maxLines: 2, gap: t.S * 0.02 },
    headline(t, c.headline, ink, t.S * 0.075, t.S * 0.025, { maxLines: 3 }),
    ...(c.validity ? [body(t, c.validity, ink, t.S * 0.035, 'validity')] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: hot === ink ? t.c.light : hot }] : []),
  ], box, wide ? 'center' : 'center', 'left');
  return bg;
};

/** Oferta 3 (marcas refinadas): marco fino, todo centrado y contenido; el precio en una línea elegante. */
const offerRefined: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const line = brandInk(bg, t.c.primary, t, true);
  const inset = t.m * 0.55;
  b.rect('Marco', { x: inset, y: inset + (t.orient === 'tall' ? t.safeTop - t.m : 0), w: t.W - inset * 2, h: t.H - inset * 2 - (t.orient === 'tall' ? t.safeTop + t.safeBottom - 2 * t.m : 0) }, '#00000000', { role: 'decoration', stroke: line, strokeWidth: Math.max(2, Math.round(t.S * 0.003)) });
  b.logo(bg);
  const photo = c.photos[0];
  const ps = t.S * (t.orient === 'wide' ? 0.36 : 0.24);
  const serif = ['Playfair Display', 'Lora', 'DM Serif Display'].includes(t.title);
  let top = t.safeTop + t.S * 0.12;
  if (photo && t.orient !== 'wide') {
    b.image('Foto', photo, { x: (t.W - ps) / 2, y: top, w: ps, h: ps }, { slot: '0', radius: ps / 2 });
    top += ps + t.m * 0.5;
  } else if (photo) b.image('Foto', photo, { x: t.m * 1.5, y: (t.H - ps) / 2, w: ps, h: ps }, { slot: '0', radius: ps / 2 });
  const box = t.orient === 'wide' && photo ? { x: t.m * 2 + ps, y: t.m, w: t.W - ps - t.m * 3.5, h: t.H - 2 * t.m } : contentBox(t, top, t.safeBottom + t.m * 0.4);
  b.stack([
    ...(c.kicker ? [kicker(t, c.kicker, line, t.S * 0.02, bg)] : []),
    headline(t, c.headline, ink, t.S * 0.06, t.S * 0.025, { maxLines: 3, italic: serif }),
    { kind: 'rule' as const, color: line, gap: t.S * 0.03 },
    { kind: 'text' as const, name: 'Precio', text: c.price ?? '', role: 'price' as ElementRole, font: t.title, color: brandInk(bg, t.c.primary, t), max: t.S * 0.11, min: t.S * 0.06, bold: false, maxLines: 2, gap: t.S * 0.02 },
    ...(c.validity ? [body(t, c.validity, ink, t.S * 0.035, 'validity')] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: t.c.primary }] : []),
  ], box, 'center', t.orient === 'wide' && photo ? 'left' : 'center');
  return bg;
};

const offer: Compose = (b, c, t, v) => (v === 2 ? offerPrice(b, c, t, v) : v === 3 ? offerRefined(b, c, t, v) : offerBadge(b, c, t, v));

function listRows(b: Builder, t: Tokens, rows: string[], box: Box, ink: string, kind: 'square' | 'number') {
  const gap = t.S * 0.035;
  const rowH = (box.h - gap * (rows.length - 1)) / rows.length;
  rows.forEach((text, i) => {
    const y = box.y + i * (rowH + gap);
    const mk = t.S * (kind === 'number' ? 0.075 : 0.04);
    if (kind === 'number') {
      b.ellipse('Número', { x: box.x, y, w: mk, h: mk }, t.c.primary, { slot: String(i) });
      b.text('Número', String(i + 1), { x: box.x, y: y + mk * 0.18, w: mk, h: mk * 0.7 }, { role: 'decoration', slot: String(i), font: t.title, color: textOn(t.c.primary, t), max: mk * 0.55, min: mk * 0.3, bold: true, align: 'center', maxLines: 1, lh: 1 });
    } else b.rect('Marca', { x: box.x, y: y + t.S * 0.01, w: mk, h: mk }, t.c.accent, { role: 'decoration', slot: String(i), radius: t.radius ? mk / 2 : 0 });
    b.text(`Punto ${i + 1}`, text, { x: box.x + mk + t.S * 0.035, y, w: box.w - mk - t.S * 0.035, h: rowH }, { role: 'point', slot: String(i), font: t.body, color: ink, max: t.S * 0.042, min: t.S * 0.027, lh: 1.3, maxLines: 3, align: 'left' });
  });
}

const benefits: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  b.motif('LIGHT');
  b.logo(bg);
  const pts = (c.points ?? []).slice(0, 4);
  const photo = c.photos[0];
  const textW = photo && t.orient !== 'tall' ? (t.W - 2 * t.m) * 0.58 : t.W - 2 * t.m;
  if (photo && t.orient !== 'tall') b.image('Foto', photo, { x: t.m + textW + t.m * 0.6, y: t.m, w: t.W - 2 * t.m - textW - t.m * 0.6, h: t.H - 2 * t.m }, { slot: '0', radius: t.radius });
  const top = b.stack([...(c.kicker ? [kicker(t, c.kicker, t.c.primary, t.S * 0.025, bg)] : []), headline(t, c.headline, ink0(bg, t), t.S * 0.075, 0, { maxLines: 3 })],
    { x: t.m, y: t.safeTop + t.S * 0.13, w: textW, h: t.H * 0.3 }, 'top', 'left');
  const ctaH = c.cta ? t.S * 0.09 + t.m * 0.5 : 0;
  listRows(b, t, pts, { x: t.m, y: top + t.m * 0.7, w: textW, h: Math.min(pts.length * t.S * 0.13, t.H - t.safeBottom - top - t.m * 0.7 - ctaH) }, ink, 'square');
  if (c.cta) b.cta(c.cta, t.m, t.H - t.safeBottom - t.S * 0.09, textW, t.c.primary, 'left');
  return bg;
};

function quoteBlocks(c: Content, t: Tokens, ink: string, mark: string, o: { size: number; serif: boolean; align: 'left' | 'center'; upper?: boolean; font?: string }): Block[] {
  return [
    { kind: 'text', name: 'Testimonio', text: c.quote ?? c.headline, role: 'quote', font: o.font ?? (o.serif ? t.title : t.body), color: ink, max: o.size, min: t.S * 0.034, italic: !o.upper, upper: o.upper, lh: o.upper ? 1.05 : 1.3, maxLines: 7, gap: t.S * 0.035 },
    { kind: 'rule', color: mark, gap: t.S * 0.02 },
    { kind: 'text', name: 'Autor', text: c.author ?? '', role: 'author', font: t.body, color: ink, max: t.S * 0.036, min: t.S * 0.026, bold: true, maxLines: 2 },
  ];
}

/**
 * Testimonio. Cuatro estructuras según el carácter de la marca:
 * 0 tarjeta con comillas y avatar (clara), 1 centrado y aireado (refinada),
 * 2 foto + panel de cita (cálida, si hay foto), 3 cita como titular (enérgica).
 */
const testimonial: Compose = (b, c, t, v0) => {
  const photo = c.photos[0];
  const v = v0 === 2 && !photo ? 1 : v0;
  const serif = ['Playfair Display', 'Lora', 'DM Serif Display'].includes(t.title);
  const wide = t.orient === 'wide';
  if (v === 2) {
    const panel = t.c.primary;
    const ink = textOn(panel, t);
    const split = wide || t.orient === 'square';
    const pw = t.W * (wide ? 0.4 : 0.46);
    const pr = split ? { x: t.mirror ? t.W - pw : 0, y: 0, w: pw, h: t.H } : { x: 0, y: 0, w: t.W, h: t.H * 0.45 };
    b.image('Foto', photo!, pr, { slot: '0' });
    const panelBox = split ? { x: t.mirror ? 0 : pw, y: 0, w: t.W - pw, h: t.H } : { x: 0, y: pr.h, w: t.W, h: t.H - pr.h };
    b.rect('Panel', panelBox, panel, { role: 'brand-color' });
    b.logo(panel);
    const mark = brandInk(panel, t.c.accent, t, true);
    const pad = t.m * 0.9;
    b.text('Comillas', '“', { x: panelBox.x + pad, y: Math.max(panelBox.y + pad, t.safeTop * (split ? 1 : 0)), w: t.S * 0.2, h: t.S * 0.16 }, { role: 'decoration', font: 'Playfair Display', color: mark, max: t.S * 0.2, min: t.S * 0.14, align: 'left', lh: 0.9, maxLines: 1 });
    b.stack(quoteBlocks(c, t, ink, mark, { size: t.S * (split ? 0.055 : 0.065), serif, align: 'left' }),
      { x: panelBox.x + pad, y: panelBox.y + pad + t.S * 0.14, w: panelBox.w - pad * 2, h: panelBox.h - pad * 2 - t.S * 0.14 - (split ? 0 : t.safeBottom - t.m) }, 'center', 'left');
    return panel;
  }
  if (v === 3) {
    const bg = isDark(t.c.primary) ? t.c.primary : t.c.dark;
    const ink = textOn(bg, t);
    const mark = brandInk(bg, t.c.accent, t, true);
    b.text('Comillas', '“', { x: t.W - t.S * 0.55, y: t.safeTop - t.S * 0.1, w: t.S * 0.6, h: t.S * 0.5 }, { role: 'decoration', font: 'Playfair Display', color: mark, max: t.S * 0.6, min: t.S * 0.4, align: 'right', lh: 0.9, maxLines: 1, opacity: 0.35 });
    b.logo(bg);
    const ps = t.S * 0.17;
    if (photo) b.image('Foto', photo, { x: t.m, y: t.H - t.safeBottom - ps, w: ps, h: ps }, { slot: '0', radius: t.radius ? ps / 2 : 0 });
    b.stack([
      { kind: 'text', name: 'Autor', text: c.author ?? '', role: 'author', font: t.body, color: mark, max: t.S * 0.032, min: t.S * 0.025, bold: true, upper: true, maxLines: 1, gap: t.S * 0.03 },
      { kind: 'text', name: 'Testimonio', text: c.quote ?? c.headline, role: 'quote', font: t.title, color: ink, max: t.S * (wide ? 0.11 : 0.095), min: t.S * 0.045, bold: t.titleBold, upper: t.upper, lh: t.upper ? 1.02 : 1.1, maxLines: 6 },
    ], wide ? { x: t.m, y: t.m, w: t.W * 0.75, h: t.H - 2 * t.m } : contentBox(t, t.safeTop + t.S * 0.2, t.safeBottom + (photo ? ps + t.m * 0.5 : 0)), 'center', 'left');
    return bg;
  }
  const bg = v === 1 ? t.c.light : (isDark(t.c.primary) || luminance(t.c.primary) > 0.6 ? t.c.primary : t.c.light);
  const ink = textOn(bg, t);
  const mark = brandInk(bg, t.c.accent, t, true);
  b.logo(bg);
  const align: 'left' | 'center' = v === 1 ? 'center' : 'left';
  const ps = t.S * (v === 1 ? 0.18 : 0.14);
  const box = wide ? { x: t.m + (photo ? ps + t.m : 0), y: t.m, w: t.W - 2 * t.m - (photo ? ps + t.m : 0), h: t.H - 2 * t.m } : contentBox(t, t.safeTop + t.S * 0.1);
  if (wide && photo) b.image('Foto', photo, { x: t.m, y: (t.H - ps) / 2, w: ps, h: ps }, { slot: '0', radius: ps / 2 });
  const blocks: Block[] = [
    { kind: 'text', name: 'Comillas', text: '“', role: 'decoration', font: 'Playfair Display', color: mark, max: t.S * (v === 1 ? 0.24 : 0.2), min: t.S * 0.12, lh: 0.75, maxLines: 1, gap: t.S * 0.01 },
    ...quoteBlocks(c, t, ink, mark, { size: t.S * (v === 1 ? 0.07 : 0.065), serif, align }),
  ];
  if (!wide && photo) blocks.splice(0, 0, { kind: 'space', h: ps + t.S * 0.03 });
  const end = b.stack(blocks, box, 'center', align);
  if (!wide && photo) {
    // El avatar va justo encima de las comillas (se calcula después de apilar para centrar el bloque entero)
    const total = end - box.y;
    void total;
    const first = b.els.find((e) => e.name === 'Comillas' && e.role === 'decoration');
    const y = (first?.y ?? box.y + ps) - ps - t.S * 0.03;
    b.image('Foto', photo, { x: align === 'center' ? (t.W - ps) / 2 : box.x, y, w: ps, h: ps }, { slot: '0', radius: ps / 2 });
  }
  return bg;
};

const tipsBand: Compose = (b, c, t, v) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  if (v % 2 === 0) b.rect('Franja lateral', { x: 0, y: 0, w: Math.round(t.S * 0.035), h: t.H }, t.c.primary, { role: 'decoration' });
  else b.rect('Franja superior', { x: 0, y: 0, w: t.W, h: Math.round(t.S * 0.035) }, t.c.primary, { role: 'decoration' });
  b.text('Índice', '01', { x: t.W - t.m - t.S * 0.3, y: t.H - t.safeBottom - t.S * 0.24, w: t.S * 0.3, h: t.S * 0.24 }, { role: 'decoration', font: t.title, color: t.c.accent, max: t.S * 0.22, min: t.S * 0.15, bold: true, align: 'right', opacity: 0.22, maxLines: 1, lh: 1 });
  b.logo(bg);
  b.stack([
    kicker(t, c.kicker ?? 'Consejo', t.c.primary, t.S * 0.025, bg),
    headline(t, c.headline, ink, t.S * 0.08, t.S * 0.04, { maxLines: 4 }),
    ...(c.body ? [{ ...body(t, c.body, ink), max: t.S * 0.044 }] : []),
  ], { x: t.m + t.S * 0.03, y: t.safeTop + t.S * 0.13, w: t.W - 2 * t.m - t.S * 0.03, h: t.H - t.safeTop - t.safeBottom - t.S * 0.38 }, 'top', 'left');
  return bg;
};

/** Consejo cálido: número grande como estructura y tarjeta clara. */
const tipsIndex: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const big = brandInk(bg, t.c.primary, t, true);
  b.motif('LIGHT');
  b.logo(bg);
  const wide = t.orient === 'wide';
  const n = t.S * (wide ? 0.42 : 0.3);
  if (wide) b.text('Índice', '01', { x: t.m, y: (t.H - n) / 2, w: n * 1.2, h: n }, { role: 'decoration', font: t.title, color: big, max: n, min: n * 0.6, bold: true, align: 'left', maxLines: 1, lh: 1 });
  const box = wide ? { x: t.m * 2 + n * 1.2, y: t.m, w: t.W - n * 1.2 - t.m * 3, h: t.H - 2 * t.m } : contentBox(t, t.safeTop + t.S * 0.12);
  b.stack([
    ...(wide ? [] : [{ kind: 'text' as const, name: 'Índice', text: '01', role: 'decoration' as ElementRole, font: t.title, color: big, max: n, min: n * 0.6, bold: true, lh: 0.9, maxLines: 1, gap: t.S * 0.02 }]),
    kicker(t, c.kicker ?? 'Consejo', big, t.S * 0.02, bg),
    headline(t, c.headline, ink, t.S * 0.08, t.S * 0.035, { maxLines: 4 }),
    ...(c.body ? [{ ...body(t, c.body, ink), max: t.S * 0.045 }] : []),
  ], box, 'center', 'left');
  return bg;
};

/** Consejo enérgico: fondo de marca, etiqueta en bloque y titular grande. */
const tipsBold: Compose = (b, c, t) => {
  const bg = isDark(t.c.primary) ? t.c.primary : t.c.dark;
  const ink = textOn(bg, t);
  const hot = brandInk(bg, t.c.accent, t, true);
  b.motif('DARK');
  b.logo(bg);
  const label = (c.kicker ?? 'Consejo').toUpperCase();
  const lh = t.S * 0.07;
  const lw = Math.min(t.W - 2 * t.m, label.length * t.S * 0.028 + lh);
  const box = t.orient === 'wide' ? { x: t.m, y: t.m + lh + t.S * 0.04, w: t.W * 0.75, h: t.H - 2 * t.m - lh - t.S * 0.04 } : contentBox(t, t.safeTop + t.S * 0.16 + lh + t.S * 0.04);
  b.rect('Etiqueta fondo', { x: t.m, y: box.y - lh - t.S * 0.04, w: lw, h: lh }, hot === ink ? t.c.light : hot, { role: 'decoration', radius: t.radius ? lh / 2 : 0 });
  b.text('Etiqueta', label, { x: t.m + lh * 0.3, y: box.y - lh - t.S * 0.04 + lh * 0.22, w: lw - lh * 0.6, h: lh * 0.6 }, { role: 'kicker', font: t.body, color: textOn(hot === ink ? t.c.light : hot, t), max: t.S * 0.03, min: t.S * 0.024, bold: true, align: 'center', maxLines: 1, lh: 1.2 });
  b.stack([
    headline(t, c.headline, ink, t.S * 0.11, t.S * 0.04, { maxLines: 5 }),
    ...(c.body ? [{ ...body(t, c.body, ink), max: t.S * 0.044 }] : []),
  ], box, 'top', 'left');
  return bg;
};

const tips: Compose = (b, c, t, v) => (v === 2 ? tipsIndex(b, c, t, v) : v === 3 ? tipsBold(b, c, t, v) : tipsBand(b, c, t, v));

const steps: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  b.logo(bg);
  const pts = (c.points ?? []).slice(0, 4);
  const top = b.stack([...(c.kicker ? [kicker(t, c.kicker, t.c.primary, t.S * 0.025, bg)] : []), headline(t, c.headline, ink0(bg, t), t.S * 0.075, 0, { maxLines: 3 })],
    { x: t.m, y: t.safeTop + t.S * 0.13, w: t.W - 2 * t.m, h: t.H * 0.28 }, 'top', 'left');
  const ctaH = c.cta ? t.S * 0.09 + t.m * 0.5 : 0;
  if (t.orient === 'wide') {
    const gap = t.S * 0.04;
    const cw = (t.W - 2 * t.m - gap * (pts.length - 1)) / pts.length;
    pts.forEach((p, i) => {
      const x = t.m + i * (cw + gap);
      const mk = t.S * 0.09;
      b.ellipse('Número', { x, y: top + t.m * 0.5, w: mk, h: mk }, t.c.primary, { slot: String(i) });
      b.text('Número', String(i + 1), { x, y: top + t.m * 0.5 + mk * 0.18, w: mk, h: mk * 0.7 }, { role: 'decoration', slot: String(i), font: t.title, color: textOn(t.c.primary, t), max: mk * 0.55, min: mk * 0.3, bold: true, align: 'center', maxLines: 1, lh: 1 });
      b.text(`Paso ${i + 1}`, p, { x, y: top + t.m * 0.5 + mk + t.S * 0.03, w: cw, h: t.H - top - mk - t.m * 1.5 - ctaH }, { role: 'point', slot: String(i), font: t.body, color: ink, max: t.S * 0.045, min: t.S * 0.028, lh: 1.3, maxLines: 4, align: 'left' });
    });
  } else listRows(b, t, pts, { x: t.m, y: top + t.m * 0.7, w: t.W - 2 * t.m, h: Math.min(pts.length * t.S * 0.15, t.H - t.safeBottom - top - t.m * 0.7 - ctaH) }, ink, 'number');
  if (c.cta) b.cta(c.cta, t.m, t.H - t.safeBottom - t.S * 0.09, t.W - 2 * t.m, t.c.primary, 'left');
  return bg;
};

const event: Compose = (b, c, t, v) => {
  const photo = c.photos[0];
  const withPhoto = !!photo && v % 2 === 0;
  const bg = withPhoto ? t.c.dark : t.c.light;
  if (withPhoto) {
    b.image('Foto', photo!, { x: 0, y: 0, w: t.W, h: t.H }, { slot: '0' });
    b.rect('Velo', { x: 0, y: 0, w: t.W, h: t.H }, t.c.dark, { role: 'overlay', opacity: 0.58 });
  } else b.motif('LIGHT');
  const ink = withPhoto ? '#FFFFFF' : textOn(bg, t);
  b.logo(bg);
  const ds = t.S * (t.orient === 'wide' ? 0.36 : 0.3);
  const dx = t.orient === 'wide' ? t.m : t.align === 'center' ? (t.W - ds) / 2 : t.m;
  const dy = t.orient === 'wide' ? (t.H - ds) / 2 : t.safeTop + t.S * 0.13;
  b.rect('Bloque fecha', { x: dx, y: dy, w: ds, h: ds }, t.c.accent, { role: 'decoration', radius: t.radius });
  const dateInk = textOn(t.c.accent, t);
  b.text('Día', c.date?.day ?? '', { x: dx, y: dy + ds * 0.1, w: ds, h: ds * 0.55 }, { role: 'date', slot: 'day', font: t.title, color: dateInk, max: ds * 0.5, min: ds * 0.3, bold: true, align: 'center', maxLines: 1, lh: 1 });
  b.text('Mes', c.date?.month ?? '', { x: dx, y: dy + ds * 0.66, w: ds, h: ds * 0.22 }, { role: 'date', slot: 'month', font: t.body, color: dateInk, max: ds * 0.15, min: ds * 0.1, bold: true, align: 'center', upper: true, maxLines: 1, lh: 1 });
  const blocks: Block[] = [
    headline(t, c.headline, ink, t.S * 0.085, t.S * 0.03, { maxLines: 3 }),
    ...(c.place ? [body(t, c.place, ink, t.S * 0.03, 'place')] : []),
    ...(c.body ? [body(t, c.body, ink)] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: t.c.accent }] : []),
  ];
  if (t.orient === 'wide') b.stack(blocks, { x: dx + ds + t.m, y: t.m, w: t.W - dx - ds - 2 * t.m, h: t.H - 2 * t.m }, 'center', 'left');
  else b.stack(blocks, contentBox(t, dy + ds + t.m * 0.8), 'top', t.align);
  return bg;
};

const modular: Compose = (b, c, t, v) => {
  const g = Math.round(t.S * 0.018);
  const bg = t.c.light;
  const photos = c.photos;
  const cells: Box[] = t.orient === 'wide'
    ? [{ x: 0, y: 0, w: t.W * 0.36, h: t.H }, { x: t.W * 0.36 + g, y: 0, w: t.W * 0.34 - g, h: t.H }, { x: t.W * 0.7 + g, y: 0, w: t.W * 0.3 - g, h: t.H * 0.55 }, { x: t.W * 0.7 + g, y: t.H * 0.55 + g, w: t.W * 0.3 - g, h: t.H * 0.45 - g }]
    : t.orient === 'tall'
      ? [{ x: 0, y: 0, w: t.W, h: t.H * 0.42 }, { x: 0, y: t.H * 0.42 + g, w: t.W, h: t.H * 0.3 - g }, { x: 0, y: t.H * 0.72 + g, w: t.W * 0.55, h: t.H * 0.28 - g }, { x: t.W * 0.55 + g, y: t.H * 0.72 + g, w: t.W * 0.45 - g, h: t.H * 0.28 - g }]
      : [{ x: 0, y: 0, w: t.W * 0.55, h: t.H * 0.58 }, { x: t.W * 0.55 + g, y: 0, w: t.W * 0.45 - g, h: t.H * 0.58 }, { x: 0, y: t.H * 0.58 + g, w: t.W * 0.42, h: t.H * 0.42 - g }, { x: t.W * 0.42 + g, y: t.H * 0.58 + g, w: t.W * 0.58 - g, h: t.H * 0.42 - g }];
  // Orden de los módulos: foto principal, titular, foto o color, cierre (varía con la variante)
  const order = v % 2 === 0 ? [0, 1, 2, 3] : [1, 0, 3, 2];
  const [pA, head, pB, close] = order.map((i) => cells[i]);
  b.image('Foto', photos[0], pA, { slot: '0' });
  b.rect('Módulo titular', head, t.c.primary, { role: 'brand-color' });
  const hi = textOn(t.c.primary, t);
  const pad = t.S * 0.045;
  b.stack([...(c.kicker ? [kicker(t, c.kicker, hi)] : []), headline(t, c.headline, hi, t.S * 0.075, 0, { maxLines: 4 })],
    { x: head.x + pad, y: head.y + Math.max(pad, head.y < t.safeTop ? t.safeTop - head.y : 0), w: head.w - 2 * pad, h: head.h - 2 * pad }, 'center', 'left');
  if (photos[1]) b.image('Foto 2', photos[1], pB, { slot: '1' });
  else b.rect('Módulo color', pB, t.c.accent, { role: 'decoration' });
  b.rect('Módulo cierre', close, t.c.dark, { role: 'decoration' });
  const lo = textOn(t.c.dark, t);
  const closeTop = close.y + pad;
  const closeBottom = Math.min(close.y + close.h - pad, t.H - t.safeBottom);
  b.stack([
    ...(c.price ? [priceBlock(t, c.price, lo, t.S * 0.02)] : c.body ? [body(t, c.body, lo, t.S * 0.02)] : []),
    ...(c.cta ? [{ kind: 'cta' as const, text: c.cta, bg: t.c.accent }] : []),
  ], { x: close.x + pad, y: closeTop, w: close.w - 2 * pad, h: closeBottom - closeTop }, 'center', 'left');
  b.logo(bg);
  return bg;
};

const corporateBars: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const barH = Math.round(t.safeTop + t.S * 0.12);
  b.rect('Barra superior', { x: 0, y: 0, w: t.W, h: barH }, t.c.primary, { role: 'brand-color' });
  const onBar = textOn(t.c.primary, t);
  if (c.kicker) b.text('Etiqueta', c.kicker, { x: t.m, y: barH - t.S * 0.08, w: t.W * 0.6, h: t.S * 0.05 }, { role: 'kicker', font: t.body, color: onBar, max: t.S * 0.03, min: t.S * 0.022, bold: true, upper: true, maxLines: 1, align: 'left' });
  const logo = { ...t, logoPlacement: 'ARRIBA_DERECHA' as const, safeTop: t.orient === 'tall' ? t.safeTop : Math.max(t.m * 0.6, barH - t.S * 0.12 - t.m * 0.2) };
  const lb = new Builder(logo, b.dims);
  lb.logo(t.c.primary);
  b.els.push(...lb.els.map((e, i) => ({ ...e, id: `lg${i}` })));
  const footH = Math.round(t.safeBottom + t.S * 0.12);
  const top = b.stack([headline(t, c.headline, ink, t.S * 0.072, t.S * 0.02, { maxLines: 3 }), { kind: 'rule', color: t.c.accent, gap: t.S * 0.035 }],
    { x: t.m, y: barH + t.m, w: t.W - 2 * t.m, h: t.H * 0.3 }, 'top', 'left');
  const pts = pointsOf(c);
  if (pts.length) listRows(b, t, pts, { x: t.m, y: top, w: t.W - 2 * t.m, h: Math.min(pts.length * t.S * 0.12, t.H - footH - top - t.m) }, ink, 'square');
  b.rect('Barra inferior', { x: 0, y: t.H - footH, w: t.W, h: footH }, t.c.dark, { role: 'decoration' });
  if (c.cta) b.text('Llamada a la acción', c.cta, { x: t.m, y: t.H - footH + t.S * 0.035, w: t.W - 2 * t.m, h: t.S * 0.06 }, { role: 'cta', font: t.body, color: textOn(t.c.dark, t), max: t.S * 0.036, min: t.S * 0.026, bold: true, maxLines: 1, align: 'left' });
  return bg;
};

const pointsOf = (c: Content) => (c.points?.length ? c.points : (c.body ?? '').split(/\n|\. /).map((x) => x.trim()).filter(Boolean)).slice(0, 4);

/** Informativo en dos paneles: bloque de marca con el titular y lista numerada al lado (o debajo). */
const corporateSplit: Compose = (b, c, t) => {
  const panel = t.c.primary;
  const onPanel = textOn(panel, t);
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const side = t.orient === 'wide' || t.orient === 'square';
  const pw = t.W * 0.44;
  // Panel a la izquierda o a la derecha según la marca (espejo)
  const pr = side ? { x: t.mirror ? t.W - pw : 0, y: 0, w: pw, h: t.H } : { x: 0, y: 0, w: t.W, h: t.H * 0.4 };
  b.rect('Panel', pr, panel, { role: 'brand-color' });
  b.logo(side && !t.mirror ? bg : panel);
  b.stack([
    ...(c.kicker ? [kicker(t, c.kicker, brandInk(panel, t.c.accent, t), t.S * 0.02, panel)] : []),
    headline(t, c.headline, onPanel, t.S * 0.08, 0, { maxLines: 6 }),
  ], side ? { x: pr.x + t.m, y: t.m + t.S * 0.12, w: pw - 2 * t.m, h: t.H - 2 * t.m - t.S * 0.12 } : { x: t.m, y: t.safeTop + t.S * 0.12, w: t.W - 2 * t.m, h: pr.h - t.safeTop - t.S * 0.12 - t.m * 0.5 }, side ? 'center' : 'bottom', 'left');
  const pts = pointsOf(c);
  const ctaH = c.cta ? t.S * 0.09 + t.m * 0.5 : 0;
  const box = side ? { x: (t.mirror ? 0 : pw) + t.m * 0.8, y: t.m + t.S * 0.14, w: t.W - pw - t.m * 1.8, h: t.H - t.m * 2 - t.S * 0.14 - ctaH } : { x: t.m, y: pr.h + t.m, w: t.W - 2 * t.m, h: t.H - pr.h - t.m - t.safeBottom - ctaH };
  if (pts.length) listRows(b, t, pts, { x: box.x, y: box.y, w: box.w, h: Math.min(box.h, pts.length * t.S * 0.15) }, ink, 'number');
  if (c.cta) b.cta(c.cta, box.x, t.H - t.safeBottom - t.S * 0.09, box.w, t.c.primary, 'left');
  return bg;
};

/** Informativo refinado: todo centrado, puntos separados por líneas finas. */
const corporateRefined: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const line = brandInk(bg, t.c.primary, t, true);
  b.logo(bg);
  const serif = ['Playfair Display', 'Lora', 'DM Serif Display'].includes(t.title);
  const pts = pointsOf(c);
  const blocks: Block[] = [
    ...(c.kicker ? [kicker(t, c.kicker, line, t.S * 0.02, bg)] : []),
    headline(t, c.headline, ink, t.S * 0.075, t.S * 0.03, { maxLines: 3, italic: serif }),
    { kind: 'rule', color: line, gap: t.S * 0.035 },
    ...pts.map((pt, i) => ({ ...body(t, pt, ink, t.S * 0.022, 'point', String(i)), name: `Punto ${i + 1}`, maxLines: 2 })),
    ...(c.cta ? [{ kind: 'space' as const, h: t.S * 0.02 }, { kind: 'cta' as const, text: c.cta, bg: t.c.primary }] : []),
  ];
  b.stack(blocks, t.orient === 'wide' ? { x: t.W * 0.15, y: t.m, w: t.W * 0.7, h: t.H - 2 * t.m } : contentBox(t, t.safeTop + t.S * 0.12), 'center', 'center');
  return bg;
};

const corporate: Compose = (b, c, t, v) => (v === 1 ? corporateSplit(b, c, t, v) : v === 2 ? corporateRefined(b, c, t, v) : corporateBars(b, c, t, v));

const COMPOSERS: Record<Family, Compose> = {
  HERO_PHOTO: heroPhoto, EDITORIAL: editorial, TYPE_DOMINANT: typeDominant, CATALOG: catalog, OFFER: offer, BENEFITS: benefits,
  TESTIMONIAL: testimonial, TIPS: tips, STEPS: steps, EVENT: event, MODULAR: modular, CORPORATE_INFO: corporate,
};

/** Compone un documento editable e informa qué bloques no entraron (si alguno). */
export function composeWithReport(family: Family, t: Tokens, content: Content, variant: number, dims: AssetDims): { doc: DesignDoc; omitted: string[] } {
  const b = new Builder(t, dims);
  const bg = COMPOSERS[family](b, content, t, variant);
  // Los elementos de fondo (fotos a sangre, bandas, decoración) van primero: se respeta el orden de creación
  return { doc: { schemaVersion: DESIGN_SCHEMA_VERSION, format: t.format, width: t.W, height: t.H, background: { color: bg, assetId: null }, elements: b.els }, omitted: [...new Set(b.omitted)] };
}

export function compose(family: Family, t: Tokens, content: Content, variant: number, dims: AssetDims): DesignDoc {
  return composeWithReport(family, t, content, variant, dims).doc;
}
