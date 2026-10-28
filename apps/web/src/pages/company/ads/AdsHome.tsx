import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { AdsSpendChart } from '../../../components/charts';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Stat, Switch, Tabs } from '../../../components/ui';
import { PickCompany, useCompanyScope, withScope } from '../shared';
import { OpportunityList } from '../../../components/opportunities/Opportunities';

/**
 * Publicidad (BackOffice Creative Ads): resultados, cuentas, campañas,
 * oportunidades (auditoría), Autopilot, leads y ventas, y nuevas campañas.
 * Todo lo que gasta dinero pasa por una confirmación explícita.
 */

type Mode = 'REAL' | 'DEMO';
/** results/costPerResult pueden venir en null: el periodo mezcla objetivos o el objetivo no busca resultados. */
interface Totals { spend: number; impressions: number; clicks: number; results: number | null; leads: number; conversations: number; purchases: number; purchaseValue: number; ctr: number | null; cpc: number | null; cpm: number | null; costPerResult: number | null; platformRoas: number | null; days: number; resultLabel?: string; reach?: number | null; frequency?: number | null }
interface Account {
  id: string; provider: string; mode: Mode; externalId: string; name: string; currency: string; status: string; lastSyncAt: string | null; lastError: string | null; dataAgeHours: number | null; stale: boolean; hasToken: boolean;
  lastSyncStatus?: 'OK' | 'PARTIAL' | 'ERROR' | null; lastErrorKind?: string | null; errorHelp?: string | null; nextSyncAt?: string | null; credential?: string; syncing?: boolean; scopes?: string[];
}
interface Overview {
  mode: Mode; modes: { real: number; demo: number }; days: number; period: { current: { since: string; until: string }; previous: { since: string; until: string } };
  currency: string | null; mixedCurrencies: boolean; accounts: Account[]; totals: Totals; previous: Totals; deltas: Record<string, number | null>; insufficient: boolean;
  comparable?: boolean; notes?: string[]; resultLabel?: string | null;
  daily: Array<{ date: string; spend: number; results: number }>; campaigns: Array<Totals & { id: string; externalId: string; name: string; status: string | null; objective: string | null; dailyBudget: number | null }>;
  configuredDailyBudget: number; openFindings: number; pendingActions: number; executedActions: number;
}

/** Pestañas de la vista del equipo BackOffice (como siempre). */
const TABS = [
  { id: 'resumen', label: 'Resultados' }, { id: 'cuentas', label: 'Cuentas' }, { id: 'campanas', label: 'Campañas' },
  { id: 'oportunidades', label: 'Oportunidades' }, { id: 'autopilot', label: 'Autopilot' }, { id: 'leads', label: 'Leads y ventas' },
  { id: 'nueva', label: 'Nueva campaña' },
];

/** Secciones de Ads Intelligence (el menú lateral las lista; aquí solo se titula la pantalla). */
const SECTIONS: Record<string, { kicker: string; title: string }> = {
  resumen: { kicker: 'Resumen publicitario', title: 'Resultados' },
  campanas: { kicker: 'Campañas y cuentas', title: 'Campañas' },
  nueva: { kicker: 'Campañas y cuentas', title: 'Nueva campaña' },
  cuentas: { kicker: 'Campañas y cuentas', title: 'Cuentas publicitarias' },
  oportunidades: { kicker: 'Inteligencia y oportunidades', title: 'Oportunidades' },
  autopilot: { kicker: 'Automatización publicitaria', title: 'Autopilot y reglas' },
  leads: { kicker: 'Leads, ventas y atribución', title: 'Leads y ventas' },
};

