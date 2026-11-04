import type { ChatMessage } from '../ai/types';

/**
 * «Resumen en palabras» del reporte para gerencia: 3 a 5 frases a partir de
 * las métricas AGREGADAS que ya calcula el reporte (totales, cumplimiento,
 * precisión de la IA, alertas y comparativa). Aquí NUNCA entran nombres,
 * teléfonos ni textos de clientes: los hechos se arman solo con conteos.
 * Si no hay IA, o la IA inventa cifras, se usa la plantilla (sin IA).
 */

export interface PeriodRow {
  label: string;
  pedidos: number;
  entregados: number;
  cancelados: number;
  cumplimientoPct: number | null;
  tomadosIA: number;
  precisionIAPct: number | null;
}

export interface DailyFacts {
  fecha: string;
  pedidos: { recibidos: number; confirmados: number; despachados: number; entregados: number; cancelados: number };
  conversaciones: { atendidas: number; resueltasPorIA: number; escaladas: number; conIntervencionHumana: number };
  precisionIA: { diaPct: number | null; mesPct: number | null; pedidosIAMes: number };
  alertas: { sinConfirmar: number; entregasSinArea: number; recordatoriosFallidos: number; clientesSinRespuesta: number };
  feedback: { respuestas: number; promedio: number | null; negativos: number };
  semana?: { actual: PeriodRow; anterior: PeriodRow };
}

export interface CompareFacts {
  periodo: 'semana' | 'mes';
  actual: PeriodRow;
  anterior: PeriodRow | null;
  /** Promedio de pedidos de los periodos anteriores (sin el actual) */
  promedioPedidos: number | null;
}

export type SummarySource = 'IA_EMPRESA' | 'IA_GENERICA' | 'PLANTILLA';

