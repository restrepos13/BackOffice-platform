/**
 * Analista de publicidad con IA. La IA NO calcula: recibe las cifras ya
 * calculadas por el código (resultados, campañas, anuncios, hallazgos de la
 * auditoría y el embudo del CRM), todas escritas tal como se muestran en
 * pantalla, y redacta qué está pasando y qué hacer esta semana.
 *
 * Garantías (funciones puras, sin red):
 *  - Al modelo solo le llegan agregados: ningún nombre, teléfono ni correo de
 *    un contacto.
 *  - Toda cifra que escriba debe existir en el contexto que recibió. Lo que
 *    cite un número que no está se descarta (no se muestra una cifra inventada).
 *  - Nunca propone subir presupuesto ni activar algo «solo»: las acciones que
 *    gastan quedan marcadas para que una persona las confirme.
 */

export interface AnalystCampaign {
  name: string;
  status: string | null;
  goal: string;
  spend: string;
  shareOfSpend: string | null;
  results: string | null;
  costPerResult: string | null;
  ctr: string | null;
  frequency: string | null;
  dailyBudget: string | null;
}

export interface AnalystAd {
  name: string;
  campaign: string | null;
  status: string | null;
  spend: string;
  results: string | null;
  costPerResult: string | null;
  ctr: string | null;
  issues: string[];
}

export interface AnalystFinding { title: string; severity: string; facts: string[]; interpretation: string | null; missing: string[] }

export interface AnalystContext {
  business: string;
  industry: string | null;
  demo: boolean;
  period: { since: string; until: string; days: number; previousSince: string; previousUntil: string };
  comparable: boolean;
  totals: Record<string, string | null>;
  changes: Record<string, string | null>;
  notes: string[];
  campaigns: AnalystCampaign[];
  ads: AnalystAd[];
  findings: AnalystFinding[];
  /** Embudo del CRM (solo datos reales): lo que pasó después del clic */
  crm: null | {
    days: number;
    leads: string; qualified: string; customers: string; sales: string; revenue: string;
    costPerLead: string | null; costPerCustomer: string | null; roas: string | null;
    byCampaign: Array<{ campaign: string; spend: string; leads: string; qualified: string; customers: string; revenue: string; costPerLead: string | null }>;
    attribution: { attributed: string; partial: string; unattributed: string } | null;
    forms: { received: string; withContact: string; pendingPermission: string } | null;
  };
  budget: { activeDaily: string; cap: string | null };
}

export interface AnalystAction { title: string; why: string; how: string; priority: 'ALTA' | 'MEDIA' | 'BAJA'; spends: boolean }
export interface AnalystPoint { title: string; evidence: string }

export interface Analysis {
  headline: string;
  summary: string;
  working: AnalystPoint[];
  notWorking: AnalystPoint[];
  actions: AnalystAction[];
  watch: string[];
  missing: string[];
  /** Solo cuando la persona hizo una pregunta */
  answer: string | null;
}

/* ── Formato: lo mismo que ve la persona en pantalla ── */

