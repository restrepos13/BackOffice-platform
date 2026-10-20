import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSearch } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Loading, PageHeader, Stat, Switch } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Auditor de ventas (complemento): cada lunes, por qué se perdieron ventas la
 * semana anterior y qué hacer. También se puede generar a demanda.
 */

interface Report {
  id: string; periodStart: string; periodEnd: string;
  stats: { conversations: number; sales: number; conversion: number; revenue: number; avgFirstReplyMin: number | null; lost: number };
  reasons: Array<{ reason: string; label: string; count: number }>;
  recommendations: string[];
  examples: Array<{ reason: string; label: string; contact: string; conversationId: string; snippet: string }>;
  source: 'IA' | 'REGLAS'; tokens: number; createdAt: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

export default function SalesAudit() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['sales-audit', q],
    queryFn: () => api.get<{ config: { email: string; useAi: boolean }; reports: Report[] }>(withScope('/addons/sales-audit', q)),
    enabled: ready,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [cfg, setCfg] = useState<{ email: string; useAi: boolean } | null>(null);
  useEffect(() => {
    if (data && !cfg) setCfg(data.config);
  }, [data, cfg]);
  const generate = useMutation({
    mutationFn: () => api.post<Report>(withScope('/addons/sales-audit/generate', q), {}),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['sales-audit'] }); setSelected(r.id); toast.success('Informe listo'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const save = useMutation({
    mutationFn: () => api.put(withScope('/addons/sales-audit/config', q), cfg),
    onSuccess: () => toast.success('Guardado'),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (error) return <Card title="Auditor de ventas"><p className="text-sm">{error instanceof Error ? error.message : 'No disponible'} <Link to="/app/mi-plan" className="font-semibold underline">Ir a Mi plan</Link></p></Card>;
  if (isLoading || !data || !cfg) return <Loading />;
  const report = data.reports.find((r) => r.id === selected) ?? data.reports[0];
  const maxReason = Math.max(1, ...(report?.reasons.map((r) => r.count) ?? [1]));

  return (
    <>
      <PageHeader
        kicker="Incluido en tu plan · llega cada lunes"
        title="Auditor"
        accent="de ventas"
        actions={canWrite && <Button disabled={generate.isPending} onClick={() => generate.mutate()}><FileSearch size={14} /> {generate.isPending ? 'Analizando…' : 'Analizar los últimos 7 días'}</Button>}
      />

      {!report ? (
        <Card title="Todavía no hay informes"><p className="text-sm text-ink-2">El primero llega el próximo lunes a las 7:00 a. m. También puedes generarlo ahora con el botón de arriba.</p></Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-ink-2">
            Semana del {day(report.periodStart)} al {day(report.periodEnd)} · {report.source === 'IA' ? 'analizado con IA' : 'analizado con reglas (sin IA)'}
            {data.reports.length > 1 && (
              <> · ver otra semana:{' '}
                {data.reports.slice(0, 6).map((r) => (
                  <button key={r.id} type="button" onClick={() => setSelected(r.id)} className={`ml-1 cursor-pointer underline ${r.id === report.id ? 'font-semibold' : ''}`}>{day(r.periodEnd)}</button>
                ))}
              </>
            )}
          </p>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
            <Stat label="Conversaciones" value={report.stats.conversations} />
            <Stat label="Ventas" value={report.stats.sales} hint={`${report.stats.conversion}% de conversión`} />
            <Stat label="Vendido" value={fmtMoney(report.stats.revenue)} />
            <Stat label="Sin venta" value={report.stats.lost} tone={report.stats.lost ? 'warn' : undefined} />
            <Stat label="Primera respuesta" value={report.stats.avgFirstReplyMin != null ? `${report.stats.avgFirstReplyMin} min` : '—'} tone={(report.stats.avgFirstReplyMin ?? 0) > 15 ? 'bad' : undefined} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card kicker="Por qué se perdieron ventas" title="Motivos">
              {report.reasons.length === 0 ? <p className="text-sm text-ink-3">No hubo conversaciones sin venta. ¡Excelente semana!</p> : (
                <ul className="space-y-2">
                  {report.reasons.map((r) => (
                    <li key={r.reason} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                      <span>{r.label}</span>
                      <span className="h-5 bg-bone-2"><span className="block h-full bg-ink" style={{ width: `${(r.count / maxReason) * 100}%` }} /></span>
                      <b className="tabular-nums">{r.count}</b>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card kicker="Qué hacer esta semana" title="Recomendaciones">
              <ol className="list-decimal space-y-2 pl-5 text-sm">{report.recommendations.map((r) => <li key={r}>{r}</li>)}</ol>
            </Card>
          </div>

          {report.examples.length > 0 && (
            <Card kicker="Para que lo veas con tus ojos" title="Ejemplos" className="mt-6">
              <ul className="divide-y divide-line text-sm">
                {report.examples.map((e) => (
                  <li key={e.conversationId + e.reason} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span><Badge tone="neutral">{e.label}</Badge> <b>{e.contact}</b>{e.snippet && <span className="block text-xs text-ink-3">“{e.snippet}”</span>}</span>
                    <Link to={`/app/inbox?open=${e.conversationId}`} className="text-xs underline">Ver chat</Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <Card kicker="Ajustes" title="Informe semanal" className="mt-6">
        <fieldset disabled={!canWrite} className="flex flex-wrap items-end gap-4">
          <Field label="Correo para el informe" hint="Vacío = los administradores de la empresa">
            <Input type="email" className="!w-72" value={cfg.email} onChange={(e) => setCfg({ ...cfg, email: e.target.value })} />
          </Field>
          <Switch checked={cfg.useAi} onChange={(v) => setCfg({ ...cfg, useAi: v })} label="Afinar con IA (una consulta por semana)" showLabel />
          {canWrite && <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>Guardar</Button>}
        </fieldset>
      </Card>
    </>
  );
}
