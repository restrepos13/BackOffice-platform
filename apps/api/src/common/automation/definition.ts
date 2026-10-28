/**
 * Definición de una automatización (esquema v1) y su validación estricta.
 *
 * Una definición es DATO, nunca código: disparadores, campos, operadores y
 * acciones salen de registros cerrados. Lo que no está en el registro se
 * rechaza. No hay expresiones, plantillas ejecutables, SQL ni JavaScript.
 *
 * {
 *   schemaVersion: 1,
 *   trigger:    { type, config },
 *   conditions: { match: 'all' | 'any', rules: [{ field, op, value? }] },
 *   actions:    [{ type, config }],           // en orden
 *   options:    { dedupe, maxRunsPerHour, maxAttempts }
 * }
 */
import { ORDER_TRANSITIONS } from '../../modules/orders.module';

export const SCHEMA_VERSION = 1;

/* ─── Límites técnicos (seguridad, no comerciales) ───────────────────── */
export const MAX_RULES = 10;
export const MAX_ACTIONS = 10;
export const MAX_TEXT = 300;
export const MAX_VALUE = 100;
export const MAX_WAIT_HOURS = 720; // 30 días
export const RUNS_PER_HOUR = { default: 60, max: 500 };
export const ATTEMPTS = { default: 3, max: 5 };

/* ─── Disparadores ───────────────────────────────────────────────────── */
export const ORDER_STATUSES = Object.keys(ORDER_TRANSITIONS);
export const ORDER_SOURCES = ['WHATSAPP', 'MENU', 'MANUAL', 'RAPPI', 'UBER_EATS', 'WEB', 'OTRO'];
export const PAYMENT_STATUSES = ['NONE', 'PENDING', 'REPORTED', 'PAID', 'FAILED'];

export type TriggerType = 'contact.created' | 'contact.stage_changed' | 'order.status_changed';
export type FieldType = 'string' | 'enum' | 'number' | 'tags' | 'bool';

export interface FieldDef { label: string; type: FieldType; options?: string[] }

const CONTACT_FIELDS: Record<string, FieldDef> = {
  'contact.name': { label: 'Nombre del contacto', type: 'string' },
  'contact.phone': { label: 'Teléfono del contacto', type: 'string' },
  'contact.email': { label: 'Correo del contacto', type: 'string' },
  'contact.channel': { label: 'Canal del contacto', type: 'string' },
  'contact.stage': { label: 'Etapa del contacto', type: 'string' },
  'contact.tags': { label: 'Etiquetas del contacto', type: 'tags' },
  'contact.assigned': { label: 'Tiene responsable', type: 'bool' },
};

export const TRIGGERS: Record<TriggerType, { label: string; record: 'contact' | 'order'; fields: Record<string, FieldDef>; config: Record<string, FieldDef> }> = {
  'contact.created': {
    label: 'Se crea un contacto',
    record: 'contact',
    fields: CONTACT_FIELDS,
    config: {},
  },
  'contact.stage_changed': {
    label: 'Un contacto cambia de etapa',
    record: 'contact',
    fields: {
      ...CONTACT_FIELDS,
      'event.fromStage': { label: 'Etapa anterior', type: 'string' },
      'event.toStage': { label: 'Etapa nueva', type: 'string' },
    },
    config: { toStage: { label: 'Solo al llegar a la etapa', type: 'string' } },
  },
  'order.status_changed': {
    label: 'Un pedido cambia de estado (o se crea)',
    record: 'order',
    fields: {
      ...CONTACT_FIELDS,
      'order.status': { label: 'Estado del pedido', type: 'enum', options: ORDER_STATUSES },
      'event.fromStatus': { label: 'Estado anterior del pedido', type: 'enum', options: ORDER_STATUSES },
      'order.total': { label: 'Total del pedido', type: 'number' },
      'order.source': { label: 'Origen del pedido', type: 'enum', options: ORDER_SOURCES },
      'order.paymentStatus': { label: 'Estado del cobro', type: 'enum', options: PAYMENT_STATUSES },
      'order.hasCourier': { label: 'Tiene domiciliario', type: 'bool' },
    },
    config: { toStatus: { label: 'Solo al llegar al estado', type: 'enum', options: ORDER_STATUSES } },
  },
};

