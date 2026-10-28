import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Revisión de un anuncio POR CÓDIGO (sin IA): formato, tamaño y proporción de
 * la imagen, luz, contraste, color y cuánto «detalle» tiene (indicio de mucho
 * texto), más reglas del texto del anuncio. Es determinista y no cuesta nada;
 * no entiende lo que muestra la imagen ni si la oferta es buena: eso lo hace
 * la revisión con la IA de la empresa (creative-ai.ts), si la tiene.
 */

export type CheckLevel = 'OK' | 'WARN' | 'BAD';

export interface CheckItem {
  key: string;
  level: CheckLevel;
  area: 'IMAGEN' | 'TEXTO' | 'POLITICAS';
  title: string;
  detail: string;
  fix?: string;
}

export interface ImageFacts {
  format: 'jpg' | 'png';
  width: number;
  height: number;
  sizeBytes: number;
  /** ancho / alto */
  ratio: number;
  /** 0-255, promedio de luminosidad */
  brightness: number;
  /** desviación estándar de la luminosidad */
  contrast: number;
  /** métrica de Hasler-Süsstrunk (0 = gris) */
  colorfulness: number;
  /** fracción de puntos con bordes fuertes (texto y elementos pequeños suben esto) */
  detail: number;
}

export interface CopyInput {
  goal: 'WHATSAPP' | 'WEBSITE';
  primaryText: string;
  headline: string;
  description?: string;
}

interface Rgba { width: number; height: number; data: Uint8Array | Buffer }

/** Límite de píxeles que se decodifican (una foto de 40 MP no tumba el servidor). */
const MAX_MEGAPIXELS = 40;

export function imageFormat(buf: Buffer): 'jpg' | 'png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'png';
  return null;
}

export function decodeImage(buf: Buffer): (Rgba & { format: 'jpg' | 'png' }) | null {
  const format = imageFormat(buf);
  try {
    if (format === 'jpg') {
      const img = decodeJpeg(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_MEGAPIXELS, maxMemoryUsageInMB: 512 });
      return { width: img.width, height: img.height, data: img.data, format };
    }
    if (format === 'png') {
      const img = PNG.sync.read(buf);
      if (img.width * img.height > MAX_MEGAPIXELS * 1e6) return null;
      return { width: img.width, height: img.height, data: img.data, format };
    }
  } catch {
    return null;
  }
  return null;
}

const luma = (d: Rgba['data'], i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Mide la imagen sobre una muestra en rejilla (~250.000 puntos como máximo). */
export function measure(img: Rgba, sizeBytes: number, format: 'jpg' | 'png'): ImageFacts {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250_000)));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let rgSum = 0, rgSq = 0, ybSum = 0, ybSq = 0;
  let edges = 0, edgeN = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const l = luma(data, i);
      sum += l;
      sumSq += l * l;
      const rg = data[i] - data[i + 1];
      const yb = 0.5 * (data[i] + data[i + 1]) - data[i + 2];
      rgSum += rg; rgSq += rg * rg; ybSum += yb; ybSq += yb * yb;
      n++;
      if (x + step < w && y + step < h) {
        const gx = Math.abs(luma(data, (y * w + x + step) * 4) - l);
        const gy = Math.abs(luma(data, ((y + step) * w + x) * 4) - l);
        edgeN++;
        if (gx + gy > 60) edges++;
      }
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const sd = (s: number, sq: number) => Math.sqrt(Math.max(0, sq / n - (s / n) ** 2));
  const colorfulness = Math.sqrt(sd(rgSum, rgSq) ** 2 + sd(ybSum, ybSq) ** 2) + 0.3 * Math.sqrt((rgSum / n) ** 2 + (ybSum / n) ** 2);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    format, width: w, height: h, sizeBytes, ratio: Math.round((w / h) * 1000) / 1000,
    brightness: r1(mean), contrast: r1(std), colorfulness: r1(colorfulness), detail: Math.round((edgeN ? edges / edgeN : 0) * 1000) / 1000,
  };
}

/** Copia reducida en JPEG (lado mayor ≤ max) para mandarla a la IA sin pasar el original. */
export function thumbnailJpeg(img: Rgba, max = 1024, quality = 82): Buffer {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = 255;
    }
  }
  return encodeJpeg({ data: out, width: w, height: h }, quality).data;
}

/** Proporción en palabras y dónde se ve bien. */
export function ratioName(r: number): string {
  if (Math.abs(r - 1) < 0.03) return 'cuadrada (1:1)';
  if (Math.abs(r - 0.8) < 0.03) return 'vertical 4:5';
  if (Math.abs(r - 0.5625) < 0.03) return 'vertical 9:16';
  if (Math.abs(r - 1.91) < 0.06) return 'horizontal 1,91:1';
  return r < 1 ? 'vertical' : 'horizontal';
}

