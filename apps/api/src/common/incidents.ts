/**
 * Incidentes 24/7 (mantenimiento de "Todo incluido"): cuando el bot no puede
 * responder, un mensaje no sale o falla un trabajo, se registra aquí. Se agrupa
 * por empresa y tipo (un incidente abierto suma repeticiones) para no inundar
 * al equipo, y el vigilante (incidents.module) avisa de inmediato.
 * Nunca rompe el flujo que lo reporta.
 */

export type IncidentKind = 'AI_DOWN' | 'WA_SEND_FAILED' | 'INBOUND_FAILED';

export const INCIDENT_LABELS: Record<IncidentKind, string> = {
  AI_DOWN: 'El asistente no pudo responder (IA no disponible)',
  WA_SEND_FAILED: 'Un mensaje de WhatsApp no se pudo enviar',
  INBOUND_FAILED: 'Falló el procesamiento de un mensaje que llegó',
};

/** Sin repetirse en este tiempo, el incidente se da por resuelto. */
export const INCIDENT_QUIET_MS = 30 * 60e3;

export async function reportIncident(prisma: any, input: { companyId?: string | null; kind: IncidentKind; detail: string }) {
  try {
    const since = new Date(Date.now() - INCIDENT_QUIET_MS);
    const open = await prisma.incident.findFirst({
      where: {
        companyId: input.companyId ?? null,
        kind: input.kind,
        lastAt: { gte: since },
        OR: [{ resolvedAt: null }, { resolvedAt: { isSet: false } }],
      },
      orderBy: { lastAt: 'desc' },
    });
    if (open) {
      await prisma.incident.update({
        where: { id: open.id },
        data: { count: (open.count ?? 1) + 1, lastAt: new Date(), detail: String(input.detail).slice(0, 400) },
      });
      return;
    }
    await prisma.incident.create({
      data: { companyId: input.companyId ?? null, kind: input.kind, detail: String(input.detail).slice(0, 400), count: 1, firstAt: new Date(), lastAt: new Date() },
    });
  } catch {
    /* el registro de incidentes jamás tumba la atención */
  }
}
