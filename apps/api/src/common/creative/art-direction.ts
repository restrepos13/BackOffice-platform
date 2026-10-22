import { FormatKey } from '../design-doc';
import { AssetDims, Content, FAMILIES, Family, compose, composeWithReport, seedHash, tokensFor } from './compose';
import { Personality, ResolvedIdentity } from './identity';

/**
 * Dirección de arte: decide QUÉ composición conviene (y por qué) según la
 * identidad de la marca, el objetivo, el contenido, los recursos y lo que
 * la empresa usó hace poco. Selección determinista y explicable; la
 * variación usa una semilla reproducible.
 */

export const GOALS = ['PRODUCT', 'PROMO', 'TIP', 'NEWS', 'EVENT', 'BRAND', 'TESTIMONIAL', 'STEPS', 'BENEFITS', 'CATALOG', 'INFO'] as const;
export type Goal = (typeof GOALS)[number];

export const GOAL_LABEL: Record<Goal, string> = {
  PRODUCT: 'Mostrar un producto', PROMO: 'Promoción u oferta', TIP: 'Consejo útil', NEWS: 'Novedad o anuncio', EVENT: 'Evento o fecha',
  BRAND: 'Frase de marca', TESTIMONIAL: 'Testimonio de un cliente', STEPS: 'Paso a paso', BENEFITS: 'Beneficios', CATALOG: 'Varios productos', INFO: 'Información del servicio',
};

interface FamilyMeta {
  label: string;
  purpose: string;
  goals: Partial<Record<Goal, number>>;
  affinity: Partial<Record<Personality, number>>;
  needs: { photos?: number; items?: number; points?: number; price?: boolean; quote?: boolean; date?: boolean };
  /** Variantes estructurales reales (no cambios de color) */
  variants: number;
  usesPhoto: 'required' | 'optional' | 'none';
}

export const CATALOG: Record<Family, FamilyMeta> = {
  HERO_PHOTO: { label: 'Fotografía protagonista', purpose: 'La foto vende; el texto acompaña sobre una banda legible.', goals: { PRODUCT: 3, NEWS: 2, PROMO: 2, EVENT: 1 }, affinity: { CALIDA: 1, NATURAL: 1, AUDAZ: 1, ENERGICA: 1 }, needs: { photos: 1 }, variants: 2, usesPhoto: 'required' },
  EDITORIAL: { label: 'Editorial minimalista', purpose: 'Mucho aire, jerarquía tipográfica y una foto enmarcada.', goals: { PRODUCT: 3, NEWS: 2, BRAND: 2, INFO: 2, TIP: 1 }, affinity: { ELEGANTE: 2, MINIMALISTA: 2, PROFESIONAL: 1 }, needs: {}, variants: 2, usesPhoto: 'optional' },
  TYPE_DOMINANT: { label: 'Titular dominante', purpose: 'El mensaje es la imagen: un titular grande con énfasis.', goals: { NEWS: 3, BRAND: 3, PROMO: 2, TIP: 2, EVENT: 1, INFO: 1 }, affinity: { ENERGICA: 2, AUDAZ: 2, DIVERTIDA: 1 }, needs: {}, variants: 2, usesPhoto: 'none' },
  CATALOG: { label: 'Catálogo de productos', purpose: 'Varios productos con nombre y precio, comparables de un vistazo.', goals: { CATALOG: 3, PRODUCT: 2 }, affinity: { DIVERTIDA: 1, PROFESIONAL: 1 }, needs: { items: 2 }, variants: 1, usesPhoto: 'optional' },
  OFFER: { label: 'Oferta destacada', purpose: 'El precio o descuento en un sello visible, con vigencia clara.', goals: { PROMO: 3, PRODUCT: 1 }, affinity: { ENERGICA: 1, DIVERTIDA: 1 }, needs: { price: true }, variants: 2, usesPhoto: 'optional' },
  BENEFITS: { label: 'Beneficios', purpose: 'Razones concretas para elegirte, en una lista corta.', goals: { BENEFITS: 3, INFO: 2, PRODUCT: 1 }, affinity: { PROFESIONAL: 1, MINIMALISTA: 1 }, needs: { points: 2 }, variants: 1, usesPhoto: 'optional' },
  TESTIMONIAL: { label: 'Testimonio', purpose: 'La voz de un cliente real, con su nombre.', goals: { TESTIMONIAL: 3, BRAND: 1 }, affinity: { CALIDA: 1, ELEGANTE: 1 }, needs: { quote: true }, variants: 2, usesPhoto: 'optional' },
  TIPS: { label: 'Consejo educativo', purpose: 'Un tip que demuestra que sabes de lo tuyo.', goals: { TIP: 3, INFO: 1 }, affinity: { PROFESIONAL: 1, CALIDA: 1, NATURAL: 1 }, needs: {}, variants: 2, usesPhoto: 'none' },
  STEPS: { label: 'Paso a paso', purpose: 'Un proceso numerado, fácil de seguir.', goals: { STEPS: 3, TIP: 2, INFO: 1 }, affinity: { PROFESIONAL: 1, DIVERTIDA: 1 }, needs: { points: 2 }, variants: 1, usesPhoto: 'none' },
  EVENT: { label: 'Anuncio de evento', purpose: 'La fecha manda: bloque de fecha, lugar y cómo asistir.', goals: { EVENT: 3 }, affinity: { ENERGICA: 1, DIVERTIDA: 1 }, needs: { date: true }, variants: 2, usesPhoto: 'optional' },
  MODULAR: { label: 'Composición modular', purpose: 'Fotos y bloques de color en una retícula, con ritmo.', goals: { PRODUCT: 2, NEWS: 2, CATALOG: 1, PROMO: 1 }, affinity: { DIVERTIDA: 2, CALIDA: 1, AUDAZ: 1 }, needs: { photos: 1 }, variants: 2, usesPhoto: 'required' },
  CORPORATE_INFO: { label: 'Informativo corporativo', purpose: 'Información clara con barras de marca y viñetas.', goals: { INFO: 3, BENEFITS: 2, NEWS: 1 }, affinity: { PROFESIONAL: 2, MINIMALISTA: 1 }, needs: {}, variants: 1, usesPhoto: 'none' },
};

