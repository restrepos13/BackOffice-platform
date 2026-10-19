/**
 * "Plano" del negocio a la medida: lo arma la IA después de entrevistar al
 * dueño y él lo ajusta antes de crear la cuenta. No es una plantilla cerrada:
 * herramientas elegidas una a una, embudo con SUS etapas, los datos que el
 * asistente debe pedir, su forma de atender, respuestas rápidas y seguimientos.
 * Todo lo que propone el modelo se valida y recorta aquí (jamás a ciegas).
 */
import { sanitizeStages } from './pipelines';
import { RUBRO_CONFIG, Rubro, guessRubro, isRubro } from './rubros';

/** Siempre incluidos (sin esto no hay panel). */
export const BASE_MODULES = ['inbox', 'contacts', 'bots', 'billing', 'team'];

/** Herramientas que la IA (y el dueño) pueden prender una a una. */
export const SELECTABLE_MODULES: Record<string, string> = {
  orders: 'pedidos con catálogo de productos o servicios con precio, clientes y reportes de ventas',
  production: 'producción por áreas (cocina, taller, empaque), vista por área y comandas impresas',
  delivery: 'domicilios en vivo: domiciliarios con GPS, rutas y seguimiento para el cliente',
  menu: 'menú o catálogo digital público con QR para pedir por WhatsApp',
  agenda: 'agenda de citas, cupos, cohortes o visitas, con recordatorios',
  campaigns: 'campañas masivas por WhatsApp y seguimiento automático a quien no responde',
  media: 'galería de contenido o fotos con precio para vender por el chat',
  gerencia: 'reporte para el dueño o gerente con ahorro y pendientes',
  automations: 'automatizaciones y flujos (n8n, webhooks)',
  analytics: 'métricas de conversaciones y ventas',
  marketing: 'planeación de contenido y reels para redes',
};

export interface InterviewTurn {
  done: boolean;
  question: string;
  options: string[];
  understood: string;
}

export interface Blueprint {
  businessType: string;
  needs: Array<{ title: string; solution: string }>;
  modules: string[];
  pipeline: { name: string; stages: Array<{ key: string; label: string; kind: 'OPEN' | 'WON' | 'LOST' }> } | null;
  clientData: string[];
  assistantFlow: string[];
  quickReplies: Array<{ shortcut: string; title: string; body: string }>;
  followUps: Array<{ when: 'no_reply' | 'draft_open'; afterHours: number; message: string }>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

/** Nombres que entiende el dueño para las claves internas que a veces cuela la IA. */
const FRIENDLY_TOOL: Record<string, string> = {
  orders: 'pedidos', production: 'producción', delivery: 'domicilios', menu: 'menú con QR', agenda: 'agenda',
  campaigns: 'mensajes a clientes', media: 'galería', gerencia: 'resumen para el dueño', automations: 'conexiones',
  analytics: 'números', marketing: 'contenido para redes',
};
export function plainWords(text: string): string {
  return text.replace(/\b(orders|production|delivery|campaigns|media|gerencia|automations|analytics|marketing)\b/g, (k) => FRIENDLY_TOOL[k] ?? k);
}
const list = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, len)).filter(Boolean).slice(0, max);

/** Turno de la entrevista: una pregunta corta con opciones sugeridas. */
export function normalizeInterviewTurn(raw: unknown, answered: number, maxQuestions: number): InterviewTurn {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const question = str(o.pregunta, 300);
  const forcedDone = answered >= maxQuestions;
  return {
    done: forcedDone || o.listo === true || !question,
    question: forcedDone ? '' : question,
    options: list(o.opciones, 5, 80),
    understood: str(o.nota, 240),
  };
}

export function shortcutOf(v: string): string {
  return v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^\//, '').replace(/[^a-z0-9_-]+/g, '').slice(0, 30);
}

