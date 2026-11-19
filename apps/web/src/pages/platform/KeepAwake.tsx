import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Badge } from '../../components/ui';

/**
 * Despertador del servidor (Plataforma → Publicidad → Resultados).
 * En el plan gratis de Render el API se duerme tras 15 min sin visitas y tarda
 * ~1 min en despertar; con esto encendido el servidor se llama solo cada 10 min.
 */

export type KeepAwakeMode = 'AUTO' | 'ON' | 'OFF';
export interface KeepAwakeStatus {
  mode: KeepAwakeMode;
  url: string | null;
  active: boolean;
  reason: string;
  campaigns: string[];
  lastCheckAt: string | null;
  lastPing: { at: string; ok: boolean; ms: number; error?: string } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const OPTIONS: { id: KeepAwakeMode; label: string; hint: string }[] = [
  { id: 'AUTO', label: 'Con campaña activa', hint: 'Despierto solo mientras haya anuncios entregando en Meta' },
  { id: 'ON', label: 'Siempre', hint: 'Despierto todo el tiempo' },
  { id: 'OFF', label: 'Apagado', hint: 'Se duerme tras 15 min sin visitas' },
];

export function KeepAwakeView({ data, onMode, saving }: { data: KeepAwakeStatus; onMode: (m: KeepAwakeMode) => void; saving: boolean }) {
  const ping = data.lastPing;
  return (
    <section className="mb-6 border-2 border-ink bg-paper px-4 py-3" data-testid="keep-awake">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="kicker">Servidor despierto</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm">
            {data.active ? <Badge tone="ok">Despierto</Badge> : <Badge>Puede dormirse</Badge>}
            <span className="text-ink-2">{data.reason}</span>
          </p>
        </div>
        <div role="radiogroup" aria-label="Despertador del servidor" className="flex flex-wrap border-2 border-ink">
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={data.mode === o.id}
              title={o.hint}
              disabled={saving}
              onClick={() => data.mode !== o.id && onMode(o.id)}
              className={clsx(
                'cursor-pointer whitespace-nowrap px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] transition-colors disabled:cursor-wait',
                data.mode === o.id ? 'bg-ink text-bone' : 'bg-paper text-ink hover:bg-bone',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-ink-3">
        {data.campaigns.length > 0 && <>Entregando: {data.campaigns.join(', ')} · </>}
        {ping
          ? ping.ok ? <>Último llamado {timeAgo(ping.at)} ({ping.ms} ms)</> : <span className="text-bad">Último llamado falló {timeAgo(ping.at)}: {ping.error}</span>
          : data.url ? 'Todavía sin llamados desde que arrancó el servidor.' : 'Solo actúa en Render (acá no hace falta).'}
        {' · '}Se revisa cada 10 min. Si el servidor ya estaba dormido, despierta con la primera visita.
      </p>
    </section>
  );
}

export default function KeepAwake() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['keep-awake'], queryFn: () => api.get<KeepAwakeStatus>('/platform/keep-awake'), refetchInterval: 60_000 });
  const save = useMutation({
    mutationFn: (mode: KeepAwakeMode) => api.put<KeepAwakeStatus>('/platform/keep-awake', { mode }),
    onSuccess: (next) => {
      queryClient.setQueryData(['keep-awake'], next);
      toast.success(next.mode === 'OFF' ? 'Despertador apagado' : next.mode === 'ON' ? 'El servidor queda despierto siempre' : 'Despierto mientras haya campaña activa');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo guardar'),
  });
  if (!data) return null;
  return <KeepAwakeView data={data} onMode={(m) => save.mutate(m)} saving={save.isPending} />;
}
