import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, Copy, Link2, RefreshCw, Trash2 } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney, fmtNum } from '../../lib/format';
import { AdsSpendChart } from '../../components/charts';
import { Badge, Button, Card, Field, Input, Select, Stat } from '../../components/ui';

/**
 * Publicidad → Resultados: la pauta propia de BackOffice por campaña y por
 * anuncio. Gasto y métricas de Meta (en vivo, con caché de 12 min) cruzados
 * con lo que pasó en el registro: visitas, registros, empresas, pagos.
 * Solo lectura: pausar y activar siguen en la tabla de siempre, con confirmación.
 */

export type RangePreset = 'today' | '7' | '14' | '30' | 'custom';
export interface RangeQuery { range: RangePreset; since?: string; until?: string }

export interface Funnel { visits: number; started: number; completed: number; companies: number; paying: number; revenue: number }
export interface Derived { ctr: number | null; cpc: number | null; cpm: number | null; costPerSignup: number | null; cac: number | null; roas: number | null }
interface Video { plays3s: number; p25: number; p50: number; p75: number; p100: number; thruplay: number }
interface Metrics { spend: number; impressions: number; reach: number; frequency: number | null; linkClicks: number; video: Video }
interface Delivery { code: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info'; reason: string | null }
interface Pace { budgetType: 'DAILY' | 'LIFETIME' | null; budget: number | null; spent: number; consumedPct: number | null; startDate: string | null; endDate: string | null; daysLeft: number | null; projected: number | null }
export interface AdRow { id: string; name: string; utmContent: string | null; link: string | null; delivery: Delivery; metrics: Metrics; funnel: Funnel; derived: Derived }
export interface CampaignRow {
  id: string; name: string; status: string; effectiveStatus: string; objective: string; delivery: Delivery; launchId: string | null;
  utms: string[]; manualUtms: string[]; metrics: Metrics; funnel: Funnel; unmatchedAds: Funnel; derived: Derived; pace: Pace; endsAt: string | null; ads: AdRow[];
}
export interface Results {
  range: { preset: RangePreset; since: string; until: string; days: number; timezone: string };
  connected: boolean;
  account: { id: string; name: string; currency: string; timezone: string; status: number } | null;
  error: { kind: string; message: string } | null;
  cachedAt: string | null;
  currency: string;
  totals: { spend: number; metaSpend: number; manualSpend: number; impressions: number; reach: number; frequency: number | null; linkClicks: number; funnel: Funnel; derived: Derived; visitsAll: number; revenueOtherCurrency: boolean };
  daily: Array<{ date: string; spend: number; results: number }>;
  campaigns: CampaignRow[];
  unattributed: Array<{ utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; utmContent: string | null; utmId: string | null; fbclid: boolean; funnel: Funnel; manualSpend: number }>;
  signups: Array<{ id: string; createdAt: string; companyId: string | null; companyName: string | null; rubro: string | null; status: string; campaignId: string | null; campaignName: string | null; adId: string | null; adName: string | null; via: string | null; utmCampaign: string | null; utmContent: string | null }>;
  alerts: Array<{ kind: string; severity: 'bad' | 'warn' | 'info'; title: string; detail: string; campaignId?: string }>;
  thresholds: Thresholds;
  mappings: Record<string, string[]>;
  manual: Array<{ id: string; date: string; campaign: string; spend: number; notes: string }>;
}
export interface Thresholds { spendWithoutSignup: number; maxFrequency: number; minLinkCtr: number; minImpressionsForCtr: number; endingHours: number }

/** «—» cuando no hay valor (denominador 0): nunca Infinity ni 0 inventado. */
const dash = (v: number | null | undefined, f: (n: number) => string) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : f(v));
const pct = (v: number | null | undefined, d = 2) => dash(v, (n) => `${n.toLocaleString('es-CO', { maximumFractionDigits: d })} %`);
const times = (v: number | null | undefined) => dash(v, (n) => `${n.toLocaleString('es-CO', { maximumFractionDigits: 2 })}x`);
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });

