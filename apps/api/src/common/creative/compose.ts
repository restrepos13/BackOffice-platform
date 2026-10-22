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
    const dropOrder: ElementRole[] = ['body', 'kicker', 'validity', 'place', 'price'];
    for (let round = 0; round <= dropOrder.length; round++) {
      let scale = 1;
      for (let attempt = 0; attempt < 5; attempt++) {
        const h = list.reduce((sum, b) => sum + measure(b, box.w, scale, this.t) + (b.gap ?? 0), 0);
        if (h <= box.h) return this.place(list, box, valign, align, scale, h);
        scale *= 0.88;
      }
      const role = dropOrder[round];
      const victim = list.find((b) => b.kind === 'text' && b.role === role);
      if (!victim || round === dropOrder.length) break;
      this.omitted.push((victim as TextBlock).name);
      list = list.filter((b) => b !== victim);
    }
    // Ni así entra: se dibuja reducido al mínimo y el control de calidad lo señalará
    const h = list.reduce((sum, b) => sum + measure(b, box.w, 0.6, this.t) + (b.gap ?? 0), 0);
    return this.place(list, box, valign, align, 0.6, h);
  }

  private place(list: Block[], box: Box, valign: 'top' | 'center' | 'bottom', align: 'left' | 'center', scale: number, h: number) {
    let y = valign === 'top' ? box.y : valign === 'bottom' ? box.y + box.h - h : box.y + (box.h - h) / 2;
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

const heroPhoto: Compose = (b, c, t, v) => {
  const ink = isDark(t.c.primary) ? t.c.primary : t.c.dark;
  const textCol = textOn(ink, t);
  if (t.orient === 'wide') {
    b.image('Foto', c.photos[0], { x: t.W * 0.45, y: 0, w: t.W * 0.55, h: t.H }, { slot: '0' });
    b.rect('Panel', { x: 0, y: 0, w: t.W * 0.45, h: t.H }, ink, { role: 'brand-color' });
    const lg = b.logo(ink);
    b.stack(textBlocks(c, t, textCol), { x: t.m, y: t.m + (lg.bottom ? 0 : lg.s * 0.6), w: t.W * 0.45 - 2 * t.m, h: t.H - 2 * t.m - lg.s * 0.6 }, 'center', 'left');
    return ink;
  }
  b.image('Foto', c.photos[0], { x: 0, y: 0, w: t.W, h: t.H }, { slot: '0' });
  if (v % 2 === 0) {
    const top = t.H * (t.orient === 'tall' ? 0.5 : 0.5);
    b.rect('Banda', { x: 0, y: top, w: t.W, h: t.H - top }, ink, { role: 'overlay', opacity: 0.86 });
    b.logo(ink);
    b.stack(textBlocks(c, t, textCol), { x: t.m, y: top + t.m * 0.8, w: t.W - 2 * t.m, h: t.H - top - t.m * 0.8 - t.safeBottom }, 'center');
  } else {
    b.rect('Velo', { x: 0, y: 0, w: t.W, h: t.H }, t.c.dark, { role: 'overlay', opacity: 0.45 });
    b.logo(t.c.dark);
    b.stack(textBlocks(c, t, '#FFFFFF'), contentBox(t, t.safeTop + t.S * 0.16), 'bottom', 'left');
  }
  return ink;
};

function textBlocks(c: Content, t: Tokens, color: string, size = t.S * 0.1): Block[] {
  return [
    ...(c.kicker ? [kicker(t, c.kicker, color)] : []),
    headline(t, c.headline, color, size),
    ...(c.body ? [body(t, c.body, color)] : []),
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
    const ph = t.H * (t.orient === 'tall' ? 0.42 : t.orient === 'portrait' ? 0.46 : 0.44);
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

const typeDominant: Compose = (b, c, t, v) => {
  const bg = (v + (t.motif === 'BLOCK' ? 1 : 0)) % 2 === 0 ? t.c.primary : t.c.dark;
  const inkC = textOn(bg, t);
  const accent = contrastRatio(bg, t.c.accent) >= 3 ? t.c.accent : inkC;
  b.motif(isDark(bg) ? 'DARK' : 'LIGHT');
  b.logo(bg);
  const words = c.headline.trim().split(/\s+/);
  const split = words.length >= 3 ? words.length - (words.at(-1)!.length <= 4 ? 2 : 1) : words.length;
  const a = words.slice(0, split).join(' ');
  const emph = words.slice(split).join(' ');
  const size = t.S * (t.orient === 'wide' ? 0.12 : 0.15);
  const blocks: Block[] = [
    ...(c.kicker ? [kicker(t, c.kicker, accent, t.S * 0.025, bg)] : []),
    { ...headline(t, a, inkC, size, emph ? t.S * 0.005 : t.S * 0.04), name: 'Titular' },
    ...(emph ? [{ ...headline(t, emph, accent, size, t.S * 0.04), name: 'Énfasis', slot: 'emphasis' }] : []),
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
  const cols = t.orient === 'wide' ? items.length : 2;
  const rows = Math.ceil(items.length / cols);
  const gap = t.S * 0.03;
  const area = { x: t.m, y: head + t.m * 0.6, w: t.W - 2 * t.m, h: t.H - t.safeBottom - (head + t.m * 0.6) - ctaH };
  const cw = (area.w - gap * (cols - 1)) / cols;
  const ch = (area.h - gap * (rows - 1)) / rows;
  items.forEach((it, i) => {
    const x = area.x + (i % cols) * (cw + gap);
    const y = area.y + Math.floor(i / cols) * (ch + gap);
    b.rect('Tarjeta', { x, y, w: cw, h: ch }, '#FFFFFF', { role: 'decoration', slot: String(i), radius: t.radius, stroke: t.c.primary, strokeWidth: 2 });
    const ph = ch * 0.62;
    if (it.assetId) b.image(`Foto ${i + 1}`, it.assetId, { x: x + gap * 0.4, y: y + gap * 0.4, w: cw - gap * 0.8, h: ph - gap * 0.4 }, { role: 'item-photo', slot: String(i), radius: t.radius });
    else b.rect(`Color ${i + 1}`, { x: x + gap * 0.4, y: y + gap * 0.4, w: cw - gap * 0.8, h: ph - gap * 0.4 }, i % 2 ? t.c.accent : t.c.primary, { role: 'decoration', slot: String(i), radius: t.radius, opacity: 0.85 });
    const ty = y + ph + gap * 0.3;
    const nh = b.text(`Producto ${i + 1}`, it.name, { x: x + gap * 0.5, y: ty, w: cw - gap, h: (ch - ph) * 0.55 }, { role: 'item-name', slot: String(i), font: t.body, color: textOn('#FFFFFF', t), max: t.S * 0.034, min: t.S * 0.024, bold: true, lh: 1.15, maxLines: 2, align: 'left' });
    if (it.price) b.text(`Precio ${i + 1}`, it.price, { x: x + gap * 0.5, y: ty + nh + gap * 0.15, w: cw - gap, h: (ch - ph) * 0.4 }, { role: 'item-price', slot: String(i), font: t.title, color: brandInk('#FFFFFF', t.c.primary, t), max: t.S * 0.04, min: t.S * 0.026, bold: true, maxLines: 1, align: 'left' });
  });
  if (c.cta) b.cta(c.cta, t.m, t.H - t.safeBottom - t.S * 0.09, t.W - 2 * t.m, t.c.primary, 'center');
  return bg;
};

const offer: Compose = (b, c, t, v) => {
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

const testimonial: Compose = (b, c, t, v) => {
  const bg = v % 2 === 0 ? t.c.light : t.c.primary;
  const ink = textOn(bg, t);
  const mark = contrastRatio(bg, t.c.accent) >= 2 ? t.c.accent : ink;
  b.logo(bg);
  const photo = c.photos[0];
  const box = contentBox(t, t.safeTop + t.S * 0.12);
  b.text('Comillas', '“', { x: box.x, y: box.y, w: t.S * 0.3, h: t.S * 0.22 }, { role: 'decoration', font: 'Playfair Display', color: mark, max: t.S * 0.3, min: t.S * 0.2, align: 'left', lh: 0.9, maxLines: 1 });
  const serif = ['Playfair Display', 'Lora', 'DM Serif Display'].includes(t.title);
  const end = b.stack([
    { kind: 'text', name: 'Testimonio', text: c.quote ?? c.headline, role: 'quote', font: serif ? t.title : t.body, color: ink, max: t.S * 0.065, min: t.S * 0.034, italic: true, lh: 1.3, maxLines: 7, gap: t.S * 0.04 },
  ], { x: box.x, y: box.y + t.S * 0.16, w: box.w, h: box.h * 0.55 }, 'top', 'left');
  const ps = t.S * 0.15;
  if (photo) b.image('Foto', photo, { x: box.x, y: end + t.S * 0.02, w: ps, h: ps }, { slot: '0', radius: ps / 2 });
  b.stack([
    { kind: 'rule', color: mark, gap: t.S * 0.02 },
    { kind: 'text', name: 'Autor', text: c.author ?? '', role: 'author', font: t.body, color: ink, max: t.S * 0.036, min: t.S * 0.026, bold: true, maxLines: 2 },
  ], { x: photo ? box.x + ps + t.S * 0.04 : box.x, y: end + t.S * 0.02 + (photo ? ps * 0.2 : 0), w: box.w - (photo ? ps + t.S * 0.04 : 0), h: t.S * 0.15 }, 'top', 'left');
  return bg;
};

const tips: Compose = (b, c, t, v) => {
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

const corporate: Compose = (b, c, t) => {
  const bg = t.c.light;
  const ink = textOn(bg, t);
  const barH = Math.round(t.safeTop + t.S * 0.12);
  b.rect('Barra superior', { x: 0, y: 0, w: t.W, h: barH }, t.c.primary, { role: 'brand-color' });
  const onBar = textOn(t.c.primary, t);
  if (c.kicker) b.text('Etiqueta', c.kicker, { x: t.m, y: barH - t.S * 0.08, w: t.W * 0.6, h: t.S * 0.05 }, { role: 'kicker', font: t.body, color: onBar, max: t.S * 0.03, min: t.S * 0.022, bold: true, upper: true, maxLines: 1, align: 'left' });
  const logo = { ...t, logoPlacement: 'ARRIBA_DERECHA' as const, safeTop: Math.max(t.m * 0.6, barH - t.S * 0.12 - t.m * 0.2) };
  const lb = new Builder(logo, b.dims);
  lb.logo(t.c.primary);
  b.els.push(...lb.els.map((e, i) => ({ ...e, id: `lg${i}` })));
  const footH = Math.round(t.safeBottom + t.S * 0.12);
  const top = b.stack([headline(t, c.headline, ink, t.S * 0.072, t.S * 0.02, { maxLines: 3 }), { kind: 'rule', color: t.c.accent, gap: t.S * 0.035 }],
    { x: t.m, y: barH + t.m, w: t.W - 2 * t.m, h: t.H * 0.3 }, 'top', 'left');
  const pts = (c.points?.length ? c.points : (c.body ?? '').split(/\n|\. /).map((x) => x.trim()).filter(Boolean)).slice(0, 4);
  if (pts.length) listRows(b, t, pts, { x: t.m, y: top, w: t.W - 2 * t.m, h: Math.min(pts.length * t.S * 0.12, t.H - footH - top - t.m) }, ink, 'square');
  b.rect('Barra inferior', { x: 0, y: t.H - footH, w: t.W, h: footH }, t.c.dark, { role: 'decoration' });
  if (c.cta) b.text('Llamada a la acción', c.cta, { x: t.m, y: t.H - footH + t.S * 0.035, w: t.W - 2 * t.m, h: t.S * 0.06 }, { role: 'cta', font: t.body, color: textOn(t.c.dark, t), max: t.S * 0.036, min: t.S * 0.026, bold: true, maxLines: 1, align: 'left' });
  return bg;
};

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