/* ─── Operadores por tipo ────────────────────────────────────────────── */
export const OPERATORS: Record<FieldType, string[]> = {
  string: ['eq', 'neq', 'contains', 'not_contains', 'exists', 'not_exists'],
  enum: ['eq', 'neq', 'in', 'exists', 'not_exists'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists'],
  tags: ['contains', 'not_contains'],
  bool: ['is_true', 'is_false'],
};
const NO_VALUE = new Set(['exists', 'not_exists', 'is_true', 'is_false']);

/* ─── Acciones ───────────────────────────────────────────────────────── */
export type ActionType = 'create_follow_up' | 'add_tag' | 'remove_tag' | 'set_stage' | 'assign_owner' | 'log_activity' | 'wait' | 'assign_courier';

export const ACTIONS: Record<ActionType, { label: string; needs: 'contact' | 'order' | null; config: Record<string, { type: 'text' | 'short' | 'hours' | 'ref'; required: boolean }> }> = {
  create_follow_up: { label: 'Crear un seguimiento (tarea)', needs: 'contact', config: { note: { type: 'text', required: true }, dueInHours: { type: 'hours', required: true } } },
  add_tag: { label: 'Agregar etiqueta al contacto', needs: 'contact', config: { tag: { type: 'short', required: true } } },
  remove_tag: { label: 'Quitar etiqueta al contacto', needs: 'contact', config: { tag: { type: 'short', required: true } } },
  set_stage: { label: 'Cambiar la etapa del contacto', needs: 'contact', config: { stage: { type: 'short', required: true } } },
  assign_owner: { label: 'Asignar responsable del contacto', needs: 'contact', config: { userId: { type: 'ref', required: true } } },
  log_activity: { label: 'Registrar actividad', needs: null, config: { text: { type: 'text', required: true } } },
  wait: { label: 'Esperar', needs: null, config: { hours: { type: 'hours', required: true } } },
  assign_courier: { label: 'Asignar domiciliario automático', needs: 'order', config: {} },
};

export interface Rule { field: string; op: string; value?: string | number | string[] }
export interface Definition {
  schemaVersion: 1;
  trigger: { type: TriggerType; config: Record<string, string> };
  conditions: { match: 'all' | 'any'; rules: Rule[] };
  actions: Array<{ type: ActionType; config: Record<string, any> }>;
  options: { dedupe: 'per_event' | 'once_per_record'; maxRunsPerHour: number; maxAttempts: number };
}

export class DefinitionError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' · '));
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const unknownKeys = (o: Record<string, any>, allowed: string[]) => Object.keys(o).filter((k) => !allowed.includes(k));

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // Sin caracteres de control; espacios normalizados
  const s = v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  return s && s.length <= max ? s : null;
}

/**
 * Valida y normaliza. Lanza DefinitionError con TODOS los problemas
 * (mensajes en español para mostrarlos tal cual en el constructor).
 */
