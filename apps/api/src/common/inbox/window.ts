import { parseJson } from '../constants';

/**
 * Qué se puede enviar en una conversación AHORA, según el canal y la línea:
 *  - WhatsApp (Twilio o Meta Cloud API): dentro de las 24 h desde el último
 *    mensaje del cliente, texto libre. Fuera, solo plantilla aprobada.
 *    BackOffice envía plantillas por Twilio (contentSid registrado por la
 *    empresa). Por Meta Cloud API aún NO: se dice explícitamente.
 *  - Instagram y Messenger: solo dentro de las 24 h. Fuera haría falta la
 *    etiqueta HUMAN_AGENT (7 días), que requiere permiso aprobado por Meta y
 *    no está implementada.
 *  - Sin línea (web, chat de prueba): no hay proveedor; nada sale.
 */

export type ComposeMode = 'FREE_TEXT' | 'TEMPLATE_ONLY' | 'BLOCKED';

export interface WindowState {
  mode: ComposeMode;
  provider: 'TWILIO' | 'META' | 'NONE';
  channel: string;
  withinWindow: boolean;
  lastInboundAt: string | null;
  expiresAt: string | null;
  reason: string | null;
  /** Plantillas registradas con contentSid (aprobación declarada por la empresa, no verificada por BackOffice) */
  templates: Array<{ key: string; name: string; body: string | null; variables: number }>;
}

const WINDOW_MS = 24 * 3600e3;

export function providerOf(integration: any): 'TWILIO' | 'META' | 'NONE' {
  if (!integration) return 'NONE';
  const cfg = parseJson<Record<string, any>>(integration.configJson, {});
  if (cfg.provider === 'TWILIO') return 'TWILIO';
  if (cfg.provider === 'META' || ['INSTAGRAM', 'MESSENGER'].includes(integration.type)) return 'META';
  return 'NONE';
}

/** Cantidad de variables {{1}}, {{2}}… de una plantilla. */
export function templateVariables(body: string | null | undefined): number {
  const nums = [...String(body ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

export function messagingWindow(input: {
  channel: string; integration: any; lastInboundAt: Date | null; waTemplatesJson?: string | null; now?: Date;
}): WindowState {
  const now = input.now ?? new Date();
  const provider = providerOf(input.integration);
  const within = !!input.lastInboundAt && now.getTime() - input.lastInboundAt.getTime() < WINDOW_MS;
  const base = {
    provider, channel: input.channel, withinWindow: within,
    lastInboundAt: input.lastInboundAt?.toISOString() ?? null,
    expiresAt: input.lastInboundAt ? new Date(input.lastInboundAt.getTime() + WINDOW_MS).toISOString() : null,
    templates: [] as WindowState['templates'],
  };
  if (provider === 'NONE') return { ...base, mode: 'BLOCKED', reason: 'Esta conversación no tiene una línea conectada: el mensaje no saldría a ningún canal.' };
  if (within) return { ...base, mode: 'FREE_TEXT', reason: null };
  if (input.channel !== 'WHATSAPP') {
    return { ...base, mode: 'BLOCKED', reason: `Pasaron más de 24 h desde el último mensaje del cliente. ${input.channel === 'INSTAGRAM' ? 'Instagram' : 'Messenger'} no permite escribir fuera de esa ventana (la etiqueta de agente humano requiere un permiso de Meta que no está configurado).` };
  }
  if (provider === 'META') {
    return { ...base, mode: 'BLOCKED', reason: 'Fuera de la ventana de 24 h solo se puede usar una plantilla aprobada, y el envío de plantillas por WhatsApp Cloud API de Meta aún no está disponible en BackOffice.' };
  }
  const templates = parseJson<any[]>(input.waTemplatesJson, [])
    .filter((t) => t?.key && t?.contentSid)
    .map((t) => ({ key: String(t.key), name: String(t.name ?? t.key), body: t.body ? String(t.body) : null, variables: templateVariables(t.body) }));
  return {
    ...base, templates, mode: templates.length ? 'TEMPLATE_ONLY' : 'BLOCKED',
    reason: templates.length
      ? 'Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite una plantilla aprobada.'
      : 'Pasaron más de 24 h y la empresa no tiene plantillas registradas (con su contentSid de Twilio). No se puede escribir hasta que el cliente vuelva a escribir.',
  };
}