/** Plano del negocio, validado. Si algo viene mal se descarta esa parte, no todo. */
export function normalizeBlueprint(raw: unknown, fallbackRubro: Rubro): Blueprint & { rubro: Rubro } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const rubro: Rubro = isRubro(o.rubro) ? o.rubro : fallbackRubro;
  const picked = list(o.herramientas ?? o.modulos, 12, 30).filter((m) => m in SELECTABLE_MODULES);
  // Sin elección válida → las del rubro; producción/domicilios/menú solo con pedidos
  let modules = picked.length ? picked : RUBRO_CONFIG[rubro].modules.filter((m) => m in SELECTABLE_MODULES);
  if (!modules.includes('orders')) modules = modules.filter((m) => !['production', 'delivery', 'menu'].includes(m));
  let pipeline: Blueprint['pipeline'] = null;
  try {
    const stages = (Array.isArray(o.embudo?.etapas) ? o.embudo.etapas : []).map((s: any) => ({
      label: typeof s === 'string' ? s : s?.nombre,
      kind: s?.tipo === 'ganada' ? 'WON' : s?.tipo === 'perdida' ? 'LOST' : 'OPEN',
    }));
    if (stages.length) pipeline = { name: str(o.embudo?.nombre, 60) || 'Embudo principal', stages: sanitizeStages(stages) };
  } catch {
    pipeline = null; // etapas inválidas → embudo estándar
  }
  const seen = new Set<string>();
  const quickReplies = (Array.isArray(o.respuestas_rapidas) ? o.respuestas_rapidas : [])
    .map((r: any) => ({ shortcut: shortcutOf(str(r?.atajo, 40) || str(r?.titulo, 40)), title: str(r?.titulo, 60), body: str(r?.texto, 1000) }))
    .filter((r: any) => r.shortcut && r.title && r.body && !seen.has(r.shortcut) && seen.add(r.shortcut))
    .slice(0, 10);
  const followUps = (Array.isArray(o.seguimientos) ? o.seguimientos : [])
    .map((f: any) => ({
      when: f?.cuando === 'draft_open' ? 'draft_open' as const : 'no_reply' as const,
      afterHours: Math.min(23, Math.max(1, Math.round(Number(f?.horas) || 2))),
      message: str(f?.mensaje, 500),
    }))
    .filter((f: any) => f.message)
    .slice(0, 3);
  return {
    rubro,
    businessType: str(o.tipo_negocio, 80),
    needs: (Array.isArray(o.necesidades) ? o.necesidades : [])
      .map((n: any) => ({ title: plainWords(str(n?.titulo, 80)), solution: plainWords(str(n?.como_lo_resuelve ?? n?.solucion, 240)) }))
      .filter((n: any) => n.title && n.solution)
      .slice(0, 8),
    modules,
    pipeline,
    clientData: list(o.datos_cliente, 12, 60),
    assistantFlow: list(o.flujo_asistente, 10, 240),
    quickReplies,
    followUps,
  };
}

/** Lo que el plano le agrega a las instrucciones del asistente. */
export function assistantPromptFromBlueprint(base: string, bp: Pick<Blueprint, 'businessType' | 'assistantFlow' | 'clientData'>): string {
  const parts = [base.trim()];
  if (bp.businessType) parts.push(`Tipo de negocio: ${bp.businessType}.`);
  if (bp.assistantFlow.length) parts.push(`Cómo atiendes, paso a paso:\n${bp.assistantFlow.map((s, i) => `${i + 1}. ${s.replace(/^\d+[.)]\s*/, '')}`).join('\n')}`);
  if (bp.clientData.length) parts.push(`Datos que debes pedirle al cliente (de forma natural, no todos de una): ${bp.clientData.join(', ')}.`);
  return parts.filter(Boolean).join('\n\n').slice(0, 4000);
}

/** Herramientas del agente según lo que el negocio realmente hace. */
export function agentPresetFor(modules: string[]): string {
  if (modules.includes('orders') && modules.includes('delivery')) return 'domicilios';
  if (modules.includes('orders')) return 'pedidos_programados';
  return 'solo_consultas';
}

export function moduleListFor(bp: Pick<Blueprint, 'modules'>): string[] {
  return [...new Set([...BASE_MODULES, ...bp.modules])];
}

/** El plano editado en el navegador vuelve a pasar por la misma validación. */
export function revalidateBlueprint(bp: any, rubro: Rubro): Blueprint {
  const { rubro: _r, ...out } = normalizeBlueprint({
    rubro,
    tipo_negocio: bp?.businessType,
    necesidades: (bp?.needs ?? []).map((n: any) => ({ titulo: n?.title, como_lo_resuelve: n?.solution })),
    herramientas: Array.isArray(bp?.modules) ? bp.modules : [],
    embudo: bp?.pipeline
      ? { nombre: bp.pipeline.name, etapas: (bp.pipeline.stages ?? []).map((s: any) => ({ nombre: s?.label, tipo: s?.kind === 'WON' ? 'ganada' : s?.kind === 'LOST' ? 'perdida' : 'abierta' })) }
      : null,
    datos_cliente: bp?.clientData,
    flujo_asistente: bp?.assistantFlow,
    respuestas_rapidas: (bp?.quickReplies ?? []).map((r: any) => ({ atajo: r?.shortcut, titulo: r?.title, texto: r?.body })),
    seguimientos: (bp?.followUps ?? []).map((f: any) => ({ cuando: f?.when, horas: f?.afterHours, mensaje: f?.message })),
  }, rubro);
  // Si el dueño apagó todas las herramientas, se respeta (solo lo básico)
  if (Array.isArray(bp?.modules) && bp.modules.length === 0) out.modules = [];
  return out;
}

export { guessRubro };
