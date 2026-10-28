/**
 * Eventos de dominio del núcleo (en proceso).
 *
 * Quien escribe un cambio real (contacto creado, etapa cambiada, estado de
 * pedido) llama a `publishDomainEvent` DESPUÉS de guardarlo. El motor de
 * automatizaciones se registra como manejador y, antes de que la llamada
 * vuelva, deja PERSISTIDAS las ejecuciones que correspondan (WorkflowRun):
 * desde ahí la cola y el barrido garantizan que se ejecuten.
 *
 * Publicar nunca rompe el flujo que lo origina: cualquier error se registra y
 * se traga. Si el proceso muere entre el guardado y la publicación el evento
 * se pierde (no hay outbox); está documentado en docs/automatizaciones.
 *
 * `causedBy` marca los cambios hechos por una automatización: el motor lo usa
 * para cortar bucles (profundidad y autoinvocación).
 */
import { Logger } from '@nestjs/common';

export type DomainEventType = 'contact.created' | 'contact.stage_changed' | 'order.status_changed';

export interface CausedBy {
  runId: string;
  automationId: string;
  depth: number;
}

export interface DomainEvent {
  type: DomainEventType;
  companyId: string;
  /** Registro principal (contacto o pedido) */
  recordId: string;
  /** Identificador determinista de ESTA ocurrencia (dos entregas del mismo hecho → mismo id) */
  eventId: string;
  data?: Record<string, string | number | null>;
  causedBy?: CausedBy | null;
}

type Handler = (event: DomainEvent) => Promise<unknown>;

const logger = new Logger('DomainEvents');
let handler: Handler | null = null;

export function setDomainEventHandler(h: Handler | null) {
  handler = h;
}

export async function publishDomainEvent(event: DomainEvent): Promise<void> {
  if (!handler || !event.companyId || !event.recordId) return;
  try {
    await handler(event);
  } catch (e: any) {
    logger.error(`${event.type} ${event.recordId}: ${String(e?.message ?? e).slice(0, 200)}`);
  }
}

const minuteBucket = (d = new Date()) => Math.floor(d.getTime() / (10 * 60_000));

/** Contacto creado: un contacto solo se crea una vez. */
export function contactCreated(companyId: string, contactId: string, causedBy?: CausedBy | null) {
  return publishDomainEvent({ type: 'contact.created', companyId, recordId: contactId, eventId: `contact.created:${contactId}`, causedBy });
}

/**
 * Cambio de etapa. No hay historial de etapas: la ocurrencia se identifica por
 * contacto + transición + ventana de 10 minutos (los reintentos y webhooks
 * repetidos caen en la misma ventana).
 */
export function contactStageChanged(companyId: string, contactId: string, fromStage: string | null | undefined, toStage: string, causedBy?: CausedBy | null) {
  if (!toStage || fromStage === toStage) return Promise.resolve();
  return publishDomainEvent({
    type: 'contact.stage_changed', companyId, recordId: contactId,
    eventId: `contact.stage:${contactId}:${fromStage ?? ''}>${toStage}:${minuteBucket()}`,
    data: { fromStage: fromStage ?? null, toStage }, causedBy,
  });
}

/**
 * Estado de pedido: se publica con el registro de historial, que es único por
 * transición (su id es el id del evento).
 */
export function orderHistory(prisma: any) {
  return {
    create: async (args: { data: Record<string, any> }) => {
      const row = await prisma.orderStatusHistory.create(args);
      await publishDomainEvent({
        type: 'order.status_changed', companyId: row.companyId, recordId: row.orderId, eventId: `order.status:${row.id}`,
        data: { fromStatus: row.fromStatus ?? null, toStatus: row.toStatus },
      });
      return row;
    },
  };
}