const PROVIDER: Record<string, string> = { META: 'Meta Ads', GOOGLE: 'Google Ads', TIKTOK: 'TikTok Ads' };
const OBJECTIVE: Record<string, string> = { MESSAGES: 'conversaciones por WhatsApp', LEADS: 'formularios de contacto', SALES: 'ventas', TRAFFIC: 'visitas a la web', AWARENESS: 'reconocimiento de marca' };
const qs = (q: string, extra: Record<string, string | undefined>) => {
  const p = new URLSearchParams(q);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function money(v: number | null | undefined, currency = 'COP') {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return currency === 'COP' ? `$${Math.round(v).toLocaleString('es-CO')}` : `${v.toLocaleString('es-CO', { maximumFractionDigits: 2 })} ${currency}`;
}
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('es-CO'));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v.toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`);

/** Variación: verde si mejora, rojo si empeora (en costos, subir es peor). */
function Delta({ v, inverse, neutral }: { v: number | null | undefined; inverse?: boolean; neutral?: boolean }) {
  if (v === null || v === undefined) return <span className="text-ink-3">sin comparación</span>;
  const good = inverse ? v < 0 : v > 0;
  return <span className={clsx('font-semibold', Math.abs(v) < 1 || neutral ? 'text-ink-2' : good ? 'text-ok' : 'text-bad')}>{v > 0 ? '+' : ''}{v.toLocaleString('es-CO', { maximumFractionDigits: 1 })} % vs. periodo anterior</span>;
}

function DemoBanner({ mode }: { mode: Mode }) {
  if (mode !== 'DEMO') return null;
  return (
    <div className="mb-5 border-2 border-info bg-info-soft px-4 py-3 text-sm text-info">
      <b>Datos de demostración.</b> Son simulados para que conozcas el producto: no vienen de ninguna cuenta real y las acciones no tocan campañas reales.
    </div>
  );
}

function Confirm({ open, title, children, cta, danger, onClose, onConfirm, busy }: { open: boolean; title: string; children: ReactNode; cta: string; danger?: boolean; onClose: () => void; onConfirm: () => void; busy?: boolean }) {
  return (
    <Modal open={open} onClose={onClose} kicker="Confirmación" title={title}>
      <div className="space-y-4 text-sm">
        {children}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>{busy ? 'Procesando…' : cta}</Button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdsHome() {
  const { ready, q, isPlatform } = useCompanyScope();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') ?? 'resumen') in SECTIONS ? (params.get('tab') ?? 'resumen') : 'resumen';
  const [mode, setMode] = useState<Mode | undefined>(undefined);
  const overview = useQuery({
    queryKey: ['ads-overview', q, mode],
    queryFn: () => api.get<Overview>(`/ads/overview${qs(q, { mode })}`),
    enabled: ready, retry: false,
  });
  if (!ready) return <PickCompany />;
  if (overview.error) return <Card title="Publicidad"><p className="text-sm">{overview.error instanceof Error ? overview.error.message : 'No disponible'} <Link to="/app/mi-plan" className="underline">Ir a Mi plan</Link></p></Card>;
  const o = overview.data;
  const effective = o?.mode ?? 'REAL';
  return (
    <>
      {isPlatform
        ? <PageHeader kicker="Anuncios conectados a tus ventas" title="Publicidad" accent="que se entiende" />
        : <PageHeader kicker={`Ads Intelligence · ${SECTIONS[tab].kicker}`} title={SECTIONS[tab].title} />}
      {o && o.modes.real > 0 && o.modes.demo > 0 && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-ink-3">Ver:</span>
          {(['REAL', 'DEMO'] as Mode[]).map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} className={clsx('cursor-pointer border-2 px-3 py-1', effective === m ? 'border-ink bg-ink text-bone' : 'border-line')}>{m === 'REAL' ? 'Cuentas reales' : 'Demostración'}</button>
          ))}
        </div>
      )}
      {isPlatform && <Tabs tabs={TABS.map((t) => ({ ...t, badge: t.id === 'oportunidades' ? o?.openFindings || undefined : t.id === 'autopilot' ? o?.pendingActions || undefined : undefined }))} active={tab} onChange={(t) => setParams({ tab: t })} />}
      <div className={isPlatform ? 'mt-5' : undefined}>
        {tab !== 'cuentas' && tab !== 'nueva' && o && <DemoBanner mode={effective} />}
        {tab === 'resumen' && (o ? <Summary q={q} mode={effective} base={o} /> : <Loading />)}
        {tab === 'cuentas' && <Accounts q={q} />}
        {tab === 'campanas' && <Campaigns q={q} mode={effective} currency={o?.currency ?? 'COP'} />}
        {tab === 'oportunidades' && <Findings q={q} mode={effective} />}
        {tab === 'autopilot' && <Autopilot q={q} mode={effective} currency={o?.currency ?? 'COP'} />}
        {tab === 'leads' && <Revenue q={q} />}
        {tab === 'nueva' && <Studio q={q} accounts={o?.accounts ?? []} />}
      </div>
    </>
  );
}

/* ── Resultados ── */

function NoAccounts() {
  return (
    <EmptyState
      title="Aún no conectas una cuenta publicitaria"
      hint="Conecta tu cuenta de Meta Ads para ver gasto, resultados y costo por cliente en un solo lugar. Si quieres conocerlo primero, abre una cuenta de demostración."
      action={<Link to="?tab=cuentas" className="inline-block border-2 border-ink bg-ink px-4 py-2 text-sm font-semibold text-bone">Conectar o ver demostración</Link>}
    />
  );
}

function Summary({ q, mode, base }: { q: string; mode: Mode; base: Overview }) {
  const [days, setDays] = useState('30');
  const [account, setAccount] = useState('');
  const [campaign, setCampaign] = useState('');
  const { data: o } = useQuery({
    queryKey: ['ads-overview', q, mode, days, account, campaign],
    queryFn: () => api.get<Overview>(`/ads/overview${qs(q, { mode, days, accountId: account || undefined, campaign: campaign || undefined })}`),
    placeholderData: base,
  });
  if (!o) return <Loading />;
  if (!o.accounts.length) return <NoAccounts />;
  const cur = o.currency ?? 'COP';
  const t = o.totals;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Periodo"><Select value={days} onChange={(e) => setDays(e.target.value)} className="!w-36">{['7', '14', '30', '60'].map((d) => <option key={d} value={d}>Últimos {d} días</option>)}</Select></Field>
        {o.accounts.length > 1 && <Field label="Cuenta"><Select value={account} onChange={(e) => setAccount(e.target.value)} className="!w-52"><option value="">Todas</option>{o.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>}
        <Field label="Campaña"><Select value={campaign} onChange={(e) => setCampaign(e.target.value)} className="!w-60"><option value="">Todas</option>{base.campaigns.map((c) => <option key={c.externalId} value={c.externalId}>{c.name}</option>)}</Select></Field>
        <p className="pb-2 text-xs text-ink-3">{o.period.current.since} a {o.period.current.until} · comparado con {o.period.previous.since} a {o.period.previous.until}</p>
      </div>
      {o.mixedCurrencies && <p className="mb-3 border-2 border-warn bg-paper px-3 py-2 text-sm">Tus cuentas usan monedas distintas: filtra por cuenta para comparar cifras.</p>}
      {o.insufficient && <p className="mb-3 border-2 border-warn bg-paper px-3 py-2 text-sm">Pocos datos para comparar periodos: {o.comparable === false ? 'las variaciones no se calculan.' : 'las variaciones pueden no ser representativas.'}</p>}
      {o.accounts.some((a) => a.lastSyncStatus === 'PARTIAL') && <p className="mb-3 border-2 border-warn bg-paper px-3 py-2 text-sm">Una cuenta quedó con la última sincronización incompleta: puede faltar algún día. <Link to="?tab=cuentas" className="underline">Ver detalle</Link></p>}
      {o.accounts.some((a) => a.stale && a.mode === 'REAL') && <p className="mb-3 border-2 border-warn bg-paper px-3 py-2 text-sm">Algunos datos tienen más de 12 horas. <Link to="?tab=cuentas" className="underline">Sincronizar</Link></p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Gasto" value={money(t.spend, cur)} hint={undefined} />
        <Stat label="Resultados" value={num(t.results)} hint={t.results === null ? 'Objetivos distintos: míralos por campaña' : o.resultLabel ?? undefined} />
        <Stat label="Costo por resultado" value={money(t.costPerResult, cur)} hint={t.results === null ? 'No hay un costo único' : undefined} />
        <Stat label="CTR" value={pct(t.ctr)} />
      </div>
      <div className="mt-1 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <Delta v={o.deltas.spend} neutral /><Delta v={o.deltas.results} /><Delta v={o.deltas.costPerResult} inverse /><Delta v={o.deltas.ctr} />
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MiniStat label="CPC" value={money(t.cpc, cur)} /><MiniStat label="CPM" value={money(t.cpm, cur)} />
        <MiniStat label="Leads" value={num(t.leads)} /><MiniStat label="Conversaciones" value={num(t.conversations)} />
        <MiniStat label="Compras" value={num(t.purchases)} /><MiniStat label="ROAS (plataforma)" value={t.platformRoas === null ? '—' : `${t.platformRoas}x`} />
        {t.reach != null && <MiniStat label="Alcance (personas)" value={num(t.reach)} />}
        {t.frequency != null && <MiniStat label="Frecuencia" value={`${t.frequency.toLocaleString('es-CO', { maximumFractionDigits: 2 })} veces`} />}
      </div>
      <p className="mt-1 text-[11px] text-ink-3">Cifras reportadas por la plataforma; CTR, CPC, CPM y costos los calcula BackOffice con ellas. Las ventas confirmadas en tu CRM están en «Leads y ventas».</p>
      {!!o.notes?.length && (
        <div className="mt-3 border-2 border-line bg-paper px-3 py-2 text-xs text-ink-2" data-testid="metric-notes">
          <p className="kicker mb-1">Lo que no se puede calcular y por qué</p>
          <ul className="list-disc space-y-0.5 pl-4">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
      <Card kicker="Día a día" title={t.results === null ? 'Gasto' : 'Gasto y resultados'} className="mt-6">
        <AdsSpendChart data={o.daily} money={(v) => money(v, cur)} showResults={t.results !== null} resultsLabel={o.resultLabel ?? 'Resultados'} />
      </Card>
      <div className="mt-6 grid gap-3 sm:grid-cols-4">
        <Link to="?tab=oportunidades" className="border-2 border-ink bg-paper p-3 hover:bg-bone-2"><p className="kicker">Oportunidades abiertas</p><p className="display text-2xl">{o.openFindings}</p></Link>
        <Link to="?tab=autopilot" className="border-2 border-ink bg-paper p-3 hover:bg-bone-2"><p className="kicker">Propuestas por revisar</p><p className="display text-2xl">{o.pendingActions}</p></Link>
        <div className="border-2 border-ink bg-paper p-3"><p className="kicker">Acciones ejecutadas</p><p className="display text-2xl">{o.executedActions}</p></div>
        <div className="border-2 border-ink bg-paper p-3"><p className="kicker">Presupuesto diario activo</p><p className="display text-2xl">{money(o.configuredDailyBudget, cur)}</p></div>
      </div>
      <Card kicker="Por campaña" title="Rendimiento" className="mt-6">
        <CampaignTable rows={o.campaigns} currency={cur} />
      </Card>
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return <div className="border-2 border-line bg-paper px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-ink-3">{label}</p><p className="font-semibold tabular-nums">{value}</p></div>;
}

function CampaignTable({ rows, currency }: { rows: Overview['campaigns']; currency: string }) {
  if (!rows.length) return <p className="text-sm text-ink-3">Sin campañas sincronizadas.</p>;
  // Alcance y frecuencia solo si la plataforma los reportó para este periodo
  const withReach = rows.some((c) => c.reach != null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm">
        <thead><tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-wider text-ink-3"><th className="p-2">Campaña</th><th className="p-2">Estado</th><th className="p-2 text-right">Gasto</th><th className="p-2 text-right">Resultados</th><th className="p-2 text-right">Costo/resultado</th><th className="p-2 text-right">CTR</th>{withReach && <th className="p-2 text-right">Alcance · frec.</th>}<th className="p-2 text-right">Ppto. diario</th></tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-line">
              <td className="p-2 font-semibold">{c.name}</td>
              <td className="p-2"><StatusBadge s={c.status} /></td>
              <td className="p-2 text-right tabular-nums">{money(c.spend, currency)}</td>
              <td className="p-2 text-right tabular-nums">{num(c.results)}{c.resultLabel && <span className="block text-[10px] text-ink-3">{c.resultLabel}</span>}</td>
              <td className="p-2 text-right tabular-nums">{money(c.costPerResult, currency)}</td>
              <td className="p-2 text-right tabular-nums">{pct(c.ctr)}</td>
              {withReach && <td className="p-2 text-right tabular-nums">{c.reach != null ? `${num(c.reach)} · ${c.frequency?.toLocaleString('es-CO', { maximumFractionDigits: 2 }) ?? '—'}` : '—'}</td>}
              <td className="p-2 text-right tabular-nums">{money(c.dailyBudget, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ s }: { s: string | null | undefined }) {
  const map: Record<string, [string, 'ok' | 'warn' | 'bad' | 'neutral']> = {
    ACTIVE: ['Activa', 'ok'], PAUSED: ['En pausa', 'neutral'], DISAPPROVED: ['Rechazado', 'bad'], WITH_ISSUES: ['Con problemas', 'warn'],
    CAMPAIGN_PAUSED: ['Campaña en pausa', 'neutral'], ADSET_PAUSED: ['Conjunto en pausa', 'neutral'], PENDING_REVIEW: ['En revisión', 'warn'], ARCHIVED: ['Archivada', 'neutral'],
  };
  const [label, tone] = map[String(s)] ?? [s ?? '—', 'neutral'];
  return <Badge tone={tone}>{label}</Badge>;
}

/* ── Cuentas ── */

interface ProviderInfo { key: string; label: string; capabilities: Record<string, boolean>; missing: string[]; oauth: boolean }

function Accounts({ q }: { q: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [params, setParams] = useSearchParams();
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['ads-accounts'] }); queryClient.invalidateQueries({ queryKey: ['ads-overview'] }); };
  const { data: accounts, isLoading } = useQuery({ queryKey: ['ads-accounts', q], queryFn: () => api.get<Account[]>(withScope('/ads/accounts', q)) });
  const { data: providers } = useQuery({ queryKey: ['ads-providers', q], queryFn: () => api.get<ProviderInfo[]>(withScope('/ads/providers', q)) });
  const pendingOn = params.get('meta') === 'elegir';
  const { data: pending } = useQuery({ queryKey: ['ads-pending', q], queryFn: () => api.get<Array<{ externalId: string; name: string; currency: string; active: boolean }>>(withScope('/ads/meta/pending', q)), enabled: pendingOn });
  const [chosen, setChosen] = useState<string[]>([]);
  const [manual, setManual] = useState({ accountId: '', token: '' });
  const [disc, setDisc] = useState<Account | null>(null);
  useEffect(() => { if (params.get('meta') === 'error') toast.error('No se pudo conectar con Facebook. Intenta de nuevo.'); }, [params]);
  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');
  const demo = useMutation({ mutationFn: (provider: string) => api.post(withScope('/ads/accounts/demo', q), { provider }), onSuccess: () => { refresh(); toast.success('Cuenta de demostración lista'); }, onError: err });
  const oauth = useMutation({ mutationFn: () => api.get<{ url: string }>(withScope('/ads/meta/oauth', q)), onSuccess: (r) => { window.location.href = r.url; }, onError: err });
  const select = useMutation({ mutationFn: () => api.post(withScope('/ads/meta/select', q), { externalIds: chosen }), onSuccess: () => { refresh(); setParams({ tab: 'cuentas' }); toast.success('Cuentas conectadas. Sincronízalas para traer los datos.'); }, onError: err });
  const connect = useMutation({ mutationFn: () => api.post(withScope('/ads/accounts/manual', q), manual), onSuccess: () => { refresh(); setManual({ accountId: '', token: '' }); toast.success('Cuenta conectada'); }, onError: err });
  const [history, setHistory] = useState<string | null>(null);
  const sync = useMutation({
    mutationFn: (id: string) => api.post<{ status: string; entities: number; insights: number; note?: string; help?: string }>(withScope(`/ads/accounts/${id}/sync`, q)),
    onSuccess: (r) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ['ads-findings'] });
      queryClient.invalidateQueries({ queryKey: ['ads-syncs'] });
      if (r.status === 'PARTIAL') toast.warning(`Sincronización incompleta. ${r.note ?? ''} ${r.help ?? ''}`);
      else toast.success(`Sincronizado: ${r.entities} elementos y ${r.insights} filas de métricas`);
    },
    onError: (e) => { refresh(); queryClient.invalidateQueries({ queryKey: ['ads-syncs'] }); err(e); },
  });
  const disconnect = useMutation({ mutationFn: (id: string) => api.delete(withScope(`/ads/accounts/${id}`, q)), onSuccess: () => { refresh(); setDisc(null); toast.success('Cuenta desconectada. El historial se conserva.'); }, onError: err });
  if (isLoading || !accounts) return <Loading />;
  const meta = providers?.find((p) => p.key === 'META');
  return (
    <div className="space-y-6">
      {pendingOn && (
        <Card kicker="Facebook" title="Elige las cuentas publicitarias">
          {!pending ? <Loading /> : !pending.length ? <p className="text-sm">La autorización venció o no tienes cuentas publicitarias. Conecta de nuevo.</p> : (
            <>
              <ul className="space-y-1 text-sm">
                {pending.map((a) => (
                  <li key={a.externalId}><label className="flex items-center gap-2"><input type="checkbox" checked={chosen.includes(a.externalId)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.externalId] : c.filter((x) => x !== a.externalId)))} />{a.name} <span className="text-xs text-ink-3">{a.externalId} · {a.currency}{a.active ? '' : ' · inactiva'}</span></label></li>
                ))}
              </ul>
              <Button className="mt-3" disabled={!chosen.length || select.isPending} onClick={() => select.mutate()}>Conectar seleccionadas</Button>
            </>
          )}
        </Card>
      )}
      <Card kicker="Conectadas" title="Tus cuentas publicitarias">
        {!accounts.length ? <p className="text-sm text-ink-3">Todavía no hay cuentas. Conecta una abajo o abre la demostración.</p> : (
          <ul className="divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <span>
                  <b>{a.name}</b> <span className="text-xs text-ink-3">{PROVIDER[a.provider]} · {a.externalId} · {a.currency}</span>
                  {a.mode === 'DEMO' && <Badge tone="info">Demostración</Badge>}{' '}
                  <Badge tone={a.status === 'CONNECTED' ? 'ok' : a.status === 'DISCONNECTED' ? 'neutral' : 'bad'}>{a.status === 'CONNECTED' ? 'Conectada' : a.status === 'EXPIRED' ? 'Conexión vencida' : a.status === 'DISCONNECTED' ? 'Desconectada' : a.lastErrorKind === 'PERMISSION' ? 'Sin permisos' : 'Con error'}</Badge>{' '}
                  {a.lastSyncStatus && a.lastSyncStatus !== 'OK' && <Badge tone={a.lastSyncStatus === 'PARTIAL' ? 'warn' : 'bad'}>{a.lastSyncStatus === 'PARTIAL' ? 'Última sincronización incompleta' : 'Última sincronización falló'}</Badge>}
                  {a.syncing && <Badge tone="info">Sincronizando…</Badge>}
                  <span className="block text-xs text-ink-3">
                    {a.lastSyncAt ? `Última sincronización completa: hace ${a.dataAgeHours ?? 0} h` : 'Sin sincronización completa'}
                    {a.mode === 'REAL' && a.status !== 'DISCONNECTED' && (a.nextSyncAt ? ` · próximo intento: ${new Date(a.nextSyncAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}` : a.status === 'EXPIRED' ? ' · sin reintentos hasta reconectar' : '')}
                  </span>
                  {(a.errorHelp || a.lastError) && <span className="block text-xs text-bad">{a.errorHelp ?? ''}{a.lastError ? ` (${a.lastError})` : ''}</span>}
                  {a.credential && <span className="block text-[11px] text-ink-3">Credencial: {a.credential}{a.scopes?.length ? ` · permisos: ${a.scopes.join(', ')}` : ''}</span>}
                  <button type="button" className="mt-1 cursor-pointer text-xs font-semibold text-ink-2 underline-offset-2 hover:underline" aria-expanded={history === a.id} onClick={() => setHistory(history === a.id ? null : a.id)}>{history === a.id ? 'Ocultar historial' : 'Historial de sincronizaciones'}</button>
                </span>
                {canWrite && a.status !== 'DISCONNECTED' && (
                  <span className="flex gap-1">
                    <Button size="sm" variant="outline" disabled={sync.isPending || a.syncing} onClick={() => sync.mutate(a.id)}>{sync.isPending && sync.variables === a.id ? 'Sincronizando…' : 'Sincronizar'}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDisc(a)}>Desconectar</Button>
                  </span>
                )}
                {history === a.id && <SyncHistory q={q} accountId={a.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canWrite && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card kicker="Meta Ads" title="Conectar Facebook / Instagram Ads">
            <p className="mb-3 text-sm text-ink-2">Es distinto de conectar tu página para publicar: aquí damos acceso de lectura y gestión a tu cuenta publicitaria. BackOffice nunca activa campañas ni sube presupuestos sin tu confirmación.</p>
            {meta?.oauth
              ? <Button disabled={oauth.isPending} onClick={() => oauth.mutate()}>Continuar con Facebook</Button>
              : <p className="mb-3 border-2 border-warn bg-paper px-3 py-2 text-xs">El botón de Facebook se activa cuando el equipo de BackOffice configure la app de Meta. Mientras tanto puedes conectar con un token de usuario del sistema.</p>}
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer font-semibold">Conectar con token (avanzado)</summary>
              <div className="mt-3 space-y-2">
                <Field label="ID de la cuenta publicitaria"><Input placeholder="act_1234567890" value={manual.accountId} onChange={(e) => setManual({ ...manual, accountId: e.target.value })} /></Field>
                <Field label="Token de acceso" hint="Se guarda cifrado y nunca se vuelve a mostrar"><Input type="password" autoComplete="off" value={manual.token} onChange={(e) => setManual({ ...manual, token: e.target.value })} /></Field>
                <Button size="sm" disabled={connect.isPending || !manual.accountId || !manual.token} onClick={() => connect.mutate()}>Verificar y conectar</Button>
              </div>
            </details>
          </Card>
          <Card kicker="Sin riesgo" title="Probar con datos de demostración">
            <p className="mb-3 text-sm text-ink-2">Crea una cuenta simulada para recorrer el producto: resultados, oportunidades y Autopilot. Se marca como demostración y nunca se mezcla con tus datos reales.</p>
            <Button variant="outline" disabled={demo.isPending} onClick={() => demo.mutate('META')}>Abrir demostración</Button>
          </Card>
        </div>
      )}
      <Card kicker="Plataformas" title="Qué está disponible">
        <ul className="divide-y divide-line text-sm">
          {(providers ?? []).map((p) => (
            <li key={p.key} className="py-2">
              <b>{p.label}</b>{' '}
              {p.missing.length ? <Badge tone="warn">Pendiente de habilitar</Badge> : <Badge tone="ok">Disponible</Badge>}
              {p.missing.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-ink-3">{p.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </Card>
      <Confirm open={!!disc} title="Desconectar cuenta" cta="Desconectar" danger busy={disconnect.isPending} onClose={() => setDisc(null)} onConfirm={() => disc && disconnect.mutate(disc.id)}>
        <p>Se borra la credencial de <b>{disc?.name}</b>. El historial de métricas y acciones se conserva. Tus campañas en la plataforma no cambian.</p>
      </Confirm>
    </div>
  );
}

interface SyncRun { id: string; trigger: string; status: string; startedAt: string; finishedAt: string | null; error: string | null; help: string | null; counts: { entities?: number; insights?: number; since?: string; until?: string; chunks?: number; chunksOk?: number; warnings?: string[] } }

const RUN_LABEL: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info']> = { OK: ['Completa', 'ok'], PARTIAL: ['Incompleta', 'warn'], ERROR: ['Falló', 'bad'], RUNNING: ['En curso', 'info'] };

function SyncHistory({ q, accountId }: { q: string; accountId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['ads-syncs', q, accountId], queryFn: () => api.get<SyncRun[]>(withScope(`/ads/accounts/${accountId}/syncs`, q)) });
  if (isLoading || !data) return <div className="w-full"><Loading /></div>;
  if (!data.length) return <p className="w-full text-xs text-ink-3">Sin sincronizaciones todavía.</p>;
  return (
    <ul className="w-full divide-y divide-line border-2 border-line bg-bone px-3 text-xs" data-testid="sync-history">
      {data.map((r) => (
        <li key={r.id} className="py-2">
          <Badge tone={RUN_LABEL[r.status]?.[1] ?? 'neutral'}>{RUN_LABEL[r.status]?.[0] ?? r.status}</Badge>{' '}
          {new Date(r.startedAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })} · {r.trigger === 'CRON' ? 'automática' : 'manual'}
          {r.counts.since && <> · {r.counts.since} a {r.counts.until}</>}
          {r.counts.chunks ? <> · {r.counts.chunksOk ?? 0}/{r.counts.chunks} tramos</> : null}
          {r.counts.entities !== undefined && <> · {r.counts.entities} elementos y {r.counts.insights ?? 0} filas nuevas o cambiadas</>}
          {r.error && <span className="block text-bad">{r.help ? `${r.help} ` : ''}({r.error})</span>}
          {r.counts.warnings?.map((w) => <span key={w} className="block text-warn">{w}</span>)}
        </li>
      ))}
    </ul>
  );
}

/* ── Campañas ── */

interface Node { id: string; level: string; externalId: string; name: string; status: string | null; effectiveStatus: string | null; dailyBudget: number | null; issues: string[]; metrics: Totals }

function Campaigns({ q, mode, currency }: { q: string; mode: Mode; currency: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [days, setDays] = useState('30');
  const [confirm, setConfirm] = useState<{ node: Node; status: 'ACTIVE' | 'PAUSED' } | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['ads-campaigns', q, mode, days], queryFn: () => api.get<{ period: any; campaigns: Array<Node & { adsets: Array<Node & { ads: Node[] }> }> }>(`/ads/campaigns${qs(q, { mode, days })}`) });
  const change = useMutation({
    mutationFn: () => api.post<{ demo?: boolean }>(withScope(`/ads/entities/${confirm!.node.id}/status`, q), { status: confirm!.status, confirm: true }),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['ads-campaigns'] }); queryClient.invalidateQueries({ queryKey: ['ads-overview'] }); setConfirm(null); toast.success(r.demo ? 'Hecho (simulado en la demostración)' : 'Hecho en la plataforma'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (isLoading || !data) return <Loading />;
  if (!data.campaigns.length) return <NoAccounts />;
  const row = (n: Node, depth: number) => {
    const st = n.effectiveStatus ?? n.status;
    return (
      <tr key={n.id} className="border-b border-line align-top">
        <td className="p-2" style={{ paddingLeft: 8 + depth * 20 }}>
          <span className={clsx(depth === 0 && 'font-semibold')}>{n.name}</span>
          <span className="block text-[10px] uppercase tracking-wider text-ink-3">{n.level === 'CAMPAIGN' ? 'Campaña' : n.level === 'ADSET' ? 'Conjunto' : 'Anuncio'}</span>
          {n.issues.map((i) => <span key={i} className="block text-xs text-bad">{i}</span>)}
        </td>
        <td className="p-2"><StatusBadge s={st} /></td>
        <td className="p-2 text-right tabular-nums">{money(n.metrics.spend, currency)}</td>
        <td className="p-2 text-right tabular-nums">{num(n.metrics.results)}{depth === 0 && n.metrics.resultLabel && <span className="block text-[10px] text-ink-3">{n.metrics.resultLabel}</span>}</td>
        <td className="p-2 text-right tabular-nums">{money(n.metrics.costPerResult, currency)}</td>
        <td className="p-2 text-right tabular-nums">{pct(n.metrics.ctr)}</td>
        <td className="p-2 text-right">
          {canWrite && n.level !== 'ADSET' && (n.status === 'ACTIVE'
            ? <Button size="sm" variant="outline" onClick={() => setConfirm({ node: n, status: 'PAUSED' })}>Pausar</Button>
            : n.status === 'PAUSED' ? <Button size="sm" variant="outline" onClick={() => setConfirm({ node: n, status: 'ACTIVE' })}>Reanudar</Button> : null)}
        </td>
      </tr>
    );
  };
  return (
    <>
      <div className="mb-3 flex items-end gap-2">
        <Field label="Periodo"><Select value={days} onChange={(e) => setDays(e.target.value)} className="!w-36">{['7', '14', '30', '60'].map((d) => <option key={d} value={d}>Últimos {d} días</option>)}</Select></Field>
        <p className="pb-2 text-xs text-ink-3">{data.period.since} a {data.period.until} · reportado por la plataforma</p>
      </div>
      <div className="overflow-x-auto border-2 border-ink bg-paper">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-wider text-ink-3"><th className="p-2">Nombre</th><th className="p-2">Estado</th><th className="p-2 text-right">Gasto</th><th className="p-2 text-right">Resultados</th><th className="p-2 text-right">Costo/resultado</th><th className="p-2 text-right">CTR</th><th className="p-2" /></tr></thead>
          <tbody>{data.campaigns.flatMap((c) => [row(c, 0), ...c.adsets.flatMap((s) => [row(s, 1), ...s.ads.map((a) => row(a, 2))])])}</tbody>
        </table>
      </div>
      <Confirm open={!!confirm} title={confirm?.status === 'ACTIVE' ? 'Reanudar (vuelve a gastar)' : 'Pausar'} cta={confirm?.status === 'ACTIVE' ? 'Sí, reanudar' : 'Sí, pausar'} danger={confirm?.status === 'ACTIVE'} busy={change.isPending} onClose={() => setConfirm(null)} onConfirm={() => change.mutate()}>
        {confirm?.status === 'ACTIVE'
          ? <p><b>{confirm?.node.name}</b> volverá a entregarse y a consumir presupuesto en la plataforma{confirm?.node.dailyBudget ? ` (presupuesto diario: ${money(confirm.node.dailyBudget, currency)})` : ''}.</p>
          : <p><b>{confirm?.node.name}</b> deja de entregarse y de gastar. Puedes reanudarlo cuando quieras; el aprendizaje de la plataforma puede reiniciarse.</p>}
        {mode === 'DEMO' && <p className="text-info">Es una demostración: no se toca ninguna cuenta real.</p>}
      </Confirm>
    </>
  );
}

/* ── Oportunidades: el mismo Radar, filtrado a anuncios ── */

function Findings({ q, mode }: { q: string; mode: Mode }) {
  const { canWrite } = useCompanyScope();
  return (
    <>
      <p className="mb-3 text-xs text-ink-3">Reglas con evidencia numérica sobre tus anuncios. No juzgamos los últimos 2 días (retraso de atribución) ni culpamos a una campaña si la medición no funciona.</p>
      <OpportunityList scope={(p) => withScope(p, q)} query={{ source: 'ADS', mode }} canWrite={canWrite} emptyHint="Cuando la auditoría de tus anuncios encuentre algo que merezca tu atención, aparecerá aquí con sus números." />
    </>
  );
}

/* ── Autopilot ── */

interface Settings { autonomy: 'ANALYSIS' | 'RECOMMEND' | 'AUTHORIZED'; globalPause: boolean; autoActions: string[]; maxDailyBudget: number | null; maxDataAgeHours: number }
interface Rule { id: string; name: string; metric: string; level: string; windowDays: number; operator: string; threshold: number; minSpend: number; action: string; active: boolean; checkEveryMin: number; lastRunAt: string | null }
interface ActionLog {
  id: string; source: string; action: string; status: string; entityName: string | null; actor: string | null; createdAt: string; error: string | null; reversible: boolean; data: any; mode: Mode;
  kind?: 'INFO' | 'SUGGESTION' | 'EXECUTION'; approvedBy?: string | null; approvedAt?: string | null; decidedAt?: string | null; retryable?: boolean;
  execution?: { id: string; status: string; error: string | null; decidedAt: string | null } | null;
}

const ACTION_LABEL: Record<string, string> = { ALERT: 'Alerta', RECOMMEND_PAUSE: 'Propone pausar', PAUSE: 'Pausa', RESUME: 'Reanuda', CREATE_CAMPAIGN: 'Crea campaña (en pausa)' };
const STATUS_LABEL: Record<string, [string, 'ok' | 'warn' | 'bad' | 'neutral' | 'info']> = {
  PROPOSED: ['Sugerida · por aprobar', 'warn'], APPROVED: ['Aprobada', 'info'], RUNNING: ['Ejecutándose', 'info'], EXECUTED: ['Ejecutada', 'ok'],
  FAILED: ['Falló', 'bad'], REJECTED: ['Rechazada', 'neutral'], SKIPPED: ['Omitida', 'neutral'],
};
const when = (d?: string | null) => (d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function Autopilot({ q, mode, currency }: { q: string; mode: Mode; currency: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');
  const { data: s } = useQuery({ queryKey: ['ads-settings', q], queryFn: () => api.get<Settings>(withScope('/ads/settings', q)) });
  const { data: rules } = useQuery({ queryKey: ['ads-rules', q], queryFn: () => api.get<{ rules: Rule[]; metrics: Record<string, { label: string; unit: string }> }>(withScope('/ads/rules', q)) });
  const { data: log } = useQuery({ queryKey: ['ads-actions', q, mode], queryFn: () => api.get<ActionLog[]>(`/ads/actions${qs(q, { mode })}`) });
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => { if (s) setForm(s); }, [s]);
  const refresh = () => ['ads-settings', 'ads-rules', 'ads-actions', 'ads-overview', 'ads-campaigns'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  const save = useMutation({ mutationFn: () => api.put(withScope('/ads/settings', q), form), onSuccess: () => { refresh(); toast.success('Ajustes guardados'); }, onError: err });
  const runNow = useMutation({ mutationFn: () => api.post<any[]>(withScope('/ads/rules/run', q)), onSuccess: (r) => { refresh(); toast.success(r.length ? `${r.length} coincidencias evaluadas` : 'Ninguna regla se cumplió'); }, onError: err });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: string }) => api.post<{ status?: string; demo?: boolean }>(withScope(`/ads/actions/${id}/decide`, q), { decision, confirm: true }),
    onSuccess: (r) => { refresh(); toast.success(r.status === 'REJECTED' ? 'Propuesta rechazada' : r.status === 'SKIPPED' ? 'Aprobada: ya estaba en pausa, no se ejecutó nada' : r.demo ? 'Aprobada y pausada (simulado)' : 'Aprobada y confirmada por la plataforma'); },
    onError: (e) => { refresh(); err(e); },
  });
  const retry = useMutation({
    mutationFn: (l: ActionLog) => api.post<{ status?: string }>(withScope(`/ads/actions/${l.id}/retry`, q), { confirm: l.action === 'RESUME' }),
    onSuccess: (r) => { refresh(); toast.success(r.status === 'SKIPPED' ? 'Ya estaba así en la plataforma' : 'Reintento confirmado por la plataforma'); },
    onError: (e) => { refresh(); err(e); },
  });
  const [revert, setRevert] = useState<ActionLog | null>(null);
  const doRevert = useMutation({ mutationFn: () => api.post(withScope(`/ads/actions/${revert!.id}/revert`, q), { confirm: true }), onSuccess: () => { refresh(); setRevert(null); toast.success('Revertido: el elemento se reanudó'); }, onError: err });
  if (!s || !form || !rules || !log) return <Loading />;
  return (
    <div className="space-y-6">
      <Card kicker="Seguridad primero" title="Nivel de autonomía">
        <fieldset disabled={!canWrite} className="space-y-4 text-sm">
          <div className="grid gap-2 md:grid-cols-3">
            {([['ANALYSIS', 'Solo análisis', 'Consulta datos y te avisa. No propone ni cambia nada.'], ['RECOMMEND', 'Recomendaciones', 'Propone pausas que una persona aprueba.'], ['AUTHORIZED', 'Automatización autorizada', 'Ejecuta solo lo que habilites abajo, con datos frescos.']] as const).map(([k, t, d]) => (
              <button key={k} type="button" onClick={() => setForm({ ...form, autonomy: k })} className={clsx('cursor-pointer border-2 p-3 text-left', form.autonomy === k ? 'border-ink bg-ink text-bone' : 'border-line bg-paper')}>
                <span className="block font-semibold">{t}</span><span className={clsx('block text-xs', form.autonomy === k ? 'text-bone/80' : 'text-ink-3')}>{d}</span>
              </button>
            ))}
          </div>
          {form.autonomy === 'AUTHORIZED' && <Switch checked={form.autoActions.includes('PAUSE')} onChange={(v) => setForm({ ...form, autoActions: v ? ['PAUSE'] : [] })} label="Permitir que el Autopilot pause anuncios y campañas" showLabel />}
          <p className="text-xs text-ink-3">El Autopilot nunca activa campañas ni sube presupuestos. Eso siempre lo decide una persona.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Tope de presupuesto diario por campaña (${currency})`} hint="BackOffice nunca crea ni deja una campaña por encima de esto"><Input inputMode="numeric" value={form.maxDailyBudget ?? ''} onChange={(e) => setForm({ ...form, maxDailyBudget: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : null })} /></Field>
            <Field label="Antigüedad máxima de los datos (horas)" hint="Con datos más viejos, nada se ejecuta solo"><Input type="number" min={1} max={48} value={form.maxDataAgeHours} onChange={(e) => setForm({ ...form, maxDataAgeHours: Number(e.target.value) })} /></Field>
          </div>
          <div className={clsx('border-2 p-3', form.globalPause ? 'border-bad bg-bad-soft' : 'border-line')}>
            <Switch checked={form.globalPause} onChange={(v) => setForm({ ...form, globalPause: v })} label="Pausa global: detener todo el Autopilot de inmediato" showLabel />
          </div>
          {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>Guardar ajustes</Button>}
        </fieldset>
      </Card>
      <RulesCard q={q} rules={rules.rules} metrics={rules.metrics} currency={currency} onChange={refresh} />
      <Card kicker="Registro auditable" title="Acciones y propuestas">
        {canWrite && <Button size="sm" variant="outline" className="mb-3" disabled={runNow.isPending} onClick={() => runNow.mutate()}>Evaluar reglas ahora</Button>}
        {!log.length ? <p className="text-sm text-ink-3">Sin acciones todavía.</p> : (
          <ul className="divide-y divide-line text-sm">
            {log.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-2 py-2" data-testid={`action-${l.id}`}>
                <span>
                  <b>{ACTION_LABEL[l.action] ?? l.action}</b> · {l.entityName}{' '}
                  {l.kind === 'INFO' ? <Badge tone="neutral">Informativa</Badge> : <Badge tone={STATUS_LABEL[l.status]?.[1] ?? 'neutral'}>{STATUS_LABEL[l.status]?.[0] ?? l.status}</Badge>}
                  {l.mode === 'DEMO' && <> <Badge tone="info">Demostración</Badge></>}
                  <span className="block text-xs text-ink-3">{when(l.createdAt)} · {l.kind === 'SUGGESTION' ? 'sugerida por' : 'por'} {l.source === 'RULE' && !l.approvedBy ? 'Autopilot' : l.actor ?? 'Sistema'}{l.data?.rule ? ` · regla «${l.data.rule}»` : ''}{l.data?.match?.reason ? ` · ${l.data.match.reason}` : ''}</span>
                  {l.data?.guard && <span className="block text-xs text-ink-3">Motivo: {l.data.guard}</span>}
                  {l.approvedBy && <span className="block text-xs text-ink-2">Aprobada por {l.approvedBy}{l.approvedAt ? ` el ${when(l.approvedAt)}` : ''}</span>}
                  {l.execution && (
                    <span className={clsx('block text-xs', l.execution.status === 'EXECUTED' ? 'text-ok' : l.execution.status === 'FAILED' ? 'text-bad' : 'text-ink-2')}>
                      Resultado: {STATUS_LABEL[l.execution.status]?.[0] ?? l.execution.status}{l.execution.status === 'EXECUTED' ? ' (confirmado por la plataforma)' : ''}{l.execution.error ? ` · ${l.execution.error}` : ''}
                    </span>
                  )}
                  {l.kind === 'EXECUTION' && l.status === 'EXECUTED' && <span className="block text-xs text-ok">Confirmado por la plataforma{l.mode === 'DEMO' ? ' (simulado)' : ''}</span>}
                  {l.error && <span className={clsx('block text-xs', l.status === 'SKIPPED' ? 'text-ink-3' : 'text-bad')}>{l.error}</span>}
                </span>
                {canWrite && (
                  <span className="flex gap-1">
                    {l.status === 'PROPOSED' && l.action === 'RECOMMEND_PAUSE' && <><Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, decision: 'APPROVE' })}>Aprobar y pausar</Button><Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, decision: 'REJECT' })}>Rechazar</Button></>}
                    {l.retryable && <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => { if (l.action !== 'RESUME' || confirm('Reanudar vuelve a gastar presupuesto. ¿Reintentar?')) retry.mutate(l); }}>Reintentar</Button>}
                    {l.status === 'EXECUTED' && l.action === 'PAUSE' && l.reversible && <Button size="sm" variant="outline" onClick={() => setRevert(l)}>Revertir</Button>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Confirm open={!!revert} title="Revertir pausa" cta="Sí, reanudar" danger busy={doRevert.isPending} onClose={() => setRevert(null)} onConfirm={() => doRevert.mutate()}>
        <p><b>{revert?.entityName}</b> volverá a entregarse y a gastar presupuesto.</p>
      </Confirm>
    </div>
  );
}

