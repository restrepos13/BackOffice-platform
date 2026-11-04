/**
 * Documento de diseño de BackOffice Creative (versión 1). Es la fuente de
 * verdad del editor por capas: se guarda así, no como imagen plana.
 *
 * Esquema CERRADO: solo tipos y propiedades conocidos, números acotados,
 * colores hex y fuentes de una lista. Cualquier otra cosa se descarta o se
 * rechaza; jamás se guarda ni se ejecuta código. Las imágenes referencian
 * recursos de la MISMA empresa (lo verifica el servicio).
 */

export const DESIGN_SCHEMA_VERSION = 1;

export const FORMATS = {
  IG_POST: { label: 'Instagram cuadrado', width: 1080, height: 1080, networks: ['instagram', 'facebook'] },
  IG_PORTRAIT: { label: 'Instagram vertical', width: 1080, height: 1350, networks: ['instagram', 'facebook'] },
  STORY: { label: 'Historia / Reel', width: 1080, height: 1920, networks: ['instagram', 'facebook'] },
  FB_POST: { label: 'Facebook horizontal', width: 1200, height: 630, networks: ['facebook'] },
} as const;
export type FormatKey = keyof typeof FORMATS;

/**
 * Fuentes autorizadas (Google Fonts, licencia OFL): las únicas que acepta el
 * editor. Las 15 primeras son las de siempre; el resto se agregó con el
 * editor ampliado (nov-2026). La web tiene la misma lista con su categoría.
 */
export const ALLOWED_FONTS = [
  'Inter', 'Montserrat', 'Poppins', 'Roboto', 'Raleway', 'Nunito', 'Lato',
  'Playfair Display', 'Lora', 'DM Serif Display', 'Anton', 'Bebas Neue', 'Oswald', 'Archivo Black', 'Pacifico',
  // Sans
  'DM Sans', 'Manrope', 'Outfit', 'Sora', 'Plus Jakarta Sans', 'Work Sans', 'Rubik', 'Space Grotesk', 'Urbanist', 'Figtree', 'Barlow', 'Josefin Sans', 'Kanit', 'League Spartan',
  // Display
  'Barlow Condensed', 'Unbounded', 'Syne', 'Alfa Slab One', 'Righteous', 'Lilita One', 'Fredoka', 'Bungee',
  // Serif
  'Fraunces', 'Cormorant Garamond', 'Libre Baskerville', 'Merriweather', 'EB Garamond', 'Prata', 'Abril Fatface', 'Yeseva One', 'Cinzel', 'Bodoni Moda', 'Marcellus',
  // Manuscritas
  'Dancing Script', 'Great Vibes', 'Caveat', 'Satisfy', 'Kaushan Script', 'Permanent Marker', 'Sacramento',
] as const;

/** Recortes con forma para imágenes (la geometría vive en el dibujo de la web). */
export const IMAGE_MASKS = ['none', 'circle', 'pill', 'arch', 'blob', 'hexagon', 'diamond', 'leaf', 'squircle'] as const;
export type ImageMask = (typeof IMAGE_MASKS)[number];

/** Formas predefinidas (nunca rutas libres: el esquema sigue cerrado). */
export const PATH_PRESETS = ['blob', 'blob2', 'wave', 'wave-top', 'arch', 'leaf', 'ribbon', 'arrow', 'bubble', 'brush', 'squiggle'] as const;
export type PathPreset = (typeof PATH_PRESETS)[number];

export const MAX_ELEMENTS = 150;
const MAX_TEXT = 2000;

export type ElementType = 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path';
export const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'polygon', 'star', 'path'] as const;
const ELEMENT_TYPES: readonly string[] = ['text', 'image', ...SHAPE_TYPES];

/** Degradado: lineal (con ángulo en grados, 0 = de izquierda a derecha) o radial (desde el centro). */
export interface Gradient { kind: 'linear' | 'radial'; angle: number; stops: Array<{ at: number; color: string }> }
/** Sombra paralela (el color puede llevar transparencia: #RRGGBBAA). */
export interface Shadow { color: string; blur: number; x: number; y: number }

export interface BaseElement {
  id: string;
  type: ElementType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  /** Rol de marca: los elementos de marca protegidos no se editan si la empresa lo decide */
  role?: ElementRole;
  /** Posición dentro de su rol (p. ej. el 2.º producto de un catálogo); la usa la adaptación de formatos */
  slot?: string;
  shadow?: Shadow;
}

