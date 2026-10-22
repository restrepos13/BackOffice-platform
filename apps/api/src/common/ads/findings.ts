import { InsightLike, Totals, delta, groupBy, inRange, periods, totals } from './metrics';
import { addDays } from './provider';

/**
 * Auditoría publicitaria con reglas deterministas. Cada hallazgo separa
 * hechos, interpretación, supuestos y datos faltantes, y trae su evidencia
 * numérica. Nunca se afirma que una campaña "pierde dinero" solo por no ver
 * conversiones: se descuentan los días recientes (retraso de atribución), se
 * exige volumen mínimo y se revisa primero que la medición funcione.
 */

export interface EntityLike {
  level: string;
  externalId: string;
  campaignExternalId?: string | null;
  name: string;
  status?: string | null;
  effectiveStatus?: string | null;
  objective?: string | null;
  dailyBudget?: number | null;
  issues: string[];
}

export interface CrmAdStats {
  /** Contactos que llegaron desde un anuncio (dato del CRM, no de la plataforma) */
  adLeads: number;
  /** De esos, cuántos siguen en la primera etapa después de 14 días */
  stuckInFirstStage: number;
  /** Conversaciones que Meta reporta como iniciadas desde anuncios en el periodo */
  platformConversations: number;
}

export interface FindingDraft {
  ruleKey: string;
  dedupeKey: string;
  level: string;
  externalId: string | null;
  entityName: string | null;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  explanation: {
    facts: string[];
    interpretation: string;
    assumptions: string[];
    missing: string[];
    action: string;
    expected: string;
    uncertainty: string;
  };
  evidence: Record<string, unknown>;
  period: Record<string, unknown>;
  confidence: 'ALTA' | 'MEDIA' | 'BAJA';
  impact: Record<string, unknown> | null;
  action: { type: 'PAUSE' | 'REVIEW' | 'NONE'; risk: 'LOW' | 'MEDIUM' | 'HIGH'; reversible: boolean };
}

export interface AuditOptions {
  /** Último día con datos (en la zona de la cuenta) */
  until: string;
  currency: string;
  /** Días recientes que no se juzgan por resultados (retraso de atribución) */
  attributionLagDays?: number;
  /** Gasto mínimo para opinar sobre un elemento */
  minSpend?: number;
}

const STATUS_ES: Record<string, string> = { DISAPPROVED: 'rechazado', WITH_ISSUES: 'con problemas de entrega', PENDING_REVIEW: 'en revisión', ACTIVE: 'activo' };