export function validateDefinition(raw: unknown): Definition {
  const errors: string[] = [];
  if (!isObj(raw)) throw new DefinitionError(['La definición debe ser un objeto']);
  const extra = unknownKeys(raw, ['schemaVersion', 'trigger', 'conditions', 'actions', 'options']);
  if (extra.length) errors.push(`Campos no soportados: ${extra.join(', ')}`);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) errors.push(`Versión de esquema no soportada: ${raw.schemaVersion}`);

  // Disparador
  const t = raw.trigger;
  let trigger: Definition['trigger'] | null = null;
  if (!isObj(t) || !(t.type in TRIGGERS)) {
    errors.push('Elige un disparador válido');
  } else {
    const spec = TRIGGERS[t.type as TriggerType];
    const cfg = t.config === undefined ? {} : t.config;
    if (!isObj(cfg)) errors.push('La configuración del disparador debe ser un objeto');
    else {
      const bad = unknownKeys(cfg, Object.keys(spec.config));
      if (bad.length) errors.push(`Opciones del disparador no soportadas: ${bad.join(', ')}`);
      const config: Record<string, string> = {};
      for (const [k, def] of Object.entries(spec.config)) {
        const v = cfg[k];
        if (v === undefined || v === null || v === '') continue;
        const s = cleanText(v, MAX_VALUE);
        if (!s) errors.push(`«${def.label}» no es válido`);
        else if (def.options && !def.options.includes(s)) errors.push(`«${def.label}»: valor no permitido (${s})`);
        else config[k] = s;
      }
      trigger = { type: t.type as TriggerType, config };
    }
    if (unknownKeys(t, ['type', 'config']).length) errors.push('El disparador tiene campos no soportados');
  }

  // Condiciones
  const c = raw.conditions === undefined ? { match: 'all', rules: [] } : raw.conditions;
  const rules: Rule[] = [];
  let match: 'all' | 'any' = 'all';
  if (!isObj(c) || !Array.isArray(c.rules)) errors.push('Las condiciones deben ser { match, rules: [] }');
  else {
    if (unknownKeys(c, ['match', 'rules']).length) errors.push('Las condiciones tienen campos no soportados (no se permiten grupos anidados)');
    if (c.match !== undefined && c.match !== 'all' && c.match !== 'any') errors.push('«match» debe ser all o any');
    match = c.match === 'any' ? 'any' : 'all';
    if (c.rules.length > MAX_RULES) errors.push(`Máximo ${MAX_RULES} condiciones`);
    const fields = trigger ? TRIGGERS[trigger.type].fields : {};
    c.rules.slice(0, MAX_RULES).forEach((r: any, i: number) => {
      const n = `Condición ${i + 1}`;
      if (!isObj(r) || unknownKeys(r, ['field', 'op', 'value']).length) return void errors.push(`${n}: formato no válido`);
      const f = fields[r.field];
      if (!f) return void errors.push(`${n}: el campo «${String(r.field)}» no está disponible para este disparador`);
      if (!OPERATORS[f.type].includes(r.op)) return void errors.push(`${n}: el operador «${String(r.op)}» no aplica a «${f.label}»`);
      if (NO_VALUE.has(r.op)) {
        if (r.value !== undefined && r.value !== null && r.value !== '') return void errors.push(`${n}: este operador no lleva valor`);
        return void rules.push({ field: r.field, op: r.op });
      }
      if (f.type === 'number') {
        const v = typeof r.value === 'string' && r.value.trim() !== '' ? Number(r.value) : r.value;
        if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12) return void errors.push(`${n}: «${f.label}» necesita un número`);
        return void rules.push({ field: r.field, op: r.op, value: v });
      }
      if (r.op === 'in') {
        const list = Array.isArray(r.value) ? r.value : [];
        if (!list.length || list.length > 20 || list.some((x: unknown) => typeof x !== 'string' || !f.options?.includes(x))) {
          return void errors.push(`${n}: elige valores válidos de «${f.label}»`);
        }
        return void rules.push({ field: r.field, op: r.op, value: [...new Set(list as string[])] });
      }
      const s = cleanText(r.value, MAX_VALUE);
      if (!s) return void errors.push(`${n}: escribe un valor (máximo ${MAX_VALUE} caracteres)`);
      if (f.type === 'enum' && !f.options?.includes(s)) return void errors.push(`${n}: «${s}» no es un valor de «${f.label}»`);
      rules.push({ field: r.field, op: r.op, value: s });
    });
  }

  // Acciones
  const actions: Definition['actions'] = [];
  if (!Array.isArray(raw.actions) || !raw.actions.length) errors.push('Agrega al menos una acción');
  else {
    if (raw.actions.length > MAX_ACTIONS) errors.push(`Máximo ${MAX_ACTIONS} acciones`);
    const record = trigger ? TRIGGERS[trigger.type].record : null;
    raw.actions.slice(0, MAX_ACTIONS).forEach((a: any, i: number) => {
      const n = `Acción ${i + 1}`;
      if (!isObj(a) || !(a.type in ACTIONS) || unknownKeys(a, ['type', 'config']).length) return void errors.push(`${n}: acción no soportada (${String(a?.type)})`);
      const spec = ACTIONS[a.type as ActionType];
      if (spec.needs === 'order' && record !== 'order') return void errors.push(`${n}: «${spec.label}» solo aplica a disparadores de pedidos`);
      const cfg = a.config === undefined ? {} : a.config;
      if (!isObj(cfg)) return void errors.push(`${n}: configuración no válida`);
      const bad = unknownKeys(cfg, Object.keys(spec.config));
      if (bad.length) return void errors.push(`${n}: opciones no soportadas (${bad.join(', ')})`);
      const config: Record<string, any> = {};
      for (const [k, def] of Object.entries(spec.config)) {
        const v = cfg[k];
        if (def.type === 'hours') {
          const h = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
          const min = a.type === 'wait' ? 1 : 0;
          if (typeof h !== 'number' || !Number.isInteger(h) || h < min || h > MAX_WAIT_HOURS) {
            errors.push(`${n}: las horas deben ser un entero entre ${min} y ${MAX_WAIT_HOURS}`);
            continue;
          }
          config[k] = h;
          continue;
        }
        const s = cleanText(v, def.type === 'text' ? MAX_TEXT : def.type === 'ref' ? 64 : 40);
        if (!s) {
          if (def.required) errors.push(`${n}: completa «${k}»${def.type === 'text' ? ` (máximo ${MAX_TEXT} caracteres)` : ''}`);
          continue;
        }
        if (def.type === 'ref' && !/^[A-Za-z0-9_-]+$/.test(s)) { errors.push(`${n}: referencia no válida`); continue; }
        config[k] = s;
      }
      actions.push({ type: a.type as ActionType, config });
    });
    if (actions.length && actions[actions.length - 1].type === 'wait') errors.push('La última acción no puede ser «Esperar»');
  }

  // Opciones
  const o = raw.options === undefined ? {} : raw.options;
  const options: Definition['options'] = { dedupe: 'per_event', maxRunsPerHour: RUNS_PER_HOUR.default, maxAttempts: ATTEMPTS.default };
  if (!isObj(o)) errors.push('Las opciones deben ser un objeto');
  else {
    if (unknownKeys(o, ['dedupe', 'maxRunsPerHour', 'maxAttempts']).length) errors.push('Opciones no soportadas');
    if (o.dedupe !== undefined) {
      if (o.dedupe !== 'per_event' && o.dedupe !== 'once_per_record') errors.push('«dedupe» debe ser per_event u once_per_record');
      else options.dedupe = o.dedupe;
    }
    if (o.maxRunsPerHour !== undefined) {
      if (!Number.isInteger(o.maxRunsPerHour) || o.maxRunsPerHour < 1 || o.maxRunsPerHour > RUNS_PER_HOUR.max) errors.push(`Ejecuciones por hora: entre 1 y ${RUNS_PER_HOUR.max}`);
      else options.maxRunsPerHour = o.maxRunsPerHour;
    }
    if (o.maxAttempts !== undefined) {
      if (!Number.isInteger(o.maxAttempts) || o.maxAttempts < 1 || o.maxAttempts > ATTEMPTS.max) errors.push(`Intentos: entre 1 y ${ATTEMPTS.max}`);
      else options.maxAttempts = o.maxAttempts;
    }
  }

  if (errors.length || !trigger) throw new DefinitionError(errors.length ? errors : ['Definición incompleta']);
  return { schemaVersion: SCHEMA_VERSION, trigger, conditions: { match, rules }, actions, options };
}