export const fmtMoney = (v: number | null | undefined, currency = 'COP') =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${Math.round(v).toLocaleString('es-CO')} ${currency}`;
export const fmtNum = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v).toLocaleString('es-CO'));
export const fmtPct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${v.toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`;
export const fmtDelta = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${v > 0 ? '+' : ''}${v.toLocaleString('es-CO', { maximumFractionDigits: 1 })} %`;
export const fmtTimes = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? null : `${v.toLocaleString('es-CO', { maximumFractionDigits: 2 })} veces`;

/* ── Cifras: lo que diga la IA tiene que salir del contexto ── */

const NUMBER = /\d+(?:[.,]\d+)*/g;
/**
 * Forma única de una cifra para compararla: «1.121.883» y «1,121,883» son
 * 1121883 (separador de miles); «4,43» y «4.43» son 4,43 (decimal). Así un
 * «1,1 millones» inventado no pasa por parecerse a un 11.
 */
const bare = (token: string) => (/^\d{1,3}(?:\.\d{3})+$/.test(token) || /^\d{1,3}(?:,\d{3})+$/.test(token) ? token.replace(/[.,]/g, '') : token.replace(/\./g, ','));
/** Números que no son métricas: listas cortas, horas, días de un periodo. */
const ALWAYS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '14', '15', '24', '30', '48', '60', '72', '90', '100']);

/** Todas las cifras que aparecen en el contexto, en su forma única. */
export function allowedNumbers(ctx: unknown): Set<string> {
  const out = new Set<string>(ALWAYS);
  const walk = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.match(NUMBER) ?? []) out.add(bare(m));
    else if (typeof v === 'number') for (const m of String(v).match(NUMBER) ?? []) out.add(bare(m));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(ctx);
  return out;
}

/** Cifras de un texto que NO están en el contexto. */
export function unknownNumbers(text: string, allowed: Set<string>): string[] {
  const bad: string[] = [];
  for (const m of text.match(NUMBER) ?? []) if (!allowed.has(bare(m))) bad.push(m);
  return [...new Set(bad)];
}

/* ── Instrucción ── */

const STATUS_ES: Record<string, string> = {
  ACTIVE: 'activa', PAUSED: 'pausada', CAMPAIGN_PAUSED: 'pausada (su campaña está pausada)', ADSET_PAUSED: 'pausada (su conjunto está pausado)',
  ARCHIVED: 'archivada', DELETED: 'eliminada', DISAPPROVED: 'rechazada por la plataforma', PENDING_REVIEW: 'en revisión', IN_PROCESS: 'en proceso',
  WITH_ISSUES: 'con problemas de entrega', ENABLED: 'activa', REMOVED: 'eliminada',
};
const SEVERITY_ES: Record<string, string> = { HIGH: 'alta', MEDIUM: 'media', LOW: 'baja' };
const status = (v: string | null) => (v ? STATUS_ES[v] ?? v.toLowerCase().replace(/_/g, ' ') : null);

/**
 * Los datos tal como los lee el modelo: en español y sin nombres de campos
 * técnicos. Si el modelo copia algo literal, copia palabras que la persona
 * entiende, no «costPerResult».
 */
export function analystData(ctx: AnalystContext) {
  const t = ctx.totals;
  const c = ctx.changes;
  return {
    negocio: ctx.business, sector: ctx.industry,
    periodo: { desde: ctx.period.since, hasta: ctx.period.until, dias: ctx.period.days, periodo_anterior: `${ctx.period.previousSince} a ${ctx.period.previousUntil}` },
    variaciones_confiables: ctx.comparable,
    totales_del_periodo: {
      gasto: t.spend, resultado_principal: t.mainResult, costo_por_resultado: t.costPerResult, porcentaje_de_clics_ctr: t.ctr, costo_por_clic: t.cpc,
      costo_por_mil_impresiones: t.cpm, leads_de_formulario_y_mensajes: t.leads, conversaciones_iniciadas: t.conversations, compras: t.purchases,
      alcance: t.reach, frecuencia: t.frequency, impresiones: t.impressions, clics: t.clicks,
    },
    variacion_contra_el_periodo_anterior: { gasto: c.spend, resultados: c.results, costo_por_resultado: c.costPerResult, porcentaje_de_clics_ctr: c.ctr, costo_por_clic: c.cpc, costo_por_mil_impresiones: c.cpm },
    avisos_del_sistema: ctx.notes,
    campanas: ctx.campaigns.map((x) => ({
      nombre: x.name, estado: status(x.status), objetivo: x.goal, gasto: x.spend, parte_del_gasto_total: x.shareOfSpend, resultados: x.results,
      costo_por_resultado: x.costPerResult, porcentaje_de_clics_ctr: x.ctr, frecuencia: x.frequency, presupuesto_diario: x.dailyBudget,
    })),
    anuncios_con_mas_gasto: ctx.ads.map((x) => ({
      nombre: x.name, campana: x.campaign, estado: status(x.status), gasto: x.spend, resultados: x.results, costo_por_resultado: x.costPerResult,
      porcentaje_de_clics_ctr: x.ctr, problemas_reportados_por_la_plataforma: x.issues,
    })),
    hallazgos_de_la_auditoria: ctx.findings.map((f) => ({ hallazgo: f.title, gravedad: SEVERITY_ES[f.severity] ?? f.severity, hechos: f.facts, interpretacion: f.interpretation, datos_que_faltan: f.missing })),
    crm_despues_del_clic: ctx.crm && {
      dias: ctx.crm.days, contactos_llegados_por_anuncios: ctx.crm.leads, contactos_calificados: ctx.crm.qualified, clientes: ctx.crm.customers, ventas_confirmadas: ctx.crm.sales,
      ingresos_confirmados: ctx.crm.revenue, costo_por_contacto: ctx.crm.costPerLead, costo_por_cliente: ctx.crm.costPerCustomer, retorno_sobre_el_gasto: ctx.crm.roas,
      por_campana: ctx.crm.byCampaign.map((x) => ({ campana: x.campaign, gasto: x.spend, contactos: x.leads, calificados: x.qualified, clientes: x.customers, ingresos: x.revenue, costo_por_contacto: x.costPerLead })),
      contactos_segun_atribucion: ctx.crm.attribution && { con_anuncio_identificado: ctx.crm.attribution.attributed, parcial: ctx.crm.attribution.partial, sin_identificar: ctx.crm.attribution.unattributed },
      formularios_instantaneos: ctx.crm.forms && { recibidos: ctx.crm.forms.received, con_contacto_creado: ctx.crm.forms.withContact, esperando_permiso_de_meta: ctx.crm.forms.pendingPermission },
    },
    presupuesto: { diario_activo_en_total: ctx.budget.activeDaily, tope_diario_definido_por_la_empresa: ctx.budget.cap },
  };
}

export function analystMessages(ctx: AnalystContext, question?: string | null, fix?: string[]) {
  const system =
    `Eres analista senior de publicidad digital (Meta Ads) y trabajas para ${ctx.business}${ctx.industry ? ` (${ctx.industry})` : ''}. ` +
    'Le explicas al dueño del negocio, que no es experto en pauta, qué está pasando con su publicidad y qué hacer esta semana. ' +
    'Recibes un JSON con cifras YA CALCULADAS por el sistema: resultados del periodo, campañas, anuncios, hallazgos de una auditoría por reglas y, si existe, lo que pasó después del clic en su CRM. ' +
    'REGLAS OBLIGATORIAS: ' +
    '1) No calcules ni estimes cifras nuevas: usa SOLO cifras que aparezcan en el JSON y cópialas tal cual están escritas (mismos puntos, comas y unidad). No redondees ni conviertas a millones. Si necesitas una cifra que no está, dilo en "falta_medir". ' +
    '2) No prometas resultados ni des porcentajes de mejora esperada. ' +
    '3) Juzga cada campaña por su propio objetivo: no compares el costo de una conversación con el de una compra o un lead de formulario (un formulario normalmente cuesta más que un chat y eso no lo hace malo), y una campaña de alcance o reconocimiento no persigue clics ni resultados: no la pongas en "no_funciona" por no tenerlos. ' +
    '4) Con pocos días de datos, o si "variaciones_confiables" es false, no saques conclusiones de las variaciones: dilo. Una variación muy grande suele venir de un cambio de tipo de campaña, no de una mejora real: adviértelo. ' +
    '5) Si el CRM no registra ventas o contactos atribuidos, no digas que la publicidad no vende ni recomiendes pausar algo por eso: di que falta medirlo y cómo. ' +
    '6) Nombra las campañas y anuncios por su nombre exacto. ' +
    '7) Las acciones deben ser concretas y ejecutables esta semana (qué anuncio o campaña, qué cambiar). Marca "gasta": true solo si la acción aumenta el gasto (subir presupuesto, activar o duplicar). Si recomiendas subir un presupuesto, di que sea de forma gradual y nunca escribas montos. No propongas reactivar algo pausado sin una razón que esté en los datos. Solo recomienda pausar un anuncio cuando otro de la MISMA campaña logre el mismo resultado a menor costo, o cuando gaste sin ningún resultado. ' +
    '8) Escribe frases completas en español neutro y claro, como se lo dirías en persona. Nunca copies nombres de campos del JSON, ni comillas, llaves o palabras en inglés (escribe "pausada", "costo por resultado", "costo por contacto", no siglas como CPL, CPA o ROAS sin explicarlas). Sin adular y sin emojis. ' +
    '10) Todo se hace dentro de BackOffice, la plataforma que la persona ya usa; no recomiendes herramientas externas. Dónde: pausar o reanudar en la pestaña Campañas (BackOffice no cambia presupuestos: eso se hace en el Administrador de anuncios de Meta); anuncios nuevos en Crear anuncio (con Creative para la pieza); reglas automáticas en Autopilot; los chats de WhatsApp se registran conectando la línea de los anuncios en Automation; los formularios instantáneos llegan solos a Leads y ventas cuando la conexión con Meta tiene el permiso de formularios; las ventas se registran moviendo el contacto a la etapa ganada o creando el pedido en el CRM. ' +
    '9) La "evidencia" es una frase corta con la cifra que lo sustenta, por ejemplo: "201 conversaciones a 2.588 COP cada una". ' +
    'Devuelve SOLO un JSON con esta forma: ' +
    '{"titular": "una frase con lo más importante (máx. 110 caracteres)", "resumen": "3 o 4 frases", ' +
    '"funciona": [{"que": "…", "evidencia": "…"}], ' +
    '"no_funciona": [{"que": "…", "evidencia": "…"}], ' +
    '"acciones": [{"titulo": "…", "por_que": "…", "como": "pasos concretos", "prioridad": "alta|media|baja", "gasta": false}], ' +
    '"vigilar": ["qué mirar los próximos días"], "falta_medir": ["dato que falta y cómo conseguirlo"]' +
    `${question ? ', "respuesta": "respuesta directa a la pregunta de la persona, en 2 a 5 frases"' : ''}}. ` +
    'Máximo 3 en "funciona", 3 en "no_funciona", 4 acciones ordenadas por impacto, 3 en "vigilar" y 3 en "falta_medir". Listas vacías si no hay evidencia.';
  const user =
    `Datos (${ctx.demo ? 'cuenta de DEMOSTRACIÓN: son datos simulados' : 'cuenta real'}):\n${JSON.stringify(analystData(ctx))}` +
    `${question ? `\n\nPregunta de la persona: ${question}` : ''}` +
    `${fix?.length ? `\n\nTu respuesta anterior citó cifras que NO están en los datos (${fix.slice(0, 12).join(', ')}). Reescríbela usando solo cifras del JSON, copiadas tal cual.` : ''}`;
  return [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];
}

/** La pregunta de la persona: una línea, sin instrucciones largas. */
export function cleanQuestion(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const q = v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return q.length >= 4 ? q : null;
}

/* ── Validación de lo que devolvió el modelo ── */

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null);
/** Señales de que el modelo copió un pedazo del JSON en vez de escribir una frase. */
const TECHNICAL = /":|[{}\\]|\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][a-zA-Z]+\b/;
const PRIORITY: Record<string, AnalystAction['priority']> = { alta: 'ALTA', media: 'MEDIA', baja: 'BAJA' };

/** Quita de un texto las frases que citan cifras desconocidas. */
function keepKnown(text: string, allowed: Set<string>): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter((p) => !unknownNumbers(p, allowed).length);
  return parts.join(' ').trim();
}

export interface NormalizedAnalysis { analysis: Analysis; dropped: number; unknown: string[] }

/**
 * Convierte la respuesta del modelo. Todo lo que cite una cifra que no está en
 * el contexto se descarta (un punto o una acción completos; del resumen, la
 * frase). Devuelve null si no queda nada útil.
 */
export function normalizeAnalysis(raw: any, ctx: AnalystContext, opts: { question?: boolean } = {}): NormalizedAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;
  const allowed = allowedNumbers(ctx);
  const unknown = new Set<string>();
  let dropped = 0;
  const ok = (...texts: Array<string | null>) => {
    const bad = texts.flatMap((t) => (t ? unknownNumbers(t, allowed) : []));
    bad.forEach((b) => unknown.add(b));
    // Restos técnicos (un campo copiado del JSON) tampoco se muestran
    const technical = texts.some((t) => !!t && TECHNICAL.test(t));
    if (bad.length || technical) dropped++;
    return !bad.length && !technical;
  };
  const points = (v: unknown, max: number): AnalystPoint[] => (Array.isArray(v) ? v : [])
    .map((x) => ({ title: str(x?.que ?? x?.title, 200), evidence: str(x?.evidencia ?? x?.evidence, 240) }))
    .filter((x): x is AnalystPoint => !!x.title && !!x.evidence && ok(x.title, x.evidence))
    .slice(0, max);
  const lines = (v: unknown, max: number): string[] => (Array.isArray(v) ? v : [])
    .map((x) => str(x, 240)).filter((x): x is string => !!x && ok(x)).slice(0, max);
  const actions: AnalystAction[] = (Array.isArray(raw.acciones ?? raw.actions) ? raw.acciones ?? raw.actions : [])
    .map((x: any) => ({
      title: str(x?.titulo ?? x?.title, 140), why: str(x?.por_que ?? x?.why, 300), how: str(x?.como ?? x?.how, 400),
      priority: PRIORITY[String(x?.prioridad ?? x?.priority ?? '').toLowerCase()] ?? 'MEDIA',
      // Ante la duda, gasta: subir, activar, duplicar o escalar siempre pide confirmación de una persona
      spends: x?.gasta === true || x?.spends === true || /\b(sub[ei]r?|aument|increment|activ|duplic|escal)/i.test(`${x?.titulo ?? ''} ${x?.como ?? ''}`),
    }))
    .filter((x: any): x is AnalystAction => !!x.title && !!x.why && !!x.how && ok(x.title, x.why, x.how))
    .slice(0, 4);
  const clean = (v: unknown, max: number) => {
    const text = str(v, max);
    if (!text) return null;
    const bad = unknownNumbers(text, allowed);
    if (!bad.length) return text;
    bad.forEach((b) => unknown.add(b));
    dropped++;
    return keepKnown(text, allowed) || null;
  };
  const headline = clean(raw.titular ?? raw.headline, 140);
  const summary = clean(raw.resumen ?? raw.summary, 700);
  const analysis: Analysis = {
    headline: headline ?? '', summary: summary ?? '',
    working: points(raw.funciona ?? raw.working, 3), notWorking: points(raw.no_funciona ?? raw.notWorking, 3),
    actions, watch: lines(raw.vigilar ?? raw.watch, 3), missing: lines(raw.falta_medir ?? raw.missing, 3),
    answer: opts.question ? clean(raw.respuesta ?? raw.answer, 900) : null,
  };
  const useful = analysis.summary || analysis.actions.length || analysis.working.length || analysis.notWorking.length || analysis.answer;
  if (!useful) return null;
  if (!analysis.headline) analysis.headline = 'Análisis de tu publicidad';
  return { analysis, dropped, unknown: [...unknown] };
}