function RulesCard({ q, rules, metrics, currency, onChange }: { q: string; rules: Rule[]; metrics: Record<string, { label: string; unit: string }>; currency: string; onChange: () => void }) {
  const { canWrite } = useCompanyScope();
  const blank = { name: '', metric: 'CPL', level: 'CAMPAIGN', windowDays: 7, operator: 'GT', threshold: '', minSpend: '', action: 'ALERT', checkEveryMin: 60 };
  const [f, setF] = useState<any>(blank);
  const [test, setTest] = useState<{ name: string; matches: any[] } | null>(null);
  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');
  const create = useMutation({ mutationFn: () => api.post(withScope('/ads/rules', q), { ...f, threshold: Number(f.threshold), minSpend: Number(f.minSpend || 0), windowDays: Number(f.windowDays) }), onSuccess: () => { onChange(); setF(blank); toast.success('Regla creada'); }, onError: err });
  const toggle = useMutation({ mutationFn: (r: Rule) => api.put(withScope(`/ads/rules/${r.id}`, q), { active: !r.active }), onSuccess: onChange, onError: err });
  const del = useMutation({ mutationFn: (id: string) => api.delete(withScope(`/ads/rules/${id}`, q)), onSuccess: onChange, onError: err });
  const dry = useMutation({ mutationFn: (r: Rule) => api.get<{ matches: any[] }>(`/ads/rules/${r.id}/test${qs(q, {})}`).then((x) => ({ name: r.name, matches: x.matches })), onSuccess: setTest, onError: err });
  const unit = (m: string) => (metrics[m]?.unit === 'money' ? currency : metrics[m]?.unit === 'pct' ? '%' : 'veces');
  return (
    <Card kicker="Umbrales tuyos" title="Reglas">
      {!rules.length ? <p className="mb-3 text-sm text-ink-3">Sin reglas. Crea la primera: por ejemplo, «avísame si el costo por resultado pasa de $15.000 en 7 días».</p> : (
        <ul className="mb-4 divide-y divide-line text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className={clsx(!r.active && 'opacity-50')}>
                <b>{r.name}</b>
                <span className="block text-xs text-ink-3">{metrics[r.metric]?.label} {r.operator === 'GT' ? 'mayor que' : 'menor que'} {r.threshold} {unit(r.metric)} · {r.windowDays} días · {r.level === 'AD' ? 'por anuncio' : 'por campaña'}{r.minSpend ? ` · con gasto ≥ ${money(r.minSpend, currency)}` : ''} → {ACTION_LABEL[r.action]}</span>
              </span>
              <span className="flex gap-1">
                <Button size="sm" variant="outline" onClick={() => dry.mutate(r)}>Probar</Button>
                {canWrite && <><Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>{r.active ? 'Desactivar' : 'Activar'}</Button><Button size="sm" variant="ghost" onClick={() => { if (confirm('¿Borrar esta regla? El registro de lo que hizo se conserva.')) del.mutate(r.id); }}>Borrar</Button></>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <fieldset className="grid gap-2 border-t-2 border-line pt-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Nombre"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Costo alto" /></Field>
          <Field label="Métrica"><Select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>{Object.entries(metrics).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></Field>
          <Field label="Condición"><div className="flex gap-1"><Select value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })} className="!w-28"><option value="GT">mayor que</option><option value="LT">menor que</option></Select><Input inputMode="decimal" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} placeholder={unit(f.metric)} /></div></Field>
          <Field label="Ventana"><Select value={f.windowDays} onChange={(e) => setF({ ...f, windowDays: Number(e.target.value) })}>{[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} días</option>)}</Select></Field>
          <Field label="Nivel"><Select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}><option value="CAMPAIGN">Campaña</option><option value="AD">Anuncio</option></Select></Field>
          <Field label={`Gasto mínimo (${currency})`} hint="Evita opinar con pocos datos"><Input inputMode="numeric" value={f.minSpend} onChange={(e) => setF({ ...f, minSpend: e.target.value })} /></Field>
          <Field label="Acción"><Select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}><option value="ALERT">Solo alertar</option><option value="RECOMMEND_PAUSE">Proponer pausa</option><option value="PAUSE">Pausar (si está autorizado)</option></Select></Field>
          <Field label="Revisar cada"><Select value={f.checkEveryMin} onChange={(e) => setF({ ...f, checkEveryMin: Number(e.target.value) })}>{[[30, '30 min'], [60, '1 hora'], [180, '3 horas'], [360, '6 horas'], [1440, '1 día']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <div className="sm:col-span-2 lg:col-span-4"><Button size="sm" disabled={create.isPending || !f.name || f.threshold === ''} onClick={() => create.mutate()}>Crear regla</Button></div>
        </fieldset>
      )}
      <Modal open={!!test} onClose={() => setTest(null)} kicker="Prueba en seco (no ejecuta nada)" title={test?.name ?? ''}>
        {!test?.matches.length ? <p className="text-sm">Hoy ningún elemento cumple la regla.</p> : (
          <ul className="space-y-1 text-sm">{test.matches.map((m) => <li key={m.externalId}><b>{m.name}</b><span className="block text-xs text-ink-3">{m.reason}</span></li>)}</ul>
        )}
      </Modal>
    </Card>
  );
}

