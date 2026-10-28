import { InsightLike, inRange, periods, totals, PeriodStat, ResultType, typedTotals } from './metrics';
import { addDays } from './provider';

/**
 * Autopilot: reglas configurables por empresa. El motor es puro (no llama a
 * ninguna API): decide qué propone y si algo PUEDE ejecutarse solo. La
 * ejecución real la hace el servicio pasando por guardAutoAction.
 *
 * Niveles de autonomía:
 *  - ANALYSIS: solo alertas.
 *  - RECOMMEND: propone cambios que una persona aprueba.
 *  - AUTHORIZED: ejecuta solo las acciones que el administrador habilitó
 *    (hoy únicamente PAUSAR, que no gasta dinero y se puede revertir).
 * Nada de lo que hace el motor puede subir presupuestos ni activar campañas.
 */

export type RuleMetric = 'SPEND' | 'CPL' | 'CTR' | 'NO_RESULTS' | 'SPEND_SPIKE' | 'FREQUENCY';
export type RuleAction = 'ALERT' | 'RECOMMEND_PAUSE' | 'PAUSE';
export type Autonomy = 'ANALYSIS' | 'RECOMMEND' | 'AUTHORIZED';

export interface RuleLike {
  id: string;
  name: string;
  metric: RuleMetric;
  level: 'CAMPAIGN' | 'AD';
  windowDays: number;
  operator: 'GT' | 'LT';
  threshold: number;
  minSpend: number;
  action: RuleAction;
}

export interface RuleEntity {
  level: string;
  externalId: string;
  campaignExternalId?: string | null;
  name: string;
  effectiveStatus?: string | null;
  status?: string | null;
}

export interface RuleMatch {
  externalId: string;
  name: string;
  value: number | null;
  threshold: number;
  spend: number;
  window: { since: string; until: string };
  reason: string;
}

export const METRICS: Record<RuleMetric, { label: string; unit: string }> = {
  SPEND: { label: 'Gasto en la ventana', unit: 'money' },
  CPL: { label: 'Costo por resultado', unit: 'money' },
  CTR: { label: 'CTR (%)', unit: 'pct' },
  NO_RESULTS: { label: 'Gasto sin resultados', unit: 'money' },
  SPEND_SPIKE: { label: 'Gasto de ayer vs. promedio (veces)', unit: 'x' },
  FREQUENCY: { label: 'Impresiones por persona alcanzada', unit: 'x' },
};

export function validateRule(r: Partial<RuleLike>): string | null {
  if (!r.name || String(r.name).trim().length < 3) return 'Ponle un nombre a la regla';
  if (!r.metric || !(r.metric in METRICS)) return 'Métrica inválida';
  if (!['CAMPAIGN', 'AD'].includes(String(r.level))) return 'Nivel inválido';
  if (!Number.isInteger(r.windowDays) || r.windowDays! < 1 || r.windowDays! > 90) return 'La ventana va de 1 a 90 días';
  if (!['GT', 'LT'].includes(String(r.operator))) return 'Operador inválido';
  if (!Number.isFinite(r.threshold) || r.threshold! < 0) return 'El umbral debe ser un número positivo';
  if (!Number.isFinite(r.minSpend) || r.minSpend! < 0) return 'El gasto mínimo debe ser positivo';
  if (!['ALERT', 'RECOMMEND_PAUSE', 'PAUSE'].includes(String(r.action))) return 'Acción inválida';
  // La plataforma reporta alcance por campaña para 7 y 30 días: la frecuencia solo existe ahí
  if (r.metric === 'FREQUENCY' && (r.level !== 'CAMPAIGN' || ![7, 30].includes(Number(r.windowDays)))) return 'La frecuencia se mide por campaña, con ventana de 7 o 30 días';
  return null;
}

const isActive = (e: RuleEntity) => (e.effectiveStatus ?? e.status) === 'ACTIVE';

export interface RuleContext {
  /** Tipo de resultado principal de cada campaña (el costo por resultado se mide con ese) */
  typeOf?: (campaignExternalId: string | null | undefined) => ResultType;
  /** Alcance del periodo reportado por la plataforma (la frecuencia solo se calcula con él) */
  periodStat?: (level: string, externalId: string, window: { since: string; until: string }) => PeriodStat | null;
}

