import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, FlaskConical, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Badge, Button, Card, Input, Loading, Select, Switch } from './ui';

/**
 * Cadena de modelos de la IA del registro (Dev Tools): en qué orden se prueban,
 * cuál está prendido, qué tan bien le fue en la prueba de BackOffice, qué tan
 * rápido responde de verdad y cuánto cupo queda hoy.
 */

type Provider = 'GEMINI' | 'OPENROUTER';

interface Bench {
  at: string;
  score: number;
  seconds: number;
  checks: Record<string, boolean>;
  error?: string;
}

interface ChainRow {
  id: string;
  provider: Provider;
  model: string;
  enabled: boolean;
  name: string;
  context: number | null;
  description: string;
  inCatalog: boolean;
  availability: { state: 'LISTO' | 'DESCANSANDO' | 'SIN_CUPO' | 'SIN_LLAVE' | 'APAGADO'; until: string | null };
  calls: number;
  successRate: number | null;
  avgSeconds: number | null;
  lastError: string | null;
  lastAt: string | null;
  bench: Bench | null;
}

interface ChainData {
  custom: boolean;
  entries: ChainRow[];
  suggestions: Array<{ provider: Provider; model: string; name: string; context: number | null; bench: Bench | null }>;
  capacity: {
    gemini: Array<{ label: string; requestsToday: number; limit: number; exhausted: boolean; lastError: string | null }>;
    openrouter: {
      configured: boolean;
      keys: Array<{ label: string; requestsToday: number; exhausted: boolean; lastError: string | null }>;
      account: { freeTier: boolean | null; dailyFreeCap: number | null; limitRemaining: number | null } | null;
    };
  };
}

const STATE: Record<ChainRow['availability']['state'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  LISTO: { label: 'Listo', tone: 'ok' },
  DESCANSANDO: { label: 'Descansando', tone: 'warn' },
  SIN_CUPO: { label: 'Sin cupo hoy', tone: 'bad' },
  SIN_LLAVE: { label: 'Sin llave', tone: 'bad' },
  APAGADO: { label: 'Apagado', tone: 'neutral' },
};

function ScoreBadge({ bench }: { bench: Bench | null }) {
  if (!bench) return <span className="text-xs text-ink-3">Sin probar</span>;
  // Si no contestó nada (saturado, sin cupo) no es un puntaje: es que no estaba disponible
  const answered = Object.entries(bench.checks).some(([k, v]) => k.endsWith('JSON válido') && v);
  if (!answered) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Badge tone="bad">No respondió</Badge>
        <span className="max-w-40 truncate text-[11px] text-ink-3" title={bench.error}>{bench.error ?? 'sin respuesta'} · {timeAgo(bench.at)}</span>
      </span>
    );
  }
  const tone = bench.score >= 85 ? 'ok' : bench.score >= 60 ? 'warn' : 'bad';
  return (
    <span className="flex flex-col items-start gap-0.5">
      <Badge tone={tone}>{bench.score} / 100</Badge>
      <span className="text-[11px] text-ink-3">{bench.seconds}s · {timeAgo(bench.at)}</span>
    </span>
  );
}