/* ── Leads y ventas ── */

interface FunnelRow { campaignExternalId: string | null; campaignName: string; spend: number; platformResults: number; leads: number; qualified: number; customers: number; sales: number; revenue: number; costPerLead: number | null; costPerQualified: number | null; cac: number | null; roas: number | null }
type AttrState = 'ATTRIBUTED' | 'PARTIAL' | 'UNATTRIBUTED';
interface AttrRow { contactId: string; name: string; createdAt: string; state: AttrState; via: string | null; adId: string | null; adName: string | null; adsetName: string | null; campaignName: string | null; evidence: string }
interface RevenueRes {
  period: { since: string; until: string }; connected: boolean; currency: string; campaigns: FunnelRow[];
  totals: { spend: number; leads: number; qualified: number; customers: number; sales: number; revenue: number; costPerLead: number | null; costPerQualified: number | null; cac: number | null; roas: number | null };
  unattributedAds: number; businessRevenue: number; method: string;
  attribution?: { counts: Record<AttrState, number>; recent: AttrRow[]; rules: Record<AttrState, string> };
  leadForms?: { received: number; withContact: number; pendingPermission: number; errors: number };
}
interface LeadRow { id: string; status: string; error: string | null; leadgenId: string; formId: string | null; adId: string | null; adName: string | null; contactId: string | null; fieldNames: string[]; receivedAt: string }

