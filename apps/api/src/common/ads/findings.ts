import { InsightLike, RESULT_LABEL, ResultType, Totals, delta, groupBy, inRange, periods, resultsOf, totals, typedTotals } from './metrics';
import { addDays } from './provider';

/**
 * Auditoría publicitaria con reglas deterministas. Cada hallazgo separa
 * hechos, interpretación, supuestos y datos faltantes, y trae su evidencia
 * numérica. Nunca se afirma que una campaña "pierde dinero" solo por no ver
 * conversiones: se descuentan los días recientes (retraso de atribución), se
 * exige volumen mínimo y se revisa primero que la medición funcione.
 *
 * Cada campaña se juzga por su resultado principal (según su objetivo): no se
 * comparan costos de chats con costos de compras. La clave de deduplicación
 * es estable por regla + elemento: mientras la condición siga, se actualiza
 * el mismo hallazgo; si desaparece y vuelve, se reabre como un episodio nuevo.
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
  /** Conversaciones del CRM que llegaron con el dato de un anuncio en el mismo periodo */
  crmAdConversations?: number;
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
    /** Regla aplicada, con sus umbrales, en palabras */
    rule: string;
  };
  evidence: Record<string, unknown>;
  period: Record<string, unknown>;
  /** SUFFICIENT = evidencia suficiente · INITIAL = indicio inicial · MISSING_DATA = faltan datos */
  evidenceLevel: 'SUFFICIENT' | 'INITIAL' | 'MISSING_DATA';
  /** Mensaje corto y humano (plantilla determinista) */
  summary: string;
  impact: Record<string, unknown> | null;
  action: { type: 'PAUSE' | 'REVIEW' | 'NONE'; risk: 'LOW' | 'MEDIUM' | 'HIGH'; reversible: boolean };
}

export interface AuditOptions {
  /** Último día con datos (en la zona de la cuenta) */
  until: string;
  /** true si `until` ya es un día completo (el servicio excluye el de hoy, que va a medias) */
  untilComplete?: boolean;
  currency: string;
  /** Días recientes que no se juzgan por resultados (retraso de atribución) */
  attributionLagDays?: number;
  /** Gasto mínimo para opinar sobre un elemento */
  minSpend?: number;
  /** Tipo de resultado principal de cada campaña (según su objetivo) */
  typeOf?: (campaignExternalId: string | null | undefined) => ResultType;
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
  const typeOf = opts.typeOf ?? (() => 'reported' as ResultType);
  const seeks = (campaign: string | null | undefined) => typeOf(campaign) !== 'none';
  // Totales del tipo de resultado de las campañas de ese tipo (para comparar como con como)
  const sameType = (type: ResultType, p: { since: string; until: string }) =>
    typedTotals(rows.filter((r) => inRange(r.date, p) && typeOf(r.campaignExternalId) === type), type);

  // ── Medición: gasto sin ningún resultado en toda la cuenta ──
  const p14 = periods(opts.until, 14).current;
  const seeking14 = rows.filter((r) => inRange(r.date, p14) && seeks(r.campaignExternalId));
  const acct14 = totals(seeking14);
  const acct14Results = [...groupBy(seeking14, (r) => r.campaignExternalId ?? '__none__')]
    .reduce((s, [c, list]) => s + (resultsOf(totals(list), typeOf(c === '__none__' ? null : c)) ?? 0), 0);
  const measurementBroken = acct14.spend > Math.max(minSpend, 0) && acct14.spend > 0 && acct14Results === 0 && acct14.days >= 5;
  if (measurementBroken) {
    out.push({
      ruleKey: 'MEASUREMENT', dedupeKey: 'MEASUREMENT:account', level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'HIGH',
      title: 'La cuenta gasta pero no registra ningún resultado',
        summary: 'Estamos viendo actividad en tus anuncios, pero no hay conversiones registradas para evaluarlos. Antes de cambiar el presupuesto, revisemos si el seguimiento funciona.',
      explanation: {
        facts: [`Gasto en 14 días: ${money(acct14.spend, cur)}`, 'Leads, conversaciones y compras reportados: 0', `Días con datos: ${acct14.days}`],
        interpretation: 'Lo más probable es un problema de medición (píxel, eventos o API de conversiones) y no que ninguna persona haya respondido.',
        assumptions: ['Las campañas buscan leads, mensajes o ventas (no solo alcance).'],
        missing: ['Configuración de eventos de conversión de la cuenta', 'Resultados registrados en el CRM para comparar'],
        action: 'Revisar el píxel / dataset y los eventos de conversión antes de juzgar campañas por costo.',
        expected: 'Poder medir el costo por resultado real de cada campaña.',
        uncertainty: 'Media: si las campañas son solo de alcance, este aviso no aplica.',
        rule: 'Campañas que buscan resultados con gasto en ≥ 5 de los últimos 14 días y 0 resultados de su tipo en toda la cuenta.',
      },
      evidence: { spend14: acct14.spend, results14: 0 }, period: p14, evidenceLevel: 'MISSING_DATA', impact: null,
      action: { type: 'NONE', risk: 'LOW', reversible: true },
    });
  }