export interface ReportSummary {
  text: string;
  source: SummarySource;
  model?: string;
  at: string;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const pctOrNull = (v: unknown) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function period(r: any): PeriodRow {
  return {
    label: String(r?.label ?? ''),
    pedidos: n(r?.pedidos), entregados: n(r?.entregados), cancelados: n(r?.cancelados),
    cumplimientoPct: pctOrNull(r?.cumplimientoPct), tomadosIA: n(r?.tomadosIA), precisionIAPct: pctOrNull(r?.precisionIAPct),
  };
}

/** Del reporte diario completo (que trae nombres para el panel) a hechos sin datos personales. */
export function dailyFacts(data: any, weekBuckets?: any[]): DailyFacts {
  const weeks = (weekBuckets ?? []).slice(-2);
  return {
    fecha: String(data?.date ?? ''),
    pedidos: {
      recibidos: n(data?.pedidos?.recibidos), confirmados: n(data?.pedidos?.confirmados), despachados: n(data?.pedidos?.despachados),
      entregados: n(data?.pedidos?.entregados), cancelados: n(data?.pedidos?.cancelados),
    },
    conversaciones: {
      atendidas: n(data?.conversaciones?.atendidas), resueltasPorIA: n(data?.conversaciones?.resueltasPorIA),
      escaladas: n(data?.conversaciones?.escaladas), conIntervencionHumana: n(data?.conversaciones?.conIntervencionHumana),
    },
    precisionIA: {
      diaPct: pctOrNull(data?.precisionIA?.dia?.precisionPct), mesPct: pctOrNull(data?.precisionIA?.mes?.precisionPct),
      pedidosIAMes: n(data?.precisionIA?.mes?.total),
    },
    alertas: {
      sinConfirmar: Array.isArray(data?.alertas?.pedidosSinConfirmar) ? data.alertas.pedidosSinConfirmar.length : 0,
      entregasSinArea: Array.isArray(data?.alertas?.entregasProximasSinArea) ? data.alertas.entregasProximasSinArea.length : 0,
      recordatoriosFallidos: Array.isArray(data?.alertas?.recordatoriosFallidos) ? data.alertas.recordatoriosFallidos.length : 0,
      clientesSinRespuesta: n(data?.alertas?.conversacionesSinRespuesta),
    },
    feedback: {
      respuestas: n(data?.feedback?.respuestas), promedio: pctOrNull(data?.feedback?.promedio),
      negativos: Array.isArray(data?.feedback?.negativos) ? data.feedback.negativos.length : 0,
    },
    ...(weeks.length === 2 ? { semana: { anterior: period(weeks[0]), actual: period(weeks[1]) } } : {}),
  };
}

export function compareFacts(granularity: 'week' | 'month', buckets: any[]): CompareFacts | null {
  const rows = (buckets ?? []).map(period);
  if (!rows.length) return null;
  const actual = rows[rows.length - 1];
  const before = rows.slice(0, -1);
  return {
    periodo: granularity === 'month' ? 'mes' : 'semana',
    actual,
    anterior: before.length ? before[before.length - 1] : null,
    promedioPedidos: before.length ? Math.round((before.reduce((a, r) => a + r.pedidos, 0) / before.length) * 10) / 10 : null,
  };
}

const num = (v: number) => v.toLocaleString('es-CO', { maximumFractionDigits: 1 });
const plural = (v: number, one: string, many: string) => `${num(v)} ${v === 1 ? one : many}`;

function change(now: number, before: number): string {
  if (!before) return now ? 'sin pedidos para comparar el periodo anterior' : 'igual que el periodo anterior';
  const d = Math.round(((now - before) / before) * 100);
  if (d === 0) return 'igual que el periodo anterior';
  return d > 0 ? `${d} % más que el periodo anterior` : `${Math.abs(d)} % menos que el periodo anterior`;
}

/** Resumen sin IA: siempre funciona y solo dice lo que está en las cifras. */
export function templateDailySummary(f: DailyFacts): string {
  const s: string[] = [];
  const p = f.pedidos;
  s.push(p.recibidos
    ? `El ${f.fecha} llegaron ${plural(p.recibidos, 'pedido', 'pedidos')}: ${num(p.entregados)} entregados, ${num(p.despachados)} despachados y ${num(p.cancelados)} cancelados.`
    : `El ${f.fecha} no llegaron pedidos nuevos.`);
  const c = f.conversaciones;
  s.push(c.atendidas
    ? `Se atendieron ${plural(c.atendidas, 'conversación', 'conversaciones')}; la IA resolvió sola ${num(c.resueltasPorIA)} y ${num(c.escaladas + c.conIntervencionHumana)} necesitaron a una persona.`
    : 'No hubo conversaciones con clientes ese día.');
  s.push(f.precisionIA.mesPct !== null
    ? `En el mes, la IA tomó ${plural(f.precisionIA.pedidosIAMes, 'pedido', 'pedidos')} y acertó en el ${num(f.precisionIA.mesPct)} % sin que hubiera que corregirlos.`
    : 'Este mes todavía no hay pedidos tomados por la IA para medir su precisión.');
  const a = f.alertas;
  const pend = [
    a.sinConfirmar && plural(a.sinConfirmar, 'pedido sin confirmar', 'pedidos sin confirmar'),
    a.entregasSinArea && plural(a.entregasSinArea, 'entrega próxima sin área', 'entregas próximas sin área'),
    a.recordatoriosFallidos && plural(a.recordatoriosFallidos, 'recordatorio fallido', 'recordatorios fallidos'),
    a.clientesSinRespuesta && plural(a.clientesSinRespuesta, 'cliente esperando respuesta', 'clientes esperando respuesta'),
  ].filter(Boolean) as string[];
  s.push(pend.length ? `Para revisar hoy: ${pend.join(', ')}.` : 'No hay alertas pendientes.');
  if (f.semana) s.push(`Esta semana van ${plural(f.semana.actual.pedidos, 'pedido', 'pedidos')}, ${change(f.semana.actual.pedidos, f.semana.anterior.pedidos)}.`);
  return s.slice(0, 5).join(' ');
}

export function templateCompareSummary(f: CompareFacts): string {
  const unidad = f.periodo === 'mes' ? 'este mes' : 'esta semana';
  const s: string[] = [];
  s.push(`${unidad.charAt(0).toUpperCase()}${unidad.slice(1)} van ${plural(f.actual.pedidos, 'pedido', 'pedidos')}${f.anterior ? `, ${change(f.actual.pedidos, f.anterior.pedidos)}` : ''}.`);
  s.push(f.actual.cumplimientoPct !== null
    ? `De las entregas que ya debían salir, se cumplió el ${num(f.actual.cumplimientoPct)} %${f.anterior?.cumplimientoPct != null ? ` (antes ${num(f.anterior.cumplimientoPct)} %)` : ''}.`
    : 'Todavía no hay entregas vencidas para medir el cumplimiento.');
  s.push(f.actual.precisionIAPct !== null
    ? `La IA tomó ${plural(f.actual.tomadosIA, 'pedido', 'pedidos')} y acertó en el ${num(f.actual.precisionIAPct)} % sin correcciones.`
    : 'La IA no tomó pedidos en este periodo.');
  if (f.actual.cancelados) s.push(`Se cancelaron ${plural(f.actual.cancelados, 'pedido', 'pedidos')}.`);
  if (f.promedioPedidos !== null) s.push(`El promedio de los periodos anteriores es de ${num(f.promedioPedidos)} pedidos.`);
  return s.slice(0, 5).join(' ');
}

/** Instrucción para la IA: los hechos van como JSON y el texto no puede salirse de ellos. */
export function summaryMessages(kind: 'diario' | 'comparativo', facts: DailyFacts | CompareFacts): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        `Eres analista de operaciones y escribes el resumen ${kind === 'diario' ? 'del reporte diario' : 'del comparativo'} para el dueño o gerente de un negocio en Colombia.`,
        'Escribe de 3 a 5 frases en español, en un solo párrafo, sin listas, sin títulos y sin markdown.',
        'Usa SOLO las cifras del JSON (puedes redondear porcentajes a enteros). No inventes cifras, causas ni nombres. Empieza por lo más importante y termina con lo que conviene revisar.',
        'Responde SOLO con un JSON: {"resumen":"…"}',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(facts) },
  ];
}