/**
 * Roles: qué función cumple cada elemento en la composición. Los primeros
 * seis existían desde el principio; el resto se agregó con la dirección de
 * arte (los documentos anteriores siguen siendo válidos).
 */
export const ELEMENT_ROLES = [
  'logo', 'cta', 'brand-color', 'headline', 'body', 'photo',
  'kicker', 'price', 'badge', 'validity', 'date', 'place', 'quote', 'author', 'item-name', 'item-price', 'item-photo', 'point', 'decoration', 'overlay',
] as const;
export type ElementRole = (typeof ELEMENT_ROLES)[number];

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic';
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  fill: string;
  textDecoration: '' | 'underline' | 'line-through';
  /** Relleno en degradado (reemplaza a `fill` al dibujar; `fill` queda como color de respaldo y para medir contraste) */
  gradient?: Gradient;
  /** Contorno de las letras */
  stroke?: string;
  strokeWidth?: number;
  /** Caja de color detrás del texto (etiquetas, píldoras) */
  background?: { color: string; padX: number; padY: number; radius: number };
  /** Una frase del texto destacada: otro color, otro estilo o resaltador detrás */
  accent?: { text: string; color: string; marker: string | null; style: 'normal' | 'bold' | 'italic' | 'bold italic' };
}

export interface ImageElement extends BaseElement {
  type: 'image';
  assetId: string;
  crop: { x: number; y: number; width: number; height: number } | null;
  cornerRadius: number;
  mask?: ImageMask;
  /** Ajustes de color: brillo -1..1, contraste -100..100, saturación -2..10, desenfoque 0..40 */
  filters?: { brightness: number; contrast: number; saturation: number; blur: number; grayscale: boolean };
  flipX?: boolean;
  /** Borde que sigue la forma del recorte */
  stroke?: string;
  strokeWidth?: number;
}

export interface ShapeElement extends BaseElement {
  type: 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path';
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
  gradient?: Gradient;
  dash?: boolean;
  /** Polígono: lados (3 a 12) */
  sides?: number;
  /** Estrella: puntas (3 a 40) y proporción del radio interior (0,2 a 0,95; 0,85 = sello de oferta) */
  points?: number;
  innerRatio?: number;
  preset?: PathPreset;
}

export type DesignElement = TextElement | ImageElement | ShapeElement;

export interface DesignDoc {
  schemaVersion: number;
  format: FormatKey;
  width: number;
  height: number;
  background: {
    color: string;
    assetId: string | null;
    gradient?: Gradient | null;
    /** Velo encima de la imagen de fondo (color o degradado) */
    overlay?: { color: string; gradient: Gradient | null; opacity: number } | null;
  };
  elements: DesignElement[];
}