export function checkImage(f: ImageFacts): CheckItem[] {
  const out: CheckItem[] = [];
  const add = (x: Omit<CheckItem, 'area'>) => out.push({ area: 'IMAGEN', ...x });
  add({ key: 'formato', level: 'OK', title: `Formato ${f.format.toUpperCase()}`, detail: `${f.width} × ${f.height} px · ${Math.round(f.sizeBytes / 1024)} KB` });

  if (f.width < 600 || f.height < 600) {
    add({ key: 'resolucion', level: 'BAD', title: 'La imagen es muy pequeña', detail: `Mide ${f.width} × ${f.height} px y Meta pide al menos 600 px por lado.`, fix: 'Usa una imagen de 1080 px de ancho o más.' });
  } else if (Math.min(f.width, f.height) < 1080) {
    add({ key: 'resolucion', level: 'WARN', title: 'Resolución justa', detail: `El lado menor mide ${Math.min(f.width, f.height)} px; en pantallas grandes puede verse borrosa.`, fix: 'Lo recomendado es 1080 px o más en el lado menor.' });
  } else {
    add({ key: 'resolucion', level: 'OK', title: 'Buena resolución', detail: `Lado menor de ${Math.min(f.width, f.height)} px.` });
  }

  const r = f.ratio;
  const name = ratioName(r);
  if (r >= 0.78 && r <= 1.03) {
    add({ key: 'proporcion', level: 'OK', title: `Proporción ${name}`, detail: 'Ocupa buen espacio en el feed de Facebook e Instagram desde el celular.', fix: r > 0.9 ? 'Si puedes, una versión vertical 4:5 ocupa aún más pantalla en el feed.' : undefined });
  } else if (r < 0.78) {
    add({ key: 'proporcion', level: 'WARN', title: `Proporción ${name}`, detail: 'Es ideal para historias y reels, pero en el feed Meta la recorta a 4:5: lo de arriba y abajo puede quedar fuera.', fix: 'Deja el mensaje y el producto en el centro, o sube también una versión 1:1 o 4:5.' });
  } else {
    add({ key: 'proporcion', level: 'WARN', title: `Proporción ${name}`, detail: 'En el celular una imagen horizontal se ve pequeña y en historias se recorta mucho.', fix: 'Para el feed usa 1:1 o 4:5; para historias, 9:16.' });
  }

  if (f.brightness < 55) add({ key: 'luz', level: 'WARN', title: 'Imagen oscura', detail: `Luminosidad promedio ${f.brightness} de 255: en el celular cuesta ver el producto.`, fix: 'Aclara la foto o usa una con mejor luz.' });
  else if (f.brightness > 215) add({ key: 'luz', level: 'WARN', title: 'Imagen muy clara', detail: `Luminosidad promedio ${f.brightness} de 255: puede verse lavada y perderse sobre el fondo blanco de Facebook.`, fix: 'Baja un poco la exposición o agrega un borde o fondo de color.' });
  else add({ key: 'luz', level: 'OK', title: 'Buena luz', detail: `Luminosidad promedio ${f.brightness} de 255.` });

  if (f.contrast < 30) add({ key: 'contraste', level: 'WARN', title: 'Poco contraste', detail: 'Los elementos se parecen mucho entre sí: el producto o el texto no resaltan al pasar rápido.', fix: 'Separa el producto del fondo (fondo más claro u oscuro, o más color).' });
  else add({ key: 'contraste', level: 'OK', title: 'Buen contraste', detail: 'El contenido se distingue del fondo.' });

  if (f.colorfulness < 12) add({ key: 'color', level: 'WARN', title: 'Colores apagados', detail: 'Casi no tiene color; en el feed compite con muchas fotos llamativas.', fix: 'Si no es a propósito (estilo blanco y negro), prueba una foto con más color.' });

  if (f.detail > 0.3) add({ key: 'detalle', level: 'WARN', title: 'Posiblemente mucho texto o muchos elementos', detail: 'La imagen tiene mucho detalle fino, algo típico de imágenes con bastante texto. Es una estimación: el código no lee las letras.', fix: 'Meta recomienda poco texto en la imagen; deja el mensaje largo para el texto del anuncio.' });

  return out;
}

const URL_RE = /(https?:\/\/|www\.)\S+/i;
/** Atributos personales: Meta rechaza anuncios que afirman o insinúan cosas de quien los lee. */
const PERSONAL = [/\b(est[aá]s|eres)\s+(gord[oa]|obes[oa]|deprimid[oa]|endeudad[oa]|diab[eé]tic[oa]|solter[oa]|divorciad[oa])/i, /\btu\s+(deuda|enfermedad|diagn[oó]stico|religi[oó]n|orientaci[oó]n)/i, /\bpierde\s+\d+\s*(kg|kilos)/i];
const RISKY = [/\bantes\s+y\s+despu[eé]s\b/i, /\bgarantizad[oa]s?\b/i, /\b100\s*%\s*(seguro|efectivo|garantizado)/i, /\bcura\b/i, /\bmilagros?[oa]?\b/i];
const ACTION = /(escr[ií]benos|escribe|reserva|pide|ped[ií]|ordena|llama|vis[ií]tanos|ven\b|aprovecha|compra|cotiza|agenda|haz tu pedido|desc[uú]brelo|pru[eé]balo|whatsapp)/i;
const CONCRETE = /(\$\s?\d|\d+\s?%|\d+\s?(x|por)\s?\d|\bgratis\b|\bdescuento\b|\b2x1\b|\bpromo|\bhoy\b|\bsolo\b|\bhasta\b)/i;
const EMOJI = /\p{Extended_Pictographic}/gu;

