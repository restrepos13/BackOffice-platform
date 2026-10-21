/**
 * Plantillas de BackOffice Creative: composiciones de capas editables que se
 * arman con la marca de cada empresa (colores, fuentes, logo, llamada a la
 * acción) y se adaptan a cualquier formato. Pocas y buenas: no son imágenes
 * fijas ni una página por diseño.
 */
import { DESIGN_SCHEMA_VERSION, DesignDoc, DesignElement, FORMATS, FormatKey } from './design-doc';

export interface BrandForTemplate {
  name: string;
  colors: string[]; // [principal, secundario, acento…]
  fonts: string[]; // [títulos, texto]
  logoAssetId: string | null;
  cta: string | null;
}

export const TEMPLATES = [
  { key: 'producto', name: 'Producto destacado', category: 'PRODUCTO', hint: 'Una foto grande, el nombre y el precio confirmado.' },
  { key: 'promo', name: 'Promoción', category: 'PROMO', hint: 'Oferta llamativa con vigencia (requiere revisión).' },
  { key: 'tip', name: 'Consejo útil', category: 'TIPS', hint: 'Un tip corto que muestra que sabes de lo tuyo.' },
  { key: 'novedad', name: 'Novedad o anuncio', category: 'MARCA', hint: 'Lanzamiento, horario nuevo o noticia de la marca.' },
  { key: 'frase', name: 'Frase de marca', category: 'MARCA', hint: 'Una frase con la voz de tu marca.' },
  { key: 'evento', name: 'Evento o fecha', category: 'EVENTO', hint: 'Fecha, lugar y cómo apartar cupo.' },
] as const;
export type TemplateKey = (typeof TEMPLATES)[number]['key'];