  // ── Por campaña: costo por resultado que sube (o baja) frente a la semana anterior ──
  for (const c of campaigns) {
    const type = typeOf(c.externalId);
    if (type === 'none') continue;
    const list = rowsByCampaign.get(c.externalId) ?? [];
    const now = typedTotals(list.filter((r) => inRange(r.date, p7.current)), type);
    const before = typedTotals(list.filter((r) => inRange(r.date, p7.previous)), type);
    const change = delta(now.costPerResult, before.costPerResult);
    const label = RESULT_LABEL[type];
    const volumeOk = now.results >= 5 && before.results >= 5 && now.spend >= minSpend && before.days >= 6 && now.days >= 6;
    if (volumeOk && change !== null && change <= -30) {
      out.push({
        ruleKey: 'CPR_DOWN', dedupeKey: `CPR_DOWN:${c.externalId}`, level: 'CAMPAIGN', externalId: c.externalId, entityName: c.name, severity: 'LOW',
        title: `El costo por resultado bajó ${Math.round(-change)} % en ${quote(c.name)}`,
        summary: 'Esta campaña está consiguiendo resultados más baratos que la semana anterior. Vale la pena entender qué cambió antes de tocarla.',
        explanation: {
          facts: [
            `Últimos 7 días: ${money(now.costPerResult!, cur)} por ${label} (${now.results}, gasto ${money(now.spend, cur)})`,
            `7 días anteriores: ${money(before.costPerResult!, cur)} (${before.results})`,
          ],
          interpretation: 'La campaña rinde mejor. Puede ser un anuncio nuevo, otra audiencia o la estacionalidad; los datos no dicen cuál.',
          assumptions: ['Los resultados que reporta la plataforma reflejan bien el objetivo de la campaña.'],
          missing: ['Historial de cambios hechos en la plataforma'],
          action: 'Identificar qué anuncio explica la mejora antes de cambiar presupuesto o creativos.',
          expected: 'Repetir lo que funcionó sin romper el aprendizaje de la campaña.',
          uncertainty: now.results >= 20 ? 'Baja: hay volumen suficiente.' : 'Media: pocos resultados, la variación puede ser ruido.',
          rule: `Costo por ${label} de los últimos 7 días ≥ 30 % menor que el de los 7 anteriores, con ≥ 5 resultados y ≥ 6 días de datos en cada periodo.`,
        },
        evidence: { now, before, changePct: change, resultType: type }, period: { current: p7.current, previous: p7.previous },
        evidenceLevel: now.results >= 20 && before.results >= 20 ? 'SUFFICIENT' : 'INITIAL', impact: null,
        action: { type: 'NONE', risk: 'LOW', reversible: true },
      });
    }
    if (volumeOk && change !== null && change >= 30) {
      out.push({
        ruleKey: 'CPR_UP', dedupeKey: `CPR_UP:${c.externalId}`, level: 'CAMPAIGN', externalId: c.externalId, entityName: c.name,
        severity: change >= 60 ? 'HIGH' : 'MEDIUM',
        title: `El costo por resultado subió ${Math.round(change)} % en ${quote(c.name)}`,
        summary: `Cada resultado de esta campaña está costando más que la semana anterior. Conviene revisar qué anuncio cambió antes de mover el presupuesto.`,
        explanation: {
          facts: [
            `Últimos 7 días: ${money(now.costPerResult!, cur)} por ${label} (${now.results}, gasto ${money(now.spend, cur)})`,
            `7 días anteriores: ${money(before.costPerResult!, cur)} (${before.results})`,
          ],
          interpretation: 'La campaña obtiene menos resultados por cada peso. Puede deberse a fatiga del anuncio, a más competencia o a un cambio en la segmentación.',
          assumptions: ['Los resultados que reporta la plataforma reflejan bien el objetivo de la campaña.', 'No hubo cambios grandes de presupuesto o segmentación en el periodo.'],
          missing: ['Historial de cambios hechos en la plataforma', 'Calidad de esos leads en el CRM'],
          action: 'Revisar qué anuncio empeoró y probar una variante nueva antes de subir presupuesto.',
          expected: 'Recuperar un costo cercano al del periodo anterior.',
          uncertainty: now.results >= 20 ? 'Baja: hay volumen suficiente.' : 'Media: pocos resultados, la variación puede ser ruido.',
          rule: `Costo por ${label} de los últimos 7 días ≥ 30 % mayor que el de los 7 anteriores, con ≥ 5 resultados y ≥ 6 días de datos en cada periodo.`,
        },
        evidence: { now, before, changePct: change, resultType: type }, period: { current: p7.current, previous: p7.previous },
        evidenceLevel: now.results >= 20 && before.results >= 20 ? 'SUFFICIENT' : 'INITIAL',
        impact: null,
        action: { type: 'REVIEW', risk: 'LOW', reversible: true },
      });
    }
  }