export function evaluateRule(rule: RuleLike, entities: RuleEntity[], rows: InsightLike[], until: string, ctx: RuleContext = {}): RuleMatch[] {
  const win = periods(until, rule.windowDays).current;
  const targets = entities.filter((e) => e.level === rule.level && isActive(e));
  const out: RuleMatch[] = [];
  for (const e of targets) {
    const own = rows.filter((r) => (rule.level === 'AD' ? r.externalId === e.externalId : r.campaignExternalId === e.externalId));
    const campaignOf = rule.level === 'AD' ? own[0]?.campaignExternalId ?? (e as any).campaignExternalId : e.externalId;
    const t = typedTotals(own.filter((r) => inRange(r.date, win)), ctx.typeOf ? ctx.typeOf(campaignOf) : 'reported');
    if (t.spend < rule.minSpend) continue;
    let value: number | null = null;
    switch (rule.metric) {
      case 'SPEND': value = t.spend; break;
      case 'CPL': value = t.costPerResult; break;
      case 'CTR': value = t.ctr; break;
      case 'NO_RESULTS': value = t.resultsAvailable && t.results === 0 ? t.spend : null; break;
      case 'FREQUENCY': {
        // El alcance son personas únicas: no se suma día a día ni se aproxima.
        // Solo con el alcance del periodo que reportó la plataforma (si no, no opina).
        const stat = ctx.periodStat?.(rule.level, e.externalId, win) ?? null;
        value = stat?.frequency ?? (stat?.reach ? Math.round((stat.impressions / stat.reach) * 100) / 100 : null);
        break;
      }
      case 'SPEND_SPIKE': {
        const y = totals(own.filter((r) => r.date === until)).spend;
        const prev = periods(addDays(until, -1), 7).current;
        const avg = totals(own.filter((r) => inRange(r.date, prev))).spend / 7;
        value = avg > 0 ? Math.round((y / avg) * 100) / 100 : null;
        break;
      }
    }
    if (value === null) continue;
    const hit = rule.operator === 'GT' ? value > rule.threshold : value < rule.threshold;
    if (hit) {
      out.push({
        externalId: e.externalId, name: e.name, value, threshold: rule.threshold, spend: t.spend, window: win,
        reason: `${METRICS[rule.metric].label}: ${value} ${rule.operator === 'GT' ? '>' : '<'} ${rule.threshold} (${win.since} a ${win.until})`,
      });
    }
  }
  return out;
}

export interface GuardInput {
  action: RuleAction;
  autonomy: Autonomy;
  autoActions: string[];
  globalPause: boolean;
  dataAgeHours: number | null;
  maxDataAgeHours: number;
  entityActive: boolean;
  sameCompany: boolean;
  tokenValid: boolean;
}

/**
 * Decide qué se hace con una coincidencia:
 *  - ALERT: solo avisa (siempre permitido, salvo pausa global).
 *  - PROPOSE: queda pendiente de aprobación humana.
 *  - EXECUTE: se ejecuta solo (todas las condiciones de seguridad cumplidas).
 *  - SKIP: no se hace nada (con el motivo).
 */
export function guardAutoAction(g: GuardInput): { decision: 'ALERT' | 'PROPOSE' | 'EXECUTE' | 'SKIP'; reason: string } {
  if (!g.sameCompany) return { decision: 'SKIP', reason: 'El elemento no pertenece a la empresa de la regla' };
  if (g.globalPause) return { decision: 'SKIP', reason: 'Pausa global activada: el Autopilot no hace nada' };
  if (g.action === 'ALERT' || g.autonomy === 'ANALYSIS') return { decision: 'ALERT', reason: g.action === 'ALERT' ? 'La regla solo alerta' : 'Modo solo análisis' };
  if (!g.entityActive) return { decision: 'SKIP', reason: 'El elemento ya no está activo' };
  if (g.action === 'RECOMMEND_PAUSE' || g.autonomy === 'RECOMMEND') return { decision: 'PROPOSE', reason: 'Requiere aprobación de una persona' };
  // A partir de aquí: acción PAUSE en modo AUTHORIZED
  if (!g.autoActions.includes('PAUSE')) return { decision: 'PROPOSE', reason: 'El administrador no habilitó pausar automáticamente' };
  if (!g.tokenValid) return { decision: 'PROPOSE', reason: 'La conexión con la plataforma no está vigente' };
  if (g.dataAgeHours === null || g.dataAgeHours > g.maxDataAgeHours) return { decision: 'PROPOSE', reason: `Datos con más de ${g.maxDataAgeHours} h: no se ejecuta solo` };
  return { decision: 'EXECUTE', reason: 'Acción habilitada, datos frescos y permisos vigentes' };
}

/** Clave de idempotencia: una ejecución por regla, elemento y día. */
export const ruleRunKey = (ruleId: string, externalId: string, day: string) => `rule:${ruleId}:${externalId}:${day}`;

/** Un presupuesto nuevo nunca puede superar el tope de la empresa. */
export function budgetAllowed(next: number, max: number | null | undefined): { ok: boolean; reason?: string } {
  if (!Number.isFinite(next) || next <= 0) return { ok: false, reason: 'Presupuesto inválido' };
  if (max && next > max) return { ok: false, reason: `Supera el tope diario autorizado (${max})` };
  return { ok: true };
}
