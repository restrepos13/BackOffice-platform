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

/** Fuentes autorizadas (Google Fonts, licencia OFL): las únicas que acepta el editor. */
export const ALLOWED_FONTS = [
  'Inter', 'Montserrat', 'Poppins', 'Roboto', 'Raleway', 'Nunito', 'Lato',
  'Playfair Display', 'Lora', 'DM Serif Display', 'Anton', 'Bebas Neue', 'Oswald', 'Archivo Black', 'Pacifico',
] as const;

export const MAX_ELEMENTS = 150;
const MAX_TEXT = 2000;

export type ElementType = 'text' | 'image' | 'rect' | 'ellipse' | 'line';

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
  role?: 'logo' | 'cta' | 'brand-color' | 'headline' | 'body' | 'photo';
}

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
  textDecoration: '' | 'underline';
}

export interface ImageElement extends BaseElement {
  type: 'image';
  assetId: string;
  crop: { x: number; y: number; width: number; height: number } | null;
  cornerRadius: number;
}

export interface ShapeElement extends BaseElement {
  type: 'rect' | 'ellipse' | 'line';
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius: number;
}

export type DesignElement = TextElement | ImageElement | ShapeElement;

export interface DesignDoc {
  schemaVersion: number;
  format: FormatKey;
  width: number;
  height: number;
  background: { color: string; assetId: string | null };
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
    if (!['text', 'image', 'rect', 'ellipse', 'line'].includes(e.type)) { problems.push(`elemento ${e.id}: tipo desconocido`); continue; }
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
      ...(e.role ? { role: oneOf(e.role, ['logo', 'cta', 'brand-color', 'headline', 'body', 'photo'] as const, 'body') } : {}),
    };
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
        textDecoration: oneOf(e.textDecoration, ['', 'underline'] as const, ''),
      });
    } else if (e.type === 'image') {
      if (typeof e.assetId !== 'string' || !ID.test(e.assetId)) { problems.push(`elemento ${e.id}: imagen sin recurso válido`); continue; }
      const c = e.crop && typeof e.crop === 'object' ? e.crop : null;
      elements.push({
        ...base, type: 'image', assetId: e.assetId,
        crop: c ? { x: num(c.x, 0, 20000, 0), y: num(c.y, 0, 20000, 0), width: num(c.width, 1, 20000, 1), height: num(c.height, 1, 20000, 1) } : null,
        cornerRadius: num(e.cornerRadius, 0, 1000, 0),
      });
    } else {
      elements.push({
        ...base, type: e.type,
        fill: color(e.fill, e.type === 'line' ? '#00000000' : '#DDDDDD'),
        stroke: color(e.stroke, '#00000000'),
        strokeWidth: num(e.strokeWidth, 0, 100, e.type === 'line' ? 4 : 0),
        cornerRadius: num(e.cornerRadius, 0, 1000, 0),
      } as ShapeElement);
    }
  }
  const bg = o.background && typeof o.background === 'object' ? o.background : {};
  const bgAsset = typeof bg.assetId === 'string' && ID.test(bg.assetId) ? bg.assetId : null;
  if (problems.length) throw new DesignDocError(problems);
  return { schemaVersion: DESIGN_SCHEMA_VERSION, format, width, height, background: { color: color(bg.color, '#FFFFFF'), assetId: bgAsset }, elements };
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