  // ── Por anuncio: gasto sin resultados (solo si la medición funciona) ──
  if (!measurementBroken) {
    for (const e of entities.filter((x) => x.level === 'AD')) {
      const type = typeOf(e.campaignExternalId);
      if (type === 'none') continue;
      const list = rowsByAd.get(e.externalId) ?? [];
      const firstDay = list.reduce((m, r) => (r.date < m ? r.date : m), '9999');
      const old = firstDay <= addDays(opts.until, -(lag + 3));
      const t = typedTotals(list.filter((r) => inRange(r.date, judged)), type);
      // Se compara contra el costo de ese MISMO tipo de resultado en la cuenta
      const acctCpr = sameType(type, judged).costPerResult;
      const bar = Math.max(minSpend, acctCpr ? acctCpr * 3 : 0);
      if (old && t.spend > 0 && t.results === 0 && acctCpr !== null && t.spend >= bar && (e.effectiveStatus ?? e.status) === 'ACTIVE') {
        out.push({
          ruleKey: 'SPEND_NO_RESULTS', dedupeKey: `SPEND_NO_RESULTS:${e.externalId}`, level: 'AD', externalId: e.externalId, entityName: e.name,
          severity: 'HIGH',
          title: `${quote(e.name)} gastó ${money(t.spend, cur)} sin resultados registrados`,
        summary: `Este anuncio sigue gastando y no tiene resultados registrados, mientras el resto de la cuenta sí los consigue. Ya descontamos los días recientes.`,
          explanation: {
            facts: [
              `Gasto del ${judged.since} al ${judged.until}: ${money(t.spend, cur)} con 0 ${RESULT_LABEL[type]} reportados`,
              `Las campañas de la cuenta con ese mismo objetivo consiguen ${RESULT_LABEL[type]} a ${money(acctCpr, cur)} cada uno`,
              `Se excluyeron los últimos ${lag} días por el retraso normal de atribución`,
            ],
            interpretation: 'Con ese gasto, la cuenta normalmente habría conseguido al menos 3 resultados; este anuncio no está funcionando.',
            assumptions: ['El anuncio persigue el mismo tipo de resultado que el resto de la cuenta.'],
            missing: ['Resultados que lleguen tarde por atribución de más días'],
            action: 'Pausar el anuncio (se puede reanudar) o reemplazar su creativo.',
            expected: `Que ese presupuesto (unos ${money(t.spend / 7, cur)} al día) vaya a anuncios que sí registran resultados.`,
            uncertainty: 'Baja: la comparación usa la propia cuenta y descarta los días recientes.',
            rule: `Anuncio activo con ≥ ${lag + 3} días de historia que gastó ≥ 3 veces el costo por resultado de la cuenta (mismo objetivo) sin ningún resultado, sin contar los últimos ${lag} días.`,
          },
          evidence: { spend: t.spend, results: 0, accountCostPerResult: acctCpr, threshold: bar, resultType: type }, period: judged, evidenceLevel: 'SUFFICIENT',
          impact: null,
          action: { type: 'PAUSE', risk: 'MEDIUM', reversible: true },
        });
      }
    }
  }

