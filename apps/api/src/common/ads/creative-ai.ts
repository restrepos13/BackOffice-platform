import { ImageFacts, ratioName } from './creative-check';

/**
 * Revisión de un anuncio con la IA DE LA EMPRESA (su propia llave de
 * DeepInfra: lo que consume lo paga directo a su proveedor). El modelo ve una
 * copia reducida de la imagen, el texto y el objetivo, y devuelve
 * recomendaciones. Todo lo que responde se valida aquí: nada se usa a ciegas.
 */

export interface AiReview {
  summary: string;
  score: number | null;
  strengths: string[];
  improvements: Array<{ area: string; problem: string; suggestion: string; priority: 'ALTA' | 'MEDIA' | 'BAJA' }>;
  suggestedCopy: { primaryText: string | null; headline: string | null };
  policyRisk: { level: 'BAJO' | 'MEDIO' | 'ALTO'; reason: string | null };
  /** Lo que la IA dice que ve en la imagen (para que la persona confirme que la entendió) */
  seen: string | null;
}

export interface AiReviewContext {
  business: string;
  industry: string | null;
  goal: 'WHATSAPP' | 'WEBSITE';
  primaryText: string;
  headline: string;
  description?: string;
  audience: string;
  facts: ImageFacts | null;
}

export function reviewMessages(ctx: AiReviewContext, imageDataUrl: string | null) {
  const facts = ctx.facts
    ? `Imagen: ${ctx.facts.width}×${ctx.facts.height} px, ${ratioName(ctx.facts.ratio)}, luminosidad ${ctx.facts.brightness}/255, contraste ${ctx.facts.contrast}.`
    : 'Sin imagen.';
  const system =
    `Eres especialista en anuncios de Meta (Facebook e Instagram) para negocios locales. Revisas un anuncio de ${ctx.business}` +
    `${ctx.industry ? ` (${ctx.industry})` : ''} antes de publicarlo. Objetivo: ${ctx.goal === 'WHATSAPP' ? 'que escriban por WhatsApp' : 'que visiten la web (reservas o pedidos)'}. ` +
    'Responde en español neutro, concreto y sin adular. Devuelve SOLO un JSON con esta forma: ' +
    '{"lo_que_ves": "qué muestra la imagen en una frase", "resumen": "2 frases con tu opinión", "puntaje": 1-10, ' +
    '"lo_que_funciona": ["…"], "mejoras": [{"aspecto": "imagen|texto|oferta|llamado|publico|politicas", "problema": "…", "sugerencia": "…", "prioridad": "alta|media|baja"}], ' +
    '"texto_sugerido": {"principal": "máx. 125 caracteres", "titulo": "máx. 40 caracteres"}, ' +
    '"riesgo_politicas": {"nivel": "bajo|medio|alto", "motivo": "…"}}. ' +
    'Máximo 5 mejoras, ordenadas por impacto. No inventes datos del negocio (precios, direcciones) que no estén en el anuncio.';
  const text =
    `${facts}\nPúblico: ${ctx.audience}\nTexto principal: ${ctx.primaryText || '(vacío)'}\nTítulo: ${ctx.headline || '(vacío)'}` +
    `${ctx.description ? `\nDescripción: ${ctx.description}` : ''}`;
  return [
    { role: 'system' as const, content: system },
    {
      role: 'user' as const,
      content: imageDataUrl
        ? [{ type: 'text' as const, text }, { type: 'image_url' as const, image_url: { url: imageDataUrl } }]
        : text,
    },
  ];
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const list = (v: unknown, max: number, len = 200) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter((x): x is string => !!x).slice(0, max) : []);

/** Valida lo que devolvió el modelo. Si no trae nada útil devuelve null (se informa como error). */
export function normalizeReview(raw: unknown): AiReview | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, any>;
  const level = (v: unknown): 'ALTA' | 'MEDIA' | 'BAJA' => (/alta/i.test(String(v)) ? 'ALTA' : /baja/i.test(String(v)) ? 'BAJA' : 'MEDIA');
  const improvements = (Array.isArray(o.mejoras) ? o.mejoras : [])
    .map((m: any) => ({ area: str(m?.aspecto, 30) ?? 'general', problem: str(m?.problema, 240), suggestion: str(m?.sugerencia, 300), priority: level(m?.prioridad) }))
    .filter((m: any) => m.problem && m.suggestion)
    .slice(0, 5) as AiReview['improvements'];
  const n = Number(o.puntaje);
  const risk = String(o.riesgo_politicas?.nivel ?? '');
  const review: AiReview = {
    summary: str(o.resumen, 500) ?? '',
    score: Number.isFinite(n) ? Math.max(1, Math.min(10, Math.round(n))) : null,
    strengths: list(o.lo_que_funciona, 5),
    improvements,
    suggestedCopy: { primaryText: str(o.texto_sugerido?.principal, 300), headline: str(o.texto_sugerido?.titulo, 80) },
    policyRisk: { level: /alto/i.test(risk) ? 'ALTO' : /medio/i.test(risk) ? 'MEDIO' : 'BAJO', reason: str(o.riesgo_politicas?.motivo, 300) },
    seen: str(o.lo_que_ves, 240),
  };
  return review.summary || review.improvements.length || review.strengths.length ? review : null;
}
