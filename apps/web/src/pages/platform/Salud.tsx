import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { RefreshCw, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Button, Card, Field, Input, Loading, PageHeader } from '../../components/ui';

/**
 * Salud de la plataforma: gasto de IA que pagamos nosotros, MongoDB, Render,
 * Redis, cupos gratis y empresas en riesgo, en semáforos. Todo se calcula con
 * reglas en el servidor (sin IA). Cada 10 minutos queda una foto (30 días).
 */

type Level = 'OK' | 'WARN' | 'CRIT' | 'NA';
interface Check { key: string; area: string; title: string; level: Level; value: string; detail: string; advice?: string }
interface View {
  at: string;
  env: 'prod' | 'local';
  summary: { level: Level; crit: number; warn: number };
  checks: Check[];
  metrics: {
    trm: number;
    ai: { top: Array<{ companyId: string; name: string; usd: number }> };
    mongo: { collections: Array<{ name: string; mb: number; count: number }> } | null;
    companies: Array<{ id: string; name: string; reasons: string[] }>;
  };
  config: Record<string, number | string>;
}
interface Point { at: string; p95Ms: number | null; rssMb: number | null; mongoMb: number | null; redisMb: number | null; aiTodayUsd: number | null }

const AREAS: Array<{ key: string; title: string; hint: string }> = [
  { key: 'IA', title: 'Inteligencia artificial', hint: 'Lo que pagamos nosotros, no las empresas' },
  { key: 'MONGO', title: 'MongoDB Atlas', hint: 'Espacio de la base de datos' },
  { key: 'RENDER', title: 'Servidor (Render)', hint: 'Velocidad, memoria y estabilidad' },
  { key: 'REDIS', title: 'Redis y colas', hint: 'Por donde pasan los mensajes de WhatsApp' },
  { key: 'CUPOS', title: 'Cupos gratis de IA', hint: 'Registro y acompañamiento' },
  { key: 'EMPRESAS', title: 'Empresas', hint: 'Las que necesitan una llamada' },
];

const TONE: Record<Level, { box: string; dot: string; label: string }> = {
  OK: { box: 'border-line', dot: 'bg-ok', label: 'Bien' },
  WARN: { box: 'border-warn bg-warn-soft', dot: 'bg-warn', label: 'Atención' },
  CRIT: { box: 'border-bad bg-bad-soft', dot: 'bg-bad', label: 'Urgente' },
  NA: { box: 'border-line', dot: 'bg-line', label: 'Sin dato' },
};

const CONFIG_FIELDS: Array<{ group: string; fields: Array<{ key: string; label: string; hint?: string; text?: boolean }> }> = [
  { group: 'IA (US$)', fields: [
    { key: 'aiMonthlyBudgetUsd', label: 'Presupuesto del mes' },
    { key: 'aiDailyBudgetUsd', label: 'Tope por día' },
    { key: 'aiSpikeFactor', label: 'Pico: veces el promedio' },
    { key: 'openrouterMinCreditUsd', label: 'Saldo mínimo OpenRouter' },
  ] },
  { group: 'Planes contratados', fields: [
    { key: 'mongoLimitMb', label: 'MongoDB (MB)', hint: 'M0 = 512 · M10 = 10240' },
    { key: 'renderPlan', label: 'Plan de Render', text: true, hint: 'Free, Starter, Standard…' },
    { key: 'renderRamMb', label: 'RAM de Render (MB)', hint: 'Free/Starter = 512 · Standard = 2048' },
    { key: 'redisLimitMb', label: 'Redis (MB) si no lo informa', hint: 'Key Value Free = 25' },
    { key: 'openrouterFreeDailyLimit', label: 'Cupo diario OpenRouter' },
  ] },
  { group: 'Umbrales', fields: [
    { key: 'p95WarnMs', label: 'Lento desde (ms)' },
    { key: 'p95CritMs', label: 'Muy lento desde (ms)' },
    { key: 'ramWarnPct', label: 'Memoria amarilla (%)' },
    { key: 'mongoWarnPct', label: 'MongoDB amarilla (%)' },
    { key: 'errorWarnPct', label: 'Errores amarilla (%)' },
    { key: 'upgradeAfterDays', label: 'Días malos para subir plan' },
    { key: 'inactiveDays', label: 'Empresa sin movimiento (días)' },
    { key: 'invoiceOverdueDays', label: 'Factura vencida (días)' },
  ] },
];