  // ── Anuncio que concentra el gasto con peor costo que su par ──
  for (const c of campaigns) {
    const ads = entities.filter((e) => e.level === 'AD' && e.campaignExternalId === c.externalId);
    const type = typeOf(c.externalId);
    if (ads.length < 2 || type === 'none') continue;
    const per = ads.map((a) => ({ a, t: typedTotals((rowsByAd.get(a.externalId) ?? []).filter((r) => inRange(r.date, p7.current)), type) })).filter((x) => x.t.spend > 0);
    const campSpend = per.reduce((s, x) => s + x.t.spend, 0);
    for (const x of per) {
      const rest = typedTotals(per.filter((y) => y !== x).flatMap((y) => (rowsByAd.get(y.a.externalId) ?? []).filter((r) => inRange(r.date, p7.current))), type);
      if (campSpend && x.t.spend / campSpend >= 0.55 && x.t.results >= 3 && rest.results >= 3 && x.t.costPerResult && rest.costPerResult && x.t.costPerResult >= rest.costPerResult * 1.3) {
        out.push({
          ruleKey: 'SPEND_CONCENTRATION', dedupeKey: `SPEND_CONCENTRATION:${x.a.externalId}`, level: 'AD', externalId: x.a.externalId, entityName: x.a.name,
          severity: 'MEDIUM',
          title: `${quote(x.a.name)} se lleva el ${Math.round((x.t.spend / campSpend) * 100)} % del gasto con peor costo`,
        summary: `La plataforma le está dando la mayor parte del presupuesto a un anuncio que hoy rinde peor que sus alternativas.`,
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
            rule: 'En los últimos 7 días un anuncio recibe ≥ 55 % del gasto de su campaña y su costo por resultado es ≥ 30 % mayor que el de los demás anuncios (≥ 3 resultados en cada lado).',
          },
          evidence: { ad: x.t, rest, campaignSpend: campSpend }, period: p7.current, evidenceLevel: x.t.results + rest.results >= 30 ? 'SUFFICIENT' : 'INITIAL',
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
        summary: `La plataforma marcó este anuncio y no se está mostrando con normalidad. Corrigiendo el motivo puede volver a circular.`,
        explanation: {
          facts: [`Estado reportado por la plataforma: ${STATUS_ES[st] ?? (st || 'con observaciones')}`, ...e.issues.map((i) => `Motivo: ${i}`)],
          interpretation: 'El anuncio no se está mostrando (o se muestra con restricciones).',
          assumptions: [],
          missing: e.issues.length ? [] : ['Motivo detallado de la revisión'],
          action: 'Corregir el texto o la imagen según el motivo y volver a enviarlo a revisión.',
          expected: 'Que el anuncio vuelva a entregarse.',
          uncertainty: 'Baja: es un estado reportado por la plataforma.',
          rule: 'Estado DISAPPROVED o WITH_ISSUES, u observaciones de revisión en un anuncio que no está pausado ni archivado.',
        },
        evidence: { effectiveStatus: st, issues: e.issues }, period: {}, evidenceLevel: 'SUFFICIENT', impact: null,
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
      ruleKey: 'SPEND_SPIKE', dedupeKey: 'SPEND_SPIKE:account', level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
      title: `El gasto del ${opts.until} duplicó el promedio`,
        summary: `El gasto de ayer fue bastante mayor que el de los días anteriores. Vale la pena confirmar que fue a propósito.`,
      explanation: {
        facts: [`Gasto del día: ${money(last.spend, cur)}`, `Promedio de los 7 días anteriores: ${money(avg, cur)}`],
        interpretation: 'Hubo un cambio de presupuesto, una campaña nueva o una anomalía de entrega.',
        assumptions: [],
        missing: ['Historial de cambios de presupuesto en la plataforma'],
        action: 'Confirmar que el aumento fue intencional.',
        expected: 'Evitar gasto no planeado.',
        uncertainty: 'Baja para el hecho; la causa no se conoce.',
        rule: 'Gasto del último día con datos > 2 veces el promedio de los 7 días anteriores.',
      },
      evidence: { daySpend: last.spend, avg7: Math.round(avg) }, period: { day: opts.until }, evidenceLevel: 'SUFFICIENT', impact: { extraSpend: Math.round(last.spend - avg) },
      action: { type: 'REVIEW', risk: 'LOW', reversible: true },
    });
  }

  // ── Caída del gasto: se mira el último día COMPLETO (el de hoy puede ir a medias) ──
  const full = opts.untilComplete ? opts.until : addDays(opts.until, -1);
  const fullSpend = totals(byDay.get(full) ?? []).spend;
  const before7: number[] = [];
  for (let i = 1; i <= 7; i++) before7.push(totals(byDay.get(addDays(full, -i)) ?? []).spend);
  const daysWithSpend = before7.filter((v) => v > 0).length;
  const avgBefore = before7.reduce((s, v) => s + v, 0) / 7;
  const activeCampaigns = campaigns.filter((c) => (c.effectiveStatus ?? c.status) === 'ACTIVE');
  if (daysWithSpend >= 6 && avgBefore > Math.max(minSpend, 0) && fullSpend < avgBefore * 0.3 && activeCampaigns.length) {
    out.push({
      ruleKey: 'SPEND_DROP', dedupeKey: 'SPEND_DROP:account', level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
      title: `El gasto del ${full} cayó a menos de un tercio del promedio`,
      summary: 'Tus campañas activas casi no gastaron el último día completo. Puede ser un problema de entrega, de pago o de revisión.',
      explanation: {
        facts: [`Gasto del ${full}: ${money(fullSpend, cur)}`, `Promedio de los 7 días anteriores: ${money(avgBefore, cur)}`, `Campañas activas: ${activeCampaigns.length}`],
        interpretation: 'Con campañas activas, una caída así suele ser un método de pago rechazado, un límite de gasto de la cuenta o anuncios en revisión.',
        assumptions: ['No se pausaron ni se bajaron presupuestos a propósito ese día.'],
        missing: ['Estado de facturación y límite de gasto de la cuenta en la plataforma'],
        action: 'Revisar en la plataforma el método de pago, el límite de gasto y el estado de los anuncios.',
        expected: 'Que las campañas vuelvan a entregar con normalidad.',
        uncertainty: 'Baja para el hecho; la causa no se conoce.',
        rule: 'Último día completo con gasto < 30 % del promedio de los 7 días anteriores (con gasto en ≥ 6 de ellos) y al menos una campaña activa.',
      },
      evidence: { daySpend: fullSpend, avg7: Math.round(avgBefore), activeCampaigns: activeCampaigns.length }, period: { day: full }, evidenceLevel: 'SUFFICIENT', impact: null,
      action: { type: 'REVIEW', risk: 'LOW', reversible: true },
    });
  }

  // ── Seguimiento de leads en el CRM ──
  if (crm) {
    if (crm.platformConversations >= 10 && crm.adLeads === 0) {
      out.push({
        ruleKey: 'LEAD_TRACKING', dedupeKey: 'LEAD_TRACKING:account', level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
        title: 'Los anuncios generan conversaciones, pero el CRM no las ve como venidas de anuncios',
        summary: 'La plataforma dice que tus anuncios abren conversaciones, pero en el CRM no vemos de qué anuncio vino cada chat. Sin eso no podemos medir ventas por anuncio.',
        explanation: {
          facts: [`Conversaciones iniciadas que reporta la plataforma: ${crm.platformConversations}`, 'Contactos del CRM con origen en anuncio: 0'],
          interpretation: 'Los chats llegan por una línea que no entrega el dato del anuncio, o llegan a otro número.',
          assumptions: ['Los anuncios llevan a la línea de WhatsApp conectada a BackOffice.'],
          missing: ['Identificador del anuncio en el primer mensaje (referral de clic a WhatsApp)'],
          action: 'Verificar que los anuncios apunten al número conectado a BackOffice por WhatsApp Cloud API o Twilio.',
          expected: 'Poder medir costo por lead calificado y por venta.',
          uncertainty: 'Media.',
          rule: 'En los últimos 7 días la plataforma reporta ≥ 10 conversaciones iniciadas y el CRM no tiene ningún contacto con origen en un anuncio.',
        },
        evidence: { ...crm }, period: p7.current, evidenceLevel: 'INITIAL', impact: null, action: { type: 'NONE', risk: 'LOW', reversible: true },
      });
    } else if (crm.adLeads >= 10 && crm.stuckInFirstStage / crm.adLeads >= 0.7) {
      out.push({
        ruleKey: 'LEAD_QUALITY', dedupeKey: 'LEAD_QUALITY:account', level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
        title: `El ${Math.round((crm.stuckInFirstStage / crm.adLeads) * 100)} % de los leads de anuncios no avanza en el embudo`,
        summary: 'Muchos de los contactos que llegan por anuncios no avanzan en el embudo. Puede ser el mensaje del anuncio o el seguimiento; los datos aún no dicen cuál.',
        explanation: {
          facts: [`Leads de anuncios con más de 14 días: ${crm.adLeads}`, `Siguen en la primera etapa: ${crm.stuckInFirstStage}`],
          interpretation: 'Los anuncios atraen curiosos que no compran, o el equipo no les está dando seguimiento.',
          assumptions: ['El equipo mueve a los contactos por el embudo cuando avanzan.'],
          missing: ['Motivos de descarte'],
          action: 'Revisar el mensaje del anuncio (calificar mejor: precio, zona) y el seguimiento comercial.',
          expected: 'Menos leads, pero más calificados.',
          uncertainty: 'Media: depende de que el embudo se actualice.',
          rule: '≥ 10 contactos llegados por anuncios hace más de 14 días y ≥ 70 % de ellos sigue en la primera etapa del embudo.',
        },
        evidence: { ...crm }, period: {}, evidenceLevel: 'INITIAL', impact: null, action: { type: 'REVIEW', risk: 'LOW', reversible: true },
      });
    }
    const crmConv = crm.crmAdConversations ?? null;
    if (crmConv !== null && crmConv > 0 && crm.platformConversations >= 20 && crmConv / crm.platformConversations < 0.5) {
      out.push({
        ruleKey: 'CONVERSATION_GAP', dedupeKey: 'CONVERSATION_GAP:account', level: 'ACCOUNT', externalId: null, entityName: 'Cuenta', severity: 'MEDIUM',
        title: `El CRM registra ${crmConv} de las ${crm.platformConversations} conversaciones que reporta la plataforma`,
        summary: 'Una parte de las conversaciones que la plataforma atribuye a tus anuncios no llega al CRM con el dato del anuncio. Puede que lleguen por otro número o sin ese dato.',
        explanation: {
          facts: [`Conversaciones iniciadas reportadas por la plataforma (7 días): ${crm.platformConversations}`, `Conversaciones del CRM con el dato de un anuncio (mismos 7 días): ${crmConv}`],
          interpretation: 'Algunos anuncios llevan a un número que no está conectado a BackOffice, o los chats llegan sin el dato del anuncio.',
          assumptions: ['Las dos cifras cubren los mismos días; la plataforma cuenta por la fecha del clic y el CRM por la del primer mensaje, así que pueden diferir un poco.'],
          missing: ['A qué número lleva cada anuncio'],
          action: 'Revisar que todos los anuncios de clic a WhatsApp apunten al número conectado a BackOffice.',
          expected: 'Poder seguir cada conversación pagada hasta la venta.',
          uncertainty: 'Media: la plataforma también cuenta conversaciones de clientes que ya existían.',
          rule: 'En 7 días la plataforma reporta ≥ 20 conversaciones iniciadas y el CRM registra menos de la mitad con el dato de un anuncio.',
        },
        evidence: { ...crm }, period: p7.current, evidenceLevel: 'INITIAL', impact: null, action: { type: 'REVIEW', risk: 'LOW', reversible: true },
      });
    }
  }

  // Más grave primero
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