let seq = 0;
const id = (p: string) => `${p}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function contrast(hex: string): string {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111111' : '#FFFFFF';
}

export function buildTemplate(key: TemplateKey, format: FormatKey, brand: BrandForTemplate): DesignDoc {
  const { width: W, height: H } = FORMATS[format];
  const primary = brand.colors[0] ?? '#1A1A1A';
  const secondary = brand.colors[1] ?? '#F4F1EC';
  const accent = brand.colors[2] ?? '#3F6B3A';
  const titleFont = brand.fonts[0] ?? 'Montserrat';
  const bodyFont = brand.fonts[1] ?? brand.fonts[0] ?? 'Inter';
  const tall = H / W > 1.2;
  const m = Math.round(W * 0.07); // margen
  const els: DesignElement[] = [];
  const base = { rotation: 0, opacity: 1, visible: true, locked: false };
  const text = (name: string, t: string, x: number, y: number, w: number, h: number, size: number, opts: Partial<Record<string, any>> = {}) =>
    els.push({ ...base, id: id('t'), type: 'text', name, text: t, x, y, width: w, height: h, fontFamily: opts.font ?? bodyFont, fontSize: size, fontStyle: opts.style ?? 'normal', align: opts.align ?? 'left', lineHeight: opts.lh ?? 1.15, letterSpacing: 0, fill: opts.fill ?? contrast(opts.on ?? secondary), textDecoration: '', ...(opts.role ? { role: opts.role } : {}) } as DesignElement);
  const rect = (name: string, x: number, y: number, w: number, h: number, fill: string, opts: Partial<Record<string, any>> = {}) =>
    els.push({ ...base, id: id('r'), type: 'rect', name, x, y, width: w, height: h, fill, stroke: '#00000000', strokeWidth: 0, cornerRadius: opts.r ?? 0, ...(opts.role ? { role: opts.role } : {}) } as DesignElement);
  const cta = (y: number) => {
    const w = Math.round(W * 0.5);
    const h = Math.round(W * 0.09);
    const x = Math.round((W - w) / 2);
    rect('Botón', x, y, w, h, accent, { r: h / 2, role: 'cta' });
    text('Llamada a la acción', brand.cta || 'Escríbenos por WhatsApp', x, y + h * 0.27, w, h * 0.5, Math.round(W * 0.034), { align: 'center', style: 'bold', fill: contrast(accent), role: 'cta' });
  };
  const logo = () => {
    if (!brand.logoAssetId) return;
    const s = Math.round(W * 0.14);
    els.push({ ...base, id: id('l'), type: 'image', name: 'Logo', assetId: brand.logoAssetId, x: W - m - s, y: m, width: s, height: s, crop: null, cornerRadius: 0, role: 'logo' } as DesignElement);
  };
  const photo = (x: number, y: number, w: number, h: number) => rect('Foto (reemplázala)', x, y, w, h, '#D9D4CF', { role: 'photo', r: Math.round(W * 0.02) });

  let bg = secondary;
  if (key === 'producto') {
    photo(m, m, W - 2 * m, Math.round(H * (tall ? 0.52 : 0.55)));
    const y0 = Math.round(H * (tall ? 0.6 : 0.64));
    text('Nombre del producto', 'Nombre del producto', m, y0, W - 2 * m, H * 0.08, Math.round(W * 0.07), { font: titleFont, style: 'bold', role: 'headline' });
    text('Precio', 'Precio confirmado', m, y0 + H * 0.09, W - 2 * m, H * 0.05, Math.round(W * 0.045), { fill: accent, style: 'bold' });
    cta(Math.round(H - m - W * 0.09));
  } else if (key === 'promo') {
    bg = primary;
    text('Etiqueta', 'PROMOCIÓN', m, m * 1.5, W - 2 * m, H * 0.05, Math.round(W * 0.04), { align: 'center', style: 'bold', on: primary, font: bodyFont });
    text('Oferta', 'Escribe aquí tu oferta real', m, H * 0.3, W - 2 * m, H * 0.25, Math.round(W * 0.1), { align: 'center', style: 'bold', on: primary, font: titleFont, role: 'headline' });
    text('Vigencia', 'Válido hasta: (fecha)', m, H * 0.58, W - 2 * m, H * 0.05, Math.round(W * 0.038), { align: 'center', on: primary });
    cta(Math.round(H * 0.72));
  } else if (key === 'tip') {
    rect('Franja', 0, 0, W, Math.round(H * 0.06), accent, { role: 'brand-color' });
    text('Etiqueta', 'CONSEJO', m, H * 0.12, W - 2 * m, H * 0.05, Math.round(W * 0.035), { style: 'bold', fill: accent });
    text('Título', 'Un consejo corto y útil', m, H * 0.2, W - 2 * m, H * 0.2, Math.round(W * 0.085), { font: titleFont, style: 'bold', role: 'headline' });
    text('Explicación', 'Explica el consejo en dos o tres líneas, con palabras de tu marca.', m, H * (tall ? 0.42 : 0.47), W - 2 * m, H * 0.25, Math.round(W * 0.042), { lh: 1.4, role: 'body' });
  } else if (key === 'novedad') {
    bg = primary;
    photo(0, Math.round(H * 0.45), W, Math.round(H * 0.55));
    text('Etiqueta', 'NOVEDAD', m, m * 1.5, W - 2 * m, H * 0.05, Math.round(W * 0.038), { style: 'bold', on: primary });
    text('Anuncio', 'Cuenta aquí la novedad', m, H * 0.13, W - 2 * m, H * 0.25, Math.round(W * 0.09), { font: titleFont, style: 'bold', on: primary, role: 'headline' });
  } else if (key === 'frase') {
    bg = primary;
    text('Comillas', '“', m, H * 0.12, W - 2 * m, H * 0.15, Math.round(W * 0.25), { font: 'Playfair Display', on: primary, fill: accent });
    text('Frase', 'Una frase que diga quiénes somos', m, H * 0.3, W - 2 * m, H * 0.3, Math.round(W * 0.075), { font: titleFont, align: 'center', on: primary, lh: 1.25, role: 'headline' });
    text('Firma', brand.name || 'Tu marca', m, H * 0.7, W - 2 * m, H * 0.05, Math.round(W * 0.035), { align: 'center', on: primary, style: 'bold' });
  } else {
    // evento
    rect('Bloque fecha', m, m * 2, Math.round(W * 0.32), Math.round(W * 0.32), accent, { r: Math.round(W * 0.03), role: 'brand-color' });
    text('Día', '24', m, m * 2 + W * 0.05, Math.round(W * 0.32), W * 0.15, Math.round(W * 0.13), { align: 'center', style: 'bold', fill: contrast(accent), font: titleFont });
    text('Mes', 'OCT', m, m * 2 + W * 0.2, Math.round(W * 0.32), W * 0.07, Math.round(W * 0.045), { align: 'center', fill: contrast(accent) });
    text('Nombre del evento', 'Nombre del evento', m, H * (tall ? 0.36 : 0.5), W - 2 * m, H * 0.12, Math.round(W * 0.075), { font: titleFont, style: 'bold', role: 'headline' });
    text('Lugar y hora', 'Lugar · hora', m, H * (tall ? 0.5 : 0.66), W - 2 * m, H * 0.05, Math.round(W * 0.04), { role: 'body' });
    cta(Math.round(H - m - W * 0.09));
  }
  logo();
  return { schemaVersion: DESIGN_SCHEMA_VERSION, format, width: W, height: H, background: { color: bg, assetId: null }, elements: els.map((e) => ({ ...e, x: Math.round(e.x), y: Math.round(e.y), width: Math.round(e.width), height: Math.round(e.height) })) };
}
