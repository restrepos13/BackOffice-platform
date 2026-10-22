/**
 * Qué pasó DESPUÉS de actuar sobre una oportunidad. Se compara la foto
 * tomada al actuar (baseline) con los datos actuales. Siempre se aclara que
 * esto muestra lo ocurrido después, no prueba que haya sido por la acción.
 */

const DAY = 86400e3;
export const CAVEAT = 'Esto muestra lo que pasó después de actuar; no prueba por sí solo que haya sido por la acción.';

/** Días de espera antes de registrar un resultado, según el tipo. */
export function waitDays(ruleKey: string): number {
  if (ruleKey === 'DORMANT_CUSTOMERS') return 21;
  if (ruleKey === 'AD_ISSUES' || ruleKey === 'SPEND_NO_RESULTS') return 3;
  return 7;
}

export function ready(actedAt: Date, ruleKey: string, now: Date) {
  return now.getTime() - actedAt.getTime() >= waitDays(ruleKey) * DAY;
}

export interface ContactAfter { id: string; stage: string; lastActivityAt: Date }

/** Seguimientos: cuántos de la lista tuvieron actividad o cambiaron de etapa, y cuántos compraron. */
export function observeFollowUp(baseline: { contactIds: string[]; stages: Record<string, string> }, actedAt: Date, contacts: ContactAfter[], buyers: Set<string>) {
  const mine = contacts.filter((c) => baseline.contactIds.includes(c.id));
  const active = mine.filter((c) => c.lastActivityAt > actedAt).length;
  const moved = mine.filter((c) => baseline.stages[c.id] && baseline.stages[c.id] !== c.stage).length;
  const bought = mine.filter((c) => buyers.has(c.id)).length;
  return {
    kind: 'FOLLOW_UP',
    facts: [`${baseline.contactIds.length} contactos en la lista`, `${active} tuvieron actividad después`, `${moved} cambiaron de etapa`, `${bought} hicieron un pedido confirmado`],
    metrics: { listed: baseline.contactIds.length, active, moved, bought },
    note: CAVEAT,
  };
}

/** Anuncio pausado: gasto y resultados en los días posteriores. */
export function observePause(before: { dailySpend: number }, after: { days: number; spend: number; results: number }) {
  const daily = after.days ? Math.round(after.spend / after.days) : 0;
  return {
    kind: 'PAUSE',
    facts: [`Antes: unos ${Math.round(before.dailySpend)} al día`, `Después: ${daily} al día durante ${after.days} días`, `Resultados después: ${after.results}`],
    metrics: { dailyBefore: Math.round(before.dailySpend), dailyAfter: daily, results: after.results },
    note: after.spend > 0 ? 'El elemento volvió a gastar: puede haberse reactivado desde la plataforma.' : CAVEAT,
  };
}

/** Revisión de una métrica (p. ej. costo por resultado de una campaña). */
export function observeMetric(label: string, before: number | null, after: number | null) {
  const change = before && after !== null ? Math.round(((after - before) / before) * 100) : null;
  return {
    kind: 'METRIC',
    facts: [`${label} al actuar: ${before ?? '—'}`, `${label} 7 días después: ${after ?? '—'}`, ...(change !== null ? [`Variación: ${change > 0 ? '+' : ''}${change} %`] : [])],
    metrics: { before, after, changePct: change },
    note: CAVEAT,
  };
}
