import { OppDraft } from './store';

/**
 * Oportunidades del CRM con reglas deterministas sobre datos reales:
 * conversaciones, etapas del embudo, pedidos y clientes inactivos.
 * Redacción honesta: nunca se habla de "ventas perdidas" ni de dinero
 * recuperable; se describen hechos y una acción posible.
 */

const DAY = 86400e3;
const SOURCE_CRM = 'CRM de BackOffice (conversaciones, embudo y pedidos)';

/** Semana ISO aproximada (para no duplicar la misma oportunidad dentro de la semana). */
export function weekKey(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

export interface ConvLike { id: string; contactId: string; status: string; lastMessageAt: Date; lastDirection: 'IN' | 'OUT' | null }
export interface ContactLite { id: string; name: string; stage: string; createdAt: Date; lastActivityAt: Date; hasConversation: boolean }
export interface DormantLite { contactId: string; dormantDays: number; basis: 'compra' | 'conversación' }
export interface ItemLite { productName: string; quantity: number; createdAt: Date }

export interface CrmInput {
  now: Date;
  conversations: ConvLike[];
  contacts: ContactLite[];
  firstStage: string;
  closedStages: Set<string>;
  dormant: DormantLite[];
  items: ItemLite[];
}

export function detectCrm(i: CrmInput): OppDraft[] {
  const out: OppDraft[] = [];
  const wk = weekKey(i.now);
  const byContact = new Map(i.contacts.map((c) => [c.id, c]));

  // A. Conversaciones que esperan respuesta (el último mensaje es del cliente, hace >24 h y <30 días)
  const waiting = i.conversations.filter((c) => {
    const age = i.now.getTime() - c.lastMessageAt.getTime();
    const contact = byContact.get(c.contactId);
    return c.lastDirection === 'IN' && !['CLOSED', 'RESOLVED', 'ARCHIVED'].includes(c.status) && age > DAY && age < 30 * DAY && !(contact && i.closedStages.has(contact.stage));
  });
  if (waiting.length >= 3) {
    const oldest = Math.max(...waiting.map((c) => Math.floor((i.now.getTime() - c.lastMessageAt.getTime()) / DAY)));
    out.push({
      ruleKey: 'FOLLOW_UP_PENDING', dedupeKey: `FOLLOW_UP_PENDING:${wk}`, severity: waiting.length >= 10 ? 'HIGH' : 'MEDIUM',
      title: `${waiting.length} conversaciones esperan respuesta hace más de un día`,
      summary: 'Hay clientes que escribieron y todavía no tienen respuesta ni un resultado registrado. Revisarlas ayuda a saber cuáles necesitan seguimiento.',
      explanation: {
        facts: [`${waiting.length} conversaciones donde el último mensaje es del cliente`, `La más antigua lleva ${oldest} días sin respuesta`, 'Solo se cuentan conversaciones de los últimos 30 días que no están cerradas'],
        interpretation: 'Pueden ser consultas sin atender o conversaciones que ya se resolvieron por otro medio y no se registraron.',
        assumptions: ['Las respuestas se dan por WhatsApp dentro de BackOffice.'],
        missing: ['Si alguna se atendió por teléfono o en persona'],
        action: 'Revisar la lista y responder o cerrar las que ya no aplican.',
        expected: 'Ningún cliente sin respuesta y el embudo al día.',
        uncertainty: 'Baja para el hecho (los mensajes están en el CRM); no sabemos cuántas eran ventas.',
      },
      evidence: { conversations: waiting.length, oldestDays: oldest }, sources: [SOURCE_CRM], period: { lastDays: 30 },
      evidenceLevel: waiting.length >= 5 ? 'SUFFICIENT' : 'INITIAL', impact: null,
      action: { type: 'FOLLOW_UP', label: 'Preparar lista de seguimiento', risk: 'LOW', reversible: true, href: '/app/inbox', contactIds: waiting.map((c) => c.contactId).slice(0, 200) },
    });
  }

  // B. Leads que no avanzan: en la primera etapa, 7 a 60 días, sin actividad hace 7 días
  const stalled = i.contacts.filter((c) => {
    const age = i.now.getTime() - c.createdAt.getTime();
    return c.stage === i.firstStage && c.hasConversation && age >= 7 * DAY && age <= 60 * DAY && i.now.getTime() - c.lastActivityAt.getTime() >= 7 * DAY;
  });
  if (stalled.length >= 5) {
    out.push({
      ruleKey: 'STALLED_LEADS', dedupeKey: `STALLED_LEADS:${wk}`, severity: 'MEDIUM',
      title: `${stalled.length} contactos siguen en la primera etapa sin movimiento`,
      summary: 'Estas personas conversaron con tu negocio pero no avanzaron en el embudo ni tienen actividad reciente. Un seguimiento corto puede aclarar si siguen interesadas.',
      explanation: {
        facts: [`${stalled.length} contactos en «${i.firstStage.toLowerCase()}» con 7 a 60 días de antigüedad`, 'Ninguno tiene actividad en los últimos 7 días', 'Todos tienen al menos una conversación'],
        interpretation: 'Pueden ser curiosos que no iban a comprar, o interesados a los que nadie volvió a escribir.',
        assumptions: ['El equipo mueve a los contactos de etapa cuando avanzan.'],
        missing: ['Motivo por el que no avanzaron'],
        action: 'Revisar la lista y escribir a quienes tenga sentido (sin envíos masivos automáticos).',
        expected: 'Saber quién sigue interesado y depurar el embudo.',
        uncertainty: 'Media: depende de que el embudo esté actualizado.',
      },
      evidence: { contacts: stalled.length }, sources: [SOURCE_CRM], period: { from: 60, to: 7, unit: 'días' },
      evidenceLevel: stalled.length >= 15 ? 'SUFFICIENT' : 'INITIAL', impact: null,
      action: { type: 'FOLLOW_UP', label: 'Preparar lista de seguimiento', risk: 'LOW', reversible: true, href: '/app/contacts', contactIds: stalled.map((c) => c.id).slice(0, 200) },
    });
  }

  // E. Clientes que compraron y dejaron de comprar (solo los que tienen compras)
  const buyers = i.dormant.filter((d) => d.basis === 'compra');
  if (buyers.length >= 3) {
    out.push({
      ruleKey: 'DORMANT_CUSTOMERS', dedupeKey: `DORMANT_CUSTOMERS:${wk}`, severity: 'LOW',
      title: `${buyers.length} clientes no han vuelto a comprar`,
      summary: 'Son personas que ya te compraron y llevan tiempo sin volver. Puedes invitarlos de nuevo desde Reactivación, que respeta los tiempos entre mensajes y las bajas.',
      explanation: {
        facts: [`${buyers.length} clientes con al menos una compra y sin compras recientes`, `Inactividad mínima: ${Math.min(...buyers.map((b) => b.dormantDays))} días`],
        interpretation: 'Algunos pueden volver con un recordatorio oportuno; otros quizá ya no necesitan el producto.',
        assumptions: ['El tiempo normal entre compras de tu negocio es menor que el que llevan inactivos.'],
        missing: ['Frecuencia de compra habitual de cada cliente'],
        action: 'Revisar la lista en Reactivación y decidir el mensaje (no se envía nada automáticamente desde aquí).',
        expected: 'Que una parte vuelva a comprar.',
        uncertainty: 'Media.',
      },
      evidence: { customers: buyers.length }, sources: [SOURCE_CRM], period: {}, evidenceLevel: buyers.length >= 10 ? 'SUFFICIENT' : 'INITIAL', impact: null,
      action: { type: 'LINK', label: 'Ver en Reactivación', risk: 'LOW', reversible: true, href: '/app/reactivacion', contactIds: buyers.map((b) => b.contactId).slice(0, 200) },
    });
  }

  // F. Producto que crece (hipótesis para investigar, no promesa)
  const cur = new Map<string, number>();
  const prev = new Map<string, number>();
  for (const it of i.items) {
    const age = i.now.getTime() - it.createdAt.getTime();
    const m = age <= 30 * DAY ? cur : age <= 60 * DAY ? prev : null;
    if (m) m.set(it.productName, (m.get(it.productName) ?? 0) + (Number(it.quantity) || 0));
  }
  const growing = [...cur.entries()]
    .map(([name, units]) => ({ name, units, before: prev.get(name) ?? 0 }))
    .filter((p) => p.units >= 10 && p.before >= 5 && p.units >= p.before * 1.4)
    .sort((a, b) => b.units / b.before - a.units / a.before)[0];
  if (growing) {
    const pct = Math.round(((growing.units - growing.before) / growing.before) * 100);
    out.push({
      ruleKey: 'PRODUCT_GROWTH', dedupeKey: `PRODUCT_GROWTH:${growing.name.toLowerCase()}:${wk}`, entityName: growing.name, severity: 'LOW',
      title: `«${growing.name}» se vendió un ${pct} % más que el mes anterior`,
      summary: 'Es un producto que está ganando tracción en tus ventas confirmadas. Podría valer la pena darle más visibilidad; es una hipótesis para probar, no una garantía.',
      explanation: {
        facts: [`Últimos 30 días: ${growing.units} unidades`, `30 días anteriores: ${growing.before} unidades`, 'Solo pedidos que no están en borrador ni cancelados'],
        interpretation: 'La demanda de este producto creció. No sabemos todavía por qué (temporada, precio, recomendación…).',
        assumptions: ['El crecimiento se mantiene en las próximas semanas.'],
        missing: ['La causa del crecimiento', 'Margen del producto'],
        action: 'Probar una publicación o un anuncio centrado en este producto y medir el resultado.',
        expected: 'Saber si darle visibilidad aumenta sus ventas.',
        uncertainty: 'Media: una sola comparación mensual.',
      },
      evidence: { units: growing.units, before: growing.before, growthPct: pct }, sources: [SOURCE_CRM], period: { lastDays: 30, previousDays: 30 },
      evidenceLevel: growing.units >= 30 ? 'SUFFICIENT' : 'INITIAL', impact: null,
      action: { type: 'LINK', label: 'Crear una publicación', risk: 'LOW', reversible: true, href: '/app/creative?tab=disenos' },
    });
  }
  return out;
}
