import { useEffect, useRef, useState } from 'react';
import { getToken } from './api';

export interface LiveEvent {
  type: 'message.new' | 'message.status' | 'conversation.updated' | 'note.new' | 'typing' | string;
  conversationId?: string;
  direction?: 'IN' | 'OUT';
  messageId?: string;
  deliveryStatus?: string;
  botPaused?: boolean;
  needsAttention?: boolean;
  attendedByName?: string | null;
  assignedToId?: string | null;
  userName?: string;
  userId?: string;
  orderId?: string;
  date?: string;
  at: number;
}

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'off';

/**
 * Suscripción SSE a los eventos en vivo de la organización.
 * EventSource no permite headers → el JWT viaja por query (el API lo
 * verifica con la misma firma). Reconecta solo (comportamiento nativo); al
 * volver, `onReconnect` permite recargar lo que pudo perderse mientras tanto
 * (SSE no reenvía eventos pasados). Se cierra al desmontar.
 */
export function useLiveEvents(
  companyId: string | null | undefined,
  onEvent: (event: LiveEvent) => void,
  enabled = true,
  onReconnect?: () => void,
): LiveStatus {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const reconnect = useRef(onReconnect);
  reconnect.current = onReconnect;
  const [status, setStatus] = useState<LiveStatus>('off');

  useEffect(() => {
    const token = getToken();
    if (!enabled || !token || typeof EventSource === 'undefined') {
      setStatus('off');
      return;
    }
    const qs = new URLSearchParams({ token });
    if (companyId) qs.set('companyId', companyId);
    const source = new EventSource(`/api/events/stream?${qs.toString()}`);
    let dropped = false;
    setStatus('connecting');
    source.onopen = () => {
      setStatus('live');
      if (dropped) reconnect.current?.();
      dropped = false;
    };
    source.onerror = () => {
      dropped = true;
      setStatus(source.readyState === EventSource.CLOSED ? 'off' : 'reconnecting');
    };
    source.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data) as LiveEvent);
      } catch {
        /* evento malformado: se ignora */
      }
    };
    return () => source.close();
  }, [companyId, enabled]);
  return status;
}
