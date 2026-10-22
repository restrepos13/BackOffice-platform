import { ALLOWED_FONTS } from '../design-doc';

/**
 * Identidad visual de una empresa. Lo que la empresa confirmó manda; lo que
 * falta se completa con una SUGERENCIA (derivada de su rubro, tono y paleta)
 * o un valor POR DEFECTO, y cada valor dice de dónde salió. Nada sugerido se
 * guarda como confirmado sin que la persona lo acepte.
 */

export const POSITIONING = ['ECONOMICO', 'ACCESIBLE', 'PREMIUM', 'ARTESANAL', 'CORPORATIVO', 'JUVENIL'] as const;
export const PERSONALITY = ['ELEGANTE', 'ENERGICA', 'CALIDA', 'PROFESIONAL', 'DIVERTIDA', 'MINIMALISTA', 'NATURAL', 'AUDAZ'] as const;
export const PHOTO_STYLE = ['PROTAGONISTA', 'ENMARCADA', 'SUAVE', 'SIN_FOTO'] as const;
export const DENSITY = ['AIREADA', 'EQUILIBRADA', 'COMPACTA'] as const;
export const ALIGNMENT = ['CENTRADA', 'IZQUIERDA', 'ASIMETRICA'] as const;
export const LOGO_PLACEMENT = ['ARRIBA_DERECHA', 'ARRIBA_IZQUIERDA', 'ABAJO_DERECHA', 'ABAJO_CENTRO'] as const;

export type Positioning = (typeof POSITIONING)[number];
export type Personality = (typeof PERSONALITY)[number];
export type PhotoStyle = (typeof PHOTO_STYLE)[number];
export type Density = (typeof DENSITY)[number];
export type Alignment = (typeof ALIGNMENT)[number];
export type LogoPlacement = (typeof LOGO_PLACEMENT)[number];

export interface VisualIdentityInput {
  positioning?: Positioning | null;
  personality?: Personality[];
  photoStyle?: PhotoStyle | null;
  density?: Density | null;
  alignment?: Alignment | null;
  logoPlacement?: LogoPlacement | null;
  colorRoles?: { primary?: string; accent?: string; background?: string; text?: string };
  references?: string[];
  forbidden?: string[];
}

export type Source = 'CONFIRMED' | 'SUGGESTED' | 'DEFAULT';
export interface Resolved<T> { value: T; source: Source; why?: string }

export interface ResolvedIdentity {
  sector: string;
  positioning: Resolved<Positioning | null>;
  personality: Resolved<Personality[]>;
  photoStyle: Resolved<PhotoStyle>;
  density: Resolved<Density>;
  alignment: Resolved<Alignment>;
  logoPlacement: Resolved<LogoPlacement>;
  colors: { primary: string; accent: string; light: string; dark: string; textOnLight: string; textOnDark: string; source: Source };
  fonts: { title: string; body: string; source: Source };
  logoAssetId: string | null;
  forbidden: string[];
  references: string[];
}

const HEX = /^#[0-9A-F]{6}$/i;
const pick = <T extends string>(v: unknown, list: readonly T[]): T | null => (list as readonly string[]).includes(String(v)) ? (v as T) : null;

/** Limpia lo que llega del panel: solo valores de las listas, colores hex y textos cortos. */
export function sanitizeVisual(raw: any): VisualIdentityInput {
  const roles = raw?.colorRoles && typeof raw.colorRoles === 'object' ? raw.colorRoles : {};
  const hex = (v: unknown) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : undefined);
  return {
    positioning: pick(raw?.positioning, POSITIONING),
    personality: (Array.isArray(raw?.personality) ? raw.personality : []).map((p: unknown) => pick(p, PERSONALITY)).filter(Boolean).slice(0, 3) as Personality[],
    photoStyle: pick(raw?.photoStyle, PHOTO_STYLE),
    density: pick(raw?.density, DENSITY),
    alignment: pick(raw?.alignment, ALIGNMENT),
    logoPlacement: pick(raw?.logoPlacement, LOGO_PLACEMENT),
    colorRoles: { primary: hex(roles.primary), accent: hex(roles.accent), background: hex(roles.background), text: hex(roles.text) },
    references: (Array.isArray(raw?.references) ? raw.references : []).filter((x: unknown) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x)).slice(0, 12),
    forbidden: (Array.isArray(raw?.forbidden) ? raw.forbidden : []).map((x: unknown) => String(x ?? '').trim().slice(0, 80)).filter(Boolean).slice(0, 12),
  };
}