/** Números que aparecen en los hechos (y sus redondeos): la IA no puede usar otros. */
function factNumbers(facts: unknown): Set<number> {
  const out = new Set<number>();
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.add(v);
      out.add(Math.round(v));
      out.add(Math.round(v * 10) / 10);
    } else if (typeof v === 'string') {
      for (const m of v.match(/\d+/g) ?? []) out.add(Number(m));
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  walk(facts);
  return out;
}

/** Valida el resumen de la IA: 3 a 5 frases, sin listas ni datos de contacto, y solo cifras de los hechos. */
export function validSummary(text: unknown, facts: DailyFacts | CompareFacts): string | null {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, ' ').replace(/[*#_`]/g, '').trim();
  if (t.length < 60 || t.length > 900) return null;
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÑ¿¡])/).filter((x) => x.trim().length > 2);
  if (sentences.length < 3 || sentences.length > 5) return null;
  if (/@|\[(tel[eé]fono|correo|contacto|documento)\]|https?:/i.test(t)) return null;
  const allowed = factNumbers(facts);
  for (let i = 1; i <= 5; i++) allowed.add(i); // "las 3 alertas", "2 de ellas"…
  for (const m of t.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const raw = m.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    if (!allowed.has(Number(raw))) return null; // cifra inventada → plantilla
  }
  return t;
}

/**
 * pdfkit con Helvetica estándar solo dibuja WinAnsi: tildes y ñ sí, pero
 * comillas tipográficas, rayas largas, flechas o emojis salen como basura.
 */
export function pdfSafe(text: string): string {
  return String(text ?? '')
    .replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...').replace(/→/g, '->')
    .replace(/[^\x20-\x7E -ÿ\n]/g, '');
}
