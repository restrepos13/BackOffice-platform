import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlertTriangle, Bot, Search, Send, Star, TrendingDown, TrendingUp,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, openPdf } from '../../lib/api';
import { ORDER_STATUS_LABELS, fmtDateTime, fmtNum } from '../../lib/format';
import type { AskResult, CompareBucket, DailyReportData, FeedbackSummary } from '../../lib/types';
import {
  Badge, Button, EmptyState, Loading, PageHeader, Stat, Table, Tabs,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

function localToday(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

/* ─── Reporte diario ─────────────────────────────────────────────────── */

function DailyTab({ q, canWrite, companyId }: { q: string; canWrite: boolean; companyId: string | null }) {
  const [date, setDate] = useState(localToday());
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['report-daily', q, date],
    queryFn: () => api.get<DailyReportData>(withScope(`/reports/daily?date=${date}`, q)),
  });
  const { data: history } = useQuery({
    queryKey: ['report-history', q],
    queryFn: () => api.get<Array<{ id: string; date: string; channel: string | null; sentAt: string | null }>>(
      withScope('/reports/history', q),
    ),
  });

  const run = useMutation({
    mutationFn: () =>
      api.post('/reports/daily/run', { date, ...(companyId ? { companyId } : {}) }),
    onSuccess: (r: any) => {
      toast.success(
        r.sent ? 'Reporte generado y enviado por correo' : 'Reporte generado y guardado en el panel',
      );
      queryClient.invalidateQueries({ queryKey: ['report-history'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !data) return <Loading label="Armando el reporte…" />;
  const precision = data.precisionIA.mes.precisionPct;
  const alertCount =
    data.alertas.pedidosSinConfirmar.length +
    data.alertas.entregasProximasSinArea.length +
    data.alertas.recordatoriosFallidos.length +
    (data.alertas.conversacionesSinRespuesta > 0 ? 1 : 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date" value={date} max={localToday()}
          onChange={(e) => setDate(e.target.value)}
          className="border-2 border-ink bg-bone px-3 py-2 text-sm"
          aria-label="Día del reporte"
        />
        {canWrite && (
          <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Generando…' : 'Generar y enviar ahora'}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            openPdf(withScope(`/reports/daily/pdf?date=${date}`, q)).catch((e) =>
              toast.error(e instanceof Error ? e.message : 'Error'),
            )
          }
        >
          Descargar PDF
        </Button>
      </div>

      {/* KPIs del día */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Recibidos" value={data.pedidos.recibidos} />
        <Stat label="Confirmados" value={data.pedidos.confirmados} />
        <Stat label="Programados" value={data.pedidos.programados} />
        <Stat label="Despachados" value={data.pedidos.despachados} />
        <Stat label="Entregados" value={data.pedidos.entregados} tone="ok" />
        <Stat
          label="Precisión IA (mes)"
          value={precision != null ? `${precision}%` : '—'}
          tone={precision == null ? undefined : precision >= 90 ? 'ok' : precision >= 70 ? 'warn' : 'bad'}
          hint={`${data.precisionIA.mes.total} pedidos IA · ${data.precisionIA.mes.corregidos} corregidos`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Conversaciones" value={data.conversaciones.atendidas} hint="con actividad del día" />
        <Stat label="Resueltas por la IA" value={data.conversaciones.resueltasPorIA} tone="ok" />
        <Stat label="Escaladas" value={data.conversaciones.escaladas} tone={data.conversaciones.escaladas > 0 ? 'warn' : undefined} />
        <Stat label="Con humano" value={data.conversaciones.conIntervencionHumana} />
      </div>

      {/* Alertas accionables */}
      <section className="border-2 border-ink bg-paper">
        <header className="flex items-center justify-between border-b-2 border-ink px-5 py-3">
          <p className="kicker">Alertas para actuar hoy</p>
          <Badge tone={alertCount > 0 ? 'bad' : 'ok'}>{alertCount > 0 ? `${alertCount} frentes` : 'Todo en orden'}</Badge>
        </header>
        <div className="divide-y divide-line">
          {data.alertas.pedidosSinConfirmar.map((o) => (
            <Link key={o.id} to={`/app/orders/${o.id}`} className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-bone-2">
              <p className="text-sm"><AlertTriangle size={13} className="mr-1.5 inline text-warn" /><strong>{o.customer}</strong> sigue en borrador (sin confirmar)</p>
              <span className="text-xs text-ink-3">entrega {fmtDateTime(o.deliveryAt)}</span>
            </Link>
          ))}
          {data.alertas.entregasProximasSinArea.map((o) => (
            <Link key={o.id} to={`/app/orders/${o.id}`} className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-bone-2">
              <p className="text-sm"><AlertTriangle size={13} className="mr-1.5 inline text-bad" /><strong>{o.customer}</strong>: entrega próxima con ítems sin área ({o.itemsSinArea.join(', ')})</p>
              <span className="text-xs text-ink-3">{fmtDateTime(o.deliveryAt)}</span>
            </Link>
          ))}
          {data.alertas.recordatoriosFallidos.map((r) => (
            <div key={r.id} className="px-5 py-2.5">
              <p className="text-sm"><AlertTriangle size={13} className="mr-1.5 inline text-bad" />Recordatorio {r.kind} fallido{r.lastError ? `: ${r.lastError}` : ''}</p>
            </div>
          ))}
          {data.alertas.conversacionesSinRespuesta > 0 && (
            <Link to="/app/inbox" className="block px-5 py-2.5 hover:bg-bone-2">
              <p className="text-sm"><AlertTriangle size={13} className="mr-1.5 inline text-warn" />{data.alertas.conversacionesSinRespuesta} conversación(es) con mensajes sin responder hace más de 2 h</p>
            </Link>
          )}
          {alertCount === 0 && (
            <p className="px-5 py-4 text-sm text-ink-3">Sin alertas pendientes.</p>
          )}
        </div>
      </section>

      {/* Casos donde la IA dudó */}
      <section className="border-2 border-ink bg-paper">
        <header className="border-b-2 border-ink px-5 py-3">
          <p className="kicker">Casos donde el asistente dudó o escaló</p>
        </header>
        <div className="divide-y divide-line">
          {data.dudas.pedidosBajaConfianza.map((o) => (
            <Link key={o.id} to={`/app/orders/${o.id}`} className="flex items-center justify-between gap-2 px-5 py-2.5 hover:bg-bone-2">
              <p className="text-sm"><Bot size={13} className="mr-1.5 inline text-info" /><strong>{o.customer}</strong> · confianza {Math.round(o.aiConfidence * 100)}%</p>
              <Badge tone="warn">{ORDER_STATUS_LABELS[o.status] ?? o.status}</Badge>
            </Link>
          ))}
          {data.dudas.escalamientos.map((e, i) => (
            <Link key={`${e.orderId}-${i}`} to={`/app/orders/${e.orderId}`} className="block px-5 py-2.5 hover:bg-bone-2">
              <p className="text-sm"><strong>{e.customer}</strong>: {e.reason ?? 'escalado sin motivo registrado'}</p>
            </Link>
          ))}
          {data.dudas.pedidosBajaConfianza.length === 0 && data.dudas.escalamientos.length === 0 && (
            <p className="px-5 py-4 text-sm text-ink-3">La IA no dudó este día.</p>
          )}
        </div>
      </section>

      {/* Historial de reportes generados */}
      {(history?.length ?? 0) > 0 && (
        <section>
          <p className="kicker mb-2">Reportes generados</p>
          <div className="flex flex-wrap gap-2">
            {history!.slice(0, 14).map((h) => (
              <button
                key={h.id}
                onClick={() => setDate(h.date)}
                className={clsx(
                  'cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold',
                  h.date === date ? 'bg-ink text-bone' : 'bg-paper hover:bg-bone-2',
                )}
              >
                {h.date}{h.channel === 'EMAIL' && h.sentAt ? ' ✉' : ''}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ─── Comparativo ────────────────────────────────────────────────────── */

function CompareTab({ q }: { q: string }) {
  const [granularity, setGranularity] = useState<'week' | 'month'>('week');
  const { data, isLoading } = useQuery({
    queryKey: ['report-compare', q, granularity],
    queryFn: () =>
      api.get<{ buckets: CompareBucket[] }>(withScope(`/reports/compare?granularity=${granularity}`, q)),
  });

  if (isLoading || !data) return <Loading />;
  const buckets = data.buckets;
  const last = buckets[buckets.length - 1];
  const prev = buckets[buckets.length - 2];
  const delta = prev && prev.pedidos > 0
    ? Math.round(((last.pedidos - prev.pedidos) / prev.pedidos) * 100)
    : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          active={granularity}
          onChange={(id) => setGranularity(id as 'week' | 'month')}
          tabs={[{ id: 'week', label: 'Semanal' }, { id: 'month', label: 'Mensual' }]}
        />
        {delta != null && (
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            {delta >= 0 ? <TrendingUp size={15} className="text-ok" /> : <TrendingDown size={15} className="text-bad" />}
            {delta > 0 ? '+' : ''}{delta}% de pedidos vs {granularity === 'week' ? 'la semana' : 'el mes'} anterior
          </p>
        )}
      </div>
      <Table head={['Período', 'Pedidos', 'Entregados', 'Cancelados', 'Cumplimiento', 'Tomados IA', 'Precisión IA']}>
        {buckets.map((b) => (
          <tr key={b.from} className={b === last ? 'bg-bone-2 font-semibold' : ''}>
            <td className="px-4 py-2.5 text-sm capitalize">{b.label}</td>
            <td className="px-4 py-2.5 tabular-nums">{fmtNum(b.pedidos)}</td>
            <td className="px-4 py-2.5 tabular-nums">{fmtNum(b.entregados)}</td>
            <td className="px-4 py-2.5 tabular-nums">{fmtNum(b.cancelados)}</td>
            <td className="px-4 py-2.5 tabular-nums">{b.cumplimientoPct != null ? `${b.cumplimientoPct}%` : '—'}</td>
            <td className="px-4 py-2.5 tabular-nums">{fmtNum(b.tomadosIA)}</td>
            <td className="px-4 py-2.5 tabular-nums">
              {b.precisionIAPct != null ? (
                <Badge tone={b.precisionIAPct >= 90 ? 'ok' : b.precisionIAPct >= 70 ? 'warn' : 'bad'}>
                  {b.precisionIAPct}%
                </Badge>
              ) : '—'}
            </td>
          </tr>
        ))}
      </Table>
      <p className="text-xs text-ink-3">
        Cumplimiento = entregas cuya fecha ya pasó que llegaron a "entregado".
        Precisión IA = pedidos tomados por la IA que NO requirieron corrección manual.
      </p>
    </div>
  );
}

/* ─── Consulta en lenguaje natural ───────────────────────────────────── */

const EXAMPLES = [
  '¿Cuántos pedidos tenemos para mañana?',
  '¿Qué cliente no ha confirmado todavía?',
  '¿Cómo nos fue esta semana frente a la anterior?',
  '¿Qué pedidos se escalaron y por qué?',
  '¿Cuál es el cliente que más nos pide este mes?',
];

function AskTab({ q, companyId }: { q: string; companyId: string | null }) {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);

  const ask = useMutation({
    mutationFn: (text: string) =>
      api.post<AskResult>('/reports/ask', {
        question: text,
        ...(companyId ? { companyId } : {}),
      }),
    onSuccess: setResult,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const submit = (text: string) => {
    if (!text.trim() || ask.isPending) return;
    setQuestion(text);
    ask.mutate(text);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex gap-2">
        <div className="flex flex-1 items-center gap-2 border-2 border-ink bg-bone px-3">
          <Search size={15} className="shrink-0 text-ink-3" />
          <input
            className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-ink-3"
            placeholder="Pregunta sobre pedidos, clientes, escalamientos, feedback…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit(question)}
            aria-label="Pregunta en lenguaje natural"
          />
        </div>
        <Button disabled={!question.trim() || ask.isPending} onClick={() => submit(question)}>
          <Send size={14} /> {ask.isPending ? 'Consultando…' : 'Preguntar'}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((e) => (
          <button
            key={e}
            onClick={() => submit(e)}
            className="cursor-pointer border-2 border-line px-3 py-1.5 text-xs text-ink-2 hover:border-ink hover:text-ink"
          >
            {e}
          </button>
        ))}
      </div>

      {ask.isPending && <Loading label="Consultando los datos…" />}

      {result && !ask.isPending && (
        <section className="border-2 border-ink bg-paper">
          <header className="border-b-2 border-ink px-5 py-3">
            <p className="kicker">Respuesta{result.tool ? ` · herramienta: ${result.tool}` : ''}</p>
            <p className="mt-1 text-[15px] leading-relaxed">{result.answer}</p>
          </header>
          {result.data && (
            <div className="max-h-80 overflow-auto bg-bone px-5 py-3">
              <p className="kicker mb-2">Datos que respaldan la respuesta</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2">
                {JSON.stringify(result.data, null, 2)}
              </pre>
            </div>
          )}
        </section>
      )}

      <p className="text-xs text-ink-3">
        La consulta se resuelve con herramientas predefinidas y siempre limitada a
        tu organización — tu texto jamás llega a la base de datos. Usa la llave de
        DeepInfra de la organización.
      </p>
    </div>
  );
}

/* ─── Feedback / testimonios ─────────────────────────────────────────── */

function Stars({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-xs text-ink-3">sin rating</span>;
  return (
    <span className="inline-flex" aria-label={`${rating} de 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star key={i} size={13} className={i < rating ? 'fill-ink text-ink' : 'text-line'} />
      ))}
    </span>
  );
}

function FeedbackTab({ q }: { q: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['report-feedback', q],
    queryFn: () => api.get<FeedbackSummary>(withScope('/reports/feedback', q)),
  });

  if (isLoading || !data) return <Loading />;
  const maxCount = Math.max(...data.distribution.map((d) => d.count), 1);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Promedio" value={data.promedio != null ? `${data.promedio} / 5` : '—'} tone={data.promedio != null && data.promedio >= 4 ? 'ok' : undefined} />
        <Stat label="Respondidos" value={`${data.respondidos}/${data.solicitados}`} hint={data.tasaRespuestaPct != null ? `${data.tasaRespuestaPct}% de respuesta` : undefined} />
        <Stat label="Negativos" value={data.negativos} tone={data.negativos > 0 ? 'bad' : 'ok'} />
        <div className="border-2 border-ink bg-paper px-4 py-3">
          <p className="kicker mb-2">Distribución</p>
          {[...data.distribution].reverse().map((d) => (
            <div key={d.star} className="mb-1 flex items-center gap-2">
              <span className="w-3 text-xs font-semibold">{d.star}</span>
              <div className="h-2.5 flex-1 bg-bone-2">
                <div className="h-full bg-ink" style={{ width: `${(d.count / maxCount) * 100}%` }} />
              </div>
              <span className="w-5 text-right text-xs tabular-nums">{d.count}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="border-2 border-ink bg-paper">
          <header className="border-b-2 border-ink px-5 py-3">
            <p className="kicker">Testimonios (para uso comercial)</p>
          </header>
          <div className="divide-y divide-line">
            {data.testimonios.map((t, i) => (
              <div key={i} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{t.customer}</p>
                  <Stars rating={t.rating} />
                </div>
                <p className="serif-accent mt-1 text-[15px] text-ink-2">"{t.comment}"</p>
              </div>
            ))}
            {data.testimonios.length === 0 && (
              <p className="px-5 py-4 text-sm text-ink-3">
                Todavía no hay testimonios positivos con comentario.
              </p>
            )}
          </div>
        </section>

        <section className="border-2 border-ink bg-paper">
          <header className="border-b-2 border-ink px-5 py-3">
            <p className="kicker">Respuestas recientes</p>
          </header>
          <div className="divide-y divide-line">
            {data.recientes.map((r, i) => (
              <Link
                key={i}
                to={`/app/orders/${r.orderId}`}
                className={clsx('block px-5 py-2.5 hover:bg-bone-2', r.alerted && 'bg-bad-soft')}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {r.alerted && <AlertTriangle size={12} className="mr-1 inline text-bad" />}
                    {r.customer}
                  </p>
                  <Stars rating={r.rating} />
                </div>
                {r.comment && <p className="mt-0.5 truncate text-xs text-ink-3">{r.comment}</p>}
              </Link>
            ))}
            {data.recientes.length === 0 && (
              <p className="px-5 py-4 text-sm text-ink-3">
                Sin respuestas aún. La encuesta se envía sola unas horas después de
                cada entrega.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ─── Página ─────────────────────────────────────────────────────────── */

export default function OrdersReports() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const [tab, setTab] = useState('diario');

  if (!ready) return <PickCompany />;

  return (
    <>
      <PageHeader kicker="Módulo de pedidos" title="Reportes" accent="y consulta." />
      <div className="mb-5">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'diario', label: 'Reporte diario' },
            { id: 'comparativo', label: 'Comparativo' },
            { id: 'consulta', label: 'Consulta' },
            { id: 'feedback', label: 'Feedback' },
          ]}
        />
      </div>
      {tab === 'diario' && <DailyTab q={q} canWrite={canWrite} companyId={companyId} />}
      {tab === 'comparativo' && <CompareTab q={q} />}
      {tab === 'consulta' && <AskTab q={q} companyId={companyId} />}
      {tab === 'feedback' && <FeedbackTab q={q} />}
    </>
  );
}