/** Nombre entre comillas, sin duplicarlas si ya las trae. */
const quote = (name: string) => (/^[«"“]/.test(name) ? name : `«${name}»`);

const money = (n: number, currency: string) => `${currency === 'COP' ? '$' : ''}${Math.round(n).toLocaleString('es-CO')}${currency === 'COP' ? '' : ` ${currency}`}`;

export function audit(entities: EntityLike[], rows: InsightLike[], opts: AuditOptions, crm?: CrmAdStats): FindingDraft[] {
  const out: FindingDraft[] = [];
  const cur = opts.currency;
  const lag = opts.attributionLagDays ?? 2;
  const minSpend = opts.minSpend ?? 0;
  const p7 = periods(opts.until, 7);
  const judged = { since: addDays(opts.until, -(7 + lag - 1)), until: addDays(opts.until, -lag) };
  const campaigns = entities.filter((e) => e.level === 'CAMPAIGN');
  const rowsByCampaign = groupBy(rows, (r) => r.campaignExternalId);
  const rowsByAd = groupBy(rows, (r) => r.externalId);
  const tag = `${p7.current.since}..${p7.current.until}`;

  // ── Medición: gasto sin ningún resultado en toda la cuenta ──
  const p14 = periods(opts.until, 14).current;
  const acct14 = totals(rows.filter((r) => inRange(r.date, p14)));
  const measurementBroken = acct14.spend > Math.max(minSpend, 0) && acct14.spend > 0 && acct14.results === 0 && acct14.days >= 5;
  if (measurementBroken) {
    out.push({
      ruleKey: 'MEASUREMENT', dedupeKey: `MEASUREMENT:account:${p14.since}`, level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'HIGH',
      title: 'La cuenta gasta pero no registra ningún resultado',
      explanation: {
        facts: [`Gasto en 14 días: ${money(acct14.spend, cur)}`, 'Leads, conversaciones y compras reportados: 0', `Días con datos: ${acct14.days}`],
        interpretation: 'Lo más probable es un problema de medición (píxel, eventos o API de conversiones) y no que ninguna persona haya respondido.',
        assumptions: ['Las campañas buscan leads, mensajes o ventas (no solo alcance).'],
        missing: ['Configuración de eventos de conversión de la cuenta', 'Resultados registrados en el CRM para comparar'],
        action: 'Revisar el píxel / dataset y los eventos de conversión antes de juzgar campañas por costo.',
        expected: 'Poder medir el costo por resultado real de cada campaña.',
        uncertainty: 'Media: si las campañas son solo de alcance, este aviso no aplica.',
      },
      evidence: { spend14: acct14.spend, results14: 0 }, period: p14, confidence: 'MEDIA', impact: { spendWithoutMeasurement: acct14.spend },
      action: { type: 'NONE', risk: 'LOW', reversible: true },
    });
  }

  const acctJudged = totals(rows.filter((r) => inRange(r.date, judged)));
  const acctCpr = acctJudged.costPerResult;

  // ── Por campaña: costo por resultado que sube frente al periodo anterior ──
  for (const c of campaigns) {
    const list = rowsByCampaign.get(c.externalId) ?? [];
    const now = totals(list.filter((r) => inRange(r.date, p7.current)));
    const before = totals(list.filter((r) => inRange(r.date, p7.previous)));
    const change = delta(now.costPerResult, before.costPerResult);
    if (now.results >= 5 && before.results >= 5 && now.spend >= minSpend && change !== null && change >= 30) {
      out.push({
        ruleKey: 'CPR_UP', dedupeKey: `CPR_UP:${c.externalId}:${tag}`, level: 'CAMPAIGN', externalId: c.externalId, entityName: c.name,
        severity: change >= 60 ? 'HIGH' : 'MEDIUM',
        title: `El costo por resultado subió ${Math.round(change)} % en ${quote(c.name)}`,
        explanation: {
          facts: [
            `Últimos 7 días: ${money(now.costPerResult!, cur)} por resultado (${now.results} resultados, gasto ${money(now.spend, cur)})`,
            `7 días anteriores: ${money(before.costPerResult!, cur)} por resultado (${before.results} resultados)`,
          ],
          interpretation: 'La campaña obtiene menos resultados por cada peso. Puede deberse a fatiga del anuncio, a más competencia o a un cambio en la segmentación.',
          assumptions: ['Los resultados que reporta la plataforma reflejan bien el objetivo de la campaña.', 'No hubo cambios grandes de presupuesto o segmentación en el periodo.'],
          missing: ['Historial de cambios hechos en la plataforma', 'Calidad de esos leads en el CRM'],
          action: 'Revisar qué anuncio empeoró y probar una variante nueva antes de subir presupuesto.',
          expected: 'Recuperar un costo cercano al del periodo anterior.',
          uncertainty: now.results >= 20 ? 'Baja: hay volumen suficiente.' : 'Media: pocos resultados, la variación puede ser ruido.',
        },
        evidence: { now, before, changePct: change }, period: { current: p7.current, previous: p7.previous },
        confidence: now.results >= 20 && before.results >= 20 ? 'ALTA' : 'MEDIA',
        impact: { extraCostPerWeek: before.costPerResult ? Math.round(now.spend - now.results * before.costPerResult) : null },
        action: { type: 'REVIEW', risk: 'LOW', reversible: true },
      });
    }
  }

  // ── Por anuncio: gasto sin resultados (solo si la medición funciona) ──
  if (!measurementBroken) {
    for (const e of entities.filter((x) => x.level === 'AD')) {
      const list = rowsByAd.get(e.externalId) ?? [];
      const firstDay = list.reduce((m, r) => (r.date < m ? r.date : m), '9999');
      const old = firstDay <= addDays(opts.until, -(lag + 3));
      const t = totals(list.filter((r) => inRange(r.date, judged)));
      const bar = Math.max(minSpend, acctCpr ? acctCpr * 3 : 0);
      if (old && t.spend > 0 && t.results === 0 && acctCpr !== null && t.spend >= bar && (e.effectiveStatus ?? e.status) === 'ACTIVE') {
        out.push({
          ruleKey: 'SPEND_NO_RESULTS', dedupeKey: `SPEND_NO_RESULTS:${e.externalId}:${judged.since}`, level: 'AD', externalId: e.externalId, entityName: e.name,
          severity: 'HIGH',
          title: `${quote(e.name)} gastó ${money(t.spend, cur)} sin resultados`,
          explanation: {
            facts: [
              `Gasto del ${judged.since} al ${judged.until}: ${money(t.spend, cur)} con 0 resultados reportados`,
              `El resto de la cuenta consigue resultados a ${money(acctCpr, cur)} cada uno`,
              `Se excluyeron los últimos ${lag} días por el retraso normal de atribución`,
            ],
            interpretation: 'Con ese gasto, la cuenta normalmente habría conseguido al menos 3 resultados; este anuncio no está funcionando.',
            assumptions: ['El anuncio persigue el mismo tipo de resultado que el resto de la cuenta.'],
            missing: ['Resultados que lleguen tarde por atribución de más días'],
            action: 'Pausar el anuncio (se puede reanudar) o reemplazar su creativo.',
            expected: `Dejar de gastar unos ${money(t.spend / 7, cur)} diarios sin retorno medible.`,
            uncertainty: 'Baja: la comparación usa la propia cuenta y descarta los días recientes.',
          },
          evidence: { spend: t.spend, results: 0, accountCostPerResult: acctCpr, threshold: bar }, period: judged, confidence: 'ALTA',
          impact: { dailySpendAtRisk: Math.round(t.spend / 7) },
          action: { type: 'PAUSE', risk: 'MEDIUM', reversible: true },
        });
      }
    }
  }

  // ── Anuncio que concentra el gasto con peor costo que su par ──
  for (const c of campaigns) {
    const ads = entities.filter((e) => e.level === 'AD' && e.campaignExternalId === c.externalId);
    if (ads.length < 2) continue;
    const per = ads.map((a) => ({ a, t: totals((rowsByAd.get(a.externalId) ?? []).filter((r) => inRange(r.date, p7.current))) })).filter((x) => x.t.spend > 0);
    const campSpend = per.reduce((s, x) => s + x.t.spend, 0);
    for (const x of per) {
      const rest = totals(per.filter((y) => y !== x).flatMap((y) => (rowsByAd.get(y.a.externalId) ?? []).filter((r) => inRange(r.date, p7.current))));
      if (campSpend && x.t.spend / campSpend >= 0.55 && x.t.results >= 3 && rest.results >= 3 && x.t.costPerResult && rest.costPerResult && x.t.costPerResult >= rest.costPerResult * 1.3) {
        out.push({
          ruleKey: 'SPEND_CONCENTRATION', dedupeKey: `SPEND_CONCENTRATION:${x.a.externalId}:${tag}`, level: 'AD', externalId: x.a.externalId, entityName: x.a.name,
          severity: 'MEDIUM',
          title: `${quote(x.a.name)} se lleva el ${Math.round((x.t.spend / campSpend) * 100)} % del gasto con peor costo`,
          explanation: {
            facts: [
              `Costo por resultado de este anuncio: ${money(x.t.costPerResult, cur)}`,
              `Costo por resultado de los demás anuncios de la campaña: ${money(rest.costPerResult, cur)}`,
            ],
            interpretation: 'La plataforma está favoreciendo un anuncio que rinde peor que sus alternativas.',
            assumptions: ['Los anuncios comparten audiencia y objetivo.'],
            missing: ['Calidad de los leads de cada anuncio en el CRM'],
            action: 'Revisar la distribución: probar a separar el mejor anuncio o pausar el más caro.',
            expected: 'Bajar el costo por resultado de la campaña.',
            uncertainty: x.t.results + rest.results >= 30 ? 'Baja' : 'Media: volumen moderado.',
          },
          evidence: { ad: x.t, rest, campaignSpend: campSpend }, period: p7.current, confidence: x.t.results + rest.results >= 30 ? 'ALTA' : 'MEDIA',
          impact: null, action: { type: 'REVIEW', risk: 'LOW', reversible: true },
        });
      }
    }
  }

  // ── Anuncios rechazados o con problemas de entrega ──
  for (const e of entities.filter((x) => x.level === 'AD')) {
    const st = String(e.effectiveStatus ?? '');
    if (st === 'DISAPPROVED' || st === 'WITH_ISSUES' || (e.issues.length && st !== 'PAUSED' && st !== 'ARCHIVED' && st !== 'DELETED')) {
      out.push({
        ruleKey: 'AD_ISSUES', dedupeKey: `AD_ISSUES:${e.externalId}:${st}`, level: 'AD', externalId: e.externalId, entityName: e.name, severity: 'HIGH',
        title: st === 'DISAPPROVED' ? `La plataforma rechazó ${quote(e.name)}` : `${quote(e.name)} tiene problemas de entrega`,
        explanation: {
          facts: [`Estado reportado por la plataforma: ${STATUS_ES[st] ?? (st || 'con observaciones')}`, ...e.issues.map((i) => `Motivo: ${i}`)],
          interpretation: 'El anuncio no se está mostrando (o se muestra con restricciones).',
          assumptions: [],
          missing: e.issues.length ? [] : ['Motivo detallado de la revisión'],
          action: 'Corregir el texto o la imagen según el motivo y volver a enviarlo a revisión.',
          expected: 'Que el anuncio vuelva a entregarse.',
          uncertainty: 'Baja: es un estado reportado por la plataforma.',
        },
        evidence: { effectiveStatus: st, issues: e.issues }, period: {}, confidence: 'ALTA', impact: null,
        action: { type: 'REVIEW', risk: 'LOW', reversible: true },
      });
    }
  }

  // ── Pico de gasto diario ──
  const byDay = groupBy(rows, (r) => r.date);
  const last = totals(byDay.get(opts.until) ?? []);
  const prev7: Totals[] = [];
  for (let i = 1; i <= 7; i++) prev7.push(totals(byDay.get(addDays(opts.until, -i)) ?? []));
  const avg = prev7.reduce((s, t) => s + t.spend, 0) / 7;
  if (avg > 0 && last.spend > avg * 2 && last.spend >= minSpend) {
    out.push({
      ruleKey: 'SPEND_SPIKE', dedupeKey: `SPEND_SPIKE:account:${opts.until}`, level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
      title: `El gasto del ${opts.until} duplicó el promedio`,
      explanation: {
        facts: [`Gasto del día: ${money(last.spend, cur)}`, `Promedio de los 7 días anteriores: ${money(avg, cur)}`],
        interpretation: 'Hubo un cambio de presupuesto, una campaña nueva o una anomalía de entrega.',
        assumptions: [],
        missing: ['Historial de cambios de presupuesto en la plataforma'],
        action: 'Confirmar que el aumento fue intencional.',
        expected: 'Evitar gasto no planeado.',
        uncertainty: 'Baja para el hecho; la causa no se conoce.',
      },
      evidence: { daySpend: last.spend, avg7: Math.round(avg) }, period: { day: opts.until }, confidence: 'ALTA', impact: { extraSpend: Math.round(last.spend - avg) },
      action: { type: 'REVIEW', risk: 'LOW', reversible: true },
    });
  }

  // ── Seguimiento de leads en el CRM ──
  if (crm) {
    if (crm.platformConversations >= 10 && crm.adLeads === 0) {
      out.push({
        ruleKey: 'LEAD_TRACKING', dedupeKey: `LEAD_TRACKING:account:${tag}`, level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
        title: 'Los anuncios generan conversaciones, pero el CRM no las ve como venidas de anuncios',
        explanation: {
          facts: [`Conversaciones iniciadas que reporta la plataforma: ${crm.platformConversations}`, 'Contactos del CRM con origen en anuncio: 0'],
          interpretation: 'Los chats llegan por una línea que no entrega el dato del anuncio, o llegan a otro número.',
          assumptions: ['Los anuncios llevan a la línea de WhatsApp conectada a BackOffice.'],
          missing: ['Identificador del anuncio en el primer mensaje (referral de clic a WhatsApp)'],
          action: 'Verificar que los anuncios apunten al número conectado a BackOffice por WhatsApp Cloud API o Twilio.',
          expected: 'Poder medir costo por lead calificado y por venta.',
          uncertainty: 'Media.',
        },
        evidence: { ...crm }, period: p7.current, confidence: 'MEDIA', impact: null, action: { type: 'NONE', risk: 'LOW', reversible: true },
      });
    } else if (crm.adLeads >= 10 && crm.stuckInFirstStage / crm.adLeads >= 0.7) {
      out.push({
        ruleKey: 'LEAD_QUALITY', dedupeKey: `LEAD_QUALITY:account:${tag}`, level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
        title: `El ${Math.round((crm.stuckInFirstStage / crm.adLeads) * 100)} % de los leads de anuncios no avanza en el embudo`,
        explanation: {
          facts: [`Leads de anuncios con más de 14 días: ${crm.adLeads}`, `Siguen en la primera etapa: ${crm.stuckInFirstStage}`],
          interpretation: 'Los anuncios atraen curiosos que no compran, o el equipo no les está dando seguimiento.',
          assumptions: ['El equipo mueve a los contactos por el embudo cuando avanzan.'],
          missing: ['Motivos de descarte'],
          action: 'Revisar el mensaje del anuncio (calificar mejor: precio, zona) y el seguimiento comercial.',
          expected: 'Menos leads, pero más calificados.',
          uncertainty: 'Media: depende de que el embudo se actualice.',
        },
        evidence: { ...crm }, period: {}, confidence: 'MEDIA', impact: null, action: { type: 'REVIEW', risk: 'LOW', reversible: true },
      });
    }
  }

  // Más grave primero
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
