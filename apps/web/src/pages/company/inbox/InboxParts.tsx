import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Check, CheckCheck, Clock, FlaskConical, RotateCcw, ShieldCheck, StickyNote, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { fmtDateTime } from '../../../lib/format';
import type { ChannelInfo, Message, MessagingWindow } from '../../../lib/types';
import { Badge, Button, Field, Input, Modal, Select } from '../../../components/ui';
import { withScope } from '../shared';

/**
 * Piezas de la bandeja (fase 4): estado de entrega con evidencia del
 * proveedor, estado verificable de los canales, responsable, ventana de
 * 24 h / plantillas y notas internas. Nada de cifras decorativas: todo sale
 * del API con el alcance de la empresa.
 */

const STATUS_TEXT: Record<string, string> = {
  QUEUED: 'En cola', SENDING: 'Enviando…', SENT: 'Enviado (aceptado por el proveedor)', DELIVERED: 'Entregado', READ: 'Leído',
  FAILED: 'No se envió', UNCERTAIN: 'Sin confirmar: puede haber salido o no', SIMULATED: 'Modo prueba: no salió', CANCELLED: 'Retirado (lo tomó una persona)',
};

/** Ticks y estados de un mensaje saliente. Solo lo que el proveedor confirmó. */
export function DeliveryState({ message, onResend, busy }: { message: Message; onResend?: (m: Message) => void; busy?: boolean }) {
  const s = message.deliveryStatus;
  if (!s) return null;
  const icon = s === 'FAILED' ? <X size={12} className="inline text-bad" />
    : s === 'UNCERTAIN' ? <AlertTriangle size={12} className="inline text-warn" />
      : s === 'SIMULATED' ? <FlaskConical size={12} className="inline" />
        : s === 'CANCELLED' ? <X size={12} className="inline opacity-60" />
          : s === 'QUEUED' || s === 'SENDING' ? <Clock size={12} className="inline" />
            : s === 'SENT' ? <Check size={12} className="inline" />
              : <CheckCheck size={12} className={clsx('inline', s === 'READ' && 'text-info')} />;
  return (
    <span className="inline-flex items-center gap-1" title={message.deliveryError ? `${STATUS_TEXT[s]} · ${message.deliveryError}` : STATUS_TEXT[s]} aria-label={STATUS_TEXT[s]}>
      {icon}
      {['FAILED', 'UNCERTAIN', 'SIMULATED', 'CANCELLED'].includes(s) && <span className="normal-case tracking-normal">{STATUS_TEXT[s]}</span>}
      {onResend && ['FAILED', 'UNCERTAIN'].includes(s) && !message.templateKey && (
        <button type="button" disabled={busy} className="ml-1 inline-flex cursor-pointer items-center gap-0.5 underline underline-offset-2 disabled:opacity-40" onClick={() => onResend(message)}>
          <RotateCcw size={10} /> Reenviar
        </button>
      )}
    </span>
  );
}

const CHANNEL_TONE: Record<ChannelInfo['state'], 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  VERIFIED: 'ok', PENDING_VERIFICATION: 'warn', SANDBOX: 'info', NOT_CONFIGURED: 'neutral', AUTH_ERROR: 'bad', ERROR: 'bad',
};

