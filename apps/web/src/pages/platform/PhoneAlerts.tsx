import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Input } from '../../components/ui';

/**
 * Plataforma → Registros → Avisos a tu celular (Telegram).
 * Tres pasos: token del bot, escribirle al bot y vincular, elegir avisos.
 */

export type AlertEvent = 'SIGNUP_CONTACT' | 'SIGNUP_DONE' | 'SIGNUP_ABANDONED' | 'CLIENT_LOGIN' | 'ADS_CONNECTED';
export interface AlertsStatus {
  configured: boolean;
  botName: string | null;
  botLink: string | null;
  linked: boolean;
  chatName: string | null;
  events: Record<AlertEvent, boolean>;
  labels: Record<AlertEvent, string>;
  lastSent: { at: string; event: AlertEvent; ok: boolean; error?: string } | null;
}

export function PhoneAlertsView({ data, onToken, onLink, onEvents, onTest, onDisconnect, busy }: {
  data: AlertsStatus;
  onToken: (token: string) => void;
  onLink: () => void;
  onEvents: (events: Partial<Record<AlertEvent, boolean>>) => void;
  onTest: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const [token, setToken] = useState('');
  const [open, setOpen] = useState(!data.linked);
  return (
    <Card kicker="Avisos a tu celular" title={data.linked ? `Llegan a Telegram · ${data.chatName ?? ''}` : 'Recibe cada registro en tu celular'} className="mb-6"
      actions={data.linked ? <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Cerrar' : 'Configurar'}</Button> : undefined}>
      <div data-testid="phone-alerts">
        {data.linked && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="ok">Activo</Badge>
            <span className="text-ink-2">
              {data.lastSent ? (data.lastSent.ok ? `Último aviso ${timeAgo(data.lastSent.at)}` : `El último aviso falló: ${data.lastSent.error ?? ''}`) : 'Todavía sin avisos desde que arrancó el servidor.'}
            </span>
          </div>
        )}

        {(open || !data.linked) && (
          <ol className="mt-3 space-y-4 text-sm">
            <li>
              <p className="font-semibold">1. Crea tu bot de avisos {data.configured && <Badge tone="ok">Listo{data.botName ? ` · @${data.botName}` : ''}</Badge>}</p>
              <p className="mt-0.5 text-ink-2">En Telegram busca <b>@BotFather</b>, escríbele <code className="font-mono">/newbot</code>, ponle un nombre (por ejemplo «Avisos BackOffice») y copia el token que te da.</p>
              <div className="mt-2 flex max-w-xl flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1"><Field label="Token del bot" hint="Se guarda cifrado"><Input type="password" autoComplete="off" placeholder="123456789:AA…" value={token} onChange={(e) => setToken(e.target.value)} /></Field></div>
                <Button size="sm" disabled={busy || token.trim().length < 20} onClick={() => { onToken(token.trim()); setToken(''); }}>Guardar</Button>
              </div>
            </li>
            <li className={data.configured ? '' : 'opacity-50'}>
              <p className="font-semibold">2. Escríbele a tu bot y vincúlalo {data.linked && <Badge tone="ok">Vinculado</Badge>}</p>
              <p className="mt-0.5 text-ink-2">
                {data.botLink ? <>Abre <a className="font-semibold underline" href={data.botLink} target="_blank" rel="noreferrer">{data.botLink.replace('https://', '')}</a></> : 'Abre tu bot'} desde el celular, toca <b>Iniciar</b> y después toca «Vincular».
              </p>
              <Button className="mt-2" size="sm" disabled={busy || !data.configured} onClick={onLink}>Vincular</Button>
            </li>
            <li className={data.linked ? '' : 'opacity-50'}>
              <p className="font-semibold">3. Elige qué te avisa</p>
              <ul className="mt-2 space-y-1.5">
                {(Object.keys(data.labels) as AlertEvent[]).map((k) => (
                  <li key={k}>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" className="h-4 w-4 accent-[#1a1a1a]" checked={data.events[k]} disabled={busy || !data.linked} onChange={(e) => onEvents({ [k]: e.target.checked })} />
                      {data.labels[k]}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy || !data.linked} onClick={onTest}>Enviarme una prueba</Button>
                {data.configured && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (confirm('¿Dejar de recibir avisos en Telegram?')) onDisconnect(); }}>Desconectar</Button>}
              </div>
            </li>
          </ol>
        )}
        <p className="mt-4 text-[11px] text-ink-3">Los avisos traen el nombre y el WhatsApp de quien se registra, con un botón para escribirle. El correo de cada registro sigue llegando igual.</p>
      </div>
    </Card>
  );
}

export default function PhoneAlerts() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['team-alerts'], queryFn: () => api.get<AlertsStatus>('/platform/alerts') });
  const done = (msg: string) => (next: AlertsStatus) => { queryClient.setQueryData(['team-alerts'], next); toast.success(msg); };
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : 'No se pudo');
  const token = useMutation({ mutationFn: (t: string) => api.put<AlertsStatus>('/platform/alerts/telegram', { token: t }), onSuccess: done('Bot guardado. Ahora escríbele y toca «Vincular».'), onError: fail });
  const link = useMutation({ mutationFn: () => api.post<AlertsStatus>('/platform/alerts/telegram/link'), onSuccess: done('Vinculado: te llegó un mensaje de confirmación.'), onError: fail });
  const events = useMutation({ mutationFn: (e: Partial<Record<AlertEvent, boolean>>) => api.put<AlertsStatus>('/platform/alerts/events', { events: e }), onSuccess: done('Avisos actualizados'), onError: fail });
  const test = useMutation({ mutationFn: () => api.post<AlertsStatus>('/platform/alerts/test'), onSuccess: done('Prueba enviada: revisa Telegram'), onError: fail });
  const off = useMutation({ mutationFn: () => api.delete<AlertsStatus>('/platform/alerts/telegram'), onSuccess: done('Avisos desconectados'), onError: fail });
  if (!data) return null;
  const busy = token.isPending || link.isPending || events.isPending || test.isPending || off.isPending;
  return <PhoneAlertsView data={data} busy={busy} onToken={(t) => token.mutate(t)} onLink={() => link.mutate()} onEvents={(e) => events.mutate(e)} onTest={() => test.mutate()} onDisconnect={() => off.mutate()} />;
}
