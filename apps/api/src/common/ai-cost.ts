/**
 * Cuánto cuesta la IA de una empresa, calculado SOLO con código (cero llamadas
 * a modelos): tamaño real de lo que lee el asistente en cada mensaje, cuántos
 * clientes escriben al día y el precio de cada modelo por millón de tokens.
 *
 * Supuestos (explicados al cliente en su panel):
 *  - Una conversación = un cliente atendido en 24 h: ~6 mensajes suyos y 6 respuestas.
 *  - En CADA respuesta el modelo vuelve a leer las instrucciones, el catálogo y lo
 *    que se ha hablado; por eso lee mucho más de lo que escribe.
 *  - 1 token ≈ 4 letras en español.
 *  - El reporte diario se arma con código (no gasta IA); las preguntas en lenguaje
 *    natural al reporte sí usan IA (2 llamadas por pregunta).
 */

export const CHARS_PER_TOKEN = 4;
export const TURNS_PER_CONVERSATION = 6;
const REPLY_TOKENS = 90;
const HISTORY_TOKENS_PER_TURN = 70; // mensaje del cliente + respuesta, resumidos
const ENGINE_BASE_TOKENS = 900; // reglas fijas del motor (formato, seguridad, humanización)
const AGENT_FACTOR = 1.5; // el modo agente consulta herramientas (más llamadas)
const REPORT_QUERY = { input: 4000, output: 450 }; // una pregunta al reporte (2 llamadas)
const DAYS_PER_MONTH = 30;

/** Modelos de referencia que pueden no estar aún en el catálogo de la base. */
export const REFERENCE_MODELS: CostModel[] = [
  {
    modelId: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', provider: 'OPENROUTER',
    inputCostPerMTok: 1, outputCostPerMTok: 5, creditsPerConversation: 3,
    notes: 'Premium de Anthropic: muy natural y preciso siguiendo instrucciones. Más caro.',
  },
  {
    modelId: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', provider: 'OPENROUTER',
    inputCostPerMTok: 0.1, outputCostPerMTok: 0.5, creditsPerConversation: 1,
    notes: 'La generación nueva de Haiku: calidad premium a precio de modelo económico.',
  },
];

export interface CostModel {
  modelId: string;
  name: string;
  provider: string;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  creditsPerConversation: number;
  recommended?: boolean;
  notes?: string | null;
}

export interface CostInputs {
  /** Letras de las instrucciones del asistente (prompt + personalidad + saludo) */
  promptChars: number;
  /** Letras de la base de conocimiento que el asistente consulta */
  knowledgeChars: number;
  products: number;
  dailyChats: number;
  agentMode: boolean;
  trm: number;
  /** Modelo que usa hoy su asistente (para marcarlo) */
  currentModel?: string | null;
}

export interface PackageOption {
  id: string;
  name: string;
  conversations: number;
  price: number;
  validityMonths: number;
}

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

/** Tokens de una conversación típica de ESTA empresa. */
export function conversationTokens(i: Pick<CostInputs, 'promptChars' | 'knowledgeChars' | 'products' | 'agentMode'>) {
  const prompt = Math.round(i.promptChars / CHARS_PER_TOKEN);
  // La base de conocimiento entra a pedazos (lo relevante), con techo
  const knowledge = Math.min(2500, Math.round(i.knowledgeChars / CHARS_PER_TOKEN));
  const catalog = Math.min(4000, i.products * 28);
  const fixed = ENGINE_BASE_TOKENS + prompt + knowledge + catalog;
  let input = 0;
  for (let turn = 0; turn < TURNS_PER_CONVERSATION; turn++) input += fixed + turn * HISTORY_TOKENS_PER_TURN;
  let output = TURNS_PER_CONVERSATION * REPLY_TOKENS;
  if (i.agentMode) {
    input = Math.round(input * AGENT_FACTOR);
    output = Math.round(output * 1.2);
  }
  return { fixedPerMessage: fixed, input, output, breakdown: { engine: ENGINE_BASE_TOKENS, prompt, knowledge, catalog } };
}