export class DesignDocError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Diseño inválido: ${problems.slice(0, 5).join('; ')}`);
  }
}

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

function num(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}
function color(v: unknown, def: string): string {
  return typeof v === 'string' && HEX.test(v) ? v : def;
}
function str(v: unknown, max: number, def = ''): string {
  return typeof v === 'string' ? v.slice(0, max) : def;
}
function oneOf<T extends string>(v: unknown, opts: readonly T[], def: T): T {
  return (opts as readonly string[]).includes(v as string) ? (v as T) : def;
}

/** Degradado válido o nada (2 a 5 paradas, posiciones de 0 a 1 en orden). */
export function gradientOf(v: unknown): Gradient | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const g = v as Record<string, any>;
  const stops = (Array.isArray(g.stops) ? g.stops : []).slice(0, 5)
    .filter((s: any) => s && typeof s === 'object' && typeof s.color === 'string' && HEX.test(s.color))
    .map((s: any) => ({ at: num(s.at, 0, 1, 0), color: s.color as string }))
    .sort((a: { at: number }, b: { at: number }) => a.at - b.at);
  if (stops.length < 2) return undefined;
  return { kind: oneOf(g.kind, ['linear', 'radial'] as const, 'linear'), angle: num(g.angle, 0, 360, 90), stops };
}
function shadowOf(v: unknown): Shadow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, any>;
  if (typeof o.color !== 'string' || !HEX.test(o.color)) return undefined;
  return { color: o.color, blur: num(o.blur, 0, 200, 20), x: num(o.x, -300, 300, 0), y: num(o.y, -300, 300, 8) };
}
const STYLES = ['normal', 'bold', 'italic', 'bold italic'] as const;

/**
 * Valida y normaliza un documento. Lo irreparable (tipos desconocidos, ids
 * inválidos o repetidos, demasiados elementos) se rechaza con DesignDocError;
 * lo reparable (números fuera de rango, colores raros) se acota.
 */
export function validateDesignDoc(raw: unknown, expectedFormat?: FormatKey): DesignDoc {
  const problems: string[] = [];
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : null;
  if (!o) throw new DesignDocError(['el documento no es un objeto']);
  if (o.schemaVersion !== DESIGN_SCHEMA_VERSION) problems.push(`versión de esquema no soportada (${String(o.schemaVersion)})`);
  const format = oneOf(o.format, Object.keys(FORMATS) as FormatKey[], (expectedFormat ?? 'IG_POST') as FormatKey);
  if (expectedFormat && o.format !== expectedFormat) problems.push('el formato no coincide con el diseño');
  const { width, height } = FORMATS[format];
  if (!Array.isArray(o.elements)) problems.push('faltan los elementos');
  const rawEls: any[] = Array.isArray(o.elements) ? o.elements : [];
  if (rawEls.length > MAX_ELEMENTS) problems.push(`máximo ${MAX_ELEMENTS} elementos`);
  const seen = new Set<string>();
  const elements: DesignElement[] = [];
  for (const [i, e] of rawEls.slice(0, MAX_ELEMENTS).entries()) {
    if (!e || typeof e !== 'object') { problems.push(`elemento ${i} inválido`); continue; }
    if (typeof e.id !== 'string' || !ID.test(e.id) || seen.has(e.id)) { problems.push(`elemento ${i}: id inválido o repetido`); continue; }
    seen.add(e.id);
    if (!ELEMENT_TYPES.includes(e.type)) { problems.push(`elemento ${e.id}: tipo desconocido`); continue; }
    const base: BaseElement = {
      id: e.id,
      type: e.type,
      name: str(e.name, 60, e.type),
      x: num(e.x, -width * 2, width * 3, 0),
      y: num(e.y, -height * 2, height * 3, 0),
      width: num(e.width, 1, width * 4, 100),
      height: num(e.height, e.type === 'line' ? 0 : 1, height * 4, 100),
      rotation: num(e.rotation, -360, 360, 0),
      opacity: num(e.opacity, 0, 1, 1),
      visible: e.visible !== false,
      locked: e.locked === true,
      ...(e.role ? { role: oneOf(e.role, ELEMENT_ROLES, 'body') } : {}),
      ...(typeof e.slot === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(e.slot) ? { slot: e.slot } : {}),
    };
    const sh = shadowOf(e.shadow);
    if (sh) base.shadow = sh;
    if (e.type === 'text') {
      const text = str(e.text, MAX_TEXT);
      if (typeof e.text === 'string' && e.text.length > MAX_TEXT) problems.push(`elemento ${e.id}: texto de más de ${MAX_TEXT} caracteres`);
      elements.push({
        ...base, type: 'text', text,
        fontFamily: oneOf(e.fontFamily, ALLOWED_FONTS, 'Inter'),
        fontSize: num(e.fontSize, 6, 400, 48),
        fontStyle: oneOf(e.fontStyle, ['normal', 'bold', 'italic', 'bold italic'] as const, 'normal'),
        align: oneOf(e.align, ['left', 'center', 'right'] as const, 'left'),
        lineHeight: num(e.lineHeight, 0.6, 3, 1.2),
        letterSpacing: num(e.letterSpacing, -20, 60, 0),
        fill: color(e.fill, '#111111'),
        textDecoration: oneOf(e.textDecoration, ['', 'underline', 'line-through'] as const, ''),
        ...textExtras(e),
      });
    } else if (e.type === 'image') {
      if (typeof e.assetId !== 'string' || !ID.test(e.assetId)) { problems.push(`elemento ${e.id}: imagen sin recurso válido`); continue; }
      const c = e.crop && typeof e.crop === 'object' ? e.crop : null;
      elements.push({
        ...base, type: 'image', assetId: e.assetId,
        crop: c ? { x: num(c.x, 0, 20000, 0), y: num(c.y, 0, 20000, 0), width: num(c.width, 1, 20000, 1), height: num(c.height, 1, 20000, 1) } : null,
        cornerRadius: num(e.cornerRadius, 0, 1000, 0),
        ...imageExtras(e),
      });
    } else {
      elements.push({
        ...base, type: e.type,
        fill: color(e.fill, e.type === 'line' ? '#00000000' : '#DDDDDD'),
        stroke: color(e.stroke, '#00000000'),
        strokeWidth: num(e.strokeWidth, 0, 100, e.type === 'line' ? 4 : 0),
        cornerRadius: num(e.cornerRadius, 0, 1000, 0),
        ...shapeExtras(e),
      } as ShapeElement);
    }
  }
  const bg = o.background && typeof o.background === 'object' ? o.background : {};
  const bgAsset = typeof bg.assetId === 'string' && ID.test(bg.assetId) ? bg.assetId : null;
  if (problems.length) throw new DesignDocError(problems);
  const background: DesignDoc['background'] = { color: color(bg.color, '#FFFFFF'), assetId: bgAsset };
  const bgGrad = gradientOf(bg.gradient);
  if (bgGrad) background.gradient = bgGrad;
  if (bg.overlay && typeof bg.overlay === 'object') {
    const ov = bg.overlay as Record<string, any>;
    background.overlay = { color: color(ov.color, '#000000'), gradient: gradientOf(ov.gradient) ?? null, opacity: num(ov.opacity, 0, 1, 0.4) };
  }
  return { schemaVersion: DESIGN_SCHEMA_VERSION, format, width, height, background, elements };
}

/* Propiedades opcionales del editor ampliado: solo se guardan si son válidas (un diseño viejo no cambia). */

function textExtras(e: Record<string, any>): Partial<TextElement> {
  const out: Partial<TextElement> = {};
  const g = gradientOf(e.gradient);
  if (g) out.gradient = g;
  const sw = num(e.strokeWidth, 0, 40, 0);
  if (typeof e.stroke === 'string' && HEX.test(e.stroke) && sw > 0) { out.stroke = e.stroke; out.strokeWidth = sw; }
  if (e.background && typeof e.background === 'object' && typeof e.background.color === 'string' && HEX.test(e.background.color)) {
    const b = e.background;
    out.background = { color: b.color, padX: num(b.padX, 0, 300, 24), padY: num(b.padY, 0, 300, 12), radius: num(b.radius, 0, 500, 0) };
  }
  if (e.accent && typeof e.accent === 'object' && typeof e.accent.text === 'string' && e.accent.text.trim()) {
    const a = e.accent;
    out.accent = { text: a.text.slice(0, 200), color: color(a.color, '#111111'), marker: typeof a.marker === 'string' && HEX.test(a.marker) ? a.marker : null, style: oneOf(a.style, STYLES, 'normal') };
  }
  return out;
}

function imageExtras(e: Record<string, any>): Partial<ImageElement> {
  const out: Partial<ImageElement> = {};
  const mask = oneOf(e.mask, IMAGE_MASKS, 'none');
  if (mask !== 'none') out.mask = mask;
  if (e.filters && typeof e.filters === 'object') {
    const f = e.filters;
    const v = { brightness: num(f.brightness, -1, 1, 0), contrast: num(f.contrast, -100, 100, 0), saturation: num(f.saturation, -2, 10, 0), blur: num(f.blur, 0, 40, 0), grayscale: f.grayscale === true };
    if (v.brightness || v.contrast || v.saturation || v.blur || v.grayscale) out.filters = v;
  }
  if (e.flipX === true) out.flipX = true;
  const sw = num(e.strokeWidth, 0, 100, 0);
  if (typeof e.stroke === 'string' && HEX.test(e.stroke) && sw > 0) { out.stroke = e.stroke; out.strokeWidth = sw; }
  return out;
}

function shapeExtras(e: Record<string, any>): Partial<ShapeElement> {
  const out: Partial<ShapeElement> = {};
  const g = gradientOf(e.gradient);
  if (g && e.type !== 'line') out.gradient = g;
  if (e.dash === true) out.dash = true;
  if (e.type === 'polygon') out.sides = Math.round(num(e.sides, 3, 12, 6));
  if (e.type === 'star') { out.points = Math.round(num(e.points, 3, 40, 5)); out.innerRatio = num(e.innerRatio, 0.2, 0.95, 0.5); }
  if (e.type === 'path') out.preset = oneOf(e.preset, PATH_PRESETS, 'blob');
  return out;
}

/** Recursos de imagen que usa un documento (para verificar que son de la empresa). */
export function assetIdsOf(doc: DesignDoc): string[] {
  return [...new Set([...doc.elements.filter((e): e is ImageElement => e.type === 'image').map((e) => e.assetId), ...(doc.background.assetId ? [doc.background.assetId] : [])])];
}

/** Documento vacío de un formato. */
export function blankDoc(format: FormatKey, background = '#FFFFFF'): DesignDoc {
  const { width, height } = FORMATS[format];
  return { schemaVersion: DESIGN_SCHEMA_VERSION, format, width, height, background: { color: background, assetId: null }, elements: [] };
}