/** Referencias a recursos de la empresa que la definición nombra (para validarlas en el tenant). */
export function definitionRefs(def: Definition): { userIds: string[]; stages: string[] } {
  const userIds = def.actions.filter((a) => a.type === 'assign_owner').map((a) => String(a.config.userId));
  const stages = def.actions.filter((a) => a.type === 'set_stage').map((a) => String(a.config.stage));
  return { userIds, stages };
}

/* ─── Evaluación ─────────────────────────────────────────────────────── */

/** Contexto plano y conocido: { 'contact.name': 'Ana', 'order.total': 120000, ... } */
export type EvalContext = Record<string, string | number | boolean | string[] | null | undefined>;

const norm = (v: unknown) => String(v ?? '').toLocaleLowerCase('es').trim();
const present = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);

export function evaluateRule(rule: Rule, ctx: EvalContext): boolean {
  const v = ctx[rule.field];
  switch (rule.op) {
    case 'exists': return present(v);
    case 'not_exists': return !present(v);
    case 'is_true': return v === true;
    case 'is_false': return v !== true;
    case 'eq': return typeof rule.value === 'number' ? typeof v === 'number' && v === rule.value : norm(v) === norm(rule.value);
    case 'neq': return typeof rule.value === 'number' ? !(typeof v === 'number' && v === rule.value) : norm(v) !== norm(rule.value);
    case 'in': return Array.isArray(rule.value) && rule.value.includes(String(v));
    case 'contains':
      return Array.isArray(v) ? v.some((x) => norm(x) === norm(rule.value)) : typeof v === 'string' && norm(v).includes(norm(rule.value));
    case 'not_contains':
      return Array.isArray(v) ? !v.some((x) => norm(x) === norm(rule.value)) : !(typeof v === 'string' && norm(v).includes(norm(rule.value)));
    case 'gt': return typeof v === 'number' && v > (rule.value as number);
    case 'gte': return typeof v === 'number' && v >= (rule.value as number);
    case 'lt': return typeof v === 'number' && v < (rule.value as number);
    case 'lte': return typeof v === 'number' && v <= (rule.value as number);
    default: return false; // operador desconocido: nunca pasa
  }
}