/** Canales de la empresa con su estado real; verificar es de solo lectura (no envía nada). */
export function ChannelStrip({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['inbox-channels', q], queryFn: () => api.get<ChannelInfo[]>(withScope('/conversations/channels', q)) });
  const verify = useMutation({
    mutationFn: (id: string) => api.post<ChannelInfo>(`/conversations/channels/${id}/verify`),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['inbox-channels'] }); if (r.state === 'VERIFIED') toast.success('Canal verificado'); else toast.error(`${r.label}${r.detail ? `: ${r.detail}` : ''}`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (!data) return null;
  if (!data.length) return <p className="mb-3 border-2 border-warn bg-paper px-3 py-2 text-sm">No hay canales configurados (WhatsApp, Instagram o Messenger). Las conversaciones de prueba siguen visibles, pero ningún mensaje saldría a un cliente.</p>;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-xs" data-testid="channel-strip">
      <span className="kicker">Canales</span>
      {data.map((c) => (
        <span key={c.id} className="inline-flex items-center gap-1.5 border-2 border-line bg-paper px-2 py-1" title={c.detail ?? undefined}>
          <b>{c.name}</b>
          <Badge tone={CHANNEL_TONE[c.state]}>{c.label}</Badge>
          {canWrite && ['PENDING_VERIFICATION', 'VERIFIED', 'AUTH_ERROR', 'ERROR'].includes(c.state) && (
            <button type="button" className="inline-flex cursor-pointer items-center gap-0.5 text-ink-2 underline-offset-2 hover:underline disabled:opacity-40" disabled={verify.isPending} onClick={() => verify.mutate(c.id)}>
              <ShieldCheck size={11} /> Verificar
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

/** Responsable de la conversación (solo miembros activos de la empresa con rol para atender). */
export function AssigneeSelect({ conversationId, assignedToId, q, canWrite }: { conversationId: string; assignedToId: string | null | undefined; q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data: people } = useQuery({ queryKey: ['inbox-assignees', q], queryFn: () => api.get<Array<{ id: string; name: string }>>(withScope('/conversations/assignees', q)) });
  const assign = useMutation({
    mutationFn: (assigneeId: string | null) => api.patch<{ assignedToName: string | null }>(`/conversations/${conversationId}/assign`, { assigneeId }),
    onSuccess: (r) => {
      toast.success(r.assignedToName ? `Asignada a ${r.assignedToName}` : 'Sin responsable');
      queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Select
      aria-label="Responsable"
      className="!w-44 !py-1 text-xs"
      disabled={!canWrite || assign.isPending}
      value={assignedToId ?? ''}
      onChange={(e) => assign.mutate(e.target.value || null)}
    >
      <option value="">Sin responsable</option>
      {people?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      {assignedToId && people && !people.some((p) => p.id === assignedToId) && <option value={assignedToId}>Responsable anterior (ya no disponible)</option>}
    </Select>
  );
}

/** Aviso de lo que permite el canal ahora mismo (sin ocultar restricciones del proveedor). */
export function WindowNotice({ win }: { win: MessagingWindow }) {
  if (win.mode === 'FREE_TEXT') {
    return win.expiresAt ? <p className="px-3 pt-2 text-[11px] text-ink-3" data-testid="window-notice">Ventana de atención abierta hasta {fmtDateTime(win.expiresAt)}{win.channelState?.state === 'SANDBOX' ? ' · línea en modo prueba: no sale nada real' : ''}</p> : null;
  }
  return (
    <p data-testid="window-notice" className={clsx('mx-3 mt-2 border-l-4 px-3 py-2 text-xs', win.mode === 'BLOCKED' ? 'border-bad bg-bad-soft text-bad' : 'border-warn bg-warn-soft')}>
      {win.mode === 'TEMPLATE_ONLY' ? 'Requiere plantilla aprobada. ' : 'No se puede escribir ahora. '}{win.reason}
    </p>
  );
}

/** Envío de una plantilla registrada (fuera de la ventana de 24 h por WhatsApp/Twilio). */
export function TemplateModal({ open, onClose, conversationId, win, onSent }: { open: boolean; onClose: () => void; conversationId: string; win: MessagingWindow; onSent: () => void }) {
  const [key, setKey] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const t = win.templates.find((x) => x.key === key);
  const preview = t?.body ? t.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n) => vars[Number(n) - 1] || `{{${n}}}`) : null;
  const send = useMutation({
    mutationFn: () => api.post(`/conversations/${conversationId}/messages`, { content: '', template: { key, variables: vars } }),
    onSuccess: () => { toast.success('Plantilla en cola de envío'); setKey(''); setVars([]); onSent(); onClose(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Fuera de la ventana de 24 h" title="Enviar plantilla">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-ink-3">Plantillas registradas por la empresa con su identificador de Twilio. BackOffice no consulta su aprobación a Meta: si no está aprobada, el proveedor la rechazará y lo verás en el mensaje.</p>
        <Field label="Plantilla">
          <Select value={key} onChange={(e) => { setKey(e.target.value); setVars([]); }}>
            <option value="">Elige una…</option>
            {win.templates.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
          </Select>
        </Field>
        {t && Array.from({ length: t.variables }, (_, i) => (
          <Field key={i} label={`Variable {{${i + 1}}}`}>
            <Input value={vars[i] ?? ''} maxLength={300} onChange={(e) => setVars((v) => { const n = [...v]; n[i] = e.target.value; return n; })} />
          </Field>
        ))}
        {preview && <p className="whitespace-pre-wrap border-2 border-line bg-bone px-3 py-2">{preview}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!t || send.isPending || Array.from({ length: t.variables }, (_, i) => vars[i]?.trim()).some((v) => !v)} onClick={() => send.mutate()}>Enviar plantilla</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Nota interna en el historial: visualmente distinta y marcada como privada. */
export function NoteBubble({ authorName, body, createdAt }: { authorName: string; body: string; createdAt: string }) {
  return (
    <div className="flex justify-center" data-testid="note">
      <div className="w-full max-w-[85%] border-2 border-dashed border-warn bg-warn-soft px-3 py-2 text-sm">
        <p className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-ink-2"><StickyNote size={11} /> Nota interna · no la ve el cliente</p>
        <p className="whitespace-pre-wrap">{body}</p>
        <p className="mt-1 text-right text-[10px] uppercase tracking-wider text-ink-3">{authorName} · {fmtDateTime(createdAt)}</p>
      </div>
    </div>
  );
}