/** Hoy en la zona de la cuenta (Intl, nunca toISOString). */
export function todayInZone(tz: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Bogota' }).format(now);
}

const PRESETS: Array<[RangePreset, string]> = [['today', 'Hoy'], ['7', '7 días'], ['14', '14 días'], ['30', '30 días'], ['custom', 'Personalizado']];
const ALERT_TONE: Record<string, string> = { bad: 'border-bad bg-bad-soft', warn: 'border-warn bg-warn-soft', info: 'border-info bg-info-soft' };

export function RangePicker({ value, tz, onChange }: { value: RangeQuery; tz: string; onChange: (q: RangeQuery) => void }) {
  const today = todayInZone(tz);
  const [since, setSince] = useState(value.since ?? today);
  const [until, setUntil] = useState(value.until ?? today);
  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label="Rango de fechas">
      <div className="flex flex-wrap pl-0.5 pt-0.5">
        {PRESETS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={value.range === id}
            className={clsx('-ml-0.5 -mt-0.5 cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.06em]', value.range === id ? 'bg-ink text-bone' : 'bg-paper text-ink hover:bg-bone-2')}
            onClick={() => onChange(id === 'custom' ? { range: 'custom', since, until } : { range: id })}
          >
            {label}
          </button>
        ))}
      </div>
      {value.range === 'custom' && (
        <>
          <Input type="date" className="!w-40" aria-label="Desde" value={since} max={until} onChange={(e) => setSince(e.target.value)} />
          <Input type="date" className="!w-40" aria-label="Hasta" value={until} max={today} onChange={(e) => setUntil(e.target.value)} />
          <Button size="sm" variant="outline" disabled={!since || !until || since > until} onClick={() => onChange({ range: 'custom', since, until })}>Aplicar</Button>
        </>
      )}
    </div>
  );
}

function FunnelBar({ f }: { f: Funnel }) {
  const steps: Array<[string, number]> = [['Visitas', f.visits], ['Empezaron', f.started], ['Registros', f.completed], ['Empresas', f.companies], ['Pagan', f.paying]];
  const max = Math.max(1, f.visits);
  return (
    <ol className="grid gap-1.5 text-xs" aria-label="Embudo">
      {steps.map(([label, n]) => (
        <li key={label} className="grid grid-cols-[84px_minmax(0,1fr)_48px] items-center gap-2">
          <span className="text-ink-2">{label}</span>
          <span className="h-3 bg-bone-2"><span className="block h-3 bg-ink" style={{ width: `${Math.round((n / max) * 100)}%` }} /></span>
          <span className="text-right font-semibold tabular-nums">{fmtNum(n)}</span>
        </li>
      ))}
    </ol>
  );
}

function PaceBox({ p, money }: { p: Pace; money: (n: number) => string }) {
  if (!p.budgetType) return <p className="text-xs text-ink-3">Sin presupuesto en la campaña ni en sus conjuntos.</p>;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
      <div><dt className="text-ink-3">Presupuesto {p.budgetType === 'LIFETIME' ? 'total' : 'diario'}</dt><dd className="font-semibold tabular-nums">{dash(p.budget, money)}</dd></div>
      <div><dt className="text-ink-3">Gastado desde el inicio</dt><dd className="font-semibold tabular-nums">{money(p.spent)}</dd></div>
      <div><dt className="text-ink-3">Consumido</dt><dd className="font-semibold tabular-nums">{pct(p.consumedPct, 1)}</dd></div>
      <div><dt className="text-ink-3">Termina</dt><dd className="font-semibold">{p.endDate ? day(p.endDate) : 'Sin fecha de fin'}</dd></div>
      <div><dt className="text-ink-3">Días restantes</dt><dd className="font-semibold tabular-nums">{p.daysLeft ?? '—'}</dd></div>
      <div><dt className="text-ink-3">Proyección al cierre</dt><dd className="font-semibold tabular-nums">{dash(p.projected, money)}</dd></div>
    </dl>
  );
}

