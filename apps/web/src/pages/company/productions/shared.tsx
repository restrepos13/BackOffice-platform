import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Badge } from '../../../components/ui';
import { withScope } from '../shared';

/**
 * Producciones (piloto LPulpo): etiquetas y llamadas a la API real.
 * Ningún botón cambia algo solo en pantalla: todo pasa por el servidor, que
 * valida permisos, estados y empresa.
 */

export type Permission = 'view' | 'edit' | 'assign' | 'resources' | 'rates' | 'quotes' | 'approve' | 'confirm' | 'finance' | 'settings' | 'integrations';

export const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP: 'WhatsApp', INSTAGRAM: 'Instagram', FACEBOOK: 'Facebook', REFERRAL: 'Referido', EMAIL: 'Correo', WEB: 'Web', OTHER: 'Otro',
};
export const PRIORITY_LABEL: Record<string, string> = { BAJA: 'Baja', NORMAL: 'Normal', ALTA: 'Alta', URGENTE: 'Urgente' };
export const RESOURCE_KIND_LABEL: Record<string, string> = {
  MODEL: 'Modelo', LOCATION: 'Locación', PHOTOGRAPHER: 'Fotógrafo', CREATIVE_DIRECTION: 'Dirección creativa', STYLING: 'Styling',
  ASSISTANT: 'Asistente', CATERING: 'Alimentación', OTHER: 'Otro',
};
export const SERVICE_LABEL: Record<string, string> = {
  MODEL: 'Modelos', LOCATION: 'Locación', PHOTOGRAPHY: 'Fotografía', CREATIVE_DIRECTION: 'Dirección creativa', STYLING: 'Styling',
  ASSISTANT: 'Asistentes', CATERING: 'Alimentación', OTHER: 'Otros',
};
export const AVAILABILITY_LABEL: Record<string, string> = {
  NOT_CHECKED: 'Sin consultar', ASKED: 'Consultada, sin respuesta', AVAILABLE: 'Disponible (registro manual)', UNAVAILABLE: 'No disponible',
};
export const RESERVATION_LABEL: Record<string, string> = {
  NONE: 'Sin reserva', HOLD: 'Retención temporal', PENDING_CONFIRMATION: 'Pendiente de confirmación', CONFIRMED: 'Confirmada',
  RELEASED: 'Liberada', CANCELLED: 'Cancelada',
};
export const TASK_STATUS_LABEL: Record<string, string> = { TODO: 'Pendiente', IN_PROGRESS: 'En curso', BLOCKED: 'Bloqueada', DONE: 'Hecha', CANCELLED: 'Cancelada' };
export const QUOTE_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Borrador', PENDING_APPROVAL: 'Por aprobar', APPROVED: 'Aprobada', REJECTED: 'Rechazada', SUPERSEDED: 'Reemplazada',
};
export const LINE_CATEGORY_LABEL: Record<string, string> = {
  MODEL: 'Modelo', LOCATION: 'Locación', PHOTOGRAPHY: 'Fotografía', CREATIVE_DIRECTION: 'Dirección creativa', STYLING: 'Styling',
  ASSISTANT: 'Asistentes', CATERING: 'Alimentación', EXPENSE: 'Otros gastos', COMMISSION: 'Comisión o margen', OTHER: 'Otro',
};
export const UNIT_LABEL: Record<string, string> = {
  HOUR: 'Hora', HALF_DAY: 'Media jornada', FULL_DAY: 'Jornada completa', DAY: 'Día', PROJECT: 'Proyecto', UNIT: 'Unidad', OTHER: 'Otra',
};
export const VALUE_STATUS_LABEL: Record<string, string> = { PENDING: 'Pendiente', ESTIMATED: 'Estimado', CONFIRMED: 'Confirmado' };
export const BILLING_LABEL: Record<string, string> = { INCLUDED: 'En el total', CLIENT_DIRECT: 'Lo paga el cliente aparte', TO_CONFIRM: 'Por definir' };

const TERMINAL = ['CERRADA', 'PERDIDA', 'CANCELADA'];

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone = TERMINAL.includes(status)
    ? status === 'CERRADA' ? 'ok' : 'neutral'
    : status === 'COTIZACION_PENDIENTE_APROBACION' ? 'warn' : status === 'EN_PAUSA' ? 'neutral' : status === 'CONFIRMADA' || status === 'EN_PRODUCCION' ? 'ok' : 'info';
  return <Badge tone={tone}>{label}</Badge>;
}

export const fmtDate = (d?: string | null, withTime = false) =>
  d ? new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) }).format(new Date(d)) : '—';

export const fmtMoney = (n?: number | null, currency = 'COP') =>
  n === null || n === undefined ? 'Pendiente' : new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: currency === 'COP' ? 0 : 2 }).format(n);

/** Para inputs datetime-local (hora local) ↔ ISO. */
export const toLocalInput = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Error');

/** Mutación contra la API real que refresca la producción y avisa el resultado. */
export function useProdMutation<T = unknown>(q: string, fn: (body: any) => Promise<T>, ok?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['production'] });
      qc.invalidateQueries({ queryKey: ['productions'] });
      qc.invalidateQueries({ queryKey: ['productions-overview'] });
      if (ok) toast.success(ok);
    },
    onError: (e) => toast.error(errorText(e)),
  });
}

export const prodApi = {
  path: (q: string, p: string) => withScope(`/productions${p}`, q),
  get: <T,>(q: string, p: string) => api.get<T>(withScope(`/productions${p}`, q)),
  post: <T,>(q: string, p: string, body?: unknown) => api.post<T>(withScope(`/productions${p}`, q), body),
  put: <T,>(q: string, p: string, body?: unknown) => api.put<T>(withScope(`/productions${p}`, q), body),
  patch: <T,>(q: string, p: string, body?: unknown) => api.patch<T>(withScope(`/productions${p}`, q), body),
};

export interface ProductionSummary {
  id: string; code: string; title: string; clientName: string; brand: string | null; contactName: string | null; channel: string;
  status: string; statusLabel: string; priority: string; ownerId: string | null; ownerName: string | null; requestedDate: string | null;
  nextAction: string | null; nextActionDueAt: string | null; updatedAt: string; createdAt: string; isTest: boolean;
}

export interface TeamResponse {
  profiles: Array<{ key: string; label: string; permissions: Permission[] }>;
  permissionLabels: Record<Permission, string>;
  users: Array<{ id: string; name: string; email?: string; role: string; opsProfile: string | null; effectiveProfile: string | null; permissions: Permission[] }>;
  me: { profile: string; permissions: Permission[] };
}
