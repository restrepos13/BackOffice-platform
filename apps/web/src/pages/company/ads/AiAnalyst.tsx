import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Badge, Button, Card, Input } from '../../../components/ui';
import { useCompanyScope, withScope } from '../shared';

/**
 * Analista con IA de la publicidad: explica en palabras simples qué está
 * pasando y qué hacer esta semana. Las cifras las calcula BackOffice; la IA
 * solo las interpreta (el servidor descarta cualquier cifra que no venga de
 * los datos). Abrir la pantalla no gasta: se muestra el último análisis.
 */

interface Point { title: string; evidence: string }
interface Action { title: string; why: string; how: string; priority: 'ALTA' | 'MEDIA' | 'BAJA'; spends: boolean }
export interface Analysis { headline: string; summary: string; working: Point[]; notWorking: Point[]; actions: Action[]; watch: string[]; missing: string[]; answer: string | null }
interface Stored { at: string; days: number; period: { since: string; until: string }; model: string; source: 'EMPRESA' | 'GENERICA'; analysis: Analysis; dropped: number; by: string | null }
interface LastRes { ai: { source: 'EMPRESA' | 'GENERICA' | 'NINGUNA'; trial: { until: string; used: number; limit: number } | null }; last: Stored | null }
type RunRes = ({ status: 'OK'; question: string | null } & Stored) | { status: 'NO_AI' | 'NO_DATA' | 'ERROR'; message: string };

const PRIORITY: Record<Action['priority'], [string, 'bad' | 'warn' | 'neutral']> = { ALTA: ['Prioridad alta', 'bad'], MEDIA: ['Prioridad media', 'warn'], BAJA: ['Prioridad baja', 'neutral'] };
const when = (iso: string) => new Date(iso).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

