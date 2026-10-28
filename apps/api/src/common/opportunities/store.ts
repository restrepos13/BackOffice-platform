import { parseJson } from '../constants';
import { deterministicId } from '../automation/run-signals';
import { story } from './present';

/**
 * Oportunidades (Radar comercial): estructura común para todo lo que detecta
 * BackOffice con reglas deterministas, venga de anuncios (ADS) o del CRM.
 * Aquí viven los estados permitidos y el guardado sin duplicados.
 */

export type OppSource = 'ADS' | 'CRM';
export type EvidenceLevel = 'SUFFICIENT' | 'INITIAL' | 'MISSING_DATA';
export type OppStatus = 'NEW' | 'REVIEWING' | 'PREPARED' | 'NEEDS_APPROVAL' | 'EXECUTED' | 'OBSERVING' | 'RESULT' | 'DISMISSED' | 'SNOOZED';

export interface OppAction {
  /** PAUSE (ejecutable en la plataforma), FOLLOW_UP (preparar lista y revisar en la bandeja), REVIEW (revisar), LINK (ir a otra pantalla), NONE */
  type: 'PAUSE' | 'FOLLOW_UP' | 'REVIEW' | 'LINK' | 'NONE';
  label?: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  reversible: boolean;
  href?: string;
  /** Para seguimientos: a quiénes (ids de contactos de la misma empresa) */
  contactIds?: string[];
}

export interface OppDraft {
  ruleKey: string;
  dedupeKey: string;
  level?: string | null;
  externalId?: string | null;
  entityName?: string | null;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  summary: string;
  explanation: { facts: string[]; interpretation: string; assumptions: string[]; missing: string[]; action: string; expected: string; uncertainty: string; rule?: string };
  evidence: Record<string, unknown>;
  sources: string[];
  period: Record<string, unknown>;
  evidenceLevel: EvidenceLevel;
  impact: Record<string, unknown> | null;
  action: OppAction;
}

export const STATUS_LABEL: Record<OppStatus, string> = {
  NEW: 'Nueva', REVIEWING: 'Pendiente de revisar', PREPARED: 'Acción preparada', NEEDS_APPROVAL: 'Requiere aprobación',
  EXECUTED: 'Acción ejecutada', OBSERVING: 'En observación', RESULT: 'Resultado registrado', DISMISSED: 'Descartada', SNOOZED: 'Pospuesta',
};

/** Abiertas = las que todavía piden algo al usuario. */
export const OPEN: OppStatus[] = ['NEW', 'REVIEWING', 'PREPARED', 'NEEDS_APPROVAL'];

/**
 * Transiciones que puede pedir una persona. EXECUTED/OBSERVING/RESULT las
 * pone el sistema (al ejecutar u observar): un clic no "resuelve" nada.
 */
const USER_MOVES: Record<string, OppStatus[]> = {
  NEW: ['REVIEWING', 'PREPARED', 'NEEDS_APPROVAL', 'DISMISSED', 'SNOOZED'],
  REVIEWING: ['PREPARED', 'NEEDS_APPROVAL', 'DISMISSED', 'SNOOZED', 'NEW'],
  PREPARED: ['NEEDS_APPROVAL', 'DISMISSED', 'SNOOZED', 'REVIEWING'],
  NEEDS_APPROVAL: ['DISMISSED', 'REVIEWING'],
  DISMISSED: ['NEW'],
  SNOOZED: ['NEW'],
  EXECUTED: [],
  OBSERVING: [],
  RESULT: [],
};

export function canMove(from: string, to: string): boolean {
  return (USER_MOVES[from] ?? []).includes(to as OppStatus);
}

export interface Decision { at: string; by: string; status: string; note?: string }

export function addDecision(json: string | null | undefined, d: Decision): string {
  const list = parseJson<Decision[]>(json, []);
  list.push({ ...d, note: d.note?.slice(0, 300) });
  return JSON.stringify(list.slice(-50));
}

/** _id derivado de la clave: Mongo garantiza que no haya dos aunque falte el índice único. */
export const opportunityId = (dedupeKey: string) => deterministicId('opp', dedupeKey);

/**
 * Guarda lo detectado en una corrida. Si ya existe (misma dedupeKey) se
 * refresca la evidencia sin tocar el estado que eligió el usuario. Lo que
 * estaba nuevo y ya no se detecta pasa a "resultado registrado" con la nota
 * de que la condición desapareció (no se borra ni se da por "resuelta").
 * Si una condición que había desaparecido vuelve, se reabre como episodio
 * nuevo (misma fila, fecha de detección nueva y la decisión en el historial).
 */
