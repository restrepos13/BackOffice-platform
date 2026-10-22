/**
 * Campaign Studio: del brief comercial a una propuesta. La propuesta es
 * determinista (reglas de negocio claras). Separa lo que es RECOMENDACIÓN de
 * lo que se ENVIARÍA a la plataforma (providerConfig), y lista supuestos y
 * datos faltantes. No promete resultados.
 */

export type Goal = 'MESSAGES' | 'LEADS' | 'SALES' | 'TRAFFIC' | 'AWARENESS';

export interface Brief {
  product: string;
  goal: Goal;
  location: string;
  audience?: string;
  dailyBudget: number;
  durationDays?: number;
  averageTicket?: number;
  marginPct?: number;
  leadCapacityPerDay?: number;
  offer?: string;
  destination?: string;
  startDate?: string;
}

export const ESSENTIAL: Record<Goal, Array<keyof Brief>> = {
  MESSAGES: ['product', 'location', 'dailyBudget'],
  LEADS: ['product', 'location', 'dailyBudget', 'destination'],
  SALES: ['product', 'location', 'dailyBudget', 'destination', 'averageTicket'],
  TRAFFIC: ['product', 'location', 'dailyBudget', 'destination'],
  AWARENESS: ['product', 'location', 'dailyBudget'],
};

const LABEL: Record<string, string> = {
  product: 'producto o servicio', location: 'ubicación', dailyBudget: 'presupuesto diario', destination: 'destino (link o WhatsApp)',
  averageTicket: 'valor promedio de venta', marginPct: 'margen', leadCapacityPerDay: 'capacidad para atender leads', offer: 'oferta verificada', audience: 'público',
};

export function validateBrief(b: Partial<Brief>, opts: { maxDailyBudget?: number | null; currency: string }): string[] {
  const errors: string[] = [];
  if (!b.goal || !(b.goal in ESSENTIAL)) errors.push('Elige el objetivo');
  else for (const k of ESSENTIAL[b.goal]) if (b[k] === undefined || b[k] === null || b[k] === '') errors.push(`Falta: ${LABEL[k] ?? k}`);
  if (b.dailyBudget !== undefined && (!Number.isFinite(b.dailyBudget) || b.dailyBudget <= 0)) errors.push('El presupuesto diario debe ser mayor a 0');
  if (opts.maxDailyBudget && b.dailyBudget && b.dailyBudget > opts.maxDailyBudget) errors.push(`El presupuesto supera el tope diario de la empresa (${opts.maxDailyBudget} ${opts.currency})`);
  if (b.durationDays !== undefined && (!Number.isInteger(b.durationDays) || b.durationDays < 1 || b.durationDays > 365)) errors.push('La duración va de 1 a 365 días');
  return errors;
}

export function buildProposal(b: Brief, ctx: { currency: string; brandName: string; ctas: string[]; historicalCostPerResult?: number | null }) {
  const days = b.durationDays ?? 14;
  const total = Math.round(b.dailyBudget * days);
  const platform = 'META';
  const objective = b.goal === 'MESSAGES' ? 'MESSAGES' : b.goal;
  const variants = [
    { hypothesis: 'OFERTA', idea: b.offer ? `Mensaje centrado en la oferta: ${b.offer}` : 'Mensaje con una razón concreta para escribir hoy (requiere una oferta real confirmada)' },
    { hypothesis: 'PROPUESTA_DE_VALOR', idea: `Qué hace distinto a ${ctx.brandName}: calidad, cercanía o rapidez` },
    { hypothesis: 'FORMATO', idea: 'La misma idea en video vertical corto vs. imagen cuadrada' },
  ];
  const split = b.dailyBudget >= 60000 ? [0.5, 0.3, 0.2] : [0.6, 0.4];
  const missing = (['averageTicket', 'marginPct', 'leadCapacityPerDay', 'offer', 'audience'] as Array<keyof Brief>).filter((k) => b[k] === undefined || b[k] === '').map((k) => LABEL[k]);
  const risks = [
    'Los primeros 3 a 5 días son de aprendizaje: el costo suele ser más alto y variable.',
    ...(b.leadCapacityPerDay && ctx.historicalCostPerResult && b.dailyBudget / ctx.historicalCostPerResult > b.leadCapacityPerDay
      ? [`Con el costo histórico, el presupuesto traería unos ${Math.round(b.dailyBudget / ctx.historicalCostPerResult)} leads al día y el equipo atiende ${b.leadCapacityPerDay}.`]
      : []),
    ...(b.offer ? [] : ['Sin una oferta confirmada, el anuncio no puede prometer precios ni descuentos.']),
  ];
  const breakEven = b.averageTicket && b.marginPct ? Math.round((b.averageTicket * b.marginPct) / 100) : null;
  return {
    recommendation: {
      objective,
      platform,
      why: objective === 'MESSAGES'
        ? 'Tu venta se cierra conversando: Meta permite anuncios que abren un chat de WhatsApp y BackOffice ya registra de qué anuncio vino cada chat.'
        : objective === 'SALES' ? 'Buscas compras: conviene optimizar a ventas si la medición de compras funciona.' : 'Es la plataforma donde BackOffice tiene integración y medición hoy.',
      structure: split.map((share, i) => ({
        name: `Conjunto ${i + 1}: ${i === 0 ? `${b.location} · público amplio` : i === 1 ? `${b.location} · ${b.audience || 'intereses relacionados'}` : 'Remarketing (personas que ya interactuaron)'}`,
        dailyBudget: Math.round(b.dailyBudget * share),
      })),
      variants,
      ctas: ctx.ctas.length ? ctx.ctas.slice(0, 3) : ['Escríbenos por WhatsApp'],
      metrics: objective === 'MESSAGES' || objective === 'LEADS'
        ? ['Costo por conversación / lead', 'Costo por lead calificado (CRM)', 'Ventas cerradas (CRM)']
        : ['Costo por compra', 'ROAS', 'Ventas confirmadas (CRM)'],
      budget: { daily: b.dailyBudget, days, total, currency: ctx.currency },
      expectations: ctx.historicalCostPerResult
        ? `Con tu costo histórico (${Math.round(ctx.historicalCostPerResult)} por resultado), serían unos ${Math.round(total / ctx.historicalCostPerResult)} resultados en total. Es una estimación, no una promesa.`
        : 'Aún no hay historial para estimar resultados. Se medirá desde el día 1.',
      breakEvenCostPerSale: breakEven,
    },
    /** Lo único que se enviaría a la plataforma al crear (siempre en PAUSA) */
    providerConfig: { provider: platform, objective, status: 'PAUSED', name: `${ctx.brandName} · ${b.product} · ${new Date().toISOString().slice(0, 10)}` },
    risks,
    assumptions: ['Los precios y ofertas mencionados están confirmados por la empresa.', 'El destino (WhatsApp o link) funciona y está conectado a BackOffice.'],
    missing,
    pendingInPlatform: [
      'Conjuntos de anuncios con segmentación y presupuesto',
      'Anuncios con el creativo y el texto aprobados',
      'Revisión de Meta y activación (gasta dinero: decisión aparte)',
    ],
  };
}
