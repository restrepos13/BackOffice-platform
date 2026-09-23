/**
 * Reglas de agenda puras (sin base de datos): día permitido, horario,
 * anticipación mínima y festivos. Las reglas con estado (corte de pedidos y
 * capacidad por franja) viven en OrdersService.validateAgenda.
 */
export function validateDelivery(
  orderConfig: Record<string, any>,
  deliveryAt: Date,
  now = new Date(),
): { ok: boolean; reason?: string } {
  const schedule = orderConfig?.schedule ?? {};
  const days: number[] = Array.isArray(schedule.days) ? schedule.days : [];
  if (days.length && !days.includes(deliveryAt.getDay())) {
    return { ok: false, reason: 'La fecha cae en un día sin entregas' };
  }
  const hhmm = (value: string) => {
    const [h, m] = String(value).split(':').map(Number);
    return h * 60 + (m || 0);
  };
  if (schedule.open && schedule.close) {
    const minutes = deliveryAt.getHours() * 60 + deliveryAt.getMinutes();
    if (minutes < hhmm(schedule.open) || minutes > hhmm(schedule.close)) {
      return { ok: false, reason: `Fuera del horario de entrega (${schedule.open}–${schedule.close})` };
    }
  }
  const minLeadHours = Number(orderConfig?.minLeadHours ?? 0);
  if (minLeadHours > 0) {
    const leadMs = deliveryAt.getTime() - now.getTime();
    if (leadMs < minLeadHours * 3600 * 1000) {
      return { ok: false, reason: `Requiere al menos ${minLeadHours} h de anticipación` };
    }
  }
  const holidays: string[] = Array.isArray(orderConfig?.holidays) ? orderConfig.holidays : [];
  const dayKey = deliveryAt.toISOString().slice(0, 10);
  if (holidays.includes(dayKey)) {
    return { ok: false, reason: 'La fecha es un día no laborable' };
  }
  return { ok: true };
}