export async function storeDetected(
  prisma: any,
  scope: { companyId: string; source: OppSource; mode: 'REAL' | 'DEMO'; accountId?: string | null; keyPrefix: string; ruleKeys?: string[] },
  drafts: OppDraft[],
  now: Date,
) {
  const seen = new Set<string>();
  let created = 0;
  for (const d of drafts) {
    const dedupeKey = `${scope.keyPrefix}:${d.dedupeKey}`;
    seen.add(dedupeKey);
    const data = {
      severity: d.severity, title: d.title, summary: d.summary, explanationJson: JSON.stringify(d.explanation), evidenceJson: JSON.stringify(d.evidence),
      sourcesJson: JSON.stringify(d.sources), periodJson: JSON.stringify(d.period), evidence: d.evidenceLevel, impactJson: d.impact ? JSON.stringify(d.impact) : null,
      actionJson: JSON.stringify(d.action), entityName: d.entityName ?? null, lastSeenAt: now,
    };
    const existing = await prisma.opportunity.findUnique({ where: { dedupeKey } });
    if (existing && existing.companyId !== scope.companyId) continue; // nunca se pisa otra empresa
    if (existing) {
      // Una pospuesta cuyo plazo venció vuelve a ser nueva
      const wake = existing.status === 'SNOOZED' && existing.snoozedUntil && new Date(existing.snoozedUntil) <= now;
      // La condición había desaparecido (cerrada por el sistema) y volvió: episodio nuevo
      const back = existing.status === 'RESULT' && parseJson<{ kind?: string }>(existing.resultJson, {}).kind === 'CONDITION_GONE';
      await prisma.opportunity.update({
        where: { id: existing.id },
        data: {
          ...data,
          ...(wake ? { status: 'NEW', snoozedUntil: null, decisionsJson: addDecision(existing.decisionsJson, { at: now.toISOString(), by: 'Sistema', status: 'NEW', note: 'Terminó el plazo de la pausa' }) } : {}),
          ...(back ? { status: 'NEW', firstSeenAt: now, resultJson: null, resultAt: null, decisionsJson: addDecision(existing.decisionsJson, { at: now.toISOString(), by: 'Sistema', status: 'NEW', note: 'La condición volvió a detectarse' }) } : {}),
        },
      });
      if (back) created++;
    } else {
      try {
        await prisma.opportunity.create({
          data: {
            id: opportunityId(dedupeKey), companyId: scope.companyId, source: scope.source, mode: scope.mode, accountId: scope.accountId ?? null, ruleKey: d.ruleKey, dedupeKey,
            level: d.level ?? null, externalId: d.externalId ?? null, status: 'NEW', firstSeenAt: now, decisionsJson: '[]', ...data,
          },
        });
        created++;
      } catch (err: any) {
        // Otra corrida simultánea la creó primero: queda una sola
        if (err?.code !== 'P2002') throw err;
      }
    }
  }
  const stale = await prisma.opportunity.findMany({
    where: { companyId: scope.companyId, source: scope.source, mode: scope.mode, status: { in: ['NEW', 'REVIEWING'] }, ...(scope.accountId ? { accountId: scope.accountId } : {}) },
  });
  let gone = 0;
  for (const o of stale) {
    if (seen.has(o.dedupeKey) || !o.dedupeKey.startsWith(`${scope.keyPrefix}:`)) continue;
    if (scope.ruleKeys && !scope.ruleKeys.includes(o.ruleKey)) continue;
    await prisma.opportunity.update({
      where: { id: o.id },
      data: {
        status: 'RESULT', resultAt: now,
        resultJson: JSON.stringify({ kind: 'CONDITION_GONE', note: 'La condición ya no se detecta en los datos más recientes. No hubo una acción registrada desde BackOffice.' }),
        decisionsJson: addDecision(o.decisionsJson, { at: now.toISOString(), by: 'Sistema', status: 'RESULT', note: 'La condición desapareció' }),
      },
    });
    gone++;
  }
  return { detected: drafts.length, created, gone };
}

export function view(o: any, now = new Date()) {
  const { explanationJson, evidenceJson, sourcesJson, periodJson, impactJson, actionJson, decisionsJson, baselineJson, resultJson, ...rest } = o;
  const action = parseJson<OppAction>(actionJson, { type: 'NONE', risk: 'LOW', reversible: true });
  return {
    ...rest,
    statusLabel: STATUS_LABEL[o.status as OppStatus] ?? o.status,
    story: story(o, now),
    explanation: parseJson(explanationJson, {}),
    evidenceData: parseJson(evidenceJson, {}),
    sources: parseJson<string[]>(sourcesJson, []),
    period: parseJson(periodJson, {}),
    impact: parseJson(impactJson, null),
    // Los ids de contactos no salen a la interfaz (se cuentan)
    action: { ...action, contactIds: undefined, contacts: action.contactIds?.length ?? 0 },
    decisions: parseJson(decisionsJson, []),
    baseline: parseJson(baselineJson, null),
    result: parseJson(resultJson, null),
  };
}
