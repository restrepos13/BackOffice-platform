import { getToken } from './api';

/**
 * Tipos y utilidades de BackOffice Creative (espejo del esquema del servidor:
 * apps/api/src/common/design-doc.ts). El servidor valida todo de nuevo.
 */

export type FormatKey = 'IG_POST' | 'IG_PORTRAIT' | 'STORY' | 'FB_POST';
export const FORMATS: Record<FormatKey, { label: string; width: number; height: number }> = {
  IG_POST: { label: 'Instagram cuadrado', width: 1080, height: 1080 },
  IG_PORTRAIT: { label: 'Instagram vertical', width: 1080, height: 1350 },
  STORY: { label: 'Historia / Reel', width: 1080, height: 1920 },
  FB_POST: { label: 'Facebook horizontal', width: 1200, height: 630 },
};

/**
 * Fuentes autorizadas con su categoría y los estilos que existen en Google
 * Fonts (si se pide un estilo que una familia no tiene, Google rechaza la
 * petición entera). Misma lista que ALLOWED_FONTS del servidor.
 */
type FontSpec = 'full' | 'wght' | 'one' | 'ital' | 'libre';
export const FONT_GROUPS: Array<{ label: string; fonts: Array<[string, FontSpec]> }> = [
  { label: 'Sans', fonts: [['Inter', 'full'], ['Montserrat', 'full'], ['Poppins', 'full'], ['Roboto', 'full'], ['Raleway', 'full'], ['Nunito', 'full'], ['Lato', 'full'], ['DM Sans', 'full'], ['Manrope', 'wght'], ['Outfit', 'wght'], ['Sora', 'wght'], ['Plus Jakarta Sans', 'full'], ['Work Sans', 'full'], ['Rubik', 'full'], ['Space Grotesk', 'wght'], ['Urbanist', 'full'], ['Figtree', 'full'], ['Barlow', 'full'], ['Josefin Sans', 'full'], ['Kanit', 'full'], ['League Spartan', 'wght']] },
  { label: 'Impacto', fonts: [['Anton', 'one'], ['Bebas Neue', 'one'], ['Oswald', 'wght'], ['Barlow Condensed', 'full'], ['Archivo Black', 'one'], ['Unbounded', 'wght'], ['Syne', 'wght'], ['Alfa Slab One', 'one'], ['Righteous', 'one'], ['Lilita One', 'one'], ['Fredoka', 'wght'], ['Bungee', 'one']] },
  { label: 'Serif', fonts: [['Playfair Display', 'full'], ['Lora', 'full'], ['DM Serif Display', 'ital'], ['Fraunces', 'full'], ['Cormorant Garamond', 'full'], ['Libre Baskerville', 'libre'], ['Merriweather', 'full'], ['EB Garamond', 'full'], ['Prata', 'one'], ['Abril Fatface', 'one'], ['Yeseva One', 'one'], ['Cinzel', 'wght'], ['Bodoni Moda', 'full'], ['Marcellus', 'one']] },
  { label: 'Manuscritas', fonts: [['Pacifico', 'one'], ['Dancing Script', 'wght'], ['Great Vibes', 'one'], ['Caveat', 'wght'], ['Satisfy', 'one'], ['Kaushan Script', 'one'], ['Permanent Marker', 'one'], ['Sacramento', 'one']] },
];
const FONT_SPEC = new Map(FONT_GROUPS.flatMap((g) => g.fonts));
export const FONTS = [...FONT_SPEC.keys()];
/** Fuentes con un solo grosor: la negrita sería sintética (se evita al proponer). */
export const SINGLE_WEIGHT_FONTS = FONTS.filter((f) => ['one', 'ital'].includes(FONT_SPEC.get(f)!));

export const IMAGE_MASKS = ['none', 'circle', 'pill', 'arch', 'blob', 'hexagon', 'diamond', 'leaf', 'squircle'] as const;
export type ImageMask = (typeof IMAGE_MASKS)[number];
export const PATH_PRESETS = ['blob', 'blob2', 'wave', 'wave-top', 'arch', 'leaf', 'ribbon', 'arrow', 'bubble', 'brush', 'squiggle'] as const;
export type PathPreset = (typeof PATH_PRESETS)[number];

export interface Gradient { kind: 'linear' | 'radial'; angle: number; stops: Array<{ at: number; color: string }> }
export interface Shadow { color: string; blur: number; x: number; y: number }

export type ElementType = 'text' | 'image' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path';
export interface BaseEl {
  id: string; type: ElementType; name: string; x: number; y: number; width: number; height: number;
  rotation: number; opacity: number; visible: boolean; locked: boolean; role?: string; slot?: string; shadow?: Shadow;
}
export type FontStyle = 'normal' | 'bold' | 'italic' | 'bold italic';
export interface TextEl extends BaseEl {
  type: 'text'; text: string; fontFamily: string; fontSize: number; fontStyle: FontStyle;
  align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number; fill: string; textDecoration: '' | 'underline' | 'line-through';
  gradient?: Gradient; stroke?: string; strokeWidth?: number;
  background?: { color: string; padX: number; padY: number; radius: number };
  accent?: { text: string; color: string; marker: string | null; style: FontStyle };
}
export interface ImageEl extends BaseEl {
  type: 'image'; assetId: string; crop: { x: number; y: number; width: number; height: number } | null; cornerRadius: number;
  mask?: ImageMask; filters?: { brightness: number; contrast: number; saturation: number; blur: number; grayscale: boolean }; flipX?: boolean; stroke?: string; strokeWidth?: number;
}
export interface ShapeEl extends BaseEl {
  type: 'rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path'; fill: string; stroke: string; strokeWidth: number; cornerRadius: number;
  gradient?: Gradient; dash?: boolean; sides?: number; points?: number; innerRatio?: number; preset?: PathPreset;
}
export type El = TextEl | ImageEl | ShapeEl;
export interface DesignDoc {
  schemaVersion: 1; format: FormatKey; width: number; height: number;
  background: { color: string; assetId: string | null; gradient?: Gradient | null; overlay?: { color: string; gradient: Gradient | null; opacity: number } | null };
  elements: El[];
}