export function usdFor(m: Pick<CostModel, 'inputCostPerMTok' | 'outputCostPerMTok'>, input: number, output: number) {
  return (input * m.inputCostPerMTok + output * m.outputCostPerMTok) / 1_000_000;
}

/** Paquete que alcanza para ~1 mes de conversaciones (o el más grande si nada alcanza). */
export function recommendPackage(monthlyCredits: number, packages: PackageOption[]) {
  const sorted = [...packages].sort((a, b) => a.conversations - b.conversations);
  if (!sorted.length) return null;
  const fits = sorted.find((p) => p.conversations >= monthlyCredits) ?? sorted[sorted.length - 1];
  return {
    ...fits,
    perConversation: round(fits.price / fits.conversations),
    monthsItLasts: monthlyCredits > 0 ? round(fits.conversations / monthlyCredits, 1) : null,
    monthlyCost: monthlyCredits > 0 ? Math.round((fits.price / fits.conversations) * monthlyCredits) : 0,
  };
}

export function estimateAiCosts(inputs: CostInputs, models: CostModel[], packages: PackageOption[]) {
  const conv = conversationTokens(inputs);
  const monthlyConversations = Math.max(0, Math.round(inputs.dailyChats * DAYS_PER_MONTH));
  const rows = models.map((m) => {
    const usdConv = usdFor(m, conv.input, conv.output);
    const usdReport = usdFor(m, REPORT_QUERY.input, REPORT_QUERY.output);
    const credits = Math.max(1, m.creditsPerConversation || 1);
    const pkg = recommendPackage(monthlyConversations * credits, packages);
    return {
      modelId: m.modelId,
      name: m.name,
      provider: m.provider,
      recommended: !!m.recommended,
      current: !!inputs.currentModel && inputs.currentModel === m.modelId,
      notes: m.notes ?? null,
      pricePerMTok: { input: m.inputCostPerMTok, output: m.outputCostPerMTok },
      perConversation: { usd: round(usdConv, 5), cop: round(usdConv * inputs.trm) },
      perMonth: { usd: round(usdConv * monthlyConversations, 2), cop: Math.round(usdConv * monthlyConversations * inputs.trm) },
      creditsPerConversation: credits,
      withPackage: pkg,
      report: {
        perQuery: { usd: round(usdReport, 5), cop: round(usdReport * inputs.trm) },
        // 3 preguntas al día al reporte
        perMonth: { usd: round(usdReport * 3 * DAYS_PER_MONTH, 2), cop: Math.round(usdReport * 3 * DAYS_PER_MONTH * inputs.trm) },
      },
    };
  });
  rows.sort((a, b) => a.perConversation.usd - b.perConversation.usd);
  return {
    assumptions: {
      turnsPerConversation: TURNS_PER_CONVERSATION,
      charsPerToken: CHARS_PER_TOKEN,
      daysPerMonth: DAYS_PER_MONTH,
      reportQueriesPerDay: 3,
      trm: inputs.trm,
    },
    inputs: { dailyChats: inputs.dailyChats, monthlyConversations, products: inputs.products, agentMode: inputs.agentMode },
    tokens: conv,
    models: rows,
  };
}

/** "10 a 30 al día" / "unos 50" → número para los cálculos. */
export function parseDailyChats(answer: string | null | undefined): number | null {
  const t = String(answer ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (/m[aá]s de 100|más de cien/.test(t)) return 150;
  const nums = (t.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0 && n < 100000);
  if (nums.length >= 2) return Math.round((nums[0] + nums[1]) / 2);
  if (nums.length === 1) return nums[0];
  if (/poc|casi nad|uno que otro/.test(t)) return 5;
  if (/much|bastant/.test(t)) return 60;
  return null;
}