export default function AiChainPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ai-chain'],
    queryFn: () => api.get<ChainData>('/onboarding/ai-chain'),
  });
  const [rows, setRows] = useState<ChainRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [manual, setManual] = useState<{ provider: Provider; model: string }>({ provider: 'OPENROUTER', model: '' });
  const [testing, setTesting] = useState<string[] | null>(null);

  useEffect(() => {
    if (data && !dirty) setRows(data.entries);
  }, [data, dirty]);

  const apply = (next: ChainData) => {
    queryClient.setQueryData(['ai-chain'], next);
    setRows(next.entries);
    setDirty(false);
  };

  const save = useMutation({
    mutationFn: () => api.post<ChainData>('/onboarding/ai-chain', { entries: rows.map(({ provider, model, enabled }) => ({ provider, model, enabled })) }),
    onSuccess: (r) => {
      apply(r);
      toast.success('Orden guardado: el registro ya usa esta cadena');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const reset = useMutation({
    mutationFn: (stats: boolean) => api.post<ChainData>('/onboarding/ai-chain/reset', { stats }),
    onSuccess: (r, stats) => {
      apply(r);
      toast.success(stats ? 'Orden y estadísticas reiniciados' : 'Volvió al orden automático');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const test = useMutation({
    mutationFn: (ids: string[]) => {
      setTesting(ids);
      return api.post<{ results: Array<{ id: string; score: number; seconds: number; error?: string }>; chain: ChainData }>('/onboarding/ai-chain/test', { ids });
    },
    onSuccess: (r) => {
      if (!dirty) apply(r.chain);
      else queryClient.setQueryData(['ai-chain'], r.chain);
      const best = r.results[0];
      toast.success(r.results.length === 1 ? `${best.id.split(':').slice(1).join(':')}: ${best.score}/100 en ${best.seconds}s` : `Probados ${r.results.length}. El mejor: ${best?.id.split(':').slice(1).join(':')} (${best?.score}/100)`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
    onSettled: () => setTesting(null),
  });

  if (isLoading || !data) return <Loading />;

  const edit = (next: ChainRow[]) => {
    setRows(next);
    setDirty(true);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    edit(next);
  };
  const sortBy = (kind: 'score' | 'speed') => {
    const score = (r: ChainRow) => r.bench?.score ?? -1;
    const speed = (r: ChainRow) => r.avgSeconds ?? r.bench?.seconds ?? 999;
    edit([...rows].sort((a, b) => (kind === 'score' ? score(b) - score(a) || speed(a) - speed(b) : speed(a) - speed(b) || score(b) - score(a))));
  };
  const add = (provider: Provider, model: string, name?: string) => {
    const id = `${provider}:${model}`;
    if (!model.trim() || rows.some((r) => r.id === id)) return;
    const sug = data.suggestions.find((s) => `${s.provider}:${s.model}` === id);
    edit([...rows, {
      id, provider, model, enabled: true, name: name ?? model, context: sug?.context ?? null, description: '', inCatalog: true,
      availability: { state: 'LISTO', until: null }, calls: 0, successRate: null, avgSeconds: null, lastError: null, lastAt: null, bench: sug?.bench ?? null,
    }]);
  };

  const or = data.capacity.openrouter;
  const enabledCount = rows.filter((r) => r.enabled).length;
  const isTesting = (id: string) => !!testing?.includes(id);

  return (
    <div className="space-y-6">
      <Card
        kicker="Registro web y guía de configuración"
        title="Cadena de modelos"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>Actualizar</Button>
            <Button size="sm" variant="outline" disabled={!!testing} onClick={() => test.mutate(rows.filter((r) => r.enabled).map((r) => r.id))}>
              <FlaskConical size={13} /> {testing && testing.length > 1 ? 'Probando… (1 a 3 min)' : 'Probar todos'}
            </Button>
            <Button size="sm" disabled={!dirty || save.isPending || !enabledCount} onClick={() => save.mutate()}>
              <Save size={13} /> {save.isPending ? 'Guardando…' : 'Guardar orden'}
            </Button>
          </div>
        }
      >
        <p className="mb-4 text-sm text-ink-2">
          El registro le pregunta al primer modelo prendido; si falla, está saturado o se le acabó el cupo, pasa al siguiente.
          Si ninguno responde, sigue con preguntas fijas (nadie se queda trabado). {data.custom ? 'Usando tu orden guardado.' : 'Orden automático (aún no guardas uno).'}
        </p>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className="self-center font-semibold uppercase tracking-[0.08em] text-ink-3">Ordenar por:</span>
          <Button size="sm" variant="ghost" onClick={() => sortBy('score')}>Puntaje</Button>
          <Button size="sm" variant="ghost" onClick={() => sortBy('speed')}>Velocidad</Button>
          {dirty && <span className="self-center font-semibold text-warn">Cambios sin guardar</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                <th className="w-16 py-2">Orden</th>
                <th className="py-2">Modelo</th>
                <th className="py-2">Puntaje</th>
                <th className="py-2">En uso real</th>
                <th className="py-2">Estado</th>
                <th className="py-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={r.id}>
                  <tr className={clsx('border-b border-line align-top', !r.enabled && 'opacity-50')}>
                    <td className="py-2.5">
                      <div className="flex items-center gap-1">
                        <span className="w-5 text-right font-mono text-xs tabular-nums">{i + 1}</span>
                        <span className="flex flex-col">
                          <button type="button" aria-label="Subir" disabled={i === 0} onClick={() => move(i, -1)} className="cursor-pointer p-0.5 hover:text-ink disabled:opacity-20"><ArrowUp size={13} /></button>
                          <button type="button" aria-label="Bajar" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="cursor-pointer p-0.5 hover:text-ink disabled:opacity-20"><ArrowDown size={13} /></button>
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-start gap-2">
                        <Switch checked={r.enabled} onChange={(v) => edit(rows.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} label={r.enabled ? 'Prendido' : 'Apagado'} />
                        <div className="min-w-0">
                          <p className="font-semibold">{r.name !== r.model ? r.name : r.model.split('/').pop()}</p>
                          <p className="truncate font-mono text-[11px] text-ink-3">
                            <Badge tone={r.provider === 'GEMINI' ? 'info' : 'neutral'}>{r.provider === 'GEMINI' ? 'Gemini' : 'OpenRouter'}</Badge> {r.model}
                          </p>
                          {r.context && <p className="text-[11px] text-ink-3">Memoria: {Math.round(r.context / 1000)}k tokens</p>}
                          {!r.inCatalog && <p className="text-[11px] font-semibold text-bad">Ya no aparece en el catálogo de OpenRouter</p>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5">
                      <button type="button" className="cursor-pointer text-left" onClick={() => setExpanded(expanded === r.id ? null : r.id)} title="Ver detalle de la prueba">
                        <ScoreBadge bench={r.bench} />
                      </button>
                    </td>
                    <td className="py-2.5 text-xs">
                      {r.calls ? (
                        <>
                          <p><b>{r.successRate}%</b> responde · {r.calls} llamadas</p>
                          <p className="text-ink-3">{r.avgSeconds != null ? `${r.avgSeconds}s promedio` : 'sin éxitos aún'}</p>
                        </>
                      ) : <span className="text-ink-3">Aún sin uso</span>}
                    </td>
                    <td className="py-2.5">
                      <Badge tone={STATE[r.availability.state].tone}>{STATE[r.availability.state].label}</Badge>
                      {r.availability.until && <p className="mt-0.5 text-[11px] text-ink-3">hasta {new Date(r.availability.until).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}</p>}
                    </td>
                    <td className="py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" disabled={!!testing} onClick={() => test.mutate([r.id])}>
                          <FlaskConical size={12} /> {isTesting(r.id) ? '…' : 'Probar'}
                        </Button>
                        <Button size="sm" variant="ghost" aria-label="Quitar de la cadena" onClick={() => edit(rows.filter((x) => x.id !== r.id))}>
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {expanded === r.id && (
                    <tr className="border-b border-line bg-bone">
                      <td />
                      <td colSpan={5} className="py-3 pr-3 text-xs">
                        {r.description && <p className="mb-2 text-ink-2">{r.description}</p>}
                        {r.bench ? (
                          <ul className="grid gap-1 sm:grid-cols-2">
                            {Object.entries(r.bench.checks).map(([k, ok]) => (
                              <li key={k} className={ok ? 'text-ok' : 'text-bad'}>{ok ? '✓' : '✗'} {k}</li>
                            ))}
                          </ul>
                        ) : <p className="text-ink-3">Toca "Probar" para medirlo con las preguntas reales del registro.</p>}
                        {r.bench?.error && <p className="mt-2 text-bad">Error en la prueba: {r.bench.error}</p>}
                        {r.lastError && <p className="mt-1 text-ink-3">Último error en uso real: {r.lastError}{r.lastAt ? ` (${timeAgo(r.lastAt)})` : ''}</p>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!enabledCount && <p className="mt-3 text-sm font-semibold text-bad">Prende al menos un modelo; si no, el registro solo usará preguntas fijas.</p>}

        <div className="mt-5 flex flex-wrap items-end gap-2 border-t-2 border-line pt-4">
          <span className="w-full text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">Agregar un modelo a mano</span>
          <Select className="!w-36" value={manual.provider} onChange={(e) => setManual({ ...manual, provider: e.target.value as Provider })}>
            <option value="OPENROUTER">OpenRouter</option>
            <option value="GEMINI">Gemini</option>
          </Select>
          <Input className="!w-80 max-w-full font-mono" placeholder={manual.provider === 'GEMINI' ? 'gemini-2.5-flash' : 'proveedor/modelo:free'} value={manual.model} onChange={(e) => setManual({ ...manual, model: e.target.value.trim() })} />
          <Button size="sm" variant="outline" disabled={!manual.model} onClick={() => { add(manual.provider, manual.model); setManual({ ...manual, model: '' }); }}>
            <Plus size={13} /> Agregar
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={reset.isPending} onClick={() => reset.mutate(false)}><RotateCcw size={12} /> Volver al orden automático</Button>
          <Button size="sm" variant="ghost" disabled={reset.isPending} onClick={() => { if (confirm('¿Borrar puntajes y estadísticas de todos los modelos?')) reset.mutate(true); }}>
            Borrar estadísticas
          </Button>
        </div>
      </Card>

      {data.suggestions.length > 0 && (
        <Card kicker="Gratis en OpenRouter y fuera de tu cadena" title="Otros modelos disponibles">
          <div className="grid gap-2 md:grid-cols-2">
            {data.suggestions.map((s) => (
              <div key={s.model} className="flex items-center justify-between gap-2 border-2 border-line p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{s.name}</p>
                  <p className="truncate font-mono text-[11px] text-ink-3">{s.model}{s.context ? ` · ${Math.round(s.context / 1000)}k` : ''}</p>
                  <div className="mt-1"><ScoreBadge bench={s.bench} /></div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" disabled={!!testing} onClick={() => test.mutate([`${s.provider}:${s.model}`])}>
                    <FlaskConical size={12} /> {isTesting(`${s.provider}:${s.model}`) ? '…' : 'Probar'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => add(s.provider, s.model, s.name)}><Plus size={12} /> Agregar</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card kicker="Cuánto queda hoy" title="Capacidad">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="kicker mb-2">Gemini (llaves genéricas)</p>
            {data.capacity.gemini.length === 0 ? <p className="text-sm text-warn">Sin llaves: agrega GEMINI_API_KEYS en el .env del API.</p> : (
              <ul className="space-y-2">
                {data.capacity.gemini.map((k) => (
                  <li key={k.label} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{k.label}</span>
                      <Badge tone={k.exhausted ? 'bad' : 'ok'}>{k.exhausted ? 'Agotada hoy' : 'Disponible'}</Badge>
                    </div>
                    <div className="mt-1 h-1.5 bg-bone-2"><div className={clsx('h-full', k.exhausted ? 'bg-bad' : 'bg-ink')} style={{ width: `${Math.min(100, (k.requestsToday / k.limit) * 100)}%` }} /></div>
                    <p className="mt-0.5 text-[11px] text-ink-3">{k.requestsToday} de {k.limit} hoy (GEMINI_DAILY_LIMIT){k.lastError ? ` · ${k.lastError}` : ''}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="kicker mb-2">OpenRouter (modelos gratis)</p>
            {!or.configured ? <p className="text-sm text-warn">Sin llave: agrega OPENROUTER_API_KEY en el .env del API.</p> : (
              <ul className="space-y-2">
                {or.keys.map((k) => {
                  const cap = or.account?.dailyFreeCap ?? null;
                  return (
                    <li key={k.label} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">{k.label}</span>
                        <Badge tone={k.exhausted ? 'bad' : 'ok'}>{k.exhausted ? 'Tope diario' : 'Disponible'}</Badge>
                      </div>
                      {cap && <div className="mt-1 h-1.5 bg-bone-2"><div className={clsx('h-full', k.exhausted ? 'bg-bad' : 'bg-ink')} style={{ width: `${Math.min(100, (k.requestsToday / cap) * 100)}%` }} /></div>}
                      <p className="mt-0.5 text-[11px] text-ink-3">{k.requestsToday}{cap ? ` de ~${cap}` : ''} respuestas hoy{k.lastError ? ` · ${k.lastError}` : ''}</p>
                    </li>
                  );
                })}
                {or.account?.freeTier === true && (
                  <li className="text-[11px] text-ink-3">Cuenta sin créditos comprados: ~50 respuestas gratis al día. Con 10 USD en créditos sube a ~1.000 (los modelos :free siguen sin costo).</li>
                )}
              </ul>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