export const newId = (p = 'e') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const STYLE_QUERY: Record<FontSpec, string> = {
  full: ':ital,wght@0,400;0,700;1,400;1,700', wght: ':wght@400;700', one: '', ital: ':ital@0;1', libre: ':ital,wght@0,400;0,700;1,400',
};
const requested = new Set<string>();
const ready = new Map<string, Promise<void>>();
/** Pide a Google Fonts la hoja de UNA familia (una sola vez). */
function requestFont(f: string) {
  if (requested.has(f) || !FONT_SPEC.has(f)) return;
  requested.add(f);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${f.replace(/ /g, '+')}${STYLE_QUERY[FONT_SPEC.get(f)!]}&display=swap`;
  document.head.appendChild(link);
}
/** Fuentes que usa un documento (textos y frases destacadas). */
export function fontsOf(doc: DesignDoc | null | undefined): string[] {
  return [...new Set((doc?.elements ?? []).filter((e): e is TextEl => e.type === 'text').map((e) => e.fontFamily))];
}
/**
 * Carga solo las fuentes pedidas (por defecto, las de siempre). Antes se
 * bajaban todas al abrir el editor; con 55 familias eso sería lento.
 */
const BASE_FONTS = ['Inter', 'Montserrat', 'Playfair Display', 'Lato'];
export function loadFonts(families: string[] = BASE_FONTS): Promise<void> {
  const list = families.filter((f) => FONT_SPEC.has(f));
  return Promise.all(list.map((f) => {
    if (!ready.has(f)) {
      requestFont(f);
      ready.set(f, Promise.all([document.fonts.load(`16px "${f}"`), document.fonts.load(`bold 16px "${f}"`), document.fonts.load(`italic 16px "${f}"`)]).then(() => undefined).catch(() => undefined));
    }
    return ready.get(f)!;
  })).then(() => undefined);
}

/** Imágenes privadas: se bajan con la sesión y se usan como blob (el lienzo no queda "contaminado" al exportar). */
const imageCache = new Map<string, Promise<HTMLImageElement>>();
export function loadAsset(assetId: string, q = ''): Promise<HTMLImageElement> {
  const key = `${assetId}?${q}`;
  if (!imageCache.has(key)) {
    imageCache.set(key, (async () => {
      const res = await fetch(`/api/creative/assets/${assetId}/file${q ? `?${q}` : ''}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('Imagen no disponible');
      const url = URL.createObjectURL(await res.blob());
      const img = new Image();
      // onload y no img.decode(): decode() a veces nunca resuelve aunque la imagen ya cargó
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Imagen no disponible'));
        img.src = url;
      });
      return img;
    })());
    imageCache.get(key)!.catch(() => imageCache.delete(key));
  }
  return imageCache.get(key)!;
}

export async function authedBlobUrl(path: string): Promise<string | null> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

/** Recorte "rellenar": la imagen cubre la caja sin deformarse (centrado). */
export function coverCrop(img: { naturalWidth: number; naturalHeight: number }, boxW: number, boxH: number) {
  const r = boxW / boxH;
  const ir = img.naturalWidth / img.naturalHeight;
  if (ir > r) {
    const w = Math.round(img.naturalHeight * r);
    return { x: Math.round((img.naturalWidth - w) / 2), y: 0, width: w, height: img.naturalHeight };
  }
  const h = Math.round(img.naturalWidth / r);
  return { x: 0, y: Math.round((img.naturalHeight - h) / 2), width: img.naturalWidth, height: h };
}

/** Lleva un diseño a otro formato: escala proporcional y conserva posiciones relativas. */
export function adaptDoc(doc: DesignDoc, to: FormatKey): DesignDoc {
  const { width: W, height: H } = FORMATS[to];
  const sx = W / doc.width;
  const sy = H / doc.height;
  const s = Math.min(sx, sy);
  return {
    ...doc, format: to, width: W, height: H,
    elements: doc.elements.map((e) => {
      const cx = (e.x + e.width / 2) * sx;
      const cy = (e.y + e.height / 2) * sy;
      const w = e.width * s;
      const h = e.height * s;
      const out: El = { ...e, id: newId(e.type[0]), x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h) } as El;
      if (out.type === 'text') out.fontSize = Math.max(6, Math.round(out.fontSize * s));
      return out;
    }),
  };
}

/** Historial para deshacer/rehacer (documentos completos; máx. 100 pasos). */
export class History {
  private past: DesignDoc[] = [];
  private future: DesignDoc[] = [];
  push(prev: DesignDoc) {
    this.past.push(prev);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(current: DesignDoc): DesignDoc | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(current);
    return prev;
  }
  redo(current: DesignDoc): DesignDoc | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(current);
    return next;
  }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}

export const CATEGORY_LABELS: Record<string, string> = {
  PRODUCTO: 'Producto', PROMO: 'Promoción', TIPS: 'Consejos', MARCA: 'Marca', EVENTO: 'Evento', OTRO: 'Otro',
};

export const STATUS_LABELS: Record<string, string> = {
  IDEA: 'Idea', BORRADOR: 'Borrador', LISTO: 'Listo', EN_REVISION: 'En revisión', APROBADO: 'Aprobado',
  PROGRAMADO: 'Programado', PUBLICANDO: 'Publicando', PUBLICADO: 'Publicado', ERROR: 'Error', CANCELADO: 'Cancelado',
};