export function checkCopy(c: CopyInput): CheckItem[] {
  const out: CheckItem[] = [];
  const add = (x: CheckItem) => out.push(x);
  const text = c.primaryText.trim();
  const head = c.headline.trim();
  if (!text) add({ key: 'texto', area: 'TEXTO', level: 'BAD', title: 'Falta el texto principal', detail: 'Es lo primero que se lee encima de la imagen.' });
  else if (text.length > 125) add({ key: 'texto', area: 'TEXTO', level: 'WARN', title: 'Texto largo', detail: `Tiene ${text.length} caracteres; en el celular se corta cerca de los 125 con «Ver más».`, fix: 'Pon la oferta y el llamado a la acción en la primera frase.' });
  else if (text.length < 20) add({ key: 'texto', area: 'TEXTO', level: 'WARN', title: 'Texto muy corto', detail: 'Con tan poco texto cuesta saber qué ofreces.', fix: 'Di qué ofreces, por qué ahora y qué hacer.' });
  else add({ key: 'texto', area: 'TEXTO', level: 'OK', title: 'Largo del texto adecuado', detail: `${text.length} caracteres: se lee completo en el celular.` });

  if (!head) add({ key: 'titulo', area: 'TEXTO', level: 'BAD', title: 'Falta el título', detail: 'Va debajo de la imagen, junto al botón.' });
  else if (head.length > 40) add({ key: 'titulo', area: 'TEXTO', level: 'WARN', title: 'Título largo', detail: `Tiene ${head.length} caracteres; se corta cerca de los 40.`, fix: 'Déjalo en una idea corta (la oferta o el plato).' });

  if (text && !CONCRETE.test(`${text} ${head}`)) add({ key: 'concreto', area: 'TEXTO', level: 'WARN', title: 'Sin un dato concreto', detail: 'No hay precio, descuento, promoción ni fecha.', fix: 'Los anuncios con un dato concreto («2x1 los martes», «desde $25.000») suelen funcionar mejor.' });
  if (text && !ACTION.test(`${text} ${head}`)) add({ key: 'accion', area: 'TEXTO', level: 'WARN', title: 'Sin llamado a la acción en el texto', detail: 'El botón ayuda, pero el texto no dice qué hacer.', fix: c.goal === 'WHATSAPP' ? 'Termina con algo como «Escríbenos por WhatsApp y reserva tu mesa».' : 'Termina con algo como «Pide en línea» o «Reserva hoy».' });

  const letters = text.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
  const upper = letters.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length;
  if (letters.length > 20 && upper / letters.length > 0.35) add({ key: 'mayusculas', area: 'TEXTO', level: 'WARN', title: 'Muchas mayúsculas', detail: 'Se lee como si gritaras y Meta puede mostrarlo menos.', fix: 'Usa mayúsculas solo al inicio o en una palabra clave.' });
  if ((text.match(/!/g) ?? []).length > 3) add({ key: 'exclamaciones', area: 'TEXTO', level: 'WARN', title: 'Demasiados signos de exclamación', detail: 'Más de tres en el texto.', fix: 'Uno o dos son suficientes.' });
  if ((text.match(EMOJI) ?? []).length > 5) add({ key: 'emojis', area: 'TEXTO', level: 'WARN', title: 'Muchos emojis', detail: 'Más de cinco emojis distraen del mensaje.', fix: 'Deja dos o tres que acompañen la idea.' });
  if (c.goal === 'WHATSAPP' && URL_RE.test(text)) add({ key: 'enlace', area: 'TEXTO', level: 'WARN', title: 'Enlace dentro del texto', detail: 'El anuncio ya abre WhatsApp con el botón; un enlace en el texto distrae.', fix: 'Quita el enlace del texto.' });

  const all = `${text} ${head} ${c.description ?? ''}`;
  if (PERSONAL.some((re) => re.test(all))) add({ key: 'atributos', area: 'POLITICAS', level: 'BAD', title: 'Riesgo de rechazo: atributos personales', detail: 'Meta rechaza textos que afirman o insinúan algo personal de quien lee (salud, peso, deudas, religión…).', fix: 'Habla de tu producto, no de la persona: «Platos ligeros» en vez de «¿Estás gordo?».' });
  if (RISKY.some((re) => re.test(all))) add({ key: 'promesas', area: 'POLITICAS', level: 'WARN', title: 'Promesas que Meta revisa con lupa', detail: 'Frases como «garantizado», «cura», «milagroso» o «antes y después» suelen frenar la aprobación.', fix: 'Cámbialas por beneficios concretos y verificables.' });
  return out;
}

/** Puntaje simple (0-100): cada problema resta. Sirve para comparar versiones, no es una predicción. */
export function scoreOf(items: CheckItem[]): number {
  const bad = items.filter((i) => i.level === 'BAD').length;
  const warn = items.filter((i) => i.level === 'WARN').length;
  return Math.max(0, Math.min(100, 100 - bad * 25 - warn * 7));
}
