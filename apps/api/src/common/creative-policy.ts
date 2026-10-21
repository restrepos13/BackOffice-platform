/**
 * Reglas de publicación híbrida de BackOffice Creative. Deterministas (sin IA):
 * deciden si una pieza puede programarse sola o necesita revisión humana.
 * La primera publicación de cada marca SIEMPRE pasa por una persona, y la
 * autonomía solo aplica a las categorías que la empresa aprobó.
 */

export const CATEGORIES = ['PRODUCTO', 'PROMO', 'TIPS', 'MARCA', 'EVENTO', 'OTRO'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface PublishPolicy {
  /** Pausa global: nada se publica solo */
  paused: boolean;
  /** Autonomía activada explícitamente por la empresa */
  autonomyEnabled: boolean;
  /** Categorías que pueden publicarse sin revisión */
  autoCategories: Category[];
  /** Temas o palabras que siempre requieren revisión */
  restrictedTopics: string[];
  /** Precios, descuentos o promociones requieren revisión */
  pricesNeedReview: boolean;
  /** Redes autorizadas */
  networks: Array<'facebook' | 'instagram'>;
  /** Máximo de publicaciones por día */
  maxPerDay: number;
  /** Ventana horaria permitida (hora local de la empresa) */
  fromHour: number;
  toHour: number;
}

export const DEFAULT_POLICY: PublishPolicy = {
  paused: false,
  autonomyEnabled: false,
  autoCategories: [],
  restrictedTopics: [],
  pricesNeedReview: true,
  networks: ['facebook', 'instagram'],
  maxPerDay: 2,
  fromHour: 7,
  toHour: 21,
};

export function readPolicy(raw: unknown): PublishPolicy {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {};
  const num = (v: unknown, min: number, max: number, def: number) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : def);
  return {
    paused: o.paused === true,
    autonomyEnabled: o.autonomyEnabled === true,
    autoCategories: Array.isArray(o.autoCategories) ? o.autoCategories.filter((c: unknown) => (CATEGORIES as readonly string[]).includes(c as string)) : [],
    restrictedTopics: Array.isArray(o.restrictedTopics) ? o.restrictedTopics.map((x: unknown) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 30) : [],
    pricesNeedReview: o.pricesNeedReview !== false,
    networks: Array.isArray(o.networks) ? o.networks.filter((n: unknown) => n === 'facebook' || n === 'instagram') : DEFAULT_POLICY.networks,
    maxPerDay: num(o.maxPerDay, 1, 20, DEFAULT_POLICY.maxPerDay),
    fromHour: num(o.fromHour, 0, 23, DEFAULT_POLICY.fromHour),
    toHour: num(o.toHour, 1, 24, DEFAULT_POLICY.toHour),
  };
}

const plain = (t: string) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Precios, descuentos y promociones (afirmaciones comerciales que debe confirmar una persona). */
const PRICE_RE = /\$\s?\d|\d{1,3}(?:[.,]\d{3})+|\d+\s?(?:mil|k)\b|\d+\s?%|descuento|promo|oferta|gratis|2x1|rebaja|precio especial|liquidacion/;

export interface ReviewDecision {
  needsReview: boolean;
  reasons: string[];
}

/**
 * ¿Esta pieza necesita revisión humana antes de programarse?
 * `humanApprovedCount` = piezas de la empresa ya aprobadas por una persona.
 */
export function reviewDecision(piece: { category?: string | null; copy?: string | null; title?: string | null }, policy: PublishPolicy, humanApprovedCount: number): ReviewDecision {
  const reasons: string[] = [];
  const text = plain(`${piece.title ?? ''} ${piece.copy ?? ''}`);
  if (humanApprovedCount === 0) reasons.push('Es la primera publicación de la marca: la aprueba una persona');
  if (!policy.autonomyEnabled) reasons.push('La publicación automática no está activada');
  if (!piece.category || !(policy.autoCategories as string[]).includes(piece.category)) reasons.push('Esta categoría no está aprobada para publicarse sola');
  if (policy.pricesNeedReview && PRICE_RE.test(text)) reasons.push('Menciona precios, descuentos o promociones');
  const hit = policy.restrictedTopics.find((t) => t && text.includes(plain(t)));
  if (hit) reasons.push(`Toca un tema restringido: ${hit}`);
  return { needsReview: reasons.length > 0, reasons };
}

/** ¿Se puede programar a esa hora y ese día? (ventana horaria y tope diario) */
export function scheduleProblem(at: Date, timezone: string, policy: PublishPolicy, scheduledThatDay: number): string | null {
  if (policy.paused) return 'Las publicaciones están en pausa';
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'America/Bogota', hour: 'numeric', hour12: false }).format(at)) % 24;
  if (hour < policy.fromHour || hour >= policy.toHour) return `Fuera del horario permitido (${policy.fromHour}:00 a ${policy.toHour}:00)`;
  if (scheduledThatDay >= policy.maxPerDay) return `Ya hay ${scheduledThatDay} publicaciones ese día (máximo ${policy.maxPerDay})`;
  return null;
}

/* ── Imágenes: tipo y dimensiones reales (sin librerías) ── */

export function imageInfo(buf: Buffer): { mime: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number } | null {
  if (buf.length < 24) return null;
  // PNG: firma + IHDR
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: busca el marcador SOF
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return null;
  }
  // WEBP: RIFF....WEBP + VP8/VP8L/VP8X
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}