export function evaluateConditions(conditions: Definition['conditions'], ctx: EvalContext): { passed: boolean; results: Array<{ field: string; op: string; passed: boolean }> } {
  const results = conditions.rules.map((r) => ({ field: r.field, op: r.op, passed: evaluateRule(r, ctx) }));
  if (!results.length) return { passed: true, results };
  return { passed: conditions.match === 'any' ? results.some((r) => r.passed) : results.every((r) => r.passed), results };
}

/** Filtros del disparador (config) — se aplican antes de las condiciones. */
export function triggerMatches(def: Definition, ctx: EvalContext): boolean {
  const cfg = def.trigger.config;
  if (def.trigger.type === 'contact.stage_changed' && cfg.toStage) return norm(ctx['event.toStage']) === norm(cfg.toStage);
  if (def.trigger.type === 'order.status_changed' && cfg.toStatus) return ctx['order.status'] === cfg.toStatus;
  return true;
}

/** Catálogo para el constructor: solo lo que el motor soporta. */
export function catalog() {
  return {
    schemaVersion: SCHEMA_VERSION,
    triggers: Object.entries(TRIGGERS).map(([type, t]) => ({ type, label: t.label, record: t.record, config: t.config, fields: Object.entries(t.fields).map(([key, f]) => ({ key, ...f, operators: OPERATORS[f.type] })) })),
    actions: Object.entries(ACTIONS).map(([type, a]) => ({ type, label: a.label, needs: a.needs, config: a.config })),
    limits: { rules: MAX_RULES, actions: MAX_ACTIONS, text: MAX_TEXT, waitHours: MAX_WAIT_HOURS, runsPerHour: RUNS_PER_HOUR, attempts: ATTEMPTS },
  };
}
