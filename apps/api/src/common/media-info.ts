/**
 * Lectura del tipo y las medidas de un video desde sus bytes (no se confía en
 * lo que diga el navegador). Solo MP4 y MOV, que son los formatos que aceptan
 * las plataformas publicitarias para subir video. Recorre las cajas ISO-BMFF:
 * moov → mvhd (duración) y trak → tkhd (ancho × alto).
 */

export interface VideoInfo {
  mime: 'video/mp4' | 'video/quicktime';
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

type Box = { type: string; start: number; body: number; end: number };

function boxes(buf: Buffer, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to && out.length < 500) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      const big = Number(buf.readBigUInt64BE(at + 8));
      size = big;
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < 8 || at + size > to) break;
    out.push({ type, start: at, body, end: at + size });
    at += size;
  }
  return out;
}

export function videoInfo(buf: Buffer): VideoInfo | null {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('latin1', 8, 12);
  const mime = brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  const info: VideoInfo = { mime, width: null, height: null, durationSec: null };
  const moov = boxes(buf, 0, buf.length).find((b) => b.type === 'moov');
  if (!moov) return info; // archivo válido pero con el índice al final o truncado: sin medidas
  for (const b of boxes(buf, moov.body, moov.end)) {
    if (b.type === 'mvhd' && b.end - b.body >= 24) {
      const v = buf.readUInt8(b.body);
      const scaleAt = b.body + (v === 1 ? 20 : 12);
      const timescale = buf.readUInt32BE(scaleAt);
      const duration = v === 1 ? Number(buf.readBigUInt64BE(scaleAt + 4)) : buf.readUInt32BE(scaleAt + 4);
      if (timescale > 0) info.durationSec = Math.round((duration / timescale) * 10) / 10;
    }
    if (b.type === 'trak' && info.width === null) {
      const tkhd = boxes(buf, b.body, b.end).find((x) => x.type === 'tkhd');
      if (tkhd && tkhd.end - tkhd.body >= 84) {
        // Ancho y alto: los últimos 8 bytes, en punto fijo 16.16
        const w = buf.readUInt32BE(tkhd.end - 8) >>> 16;
        const h = buf.readUInt32BE(tkhd.end - 4) >>> 16;
        if (w > 0 && h > 0) {
          info.width = w;
          info.height = h;
        }
      }
    }
  }
  return info;
}

/** Proporciones habituales de los anuncios (orientativo; cada plataforma valida al subir). */
const RATIOS: Array<{ label: string; ratio: number }> = [
  { label: 'Cuadrado 1:1', ratio: 1 },
  { label: 'Vertical 4:5', ratio: 4 / 5 },
  { label: 'Historias y reels 9:16', ratio: 9 / 16 },
  { label: 'Horizontal 1.91:1', ratio: 1.91 },
  { label: 'Horizontal 16:9', ratio: 16 / 9 },
];

export function ratioLabels(width?: number | null, height?: number | null): string[] {
  if (!width || !height) return [];
  const r = width / height;
  return RATIOS.filter((x) => Math.abs(r - x.ratio) / x.ratio <= 0.03).map((x) => x.label);
}
