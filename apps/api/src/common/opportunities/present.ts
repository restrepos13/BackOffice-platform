import { parseJson } from '../constants';
import type { OppStatus } from './store';
import { waitDays } from './observe';

/**
 * Capa de presentación: convierte el estado y la evidencia de una
 * oportunidad en una historia corta que responde cinco preguntas:
 * ¿qué pasa?, ¿cómo lo sabemos?, ¿por qué importa?, ¿qué hago ahora?,
 * ¿qué pasó después? Todo con plantillas deterministas sobre datos reales.
 * Si una pregunta no tiene respuesta con datos, se dice eso (no se rellena).
 */

const WHY: Record<string, string> = {
  FOLLOW_UP_PENDING: 'Son personas que ya mostraron interés escribiéndote. Responderles no cuesta publicidad.',
  STALLED_LEADS: 'Ya conversaron contigo. Saber si siguen interesadas ordena tu embudo y te ahorra esfuerzo.',
  DORMANT_CUSTOMERS: 'Ya conocen tu producto. Invitarlos de nuevo suele costar menos que conseguir un cliente nuevo.',
  PRODUCT_GROWTH: 'Darle visibilidad a algo que ya se está vendiendo más es una prueba de bajo riesgo.',
  MEASUREMENT: 'Sin conversiones registradas no se puede saber qué campaña funciona; cambiar presupuestos así es decidir sin datos.',
  CPR_UP: 'Si la tendencia sigue, el mismo presupuesto trae menos resultados.',
  SPEND_NO_RESULTS: 'Es presupuesto que hoy no muestra resultados registrados, mientras otros anuncios de la cuenta sí los tienen.',
  SPEND_CONCENTRATION: 'La plataforma decide cómo repartir el dinero y no siempre favorece al anuncio que rinde mejor.',
  AD_ISSUES: 'Mientras el anuncio esté rechazado o restringido, la campaña llega a menos personas.',
  SPEND_SPIKE: 'Un cambio de gasto que nadie planeó afecta el presupuesto del mes.',
  LEAD_TRACKING: 'Sin saber de qué anuncio llegó cada chat no podemos decirte qué anuncio termina en ventas.',
  LEAD_QUALITY: 'Leads que no avanzan consumen tiempo del equipo y presupuesto.',
};

/** Tipo de dato, para que la interfaz los distinga siempre. */
export type DataKind = 'PLATFORM' | 'CALCULATED' | 'CRM' | 'DECLARED' | 'HYPOTHESIS' | 'DEMO';

const fmt = (d: Date) => d.toLocaleDateString('es-CO', { day: 'numeric', month: 'long', timeZone: 'America/Bogota' });

function howWeKnow(o: { source: string; mode: string; sources: string[]; facts: string[] }) {
  const origin = o.mode === 'DEMO'
    ? 'Con datos de demostración (simulados)'
    : o.source === 'CRM' ? 'Según tus conversaciones, embudo y pedidos en BackOffice'
      : o.sources.some((s) => /CRM/.test(s)) ? 'Cruzando lo que reporta la plataforma con tu CRM' : 'Según lo que reporta la plataforma de anuncios';
  const first = o.facts[0];
  return first ? `${origin}: ${first.charAt(0).toLowerCase()}${first.slice(1)}.` : `${origin}.`;
}

function kinds(o: { source: string; mode: string; ruleKey: string; sources: string[] }): DataKind[] {
  if (o.mode === 'DEMO') return ['DEMO'];
  const k: DataKind[] = [];
  if (o.source === 'ADS') k.push('PLATFORM', 'CALCULATED');
  if (o.source === 'CRM' || o.sources.some((s) => /CRM/.test(s))) k.push('CRM');
  if (o.ruleKey === 'PRODUCT_GROWTH') k.push('HYPOTHESIS');
  return [...new Set(k)];
}

export interface Story {
  what: string;
  howWeKnow: string;
  whyItMatters: string | null;
  next: { label: string; hint: string } | null;
  after: { text: string; kind: 'PENDING' | 'WAITING' | 'MEASURED' | 'GONE' | 'CLOSED' | 'NONE'; measuredAt?: string } | null;
  dataKinds: DataKind[];
}

export function story(o: any, now = new Date()): Story {
  const explanation = parseJson<any>(o.explanationJson, {});
  const facts: string[] = explanation.facts ?? [];
  const sources = parseJson<string[]>(o.sourcesJson, []);
  const action = parseJson<any>(o.actionJson, {});
  const result = parseJson<any>(o.resultJson, null);
  const decisions = parseJson<any[]>(o.decisionsJson, []);
  const status = o.status as OppStatus;

  let next: Story['next'] = null;
  if (status === 'NEW' || status === 'REVIEWING') {
    next = action.type === 'PAUSE' ? { label: 'Preparar la pausa', hint: 'Primero te mostramos qué va a pasar; nada cambia hasta que lo apruebes.' }
      : action.type === 'FOLLOW_UP' ? { label: 'Ver a quiénes escribir', hint: 'Armamos la lista. Tú decides a quién y qué escribir; no se envía nada automático.' }
        : action.type === 'LINK' ? { label: action.label ?? 'Ir', hint: explanation.action ?? '' }
          : { label: 'Ya lo revisé', hint: explanation.action ?? '' };
  } else if (status === 'PREPARED') {
    next = { label: 'Ya hice el seguimiento', hint: 'Cuando hayas escrito, márcalo y mediremos qué pasa después.' };
  } else if (status === 'NEEDS_APPROVAL') {
    next = { label: 'Aprobar y pausar', hint: 'Se pausa en la plataforma. Se puede reanudar después.' };
  }

  let after: Story['after'] = null;
  if (status === 'OBSERVING' && o.actedAt) {
    const when = new Date(new Date(o.actedAt).getTime() + waitDays(o.ruleKey) * 86400e3);
    after = { kind: 'WAITING', text: when > now ? `Actuaste el ${fmt(new Date(o.actedAt))}. El ${fmt(when)} medimos qué pasó después.` : 'Ya pasó el tiempo de espera: el resultado se registra en la próxima revisión (cada hora).' };
  } else if (status === 'RESULT') {
    if (result?.kind === 'CONDITION_GONE') after = { kind: 'GONE', text: 'Dejó de detectarse en los datos más recientes, sin una acción registrada desde BackOffice.' };
    else after = { kind: 'MEASURED', text: result?.note ?? 'Resultado medido.', measuredAt: o.resultAt ? new Date(o.resultAt).toISOString() : undefined };
  } else if (status === 'DISMISSED') {
    const last = [...decisions].reverse().find((d) => d.status === 'DISMISSED');
    after = { kind: 'CLOSED', text: `Descartada${last?.note && last.note !== 'Sin motivo' ? `: «${last.note}»` : ''}.` };
  } else if (status === 'SNOOZED' && o.snoozedUntil) {
    after = { kind: 'CLOSED', text: `Pospuesta. Vuelve a aparecer el ${fmt(new Date(o.snoozedUntil))}.` };
  } else if (status === 'PREPARED' || status === 'NEEDS_APPROVAL') {
    after = { kind: 'PENDING', text: 'Todavía no se hizo ningún cambio.' };
  }

  return {
    what: o.summary || o.title,
    howWeKnow: howWeKnow({ source: o.source, mode: o.mode, sources, facts }),
    whyItMatters: WHY[o.ruleKey] ?? null,
    next,
    after,
    dataKinds: kinds({ source: o.source, mode: o.mode, ruleKey: o.ruleKey, sources }),
  };
}