export interface ProposalRequest {
  goal: Goal;
  format: FormatKey;
  content: Content;
  /** Familias de los diseños recientes de la empresa (más nuevo primero) */
  recent: Family[];
  /** Mantener la estructura de una campaña (consistencia por encima de variedad) */
  consistentWith?: Family | null;
  seed: number;
  companySeed: number;
  brandName: string;
  dims: AssetDims;
}

export interface Ranked { family: Family; score: number; reasons: string[]; blockedBy?: string }

function missing(meta: FamilyMeta, c: Content): string | null {
  if (meta.needs.photos && c.photos.length < meta.needs.photos) return 'necesita una foto';
  if (meta.needs.items && (c.items?.length ?? 0) < meta.needs.items) return `necesita al menos ${meta.needs.items} productos`;
  if (meta.needs.points && (c.points?.length ?? 0) < meta.needs.points) return `necesita al menos ${meta.needs.points} puntos`;
  if (meta.needs.price && !c.price) return 'necesita un precio o descuento';
  if (meta.needs.quote && !c.quote) return 'necesita la frase del cliente';
  if (meta.needs.date && !c.date?.day) return 'necesita la fecha';
  return null;
}

/** Puntaje explicable de cada familia para esta empresa y este pedido. */
export function rank(id: ResolvedIdentity, req: ProposalRequest): Ranked[] {
  const pers = id.personality.value;
  return FAMILIES.map((family) => {
    const meta = CATALOG[family];
    const reasons: string[] = [];
    const fit = meta.goals[req.goal] ?? 0;
    let score = fit * 10;
    if (fit >= 3) reasons.push(`es la forma más directa de «${GOAL_LABEL[req.goal].toLowerCase()}»`);
    else if (fit === 2) reasons.push(`funciona bien para «${GOAL_LABEL[req.goal].toLowerCase()}»`);
    const aff = pers.reduce((s, p) => s + (meta.affinity[p] ?? 0), 0);
    score += aff * 3;
    if (aff >= 2) reasons.push(`encaja con la personalidad de tu marca (${pers.map((p) => p.toLowerCase()).join(', ')})`);
    // Estilo de foto de la marca
    if (id.photoStyle.value === 'SIN_FOTO' && meta.usesPhoto === 'required') score -= 20;
    if (id.photoStyle.value === 'PROTAGONISTA' && family === 'HERO_PHOTO') { score += 6; reasons.push('tu marca prefiere fotos protagonistas'); }
    if (id.photoStyle.value === 'ENMARCADA' && family === 'EDITORIAL') score += 4;
    if (meta.usesPhoto !== 'none' && req.content.photos.length) { score += 3; reasons.push('aprovecha tu foto'); }
    // Lo que se prohibió en la marca
    if (id.forbidden.some((f) => /foto/.test(f) && /sin|no /.test(f)) && meta.usesPhoto === 'required') score -= 15;
    // Repetición reciente: penaliza (salvo que se pida consistencia de campaña)
    const uses = req.recent.slice(0, 6).filter((f) => f === family).length;
    if (req.consistentWith) {
      if (req.consistentWith === family) { score += 40; reasons.unshift('mantiene la estructura de tu campaña'); }
    } else if (uses) {
      score -= uses * 6;
      if (uses >= 2) reasons.push(`la usaste ${uses} veces en tus últimas piezas`);
    } else if (req.recent.length >= 2) reasons.push('no la usaste últimamente');
    const blockedBy = missing(meta, req.content) ?? undefined;
    return { family, score: blockedBy ? -Infinity : score, reasons, blockedBy };
  }).sort((a, b) => b.score - a.score);
}

