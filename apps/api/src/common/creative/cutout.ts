import { PNG } from 'pngjs';

/**
 * Operaciones de imagen de Creative detrás de una interfaz. Quitar el fondo
 * usa un servicio ESPECIALIZADO (no un generador): el producto se conserva tal
 * cual. Hoy hay un proveedor: remove.bg (llave REMOVE_BG_API_KEY en Dev Tools).
 * Sin llave, la capacidad se informa como «no configurada»: nunca se simula.
 *
 * Generar fondos o imágenes nuevas ya existe en ai/media-gen.ts (FLUX/Gemini)
 * y no se usa para escribir precios, logos ni textos: eso lo hace el editor.
 */

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<any> }>;

export class ImageOpError extends Error {
  constructor(readonly kind: 'NOT_CONFIGURED' | 'KEY' | 'NO_CREDIT' | 'NO_SUBJECT' | 'TIMEOUT' | 'PROVIDER' | 'INVALID_RESULT', message: string) {
    super(message);
  }
}

export interface CutoutProvider {
  readonly key: string;
  readonly label: string;
  removeBackground(image: Buffer, mime: string): Promise<Buffer>;
}

export const CUTOUT_TIMEOUT_MS = 45_000;
const MAX_RESULT_BYTES = 25 * 1024 * 1024;
/** Antes de descomprimir: una cabecera que declara una imagen enorme no se decodifica */
const MAX_PIXELS = 40_000_000;
const REMOVE_BG_URL = 'https://api.remove.bg/v1.0/removebg';

export class RemoveBgProvider implements CutoutProvider {
  readonly key = 'REMOVE_BG';
  readonly label = 'remove.bg';
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i) as any, private readonly timeoutMs = CUTOUT_TIMEOUT_MS) {}

  async removeBackground(image: Buffer, mime: string): Promise<Buffer> {
    const form = new FormData();
    form.append('image_file', new Blob([new Uint8Array(image)], { type: mime }), mime === 'image/png' ? 'imagen.png' : 'imagen.jpg');
    form.append('size', 'auto');
    form.append('format', 'png');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(REMOVE_BG_URL, { method: 'POST', headers: { 'X-Api-Key': this.apiKey }, body: form, signal: ctrl.signal });
    } catch (e: any) {
      throw e?.name === 'AbortError' ? new ImageOpError('TIMEOUT', 'El servicio de recorte tardó demasiado. Intenta de nuevo.') : new ImageOpError('PROVIDER', 'No se pudo contactar el servicio de recorte.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = String(body?.errors?.[0]?.title ?? '').slice(0, 160);
      if (res.status === 401 || res.status === 403) throw new ImageOpError('KEY', 'El servicio de recorte rechazó la llave configurada.');
      if (res.status === 402) throw new ImageOpError('NO_CREDIT', 'El servicio de recorte no tiene saldo.');
      if (res.status === 400 && /foreground/i.test(detail)) throw new ImageOpError('NO_SUBJECT', 'No se encontró un producto o persona claro en la foto.');
      throw new ImageOpError('PROVIDER', `El servicio de recorte respondió con error${detail ? `: ${detail}` : ''}.`);
    }
    const out = Buffer.from(await res.arrayBuffer());
    if (out.length > MAX_RESULT_BYTES) throw new ImageOpError('INVALID_RESULT', 'El recorte que devolvió el servicio pesa demasiado.');
    return out;
  }
}

/**
 * Comprueba que el recorte es un PNG válido con transparencia real: ni todo
 * opaco (no recortó) ni casi todo transparente (borró el producto).
 */
export function validateCutout(png: Buffer, original?: { width: number | null; height: number | null }): { width: number; height: number; transparent: number } {
  const sig = png.subarray(0, 8).toString('hex');
  if (png.length < 24 || sig !== '89504e470d0a1a0a') throw new ImageOpError('INVALID_RESULT', 'El recorte no es un PNG válido.');
  if (png.readUInt32BE(16) * png.readUInt32BE(20) > MAX_PIXELS) throw new ImageOpError('INVALID_RESULT', 'El recorte es demasiado grande.');
  let img: PNG;
  try {
    img = PNG.sync.read(png);
  } catch {
    throw new ImageOpError('INVALID_RESULT', 'El recorte no es un PNG válido.');
  }
  const total = img.width * img.height;
  if (!total) throw new ImageOpError('INVALID_RESULT', 'El recorte está vacío.');
  const step = Math.max(1, Math.floor(Math.sqrt(total / 200_000)));
  let clear = 0;
  let n = 0;
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      n++;
      if (img.data[(y * img.width + x) * 4 + 3] < 16) clear++;
    }
  }
  const transparent = clear / n;
  if (transparent < 0.02) throw new ImageOpError('INVALID_RESULT', 'El recorte no quitó el fondo.');
  if (transparent > 0.98) throw new ImageOpError('INVALID_RESULT', 'El recorte quedó vacío: no se reconoció el producto.');
  if (original?.width && original?.height) {
    const r1 = original.width / original.height;
    const r2 = img.width / img.height;
    if (Math.abs(r1 - r2) / r1 > 0.05) throw new ImageOpError('INVALID_RESULT', 'El recorte no corresponde a la foto original.');
  }
  return { width: img.width, height: img.height, transparent: Math.round(transparent * 1000) / 1000 };
}
