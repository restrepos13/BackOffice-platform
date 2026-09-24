import { useEffect, useRef } from 'react';
import { getToken } from './api';

export interface LiveEvent {
  type: 'message.new' | 'message.status' | 'conversation.updated' | 'typing' | string;
  conversationId?: string;
  direction?: 'IN' | 'OUT';
  messageId?: string;
  deliveryStatus?: string;
  botPaused?: boolean;
  needsAttention?: boolean;
  attendedByName?: string | null;
  userName?: string;
  userId?: string;
  orderId?: string;
  date?: string;
  at: number;
}

/**
 * Suscripción SSE a los eventos en vivo de la organización.
 * EventSource no permite headers → el JWT viaja por query (el API lo
 * verifica con la misma firma). Reconecta solo (comportamiento nativo).
 */
export function useLiveEvents(
  companyId: string | null | undefined,
  onEvent: (event: LiveEvent) => void,
  enabled = true,
) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const token = getToken();
    if (!enabled || !token) return;
    const qs = new URLSearchParams({ token });
    if (companyId) qs.set('companyId', companyId);
    const source = new EventSource(`/api/events/stream?${qs.toString()}`);
    source.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data) as LiveEvent);
      } catch {
        /* evento malformado: se ignora */
      }
    };
    return () => source.close();
  }, [companyId, enabled]);
}