export interface Proposal {
  family: Family;
  label: string;
  purpose: string;
  variant: number;
  reason: string;
  doc: ReturnType<typeof compose>;
  /** Bloques que no entraron en este formato (se avisa; se pueden agregar en el editor) */
  omitted: string[];
}

/**
 * Hasta 3 propuestas ESTRUCTURALMENTE distintas (familias diferentes). Si
 * solo una encaja de verdad, se devuelve una sola y se explica: no se
 * inventan alternativas para aparentar variedad.
 */
export function propose(id: ResolvedIdentity, req: ProposalRequest): { proposals: Proposal[]; note: string | null; unavailable: Array<{ family: Family; label: string; why: string }> } {
  const ranked = rank(id, req);
  const fitting = ranked.filter((r) => r.score > 0 && Number.isFinite(r.score) && (CATALOG[r.family].goals[req.goal] ?? 0) >= 2 || (req.consistentWith === r.family && Number.isFinite(r.score)));
  const chosen = (fitting.length ? fitting : ranked.filter((r) => Number.isFinite(r.score)).slice(0, 1)).slice(0, req.consistentWith ? 1 : 3);
  const proposals = chosen.map((r, i) => {
    const meta = CATALOG[r.family];
    // La variante sale de la semilla: misma petición → mismo resultado; "otra opción" cambia la semilla
    const variant = (seedHash(`${req.seed}:${r.family}`) + i) % meta.variants;
    const tokens = tokensFor(id, req.format, req.companySeed, req.brandName);
    const { doc, omitted } = composeWithReport(r.family, tokens, req.content, variant, req.dims);
    return {
      family: r.family, label: meta.label, purpose: meta.purpose, variant,
      reason: r.reasons.length ? `Recomendada porque ${r.reasons.slice(0, 3).join('; ')}.` : meta.purpose,
      doc, omitted,
    };
  });
  const note = req.consistentWith ? 'Mantuvimos la estructura de tu campaña; solo cambia el contenido.'
    : proposals.length === 1 ? 'Con lo que tenemos, una sola dirección encaja bien. Si agregas una foto o más detalles, aparecerán otras opciones.'
      : null;
  const unavailable = ranked.filter((r) => r.blockedBy && (CATALOG[r.family].goals[req.goal] ?? 0) >= 2).map((r) => ({ family: r.family, label: CATALOG[r.family].label, why: r.blockedBy! }));
  return { proposals, note, unavailable };
}
