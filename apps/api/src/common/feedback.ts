/**
 * Interpretación DETERMINISTA de la respuesta de feedback del cliente.
 * Sin IA: reglas simples y auditables (la respuesta completa queda como
 * comentario, esto solo extrae rating y sentimiento).
 */

const WORD_RATINGS: Record<string, number> = {
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
};

/** Extrae una calificación 1-5 del texto (dígito suelto, palabra o estrellas). */
export function parseRating(text: string): number | null {
  const t = (text ?? '').toLowerCase();

  // "4", "4/5", "un 4", "le doy 5" — dígito 1-5 no pegado a otros números
  const digit = t.match(/(?:^|[^\d.,])([1-5])(?:[^\d]|$)/);
  if (digit) return Number(digit[1]);

  for (const [word, value] of Object.entries(WORD_RATINGS)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) return value;
  }

  const stars = (text.match(/⭐|★/g) ?? []).length;
  if (stars >= 1 && stars <= 5) return stars;

  return null;
}

const NEGATIVE_WORDS = [
  'malo', 'mala', 'pésimo', 'pesimo', 'terrible', 'frío', 'frio', 'tarde',
  'incompleto', 'queja', 'reclamo', 'demora', 'demorado', 'nunca', 'horrible',
  'decepcion', 'decepción', 'mal ',
];
const POSITIVE_WORDS = [
  'excelente', 'delicioso', 'deliciosa', 'perfecto', 'perfecta', 'rico', 'rica',
  'gracias', 'buenísimo', 'buenisimo', 'espectacular', 'genial', 'muy bien',
  'muy bueno', 'muy buena', 'encant',
];

/** Sentimiento del comentario: el rating manda; sin rating, palabras clave. */
export function inferSentiment(
  text: string,
  rating: number | null,
): 'POSITIVO' | 'NEUTRO' | 'NEGATIVO' {
  if (rating != null) {
    if (rating >= 4) return 'POSITIVO';
    if (rating === 3) return 'NEUTRO';
    return 'NEGATIVO';
  }
  const t = ` ${(text ?? '').toLowerCase()} `;
  if (NEGATIVE_WORDS.some((w) => t.includes(w))) return 'NEGATIVO';
  if (POSITIVE_WORDS.some((w) => t.includes(w))) return 'POSITIVO';
  return 'NEUTRO';
}

/** Insatisfacción = alerta inmediata al equipo. */
export function isDissatisfied(rating: number | null, sentiment: string): boolean {
  return (rating != null && rating <= 3) || sentiment === 'NEGATIVO';
}