/** Punto de partida por rubro (solo una sugerencia: la marca de la empresa manda). */
const SECTOR: Record<string, { personality: Personality[]; photoStyle: PhotoStyle; density: Density; alignment: Alignment; positioning: Positioning | null }> = {
  COMIDA: { personality: ['CALIDA', 'NATURAL'], photoStyle: 'PROTAGONISTA', density: 'EQUILIBRADA', alignment: 'ASIMETRICA', positioning: 'ARTESANAL' },
  BELLEZA: { personality: ['ELEGANTE', 'MINIMALISTA'], photoStyle: 'ENMARCADA', density: 'AIREADA', alignment: 'CENTRADA', positioning: 'PREMIUM' },
  ROPA: { personality: ['AUDAZ', 'ELEGANTE'], photoStyle: 'PROTAGONISTA', density: 'AIREADA', alignment: 'ASIMETRICA', positioning: null },
  SALUD: { personality: ['PROFESIONAL', 'CALIDA'], photoStyle: 'SUAVE', density: 'EQUILIBRADA', alignment: 'IZQUIERDA', positioning: 'CORPORATIVO' },
  EDUCACION: { personality: ['PROFESIONAL', 'DIVERTIDA'], photoStyle: 'SUAVE', density: 'EQUILIBRADA', alignment: 'IZQUIERDA', positioning: 'ACCESIBLE' },
  INMOBILIARIA: { personality: ['PROFESIONAL', 'ELEGANTE'], photoStyle: 'PROTAGONISTA', density: 'EQUILIBRADA', alignment: 'IZQUIERDA', positioning: 'CORPORATIVO' },
  TIENDA: { personality: ['DIVERTIDA', 'ENERGICA'], photoStyle: 'ENMARCADA', density: 'COMPACTA', alignment: 'CENTRADA', positioning: 'ACCESIBLE' },
  TALLER: { personality: ['PROFESIONAL', 'AUDAZ'], photoStyle: 'ENMARCADA', density: 'COMPACTA', alignment: 'IZQUIERDA', positioning: 'ACCESIBLE' },
  WEBCAM: { personality: ['AUDAZ', 'ENERGICA'], photoStyle: 'PROTAGONISTA', density: 'EQUILIBRADA', alignment: 'ASIMETRICA', positioning: 'JUVENIL' },
  SERVICIOS: { personality: ['PROFESIONAL', 'MINIMALISTA'], photoStyle: 'SUAVE', density: 'EQUILIBRADA', alignment: 'IZQUIERDA', positioning: 'CORPORATIVO' },
  GENERAL: { personality: ['CALIDA'], photoStyle: 'ENMARCADA', density: 'EQUILIBRADA', alignment: 'CENTRADA', positioning: null },
};

/** Señales del tono de comunicación que la empresa escribió. */
function fromTone(tone: string): { personality: Personality[]; positioning: Positioning | null } {
  // "nunca técnico", "sin formalismos", "no infantil": lo negado no cuenta como rasgo
  const t = tone.toLowerCase().replace(/\b(nunca|no|sin|evitar|evita|jamás|jamas|nada de)\s+(\S+)(\s+(y|ni|o)\s+\S+)?/g, ' ');
  const p: Personality[] = [];
  if (/elegan|sofistic|lujo|exclusiv|refinad/.test(t)) p.push('ELEGANTE');
  if (/energ|intens|motiva|fuerza|dinámic|dinamic/.test(t)) p.push('ENERGICA');
  if (/cercan|cálid|calid|amable|familiar|paisa/.test(t)) p.push('CALIDA');
  if (/profesional|serio|técnic|tecnic|formal|confiable/.test(t)) p.push('PROFESIONAL');
  if (/divertid|juvenil|alegre|fresco|relajad/.test(t)) p.push('DIVERTIDA');
  if (/minimal|simple|limpi|sobri/.test(t)) p.push('MINIMALISTA');
  if (/natural|orgánic|organic|artesan|origen/.test(t)) p.push('NATURAL');
  if (/audaz|atrevid|disruptiv|rebeld/.test(t)) p.push('AUDAZ');
  const positioning: Positioning | null = /lujo|premium|exclusiv/.test(t) ? 'PREMIUM' : /artesan|hecho a mano|origen/.test(t) ? 'ARTESANAL' : /económic|economic|barat/.test(t) ? 'ECONOMICO' : /juvenil/.test(t) ? 'JUVENIL' : null;
  return { personality: p, positioning };
}

