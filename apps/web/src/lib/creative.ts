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

export const FONTS = [
  'Inter', 'Montserrat', 'Poppins', 'Roboto', 'Raleway', 'Nunito', 'Lato',
  'Playfair Display', 'Lora', 'DM Serif Display', 'Anton', 'Bebas Neue', 'Oswald', 'Archivo Black', 'Pacifico',
] as const;

export type ElementType = 'text' | 'image' | 'rect' | 'ellipse' | 'line';
export interface BaseEl {
  id: string; type: ElementType; name: string; x: number; y: number; width: number; height: number;
  rotation: number; opacity: number; visible: boolean; locked: boolean; role?: string; slot?: string;
}
export interface TextEl extends BaseEl {
  type: 'text'; text: string; fontFamily: string; fontSize: number; fontStyle: 'normal' | 'bold' | 'italic' | 'bold italic';
  align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number; fill: string; textDecoration: '' | 'underline';
}
export interface ImageEl extends BaseEl { type: 'image'; assetId: string; crop: { x: number; y: number; width: number; height: number } | null; cornerRadius: number }
export interface ShapeEl extends BaseEl { type: 'rect' | 'ellipse' | 'line'; fill: string; stroke: string; strokeWidth: number; cornerRadius: number }
export type El = TextEl | ImageEl | ShapeEl;
export interface DesignDoc {
  schemaVersion: 1; format: FormatKey; width: number; height: number;
  background: { color: string; assetId: string | null }; elements: El[];
}

export const newId = (p = 'e') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Carga las fuentes autorizadas (Google Fonts, licencia OFL) una sola vez. */
let fontsRequested = false;
export function loadFonts(): Promise<void> {
  if (!fontsRequested) {
    fontsRequested = true;
    // Google rechaza la petición entera si se piden estilos que una familia no tiene
    const only400 = ['Anton', 'Bebas Neue', 'Archivo Black', 'Pacifico'];
    const spec = (f: string) =>
      only400.includes(f) ? '' : f === 'DM Serif Display' ? ':ital@0;1' : f === 'Oswald' ? ':wght@400;700' : ':ital,wght@0,400;0,700;1,400;1,700';
    const families = FONTS.map((f) => `family=${f.replace(/ /g, '+')}${spec(f)}`).join('&');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    document.head.appendChild(link);
  }
  return Promise.all(FONTS.flatMap((f) => [document.fonts.load(`16px "${f}"`), document.fonts.load(`bold 16px "${f}"`)]))
    .then(() => undefined)
    .catch(() => undefined);
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
