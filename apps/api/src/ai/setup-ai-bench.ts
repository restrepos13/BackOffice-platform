/**
 * Prueba de modelos para la IA del registro (Dev Tools). Cada modelo hace las
 * mismas dos tareas reales del registro, con las mismas instrucciones:
 *  A. Entrevista (30 pts): hacer la siguiente pregunta al dueño de una panadería.
 *  B. Plano del negocio (70 pts): armar la cuenta con lo que contó el dueño.
 * Se revisan cosas concretas (JSON válido, nombre y precio correctos, no inventar
 * precios, asistente completo…) y se mide cuánto tarda. El puntaje es NUESTRO,
 * hecho para esta tarea: no es un ranking general de inteligencia.
 */
import { extractJson } from './types';
import type { ChainEntry, GeminiPool } from './gemini-pool';
import { blueprintSystemPrompt, interviewSystemPrompt } from '../common/signup-prompts';

const INTERVIEW = [
  { role: 'assistant' as const, content: '¡Hola! ¿Qué hace tu negocio y a quién le vende?' },
  { role: 'user' as const, content: 'Tengo una panadería en Envigado, vendo pan todos los días y tortas por encargo' },
];

const TRANSCRIPT = [
  'BackOffice: ¿Qué hace tu negocio y a quién le vende?',
  'Dueño: Panadería Doña Rosa en Envigado. Pan de todos los días y tortas por encargo para cumpleaños.',
  'BackOffice: ¿Cómo te hacen los pedidos?',
  'Dueño: Por WhatsApp. Las tortas con 2 días de anticipación y 50% de anticipo por Nequi.',
  'BackOffice: ¿Haces domicilios?',
  'Dueño: Sí, cerca, el domicilio vale 5000. La torta de chocolate vale 60000.',
].join('\n');

export interface BenchResult {
  id: string;
  score: number;
  seconds: number;
  checks: Record<string, boolean>;
  error?: string;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

function scoreInterview(raw: any) {
  const q = typeof raw?.pregunta === 'string' ? raw.pregunta.trim() : '';
  const opts = Array.isArray(raw?.opciones) ? raw.opciones : [];
  const checks = {
    'Entrevista: JSON válido': !!raw,
    'Entrevista: hace una pregunta': !!q && (q.includes('?') || q.includes('¿')),
    'Entrevista: pregunta corta': !!q && words(q) <= 25,
    'Entrevista: da opciones': opts.length >= 2 && opts.length <= 5,
  };
  const pts = (checks['Entrevista: JSON válido'] ? 10 : 0) + (checks['Entrevista: hace una pregunta'] ? 10 : 0)
    + (checks['Entrevista: pregunta corta'] ? 5 : 0) + (checks['Entrevista: da opciones'] ? 5 : 0);
  return { checks, pts };
}

function scoreBlueprint(raw: any) {
  const products: any[] = Array.isArray(raw?.productos) ? raw.productos : [];
  const price = (p: any) => Number(String(p?.precio ?? '').replace(/[^\d]/g, '')) || null;
  const torta = products.find((p) => /torta/i.test(String(p?.nombre)) && /chocolate/i.test(String(p?.nombre)));
  const pan = products.filter((p) => /\bpan\b/i.test(String(p?.nombre)) && !/torta/i.test(String(p?.nombre)));
  const asistente = raw?.asistente ?? {};
  const etapas: any[] = Array.isArray(raw?.embudo?.etapas) ? raw.embudo.etapas : [];
  const checks = {
    'Plano: JSON válido': !!raw,
    'Plano: entiende el nombre': /doña rosa/i.test(String(raw?.empresa?.nombre ?? '')),
    'Plano: tipo de negocio correcto': raw?.rubro === 'COMIDAS',
    'Plano: precio real de la torta': !!torta && price(torta) === 60000,
    'Plano: no inventa precios': !!raw && pan.every((p) => !price(p)),
    'Plano: asistente completo': !!String(asistente.nombre ?? '').trim() && /rosa|panader/i.test(String(asistente.bienvenida ?? '')),
    'Plano: proceso con cierre': etapas.length >= 3 && etapas.some((e) => e?.tipo === 'ganada'),
  };
  const weights: Record<string, number> = {
    'Plano: JSON válido': 15, 'Plano: entiende el nombre': 10, 'Plano: tipo de negocio correcto': 10,
    'Plano: precio real de la torta': 10, 'Plano: no inventa precios': 10, 'Plano: asistente completo': 10, 'Plano: proceso con cierre': 5,
  };
  const pts = Object.entries(checks).reduce((a, [k, v]) => a + (v ? weights[k] : 0), 0);
  return { checks, pts };
}

export async function benchEntry(pool: GeminiPool, entry: Pick<ChainEntry, 'provider' | 'model'>): Promise<BenchResult> {
  const id = `${entry.provider}:${entry.model}`;
  const t = Date.now();
  const a = await pool.tryEntry(entry, {
    json: true, temperature: 0.5, maxTokens: 500, timeoutMs: 45_000,
    messages: [{ role: 'system', content: interviewSystemPrompt(8) }, ...INTERVIEW],
  }, false);
  const ia = scoreInterview(a.result ? extractJson(a.result.content) : null);
  const b = await pool.tryEntry(entry, {
    json: true, temperature: 0.2, maxTokens: 5000, timeoutMs: 100_000,
    messages: [{ role: 'system', content: blueprintSystemPrompt() }, { role: 'user', content: TRANSCRIPT }],
  }, false);
  const ib = scoreBlueprint(b.result ? extractJson(b.result.content) : null);
  const seconds = Math.round((Date.now() - t) / 100) / 10;
  const error = !a.result && !b.result ? (a.error || b.error) : !b.result ? `plano: ${b.error}` : !a.result ? `entrevista: ${a.error}` : undefined;
  const result: BenchResult = { id, score: ia.pts + ib.pts, seconds, checks: { ...ia.checks, ...ib.checks }, ...(error ? { error } : {}) };
  await pool.record(id, (s) => ({
    ...s,
    bench: { at: new Date().toISOString(), score: result.score, seconds, checks: result.checks, ...(error ? { error } : {}) },
  }));
  return result;
}

/** Varias a la vez, sin pasar de `parallel` simultáneas (los gratuitos tienen tope por minuto). */
export async function benchMany(pool: GeminiPool, entries: Array<Pick<ChainEntry, 'provider' | 'model'>>, parallel = 4) {
  const out: BenchResult[] = [];
  const queue = [...entries];
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
    while (queue.length) {
      const next = queue.shift()!;
      out.push(await benchEntry(pool, next));
    }
  }));
  return out;
}