function AdsCompare({ ads, money }: { ads: AdRow[]; money: (n: number) => string }) {
  if (!ads.length) return <p className="text-xs text-ink-3">Sin anuncios en este rango.</p>;
  const best = ads.filter((a) => a.derived.costPerSignup !== null).sort((a, b) => a.derived.costPerSignup! - b.derived.costPerSignup!)[0]?.id;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-xs">
        <thead>
          <tr className="border-b-2 border-ink text-left uppercase tracking-[0.08em] text-ink-3">
            <th className="py-1.5">Anuncio</th><th className="px-2 py-1.5 text-right whitespace-nowrap">Gasto</th><th className="px-2 py-1.5 text-right whitespace-nowrap">Clics · CTR</th><th className="px-2 py-1.5 text-right whitespace-nowrap">CPC</th>
            <th className="px-2 py-1.5 text-right whitespace-nowrap">Video 3 s · ThruPlay</th><th className="px-2 py-1.5 text-right whitespace-nowrap">25/50/75/100 %</th>
            <th className="px-2 py-1.5 text-right whitespace-nowrap">Visitas</th><th className="px-2 py-1.5 text-right whitespace-nowrap">Registros</th><th className="px-2 py-1.5 text-right whitespace-nowrap">Costo/registro</th><th className="px-2 py-1.5 text-right whitespace-nowrap">Pagan</th>
          </tr>
        </thead>
        <tbody>
          {ads.map((a) => (
            <tr key={a.id} className={clsx('border-b border-line', a.id === best && ads.length > 1 && 'bg-ok-soft')}>
              <td className="py-1.5 pr-2">
                <span className="font-semibold">{a.name}</span> <Badge tone={a.delivery.tone}>{a.delivery.label}</Badge>
                {a.id === best && ads.length > 1 && <span className="ml-1 text-ok">mejor costo por registro</span>}
                {a.delivery.reason && <span className="block text-bad">{a.delivery.reason}</span>}
                {a.utmContent && <span className="block text-ink-3">utm_content: {a.utmContent}</span>}
              </td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{money(a.metrics.spend)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{fmtNum(a.metrics.linkClicks)} · {pct(a.derived.ctr)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{dash(a.derived.cpc, money)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{fmtNum(a.metrics.video.plays3s)} · {fmtNum(a.metrics.video.thruplay)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{[a.metrics.video.p25, a.metrics.video.p50, a.metrics.video.p75, a.metrics.video.p100].map(fmtNum).join(' / ')}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{fmtNum(a.funnel.visits)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{fmtNum(a.funnel.completed)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{dash(a.derived.costPerSignup, money)}</td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{fmtNum(a.funnel.paying)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResultsView({ data, query, onQuery, onRefresh, refreshing, onStatus }: {
  data: Results; query: RangeQuery; onQuery: (q: RangeQuery) => void; onRefresh: () => void; refreshing: boolean;
  onStatus: (c: CampaignRow) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [assign, setAssign] = useState<Record<string, string>>({});
  const cur = data.currency;
  const money = (n: number) => fmtMoney(n, cur);
  const t = data.totals;
  const mapping = useMutation({
    mutationFn: (body: { campaignId: string; utmCampaign: string; remove?: boolean }) => api.put('/platform/ads/mappings', body),
    onSuccess: (_r, v) => { toast.success(v.remove ? 'Asignación quitada' : 'Asignado a la campaña'); queryClient.invalidateQueries({ queryKey: ['ads'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo asignar'),
  });
  const ageMin = data.cachedAt ? Math.max(0, Math.round((Date.now() - Date.parse(data.cachedAt)) / 60000)) : null;

  return (
    <div className="min-w-0 space-y-6 [&>*]:min-w-0" data-testid="ads-results">
      <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper px-4 py-3">
        <p className="min-w-0 text-sm [overflow-wrap:anywhere]" data-testid="ads-account">
          {data.account
            ? <>Leyendo <b>{data.account.name}</b> · <span className="font-mono text-xs">{data.account.id}</span> · {data.account.currency} · {data.account.timezone}</>
            : data.connected ? 'Cuenta conectada, pero Meta no respondió (abajo el motivo).' : 'Sin cuenta de Meta conectada: se muestran los registros y el gasto anotado a mano.'}
          <span className="block text-xs text-ink-3">
            {data.range.since === data.range.until ? day(data.range.since) : `${day(data.range.since)} – ${day(data.range.until)}`} · hora de {data.range.timezone}
            {ageMin !== null && <> · datos de Meta de hace {ageMin} min</>}
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <RangePicker value={query} tz={data.range.timezone} onChange={onQuery} />
          {data.connected && <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh} aria-label="Actualizar datos de Meta"><RefreshCw size={13} className={clsx(refreshing && 'animate-spin')} /> Actualizar</Button>}
        </div>
      </div>

      {data.error && (
        <p role="alert" className="border-2 border-bad bg-bad-soft px-4 py-3 text-sm text-bad">
          <b>No pudimos leer Meta.</b> {data.error.message}
        </p>
      )}

      {data.alerts.length > 0 && (
        <ul className="space-y-2" aria-label="Alertas" data-testid="ads-alerts">
          {data.alerts.map((a, i) => (
            <li key={`${a.kind}-${a.campaignId ?? ''}-${i}`} className={clsx('border-2 px-4 py-2 text-sm', ALERT_TONE[a.severity])}>
              <b>{a.title}</b>
              <span className="block text-xs text-ink-2">{a.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Gasto" value={money(t.spend)} hint={t.manualSpend ? `incluye ${money(t.manualSpend)} anotado a mano` : data.account ? 'reportado por Meta' : 'sin cuenta de Meta: anota el gasto abajo'} />
        <Stat label="Clics en el enlace" value={fmtNum(t.linkClicks)} hint={`CPC ${dash(t.derived.cpc, money)}`} />
        <Stat label="Registros" value={fmtNum(t.funnel.completed)} hint={`${fmtNum(t.funnel.visits)} visitas desde Meta`} />
        <Stat label="Costo por registro" value={dash(t.derived.costPerSignup, money)} />
        <Stat label="Empresas que pagan" value={fmtNum(t.funnel.paying)} hint={`CAC ${dash(t.derived.cac, money)}`} tone={t.funnel.paying ? 'ok' : undefined} />
        <Stat label="ROAS" value={times(t.derived.roas)} hint={`cobrado ${money(t.funnel.revenue)}`} />
      </div>
      {t.revenueOtherCurrency && <p className="text-xs text-warn">Hay pagos en otra moneda distinta de {cur}: cuentan como empresa que paga, pero no suman al ingreso ni al ROAS.</p>}

      <Card kicker="Día a día" title="Gasto y registros">
        {data.daily.every((d) => !d.spend && !d.results)
          ? <p className="text-sm text-ink-3">Sin gasto ni registros en este rango.</p>
          : <AdsSpendChart data={data.daily} money={money} resultsLabel="Registros" />}
      </Card>

      <Card kicker="Por campaña y por anuncio" title="Qué trajo cada campaña">
        {!data.campaigns.length ? (
          <p className="text-sm text-ink-3">{data.connected ? 'Ninguna campaña gastó ni trajo registros en este rango.' : 'Conecta la cuenta de Meta para ver las campañas.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm" data-testid="ads-campaigns">
              <thead>
                <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  <th className="w-8 py-2" /><th className="py-2">Campaña</th><th className="px-2 py-2 text-right whitespace-nowrap">Gasto</th><th className="px-2 py-2 text-right whitespace-nowrap">Clics · CTR</th>
                  <th className="px-2 py-2 text-right whitespace-nowrap">CPC</th><th className="px-2 py-2 text-right whitespace-nowrap">Visitas</th><th className="px-2 py-2 text-right whitespace-nowrap">Registros</th>
                  <th className="px-2 py-2 text-right whitespace-nowrap">Costo/registro</th><th className="px-2 py-2 text-right whitespace-nowrap">Pagan</th><th className="px-2 py-2 text-right whitespace-nowrap">CAC</th><th className="px-2 py-2 text-right whitespace-nowrap">ROAS</th><th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <Fragment key={c.id}>
                    <tr className="border-b border-line align-top">
                      <td className="py-2.5">
                        <button type="button" className="cursor-pointer" aria-expanded={!!open[c.id]} aria-label={open[c.id] ? 'Ocultar anuncios' : 'Ver anuncios'} onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })}>
                          {open[c.id] ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                      <td className="py-2.5 pr-3">
                        <p className="font-semibold">{c.name}</p>
                        <p className="text-[11px] text-ink-3">
                          <Badge tone={c.delivery.tone}>{c.delivery.label}</Badge>{' '}
                          {c.pace.consumedPct !== null && <>{pct(c.pace.consumedPct, 0)} del presupuesto · </>}
                          {c.pace.daysLeft !== null && <>{c.pace.daysLeft === 0 ? 'termina hoy' : `${c.pace.daysLeft} días restantes`} · </>}
                          {c.launchId ? 'lanzada desde aquí' : 'creada en Meta'}
                        </p>
                        {c.delivery.reason && <p className="text-[11px] text-bad">{c.delivery.reason}</p>}
                      </td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{money(c.metrics.spend)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{fmtNum(c.metrics.linkClicks)} · {pct(c.derived.ctr)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{dash(c.derived.cpc, money)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{fmtNum(c.funnel.visits)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap font-semibold tabular-nums">{fmtNum(c.funnel.completed)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{dash(c.derived.costPerSignup, money)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{fmtNum(c.funnel.paying)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{dash(c.derived.cac, money)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap tabular-nums">{times(c.derived.roas)}</td>
                      <td className="px-2 py-2.5 text-right whitespace-nowrap">
                        {['ACTIVE', 'PAUSED'].includes(c.status) && (
                          <Button size="sm" variant="ghost" onClick={() => onStatus(c)}>{c.status === 'ACTIVE' ? 'Pausar' : 'Activar'}</Button>
                        )}
                      </td>
                    </tr>
                    {open[c.id] && (
                      <tr className="border-b-2 border-ink bg-bone">
                        <td />
                        <td colSpan={11} className="space-y-4 py-4 pr-3">
                          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                            <div><p className="kicker mb-2">Ritmo</p><PaceBox p={c.pace} money={money} /></div>
                            <div><p className="kicker mb-2">Embudo en el rango</p><FunnelBar f={c.funnel} /></div>
                          </div>
                          <div>
                            <p className="kicker mb-2">Anuncios de esta campaña</p>
                            <AdsCompare ads={c.ads} money={money} />
                            {c.unmatchedAds.visits > 0 && <p className="mt-1 text-xs text-ink-3">{fmtNum(c.unmatchedAds.visits)} visitas de esta campaña no traían un utm_content que coincida con un anuncio.</p>}
                          </div>
                          <div className="text-xs">
                            <p className="kicker mb-1">utm_campaign que cuentan para esta campaña</p>
                            <p className="flex flex-wrap gap-1.5">
                              {c.utms.length ? c.utms.map((u) => (
                                <span key={u} className="inline-flex items-center gap-1 border border-line bg-paper px-1.5 py-0.5 font-mono">
                                  {u}
                                  {c.manualUtms.includes(u) && <button type="button" aria-label={`Quitar ${u}`} className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => mapping.mutate({ campaignId: c.id, utmCampaign: u, remove: true })}><Trash2 size={11} /></button>}
                                </span>
                              )) : <span className="text-ink-3">Ninguno: solo cruza por utm_id o por el nombre.</span>}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">
          Un registro cuenta para una campaña por, en este orden: utm_id igual al ID de la campaña · utm_campaign de un lanzamiento hecho aquí · asignación manual · utm_campaign del enlace del anuncio en Meta · nombre de la campaña.
        </p>
      </Card>

      <Card kicker="Llegaron desde Meta" title="Sin atribuir">
        {!data.unattributed.length ? (
          <p className="text-sm text-ink-3">Todo lo que llegó desde Meta en este rango quedó asignado a una campaña.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-testid="ads-unattributed">
              <thead>
                <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  <th className="py-2">Origen</th><th className="px-2 py-2 text-right whitespace-nowrap">Visitas</th><th className="px-2 py-2 text-right whitespace-nowrap">Registros</th><th className="px-2 py-2 text-right whitespace-nowrap">Empresas</th><th className="py-2 pl-4">Asignar a campaña</th>
                </tr>
              </thead>
              <tbody>
                {data.unattributed.map((u) => {
                  const key = u.utmCampaign ?? '';
                  return (
                    <tr key={key || 'sin-utm'} className="border-b border-line align-top">
                      <td className="py-2 pr-3 font-mono text-xs">
                        {u.utmCampaign ? <>utm_campaign={u.utmCampaign}</> : <span className="font-sans text-ink-3">Sin utm_campaign{u.fbclid ? ' (llegó con fbclid de Meta)' : ''}</span>}
                        <span className="block text-ink-3">{[u.utmSource && `utm_source=${u.utmSource}`, u.utmMedium && `utm_medium=${u.utmMedium}`, u.utmContent && `utm_content=${u.utmContent}`, u.utmId && `utm_id=${u.utmId}`].filter(Boolean).join(' · ')}</span>
                      </td>
                      <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">{fmtNum(u.funnel.visits)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">{fmtNum(u.funnel.completed)}</td>
                      <td className="px-2 py-2 text-right whitespace-nowrap tabular-nums">{fmtNum(u.funnel.companies)}</td>
                      <td className="py-2 pl-4">
                        {u.utmCampaign && data.campaigns.length > 0 ? (
                          <span className="flex gap-1.5">
                            <Select className="!w-56 !py-1 text-xs" aria-label={`Campaña para ${u.utmCampaign}`} value={assign[key] ?? ''} onChange={(e) => setAssign({ ...assign, [key]: e.target.value })}>
                              <option value="">Elegir campaña…</option>
                              {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </Select>
                            <Button size="sm" variant="outline" disabled={!assign[key] || mapping.isPending} onClick={() => mapping.mutate({ campaignId: assign[key], utmCampaign: u.utmCampaign! })}>Asignar</Button>
                          </span>
                        ) : <span className="text-xs text-ink-3">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card kicker="Quiénes se registraron" title="Registros atribuidos">
        {!data.signups.length ? <p className="text-sm text-ink-3">Nadie terminó el registro desde Meta en este rango.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-testid="ads-signups">
              <thead>
                <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  <th className="py-2">Fecha</th><th className="py-2">Empresa</th><th className="py-2">Rubro</th><th className="py-2">Estado</th><th className="py-2">Campaña · anuncio</th>
                </tr>
              </thead>
              <tbody>
                {data.signups.map((s) => (
                  <tr key={s.id} className="border-b border-line">
                    <td className="py-2 pr-2 text-xs tabular-nums">{new Date(s.createdAt).toLocaleString('es-CO', { timeZone: data.range.timezone, dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="py-2 pr-2">{s.companyId ? <Link className="font-semibold underline-offset-2 hover:underline" to={`/platform/companies/${s.companyId}`}>{s.companyName ?? 'Empresa'}</Link> : <span className="text-ink-3">{s.companyName ?? '—'}</span>}</td>
                    <td className="py-2 pr-2 text-xs">{s.rubro ?? '—'}</td>
                    <td className="py-2 pr-2"><Badge tone={s.status === 'PAGÓ' ? 'ok' : s.status === 'ACTIVA' ? 'info' : 'neutral'}>{s.status}</Badge></td>
                    <td className="py-2 text-xs">
                      {s.campaignName ? <>{s.campaignName}{s.adName ? <> · {s.adName}</> : null}<span className="block text-ink-3">por {s.via}</span></> : <span className="text-ink-3">Sin atribuir{s.utmCampaign ? ` (${s.utmCampaign})` : ''}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Enlace con seguimiento para los anuncios creados en el Administrador de anuncios de Meta. */
export function TrackingLink({ base }: { base: string }) {
  const [campaign, setCampaign] = useState('');
  const slug = campaign.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '').slice(0, 60) || 'nombre_campana';
  const url = `${base}?utm_source=meta&utm_medium=paid_social&utm_campaign=${slug}`;
  const tags = 'utm_id={{campaign.id}}&utm_content={{ad.name}}';
  const copy = (text: string, msg: string) => {
    navigator.clipboard?.writeText(text).then(() => toast.success(msg), () => toast.error('No se pudo copiar: selecciónalo y cópialo a mano'));
  };
  return (
    <Card kicker="Para los anuncios creados en Meta" title="Enlace con seguimiento">
      <Field label="Nombre corto de la campaña" hint="Va en utm_campaign">
        <Input value={campaign} placeholder="Prueba 3 días registro" onChange={(e) => setCampaign(e.target.value)} />
      </Field>
      <p className="kicker mb-1 mt-3">1 · URL del sitio web</p>
      <div className="flex items-center gap-2 border-2 border-line bg-bone px-3 py-2 text-xs">
        <Link2 size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono">{url}</span>
        <button type="button" className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Copiar URL" onClick={() => copy(url, 'URL copiada')}><Copy size={13} /></button>
      </div>
      <p className="kicker mb-1 mt-3">2 · Parámetros de URL (en el anuncio, «Seguimiento»)</p>
      <div className="flex items-center gap-2 border-2 border-line bg-bone px-3 py-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono">{tags}</span>
        <button type="button" className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Copiar parámetros" onClick={() => copy(tags, 'Parámetros copiados')}><Copy size={13} /></button>
      </div>
      <p className="mt-2 text-xs text-ink-3">Con los parámetros, Meta agrega el ID de la campaña y el nombre del anuncio en cada clic: cada registro cae en su campaña y su anuncio sin asignar nada a mano.</p>
    </Card>
  );
}

/** Umbrales de las alertas (Configuración). */
export function AlertSettings({ value, currency }: { value: Thresholds; currency: string }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    spendWithoutSignup: String(value.spendWithoutSignup), maxFrequency: String(value.maxFrequency), minLinkCtr: String(value.minLinkCtr).replace('.', ','),
    minImpressionsForCtr: String(value.minImpressionsForCtr), endingHours: String(value.endingHours),
  });
  const save = useMutation({
    mutationFn: () => api.put<Thresholds>('/platform/ads/alerts', form),
    onSuccess: () => { toast.success('Alertas guardadas'); queryClient.invalidateQueries({ queryKey: ['ads'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo guardar'),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <Card kicker="Resultados" title="Alertas de la pauta">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Gasto sin ningún registro (${currency})`} hint="Avisa cuando una campaña gasta esto sin registros"><Input inputMode="numeric" value={form.spendWithoutSignup} onChange={set('spendWithoutSignup')} /></Field>
        <Field label="Frecuencia máxima" hint="Veces que la misma persona ve el anuncio"><Input inputMode="decimal" value={form.maxFrequency} onChange={set('maxFrequency')} /></Field>
        <Field label="CTR del enlace mínimo (%)" hint="Por debajo, la pieza o el público no conectan"><Input inputMode="decimal" value={form.minLinkCtr} onChange={set('minLinkCtr')} /></Field>
        <Field label="Impresiones antes de juzgar el CTR"><Input inputMode="numeric" value={form.minImpressionsForCtr} onChange={set('minImpressionsForCtr')} /></Field>
        <Field label="Avisar cuando falten (horas)" hint="Para campañas con fecha de fin"><Input inputMode="numeric" value={form.endingHours} onChange={set('endingHours')} /></Field>
      </div>
      <Button className="mt-3" disabled={save.isPending} onClick={() => save.mutate()}>Guardar alertas</Button>
    </Card>
  );
}
