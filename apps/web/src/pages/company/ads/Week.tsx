import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { Button, Card, EmptyState, Loading } from '../../../components/ui';
import { withScope } from '../shared';

/** Programación semanal: qué anuncios corren cada día (lunes a domingo). */

interface WeekItem { key: string; name: string; campaign: string | null; status: string; start: string | null; end: string | null; dailyBudget: number | null; source: 'META' | 'BACKOFFICE' }
interface WeekData { today: string; days: string[]; start: string; previous: string; next: string; items: WeekItem[]; note: string }

const DAY = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const RUNS = new Set(['ACTIVE']);

export function Week({ q }: { q: string }) {
  const [start, setStart] = useState<string | undefined>(undefined);
  const { data, isLoading } = useQuery({
    queryKey: ['ads-week', q, start],
    queryFn: () => api.get<WeekData>(withScope(`/ads/create/week${start ? `?start=${start}` : ''}`, q)),
  });
  if (isLoading || !data) return <Loading />;
  const on = (i: WeekItem, d: string) => (!i.start || i.start <= d) && (!i.end || i.end >= d);
  const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (
    <Card kicker="Programación" title={`Semana del ${label(data.days[0])} al ${label(data.days[6])}`}
      actions={(
        <span className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setStart(data.previous)}>← Anterior</Button>
          <Button size="sm" variant="outline" onClick={() => setStart(undefined)}>Hoy</Button>
          <Button size="sm" variant="outline" onClick={() => setStart(data.next)}>Siguiente →</Button>
        </span>
      )}>
      {!data.items.length ? (
        <EmptyState title="Nada programado esta semana" hint="Crea un anuncio con fechas y aparecerá aquí." action={<Link to="/app/ads?tab=nueva" className="underline">Crear un anuncio</Link>} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] border-collapse text-sm" data-testid="week">
            <thead>
              <tr>
                <th className="w-40 border-b-2 border-ink py-2 text-left">Anuncio</th>
                {data.days.map((d, i) => (
                  <th key={d} className={clsx('border-b-2 border-ink py-2 text-center text-xs', d === data.today && 'bg-bone-2')}>{DAY[i]}<span className="block font-normal text-ink-3">{label(d)}</span></th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.key} className="border-b border-line">
                  <td className="py-2 pr-2">
                    <b className="block break-words">{it.name}</b>
                    <span className="text-xs text-ink-3">
                      {it.source === 'BACKOFFICE' ? 'Creado en BackOffice' : 'Desde Meta'} · {RUNS.has(it.status) ? 'activo' : 'en pausa'}
                      {it.dailyBudget ? ` · ${Math.round(it.dailyBudget).toLocaleString('es-CO')}/día` : ''}
                    </span>
                  </td>
                  {data.days.map((d) => (
                    <td key={d} className={clsx('px-0.5 py-2', d === data.today && 'bg-bone-2')}>
                      {on(it, d) && <div className={clsx('h-5 border-2', RUNS.has(it.status) ? 'border-ink bg-ink' : 'border-ink-3 bg-transparent')} title={RUNS.has(it.status) ? 'Programado y activo' : 'Programado, en pausa (no gasta)'} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-3">
            <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 border-2 border-ink bg-ink" /> Activo</span>
            <span className="inline-flex items-center gap-1"><span className="inline-block h-3 w-5 border-2 border-ink-3" /> En pausa (no gasta)</span>
          </p>
          <p className="mt-2 text-xs text-ink-3">{data.note}</p>
        </div>
      )}
    </Card>
  );
}