function Points({ title, rows, tone }: { title: string; rows: Point[]; tone: 'ok' | 'bad' }) {
  if (!rows.length) return null;
  return (
    <div className="border-2 border-line bg-paper p-3">
      <p className="kicker mb-2">{title}</p>
      <ul className="space-y-2 text-sm">
        {rows.map((r) => (
          <li key={r.title} className={tone === 'ok' ? 'border-l-4 border-ok pl-2' : 'border-l-4 border-bad pl-2'}>
            <b>{r.title}</b>
            <span className="block text-xs text-ink-2">{r.evidence}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AiAnalyst({ q, mode, days }: { q: string; mode: 'REAL' | 'DEMO'; days: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<{ question: string; answer: string } | null>(null);
  const sep = withScope('/ads/ai/analysis', q).includes('?') ? '&' : '?';
  const { data } = useQuery({ queryKey: ['ads-ai-analysis', q, mode], queryFn: () => api.get<LastRes>(`${withScope('/ads/ai/analysis', q)}${sep}mode=${mode}`) });
  const run = useMutation({
    mutationFn: (ask?: string) => api.post<RunRes>(withScope('/ads/ai/analysis', q), { days: Number(days), mode, ...(ask ? { question: ask } : {}) }),
    onSuccess: (r, ask) => {
      if (r.status !== 'OK') { toast.error(r.message); return; }
      if (ask) {
        setAsked({ question: ask, answer: r.analysis.answer ?? r.analysis.summary });
        setQuestion('');
      } else {
        queryClient.invalidateQueries({ queryKey: ['ads-ai-analysis'] });
        toast.success('Análisis listo');
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo analizar'),
  });
  if (!data?.ai) return null;
  const { ai, last } = data;
  const noAi = ai.source === 'NINGUNA';
  const a = last?.analysis;
  const stale = last ? (Date.now() - new Date(last.at).getTime()) / 36e5 > 24 || String(last.days) !== days : false;
  return (
    <Card
      kicker="Análisis con IA"
      title={a ? a.headline : 'Qué está pasando y qué hacer esta semana'}
      className="mt-6"
      actions={canWrite && !noAi ? <Button size="sm" variant={a ? 'outline' : 'primary'} disabled={run.isPending} onClick={() => run.mutate(undefined)}>{run.isPending && !run.variables ? 'Analizando…' : a ? 'Actualizar análisis' : 'Analizar con IA'}</Button> : undefined}
    >
      <div data-testid="ai-analyst">
        {noAi && !a && (
          <p className="text-sm text-ink-2">
            Tu empresa todavía no tiene IA activa. Las oportunidades y el Autopilot siguen funcionando con reglas; para tener este análisis escrito conecta tu proveedor de IA en Configuración o pídele al equipo de BackOffice la IA de prueba.
          </p>
        )}
        {!noAi && !a && (
          <p className="text-sm text-ink-2">
            La IA lee los resultados del periodo, tus campañas y anuncios, las oportunidades detectadas y lo que pasó después en tu CRM, y te dice en palabras simples qué funciona, qué no y qué hacer. No cambia nada en tu cuenta: solo recomienda.
          </p>
        )}
        {a && (
          <>
            <p className="text-sm leading-relaxed">{a.summary}</p>
            <p className="mt-2 text-[11px] text-ink-3">
              Datos del {last!.period.since} al {last!.period.until} · analizado el {when(last!.at)}{last!.by ? ` por ${last!.by}` : ''} · {last!.source === 'GENERICA' ? 'IA de prueba' : 'IA de tu empresa'}
              {stale && <> · <span className="text-warn">puede estar desactualizado: actualízalo</span></>}
            </p>
            {(a.working.length > 0 || a.notWorking.length > 0) && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <Points title="Lo que funciona" rows={a.working} tone="ok" />
                <Points title="Lo que no funciona" rows={a.notWorking} tone="bad" />
              </div>
            )}
            {a.actions.length > 0 && (
              <div className="mt-4">
                <p className="kicker mb-2">Qué hacer esta semana</p>
                <ol className="space-y-2">
                  {a.actions.map((x, i) => (
                    <li key={x.title} className="border-2 border-ink bg-paper p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="display text-xl leading-none">{i + 1}</span>
                        <b>{x.title}</b>
                        <Badge tone={PRIORITY[x.priority][1]}>{PRIORITY[x.priority][0]}</Badge>
                        {x.spends && <Badge tone="warn">Aumenta el gasto: lo decides tú</Badge>}
                      </p>
                      <p className="mt-1 text-ink-2"><span className="font-semibold text-ink">Por qué:</span> {x.why}</p>
                      <p className="text-ink-2"><span className="font-semibold text-ink">Cómo:</span> {x.how}</p>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {(a.watch.length > 0 || a.missing.length > 0) && (
              <div className="mt-4 grid gap-3 text-xs text-ink-2 md:grid-cols-2">
                {a.watch.length > 0 && <div><p className="kicker mb-1">Para vigilar</p><ul className="list-disc space-y-0.5 pl-4">{a.watch.map((w) => <li key={w}>{w}</li>)}</ul></div>}
                {a.missing.length > 0 && <div><p className="kicker mb-1">Lo que falta medir</p><ul className="list-disc space-y-0.5 pl-4">{a.missing.map((w) => <li key={w}>{w}</li>)}</ul></div>}
              </div>
            )}
          </>
        )}
        {canWrite && !noAi && (
          <form
            className="mt-4 flex flex-wrap items-end gap-2 border-t-2 border-line pt-3"
            onSubmit={(e) => { e.preventDefault(); const ask = question.trim(); if (ask.length >= 4) run.mutate(ask); }}
          >
            <label className="min-w-[16rem] flex-1 text-xs font-semibold text-ink-2">
              Pregúntale a tus anuncios
              <Input className="mt-1" value={question} maxLength={300} onChange={(e) => setQuestion(e.target.value)} placeholder="Ej.: ¿qué anuncio debería pausar? ¿por qué subió el costo?" />
            </label>
            <Button type="submit" size="sm" variant="outline" disabled={run.isPending || question.trim().length < 4}>{run.isPending && run.variables ? 'Pensando…' : 'Preguntar'}</Button>
          </form>
        )}
        {asked && (
          <div className="mt-3 border-2 border-line bg-paper p-3 text-sm" data-testid="ai-answer">
            <p className="kicker mb-1">{asked.question}</p>
            <p className="leading-relaxed">{asked.answer}</p>
          </div>
        )}
        {noAi && a && <p className="mt-3 text-[11px] text-ink-3">Tu empresa ya no tiene IA activa: este es el último análisis guardado. Para actualizarlo, conecta tu proveedor de IA en Configuración.</p>}
        {!noAi && (
          <p className="mt-3 text-[11px] text-ink-3">
            Las cifras las calcula BackOffice con lo que reporta la plataforma y tu CRM; la IA solo las interpreta y no puede cambiar nada en tu cuenta.
            {last && last.dropped > 0 ? ` Se descartaron ${last.dropped} afirmaciones porque citaban cifras que no estaban en tus datos.` : ''}
            {ai.trial ? ` IA de prueba: ${ai.trial.used} de ${ai.trial.limit} usos hoy.` : ai.source === 'EMPRESA' ? ' Cada análisis consume de la IA de tu empresa.' : ''}
          </p>
        )}
      </div>
    </Card>
  );
}