const ATTR: Record<AttrState, [string, 'ok' | 'warn' | 'neutral']> = { ATTRIBUTED: ['Atribuido', 'ok'], PARTIAL: ['Parcial', 'warn'], UNATTRIBUTED: ['Sin atribuir', 'neutral'] };
const VIA: Record<string, string> = { WHATSAPP_REFERRAL: 'Clic a WhatsApp', LEAD_FORM: 'Formulario Lead Ads', POST: 'Publicación' };
const LEAD_STATUS: Record<string, [string, 'ok' | 'warn' | 'bad' | 'info' | 'neutral']> = {
  FETCHED: ['Con datos', 'ok'], PENDING_PERMISSION: ['Falta permiso', 'warn'], ERROR: ['Error', 'bad'], RECEIVED: ['Recibido', 'info'], FETCHING: ['Leyendo…', 'info'],
};

function Revenue({ q }: { q: string }) {
  const [days, setDays] = useState('30');
  const { data, isLoading } = useQuery({ queryKey: ['ads-revenue', q, days], queryFn: () => api.get<RevenueRes>(`/ads/revenue${qs(q, { days })}`) });
  if (isLoading || !data) return <Loading />;
  const cur = data.currency;
  const t = data.totals;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Field label="Periodo"><Select value={days} onChange={(e) => setDays(e.target.value)} className="!w-36">{['30', '60', '90'].map((d) => <option key={d} value={d}>Últimos {d} días</option>)}</Select></Field>
        <p className="pb-2 text-xs text-ink-3">{data.period.since} a {data.period.until} · solo cuentas reales</p>
      </div>
      {!data.connected && <p className="mb-4 border-2 border-warn bg-paper px-3 py-2 text-sm">Sin una cuenta publicitaria real conectada no hay gasto para calcular costos. Igual verás los leads que llegaron por anuncios de clic a WhatsApp.</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Leads de anuncios (CRM)" value={num(t.leads)} hint="Chats con el ID del anuncio" />
        <Stat label="Calificados (CRM)" value={num(t.qualified)} hint="Avanzaron en tu embudo" />
        <Stat label="Clientes (CRM)" value={num(t.customers)} />
        <Stat label="Ventas confirmadas (CRM)" value={money(t.revenue, cur)} hint={`${t.sales} pedidos pagados o entregados`} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MiniStat label="Costo por lead (calculado)" value={money(t.costPerLead, cur)} />
        <MiniStat label="Costo por lead calificado" value={money(t.costPerQualified, cur)} />
        <MiniStat label="Costo de adquisición (CAC)" value={money(t.cac, cur)} />
        <MiniStat label="ROAS con ventas reales" value={t.roas === null ? '—' : `${t.roas}x`} />
      </div>
      <Card kicker="Por campaña" title="Del anuncio a la venta" className="mt-6">
        {!data.campaigns.length ? <p className="text-sm text-ink-3">Aún no hay leads ni gasto que cruzar en este periodo.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead><tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-wider text-ink-3"><th className="p-2">Campaña</th><th className="p-2 text-right">Gasto (plataforma)</th><th className="p-2 text-right">Leads</th><th className="p-2 text-right">Calificados</th><th className="p-2 text-right">Clientes</th><th className="p-2 text-right">Ventas</th><th className="p-2 text-right">CPL</th><th className="p-2 text-right">CAC</th><th className="p-2 text-right">ROAS</th></tr></thead>
              <tbody>
                {data.campaigns.map((c) => (
                  <tr key={c.campaignExternalId ?? 'x'} className="border-b border-line">
                    <td className="p-2 font-semibold">{c.campaignName}</td>
                    <td className="p-2 text-right tabular-nums">{money(c.spend, cur)}</td>
                    <td className="p-2 text-right tabular-nums">{c.leads}</td><td className="p-2 text-right tabular-nums">{c.qualified}</td><td className="p-2 text-right tabular-nums">{c.customers}</td>
                    <td className="p-2 text-right tabular-nums">{money(c.revenue, cur)}</td>
                    <td className="p-2 text-right tabular-nums">{money(c.costPerLead, cur)}</td><td className="p-2 text-right tabular-nums">{money(c.cac, cur)}</td>
                    <td className="p-2 text-right tabular-nums">{c.roas === null ? '—' : `${c.roas}x`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data.attribution && <Attribution a={data.attribution} />}
      <LeadForms q={q} summary={data.leadForms} />
      <div className="mt-6 grid gap-3 text-sm md:grid-cols-2">
        <div className="border-2 border-line bg-paper p-3"><p className="kicker mb-1">Cómo se atribuye</p><p>{data.method}</p>{data.unattributedAds > 0 && <p className="mt-1 text-xs text-warn">{data.unattributedAds} leads vinieron de anuncios que no están en tus cuentas conectadas (no se adivinan).</p>}</div>
        <div className="border-2 border-line bg-paper p-3"><p className="kicker mb-1">Ventas totales del negocio en el periodo</p><p className="display text-2xl">{money(data.businessRevenue, cur)}</p><p className="text-xs text-ink-3">Incluye todo, no solo lo que vino de anuncios. No se usa para el ROAS.</p></div>
      </div>
    </>
  );
}

function Attribution({ a }: { a: NonNullable<RevenueRes['attribution']> }) {
  const total = a.counts.ATTRIBUTED + a.counts.PARTIAL + a.counts.UNATTRIBUTED;
  return (
    <Card kicker="Atribución" title="De dónde salió cada contacto" className="mt-6">
      {!total ? <p className="text-sm text-ink-3">En este periodo no llegaron contactos desde anuncios, formularios ni publicaciones de Meta.</p> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(ATTR) as AttrState[]).map((k) => (
              <div key={k} className="border-2 border-line bg-paper p-3">
                <p className="kicker">{ATTR[k][0]}</p>
                <p className="display text-2xl">{a.counts[k]}</p>
                <p className="text-xs text-ink-3">{a.rules[k]}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm" data-testid="attribution-table">
              <thead><tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-wider text-ink-3"><th className="p-2">Contacto</th><th className="p-2">Estado</th><th className="p-2">Vía</th><th className="p-2">Campaña · conjunto · anuncio</th><th className="p-2">Evidencia</th></tr></thead>
              <tbody>
                {a.recent.map((r) => (
                  <tr key={r.contactId} className="border-b border-line align-top">
                    <td className="p-2"><span className="font-semibold">{r.name}</span><span className="block text-[11px] text-ink-3">{new Date(r.createdAt).toLocaleDateString('es-CO')}</span></td>
                    <td className="p-2"><Badge tone={ATTR[r.state][1]}>{ATTR[r.state][0]}</Badge></td>
                    <td className="p-2 text-xs">{r.via ? VIA[r.via] ?? r.via : '—'}</td>
                    <td className="p-2 text-xs">{r.campaignName || r.adsetName || r.adName ? [r.campaignName, r.adsetName, r.adName].map((x) => x ?? 'desconocido').join(' · ') : <span className="text-ink-3">Desconocido</span>}</td>
                    <td className="p-2 text-xs text-ink-2">{r.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > a.recent.length && <p className="mt-2 text-xs text-ink-3">Se muestran los {a.recent.length} más recientes de {total}.</p>}
        </>
      )}
    </Card>
  );
}

function LeadForms({ q, summary }: { q: string; summary?: RevenueRes['leadForms'] }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const { data } = useQuery({ queryKey: ['ads-leads', q], queryFn: () => api.get<LeadRow[]>(withScope('/ads/leads', q)) });
  const fetchLead = useMutation({
    mutationFn: (id: string) => api.post<LeadRow>(withScope(`/ads/leads/${id}/fetch`, q)),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['ads-leads'] }); queryClient.invalidateQueries({ queryKey: ['ads-revenue'] }); if (r.status === 'FETCHED') toast.success('Datos del lead recibidos'); else toast.error(r.error ?? 'Meta todavía no entrega los datos'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (!data) return null;
  return (
    <Card kicker="Meta Lead Ads" title="Formularios recibidos" className="mt-6">
      {!data.length ? (
        <p className="text-sm text-ink-3">Aún no llega ningún formulario. Para recibirlos, la página debe estar conectada en BackOffice y suscrita al aviso «leadgen» de Meta, con el permiso <b>leads_retrieval</b> aprobado.</p>
      ) : (
        <>
          {summary && <p className="mb-3 text-xs text-ink-3">En el periodo: {summary.received} recibidos · {summary.withContact} con datos · {summary.pendingPermission} esperando permiso · {summary.errors} con error.</p>}
          <ul className="divide-y divide-line text-sm">
            {data.map((l) => (
              <li key={l.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span>
                  <Badge tone={LEAD_STATUS[l.status]?.[1] ?? 'neutral'}>{LEAD_STATUS[l.status]?.[0] ?? l.status}</Badge>{' '}
                  <span className="text-xs text-ink-3">{new Date(l.receivedAt).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })} · lead {l.leadgenId}{l.adName ? ` · anuncio «${l.adName}»` : l.adId ? ` · anuncio ${l.adId} (no sincronizado)` : ' · sin ID de anuncio'}</span>
                  {l.contactId && <span className="block text-xs text-ok">Contacto creado o unido en el CRM</span>}
                  {l.error && <span className="block text-xs text-warn">{l.error}</span>}
                </span>
                {canWrite && ['PENDING_PERMISSION', 'ERROR'].includes(l.status) && <Button size="sm" variant="outline" disabled={fetchLead.isPending} onClick={() => fetchLead.mutate(l.id)}>Pedir datos otra vez</Button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/* ── Nueva campaña (Campaign Studio) ── */

interface BriefRow { id: string; title: string; status: string; createdAt: string; createdExternalId: string | null; data: any; proposal: any }

function Studio({ q, accounts }: { q: string; accounts: Account[] }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [f, setF] = useState<any>({ goal: 'MESSAGES', product: '', location: '', audience: '', dailyBudget: '', durationDays: '14', averageTicket: '', marginPct: '', leadCapacityPerDay: '', offer: '', destination: '' });
  const [current, setCurrent] = useState<BriefRow | null>(null);
  const [account, setAccount] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { data: briefs } = useQuery({ queryKey: ['ads-briefs', q], queryFn: () => api.get<BriefRow[]>(withScope('/ads/briefs', q)) });
  const usable = useMemo(() => accounts.filter((a) => a.status === 'CONNECTED'), [accounts]);
  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');
  const propose = useMutation({ mutationFn: () => api.post<BriefRow>(withScope('/ads/briefs', q), f), onSuccess: (b) => { setCurrent(b); queryClient.invalidateQueries({ queryKey: ['ads-briefs'] }); }, onError: err });
  const create = useMutation({
    mutationFn: () => api.post<{ externalId: string; demo: boolean }>(withScope(`/ads/briefs/${current!.id}/create`, q), { accountId: account, confirm: true }),
    onSuccess: (r) => { setConfirmOpen(false); setCurrent(null); queryClient.invalidateQueries({ queryKey: ['ads-briefs'] }); toast.success(r.demo ? 'Campaña creada en pausa (simulada)' : `Campaña creada en pausa (${r.externalId}). Complétala y actívala en Meta.`); },
    onError: err,
  });
  const p = current?.proposal;
  const cur = accounts.find((a) => a.id === account)?.currency ?? 'COP';
  // Abandono: empezó el brief y se fue sin ver la propuesta (solo el paso, sin datos)
  const started = useRef(false);
  const proposed = useRef(false);
  started.current = !!(f.product || f.location || f.dailyBudget);
  proposed.current = proposed.current || !!current;
  useEffect(() => () => {
    if (started.current && !proposed.current && canWrite) void api.post(withScope('/creative/events', q), { type: 'abandon_step', step: 'campaign_brief' }).catch(() => undefined);
  }, []);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-6">
      {!p ? (
        <Card kicker="Paso 1" title="Cuéntanos qué quieres lograr">
          <fieldset disabled={!canWrite} className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Objetivo"><Select value={f.goal} onChange={set('goal')}><option value="MESSAGES">Conversaciones por WhatsApp</option><option value="LEADS">Formularios de contacto</option><option value="SALES">Ventas en la web</option><option value="TRAFFIC">Visitas a la web</option><option value="AWARENESS">Que me conozcan</option></Select></Field>
            <Field label="Producto o servicio"><Input value={f.product} onChange={set('product')} placeholder="Café de origen 250 g" /></Field>
            <Field label="Ubicación"><Input value={f.location} onChange={set('location')} placeholder="Medellín, 5 km de Laureles" /></Field>
            <Field label="Público (opcional)"><Input value={f.audience} onChange={set('audience')} placeholder="25-40, les gusta el café" /></Field>
            <Field label="Presupuesto diario"><Input inputMode="numeric" value={f.dailyBudget} onChange={set('dailyBudget')} placeholder="30000" /></Field>
            <Field label="Duración (días)"><Input type="number" min={1} max={365} value={f.durationDays} onChange={set('durationDays')} /></Field>
            <Field label="Destino" hint="Link de la web o número de WhatsApp"><Input value={f.destination} onChange={set('destination')} /></Field>
            <Field label="Oferta confirmada (opcional)" hint="Solo si es real y vigente"><Input value={f.offer} onChange={set('offer')} /></Field>
            <Field label="Valor promedio de venta (opcional)"><Input inputMode="numeric" value={f.averageTicket} onChange={set('averageTicket')} /></Field>
            <Field label="Margen % (opcional)"><Input inputMode="numeric" value={f.marginPct} onChange={set('marginPct')} /></Field>
            <Field label="¿Cuántos leads atiende tu equipo al día? (opcional)"><Input inputMode="numeric" value={f.leadCapacityPerDay} onChange={set('leadCapacityPerDay')} /></Field>
            <div className="sm:col-span-2"><Button disabled={propose.isPending} onClick={() => propose.mutate()}>{propose.isPending ? 'Armando propuesta…' : 'Ver propuesta'}</Button></div>
          </fieldset>
        </Card>
      ) : (
        <Card kicker="Paso 2 · revisa antes de crear" title="Propuesta">
          <div className="grid gap-5 text-sm md:grid-cols-2">
            <div>
              <p className="kicker mb-1">Recomendación</p>
              <p><b>Objetivo:</b> {OBJECTIVE[p.recommendation.objective] ?? p.recommendation.objective} en {p.recommendation.platform === 'META' ? 'Meta (Facebook e Instagram)' : p.recommendation.platform}</p>
              <p className="text-ink-2">{p.recommendation.why}</p>
              <p className="kicker mb-1 mt-3">Estructura sugerida</p>
              <ul className="list-disc pl-5">{p.recommendation.structure.map((s: any) => <li key={s.name}>{s.name} · {money(s.dailyBudget, p.recommendation.budget.currency)}/día</li>)}</ul>
              <p className="kicker mb-1 mt-3">Variantes para probar (una hipótesis cada una)</p>
              <ul className="list-disc pl-5">{p.recommendation.variants.map((v: any) => <li key={v.hypothesis}><b>{v.hypothesis.replace(/_/g, ' ').toLowerCase()}:</b> {v.idea}</li>)}</ul>
              <p className="mt-3"><b>Cómo se mide:</b> {p.recommendation.metrics.join(' · ')}</p>
            </div>
            <div>
              <p className="kicker mb-1">Presupuesto</p>
              <p className="display text-2xl">{money(p.recommendation.budget.total, p.recommendation.budget.currency)}</p>
              <p className="text-ink-2">{money(p.recommendation.budget.daily, p.recommendation.budget.currency)} al día durante {p.recommendation.budget.days} días. Lo cobra Meta a tu medio de pago, aparte de BackOffice.</p>
              <p className="mt-2 text-ink-2">{p.recommendation.expectations}</p>
              {p.recommendation.breakEvenCostPerSale && <p className="mt-1 text-ink-2">Para no perder, cada venta debería costar menos de {money(p.recommendation.breakEvenCostPerSale, p.recommendation.budget.currency)}.</p>}
              <p className="kicker mb-1 mt-3">Riesgos</p><ul className="list-disc pl-5 text-ink-2">{p.risks.map((r: string) => <li key={r}>{r}</li>)}</ul>
              {p.missing.length > 0 && <><p className="kicker mb-1 mt-3">Datos que faltan</p><p className="text-ink-2">{p.missing.join(' · ')}</p></>}
              <p className="kicker mb-1 mt-3">Supuestos</p><p className="text-ink-2">{p.assumptions.join(' · ')}</p>
            </div>
          </div>
          <div className="mt-5 border-t-2 border-line pt-4 text-sm">
            <p className="kicker mb-1">Lo que se enviará a la plataforma</p>
            <p>Campaña «{p.providerConfig.name}» · objetivo {OBJECTIVE[p.providerConfig.objective] ?? p.providerConfig.objective} · <b>en PAUSA</b>.</p>
            <p className="text-xs text-ink-3">Después hay que completar en Meta: {p.pendingInPlatform.join(' · ')}.</p>
            {canWrite && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                {usable.length ? (
                  <>
                    <Field label="Cuenta"><Select value={account} onChange={(e) => setAccount(e.target.value)} className="!w-64"><option value="">Elegir…</option>{usable.map((a) => <option key={a.id} value={a.id}>{a.name}{a.mode === 'DEMO' ? ' (demostración)' : ''}</option>)}</Select></Field>
                    <Button disabled={!account} onClick={() => setConfirmOpen(true)}>Crear en pausa</Button>
                  </>
                ) : <p className="text-sm">Conecta una cuenta publicitaria para crearla. <Link to="?tab=cuentas" className="underline">Ir a Cuentas</Link></p>}
                <Button variant="ghost" onClick={() => setCurrent(null)}>Editar brief</Button>
              </div>
            )}
          </div>
        </Card>
      )}
      <Card kicker="Historial" title="Briefs y campañas">
        {!briefs?.length ? <p className="text-sm text-ink-3">Sin briefs todavía.</p> : (
          <ul className="divide-y divide-line text-sm">
            {briefs.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><b>{b.title}</b> <Badge tone={b.status === 'CREATED' ? 'ok' : 'neutral'}>{b.status === 'CREATED' ? 'Creada en pausa' : 'Propuesta'}</Badge><span className="block text-xs text-ink-3">{new Date(b.createdAt).toLocaleDateString('es-CO')}{b.createdExternalId ? ` · ID ${b.createdExternalId}` : ''}</span></span>
                {b.status !== 'CREATED' && <Button size="sm" variant="outline" onClick={() => setCurrent(b)}>Ver propuesta</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Confirm open={confirmOpen} title="Crear campaña en pausa" cta="Crear en pausa" busy={create.isPending} onClose={() => setConfirmOpen(false)} onConfirm={() => create.mutate()}>
        <p>Se creará «{p?.providerConfig.name}» en la cuenta elegida, <b>en pausa</b>: no gasta nada hasta que la completes y la actives.</p>
        <p>Presupuesto planeado: {money(p?.recommendation.budget.daily, cur)} al día ({money(p?.recommendation.budget.total, cur)} en total), que activarás tú en la plataforma.</p>
        {accounts.find((a) => a.id === account)?.mode === 'DEMO' && <p className="text-info">Es una cuenta de demostración: la creación es simulada.</p>}
      </Confirm>
    </div>
  );
}