export function luminance(hex: string) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrastRatio(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
function saturation(hex: string) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

const TITLE_BY_PERSONALITY: Record<Personality, string> = {
  ELEGANTE: 'Playfair Display', ENERGICA: 'Anton', CALIDA: 'Lora', PROFESIONAL: 'Montserrat', DIVERTIDA: 'Poppins',
  MINIMALISTA: 'Inter', NATURAL: 'DM Serif Display', AUDAZ: 'Archivo Black',
};

export function resolveIdentity(input: {
  visual: VisualIdentityInput | null;
  sector: string;
  tone: string;
  colors: string[];
  fonts: string[];
  logoAssetId: string | null;
  restrictions: string[];
}): ResolvedIdentity {
  const v = input.visual ?? {};
  const base = SECTOR[input.sector] ?? SECTOR.GENERAL;
  const tone = fromTone(input.tone ?? '');
  const sugPersonality = [...new Set([...tone.personality, ...base.personality])].slice(0, 3);
  const r = <T>(confirmed: T | null | undefined, suggested: T | null, def: T, why: string): Resolved<T> =>
    confirmed !== null && confirmed !== undefined && !(Array.isArray(confirmed) && !confirmed.length)
      ? { value: confirmed, source: 'CONFIRMED' }
      : suggested !== null && suggested !== undefined && !(Array.isArray(suggested) && !suggested.length) ? { value: suggested, source: 'SUGGESTED', why } : { value: def, source: 'DEFAULT', why: 'Valor neutro mientras no definas uno' };

  const personality = r<Personality[]>(v.personality, sugPersonality, ['CALIDA'], tone.personality.length ? 'Según el tono de tu marca y tu tipo de negocio' : 'Según tu tipo de negocio');
  // Colores: roles confirmados o deducidos de la paleta de la marca
  const palette = input.colors.filter((c) => HEX.test(c));
  const byLum = [...palette].sort((a, b) => luminance(a) - luminance(b));
  const dark = v.colorRoles?.text ?? (byLum[0] && luminance(byLum[0]) < 0.12 ? byLum[0] : '#1A1A1A');
  const light = v.colorRoles?.background ?? (byLum.at(-1) && luminance(byLum.at(-1)!) > 0.7 ? byLum.at(-1)! : '#F6F3EE');
  const primary = v.colorRoles?.primary ?? palette.find((c) => c !== light && c !== dark) ?? palette[0] ?? '#1F3A5F';
  const accent = v.colorRoles?.accent ?? [...palette].filter((c) => c !== primary && c !== light && c !== dark).sort((a, b) => saturation(b) - saturation(a))[0] ?? primary;
  const textOn = (bg: string) => (contrastRatio(bg, dark) >= contrastRatio(bg, '#FFFFFF') ? dark : '#FFFFFF');
  const title = input.fonts[0] && (ALLOWED_FONTS as readonly string[]).includes(input.fonts[0]) ? input.fonts[0] : TITLE_BY_PERSONALITY[personality.value[0]];
  const body = input.fonts[1] && (ALLOWED_FONTS as readonly string[]).includes(input.fonts[1]) ? input.fonts[1] : ['Anton', 'Bebas Neue', 'Archivo Black', 'Pacifico'].includes(title) ? 'Inter' : title === 'Playfair Display' || title === 'Lora' || title === 'DM Serif Display' ? 'Lato' : 'Inter';

  return {
    sector: input.sector,
    positioning: r(v.positioning, tone.positioning ?? base.positioning, null, 'Según el tono y el tipo de negocio'),
    personality,
    photoStyle: r(v.photoStyle, base.photoStyle, 'ENMARCADA', 'Según tu tipo de negocio'),
    density: r(v.density, personality.value.includes('MINIMALISTA') || personality.value.includes('ELEGANTE') ? 'AIREADA' : base.density, 'EQUILIBRADA', 'Según la personalidad de la marca'),
    alignment: r(v.alignment, base.alignment, 'CENTRADA', 'Según tu tipo de negocio'),
    logoPlacement: r(v.logoPlacement, null, 'ARRIBA_DERECHA', ''),
    colors: { primary, accent, light, dark, textOnLight: textOn(light), textOnDark: textOn(dark), source: v.colorRoles && Object.values(v.colorRoles).some(Boolean) ? 'CONFIRMED' : palette.length ? 'SUGGESTED' : 'DEFAULT' },
    fonts: { title, body, source: input.fonts.length ? 'CONFIRMED' : 'SUGGESTED' },
    logoAssetId: input.logoAssetId,
    forbidden: [...(v.forbidden ?? []), ...input.restrictions].map((x) => x.toLowerCase()),
    references: v.references ?? [],
  };
}

/** Sugerencia completa para mostrar (no se guarda sola). */
export function suggestVisual(sector: string, tone: string): { values: VisualIdentityInput; reasons: string[] } {
  const base = SECTOR[sector] ?? SECTOR.GENERAL;
  const t = fromTone(tone);
  const personality = [...new Set([...t.personality, ...base.personality])].slice(0, 3);
  return {
    values: { positioning: t.positioning ?? base.positioning, personality, photoStyle: base.photoStyle, density: personality.includes('MINIMALISTA') || personality.includes('ELEGANTE') ? 'AIREADA' : base.density, alignment: base.alignment },
    reasons: [
      `Tu tipo de negocio (${sector.toLowerCase()}) suele verse bien con ${base.photoStyle === 'PROTAGONISTA' ? 'fotos grandes y protagonistas' : base.photoStyle === 'ENMARCADA' ? 'fotos enmarcadas' : 'fotos suaves y acompañantes'}.`,
      ...(t.personality.length ? [`Tu tono («${tone.slice(0, 60)}») sugiere una personalidad ${t.personality.map((p) => p.toLowerCase()).join(' y ')}.`] : []),
      'Es solo un punto de partida: tu marca puede verse distinta a otras de tu rubro.',
    ],
  };
}