/** Línea simple de 30 días (sin librerías). */
function Spark({ points, label, unit, limit }: { points: Array<number | null>; label: string; unit: string; limit?: number }) {
  const vals = points.filter((v): v is number => v != null);
  const last = vals[vals.length - 1];
  const max = Math.max(1, limit ?? 0, ...vals);
  const w = 260;
  const h = 56;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  let d = '';
  points.forEach((v, i) => {
    if (v == null) return;
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    d += `${d ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div className="border-2 border-line bg-paper p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="kicker">{label}</p>
        <p className="text-sm font-semibold tabular-nums">{last == null ? '—' : `${last}${unit}`}</p>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 h-14 w-full" preserveAspectRatio="none" aria-hidden>
        {limit ? <line x1="0" x2={w} y1={h - (limit / max) * (h - 4) - 2} y2={h - (limit / max) * (h - 4) - 2} stroke="currentColor" strokeDasharray="4 4" className="text-bad" strokeWidth="1" /> : null}
        <path d={d} fill="none" stroke="currentColor" strokeWidth="2" className="text-ink" />
      </svg>
      <p className="text-[11px] text-ink-3">{vals.length ? `Máx. ${Math.max(...vals)}${unit} en el periodo` : 'Aún sin historial'}{limit ? ` · límite ${limit}${unit}` : ''}</p>
    </div>
  );
}

export default function Salud() {
  const queryClient = useQueryClient();
  const [showConfig, setShowConfig] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const { data, isFetching, refetch } = useQuery({ queryKey: ['health'], queryFn: () => api.get<View>('/platform/health'), refetchInterval: 5 * 60_000 });
  const { data: history } = useQuery({ queryKey: ['health-history'], queryFn: () => api.get<Point[]>('/platform/health/history?days=30') });
  useEffect(() => {
    if (data && !Object.keys(form).length) setForm(Object.fromEntries(Object.entries(data.config).map(([k, v]) => [k, String(v)])));
  }, [data, form]);
  const save = useMutation({
    mutationFn: () => api.put('/platform/health/config', Object.fromEntries(Object.entries(form).map(([k, v]) => [k, k === 'renderPlan' ? v : Number(v)]))),
    onSuccess: async () => {
      toast.success('Umbrales guardados');
      setShowConfig(false);
      await api.get('/platform/health?refresh=1').then((v) => queryClient.setQueryData(['health'], v));
      queryClient.invalidateQueries({ queryKey: ['health-summary'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!data) return <Loading label="Midiendo la plataforma…" />;
  const s = data.summary;
  const h = history ?? [];
  const cfg = data.config;

  return (
    <>
      <PageHeader
        kicker={`Medido ${timeAgo(data.at)} · se mide solo cada 10 min${data.env === 'local' ? ' · ESTE ES TU COMPUTADOR, no producción' : ''}`}
        title="Salud de"
        accent="la plataforma"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowConfig((v) => !v)}><Settings2 size={14} /> Planes y umbrales</Button>
            <Button disabled={isFetching} onClick={() => api.get<View>('/platform/health?refresh=1').then((v) => queryClient.setQueryData(['health'], v)).catch(() => refetch())}>
              <RefreshCw size={14} className={clsx(isFetching && 'animate-spin')} /> Medir ahora
            </Button>
          </div>
        }
      />

      <div className={clsx('mb-6 flex flex-wrap items-center gap-4 border-2 p-4', TONE[s.level].box)}>
        <span className={clsx('h-5 w-5 shrink-0', TONE[s.level].dot)} aria-hidden />
        <p className="display text-2xl">{s.level === 'OK' ? 'Todo en verde' : s.level === 'CRIT' ? `${s.crit} urgente${s.crit === 1 ? '' : 's'}` : `${s.warn} para revisar`}</p>
        <p className="text-sm text-ink-2">{s.crit} en rojo · {s.warn} en amarillo · TRM usada ${Math.round(data.metrics.trm).toLocaleString('es-CO')}</p>
      </div>

      {showConfig && (
        <Card kicker="Lo que tienes contratado y cuándo avisar" title="Planes y umbrales" className="mb-6">
          <div className="space-y-4">
            {CONFIG_FIELDS.map((g) => (
              <div key={g.group}>
                <p className="kicker mb-2">{g.group}</p>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {g.fields.map((f) => (
                    <Field key={f.key} label={f.label} hint={f.hint}>
                      <Input inputMode={f.text ? 'text' : 'decimal'} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                    </Field>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowConfig(false)}>Cancelar</Button>
              <Button disabled={save.isPending} onClick={() => save.mutate()}>Guardar</Button>
            </div>
          </div>
        </Card>
      )}

      <div className="space-y-6">
        {AREAS.map((area) => {
          const checks = data.checks.filter((c) => c.area === area.key);
          if (!checks.length) return null;
          return (
            <section key={area.key}>
              <div className="mb-2 flex items-end justify-between gap-2">
                <div>
                  <p className="kicker">{area.hint}</p>
                  <h2 className="display text-2xl">{area.title}</h2>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {checks.map((c) => (
                  <div key={c.key} className={clsx('border-2 p-4', TONE[c.level].box)}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold">{c.title}</p>
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] uppercase tracking-wider">
                        <span className={clsx('h-2.5 w-2.5', TONE[c.level].dot)} aria-hidden />{TONE[c.level].label}
                      </span>
                    </div>
                    <p className="mt-1 text-lg font-semibold tabular-nums">{c.value}</p>
                    <p className="mt-1 text-xs text-ink-2">{c.detail}</p>
                    {c.advice && <p className="mt-2 border-t border-line pt-2 text-xs font-semibold">{c.advice}</p>}
                  </div>
                ))}
              </div>

              {area.key === 'IA' && data.metrics.ai.top.length > 0 && (
                <div className="mt-3 border-2 border-line bg-paper p-3 text-sm">
                  <p className="kicker mb-1">Quién más gasta este mes</p>
                  <ul className="divide-y divide-line">
                    {data.metrics.ai.top.map((t) => (
                      <li key={t.companyId} className="flex justify-between py-1">
                        <Link to={`/platform/companies/${t.companyId}`} className="underline">{t.name}</Link>
                        <span className="tabular-nums">US${t.usd.toFixed(2)} · ${Math.round(t.usd * data.metrics.trm).toLocaleString('es-CO')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {area.key === 'MONGO' && !!data.metrics.mongo?.collections.length && (
                <div className="mt-3 border-2 border-line bg-paper p-3 text-sm">
                  <p className="kicker mb-1">Lo que más pesa</p>
                  <ul className="grid gap-x-6 sm:grid-cols-2">
                    {data.metrics.mongo.collections.map((x) => (
                      <li key={x.name} className="flex justify-between border-b border-line py-1"><span>{x.name}</span><span className="tabular-nums text-ink-2">{x.mb} MB · {x.count.toLocaleString('es-CO')} registros</span></li>
                    ))}
                  </ul>
                </div>
              )}

              {area.key === 'EMPRESAS' && data.metrics.companies.length > 0 && (
                <div className="mt-3 border-2 border-line bg-paper p-3 text-sm">
                  <ul className="divide-y divide-line">
                    {data.metrics.companies.map((x) => (
                      <li key={x.id} className="flex flex-wrap justify-between gap-2 py-1.5">
                        <Link to={`/platform/companies/${x.id}`} className="font-semibold underline">{x.name}</Link>
                        <span className="text-xs text-bad">{x.reasons.join(' · ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })}

        <section>
          <p className="kicker">Últimos 30 días · una foto cada 10 minutos</p>
          <h2 className="display mb-2 text-2xl">Historial</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Spark label="Velocidad (95%)" unit=" ms" points={h.map((p) => p.p95Ms)} limit={Number(cfg.p95WarnMs)} />
            <Spark label="Memoria del servidor" unit=" MB" points={h.map((p) => p.rssMb)} limit={Number(cfg.renderRamMb)} />
            <Spark label="MongoDB" unit=" MB" points={h.map((p) => p.mongoMb)} limit={Number(cfg.mongoLimitMb)} />
            <Spark label="Redis" unit=" MB" points={h.map((p) => p.redisMb)} />
            <Spark label="IA de hoy (US$)" unit="" points={h.map((p) => (p.aiTodayUsd == null ? null : Math.round(p.aiTodayUsd * 100) / 100))} limit={Number(cfg.aiDailyBudgetUsd)} />
          </div>
        </section>
      </div>
    </>
  );
}
