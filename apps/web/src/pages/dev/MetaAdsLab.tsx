import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Table, Tabs } from '../../components/ui';

/**
 * Meta Ads · laboratorio INTERNO del equipo (solo existe en el build local).
 * La protección real está en el backend (rol DEV + META_DEV_ENABLED, 404 para
 * cualquier otro); esta pantalla solo muestra lo que el API ya autorizó.
 * Todo lo que se ve aquí es de la cuenta de pruebas del equipo.
 */

interface Counts { created: number; updated: number; unchanged: number; total: number }
interface CallLog { at: string; method: string; request: string; status: number | null; ms: number; attempt: number; rows?: number; errorKind?: string; errorCode?: string | number; errorSubcode?: string | number; error?: string; usage?: string }
interface Run { id: string; status: string; days: number; since: string; until: string; counts: Record<string, Counts>; warnings: string[]; error: string | null; errorKind: string | null; startedBy: string; startedAt: string; finishedAt: string | null; calls?: CallLog[]; callCount?: number }
interface Status {
  label: string;
  config: { appId: string | null; appSecretSet: boolean; redirectUri: string | null; redirectError: string | null; scopes: string[]; version: string; missing: string[]; defaultDays: number; readOnly: boolean };
  connection: {
    status: 'CONNECTED' | 'EXPIRED' | 'REVOKED' | 'DISCONNECTED'; metaUserId?: string; metaUserName?: string; scopes?: string[]; declined?: string[]; longLived?: boolean | null;
    tokenExpiresAt?: string | null; daysLeft?: number | null; dataAccessExpiresAt?: string | null; selectedAccountId?: string | null; selectedAccountName?: string | null;
    accountCurrency?: string | null; accountTimezone?: string | null; lastSyncAt?: string | null; lastSyncStatus?: string | null; lastError?: string | null; lastErrorKind?: string | null; syncing?: boolean; connectedBy?: string | null; connectedAt?: string | null;
  };
  stored: Record<string, number>;
  runs: Run[];
}
interface Account { id: string; name: string; status: string | null; currency: string | null; timezone: string | null; selected: boolean }
interface Obj { id: string; name: string; status: string | null; effectiveStatus: string | null; objective: string | null; campaignId: string | null; adsetId: string | null; syncedAt: string }
interface InsightRow { campaignId: string; campaignName: string | null; dateStart: string; dateStop: string; impressions: number | null; clicks: number | null; spend: number | null; cpc: number | null; cpm: number | null; ctr: number | null; reach: number | null; actions: Array<{ action_type: string; value: string }> }

const BASE = '/dev/meta-ads';
const dt = (v?: string | null) => (v ? new Date(v).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
/** null = Meta no lo informó: se muestra como guion, nunca como 0 */
const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? '—' : v.toLocaleString('es-CO', { maximumFractionDigits: digits }));
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Error inesperado');
const errCode = (e: unknown) => (e instanceof ApiError ? e.code ?? null : null);

const RETURN_MSG: Record<string, string> = {
  state: 'La vuelta de Meta no traía un state válido (vencido, usado o de otro navegador). Vuelve a conectar.',
  usuario: 'El usuario que inició la conexión ya no tiene rol DEV.',
  token: 'Meta devolvió un token inválido o de otra app.',
  intercambio: 'Meta rechazó el cambio del código por el token. Revisa el App Secret y la URI de redirección.',
  config: 'Falta configuración en el .env del API.',
  meta: 'Meta devolvió un error en la autorización.',
};

function StatusBadge({ s }: { s: Status['connection'] }) {
  if (s.syncing) return <Badge tone="warn">Sincronizando</Badge>;
  if (s.status === 'CONNECTED') return <Badge tone="ok">Conectado</Badge>;
  if (s.status === 'EXPIRED') return <Badge tone="bad">Token vencido</Badge>;
  if (s.status === 'REVOKED') return <Badge tone="bad">Autorización revocada</Badge>;
  return <Badge tone="neutral">No conectado</Badge>;
}

function RunCounts({ counts }: { counts: Record<string, Counts> }) {
  const labels: Record<string, string> = { CAMPAIGN: 'Campañas', ADSET: 'Conjuntos', AD: 'Anuncios', INSIGHT: 'Filas de Insights' };
  return (
    <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
      {Object.entries(labels).map(([k, label]) => (
        <li key={k}>
          <strong>{label}:</strong>{' '}
          {counts[k] ? `${counts[k].total} leídos · ${counts[k].created} nuevos · ${counts[k].updated} actualizados · ${counts[k].unchanged} sin cambios` : 'no leído'}
        </li>
      ))}
    </ul>
  );
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('es-CO')} ${n === 1 ? one : many}`;

function CallsTable({ calls }: { calls: CallLog[] }) {
  if (!calls.length) return <p className="text-sm text-ink-3">Sin llamadas registradas.</p>;
  return (
    <Table head={['Hora', 'Solicitud (sin credenciales)', 'HTTP', 'Duración', 'Filas', 'Error']}>
      {calls.map((c, i) => (
        <tr key={i} className="align-top">
          <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{new Date(c.at).toLocaleTimeString('es-CO')}{c.attempt > 1 ? ` · intento ${c.attempt}` : ''}</td>
          <td className="px-4 py-2 font-mono text-xs [overflow-wrap:anywhere]">{c.request}{c.usage && <div className="mt-1 text-ink-3">{c.usage}</div>}</td>
          <td className="whitespace-nowrap px-4 py-2" data-col="http">{c.status ?? '—'}</td>
          <td className="whitespace-nowrap px-4 py-2" data-col="duracion">{`${c.ms.toLocaleString('es-CO')} ms`}</td>
          {/* Filas = elementos de data[] en la respuesta; sin lista (error o respuesta sin data) → — */}
          <td className="whitespace-nowrap px-4 py-2" data-col="filas">{c.rows === undefined ? '—' : plural(c.rows, 'fila', 'filas')}</td>
          <td className={`px-4 py-2 text-xs ${c.error ? 'text-bad' : 'text-ink-3'}`} data-col="error">
            {c.error ? `${c.errorKind ?? ''} ${c.errorCode ?? ''}${c.errorSubcode ? `/${c.errorSubcode}` : ''} · ${c.error}` : '—'}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export default function MetaAdsLab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('campanas');
  const [days, setDays] = useState<number | null>(null);
  const [lastRun, setLastRun] = useState<Run | null>(null);
  const isDev = user?.role === 'DEV';

  const status = useQuery({ queryKey: ['meta-dev'], queryFn: () => api.get<Status>(`${BASE}/status`), enabled: isDev, retry: false, refetchInterval: (q) => (q.state.data?.connection.syncing ? 3000 : false) });
  const conn = status.data?.connection;
  const connected = conn?.status === 'CONNECTED';
  const refresh = () => qc.invalidateQueries({ queryKey: ['meta-dev'] });

  // Vuelta de Meta: ?r=conectado | cancelado | error&motivo=…
  useEffect(() => {
    const r = params.get('r');
    if (!r) return;
    if (r === 'conectado') toast.success(params.get('motivo') === 'sin_ads_read' ? 'Conectado, pero Meta no concedió ads_read.' : 'Cuenta de Meta conectada.');
    else if (r === 'cancelado') toast.message('Cancelaste la autorización en Facebook. No se guardó nada.');
    else toast.error(RETURN_MSG[params.get('motivo') ?? ''] ?? 'No se pudo conectar con Meta.');
    setParams({}, { replace: true });
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = useMutation({ mutationFn: () => api.get<{ url: string }>(`${BASE}/connect`), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => toast.error(errMsg(e)) });
  const accounts = useQuery({ queryKey: ['meta-dev', 'accounts'], queryFn: () => api.get<Account[]>(`${BASE}/accounts`), enabled: false, retry: false });
  const select = useMutation({ mutationFn: (accountId: string) => api.post(`${BASE}/select`, { accountId }), onSuccess: () => { toast.success('Cuenta de pruebas elegida'); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const sync = useMutation({
    mutationFn: () => api.post<Run & { calls: number }>(`${BASE}/sync`, { days: days ?? status.data?.config.defaultDays }),
    onSuccess: (r) => {
      setLastRun({ ...r, calls: undefined, callCount: r.calls } as Run);
      if (r.status === 'OK') toast.success('Sincronización completada');
      else if (r.status === 'PARTIAL') toast.warning('Sincronización parcial: revisa los avisos');
      else toast.error(r.error ?? 'La sincronización falló');
      refresh();
    },
    onError: (e) => { toast.error(errMsg(e)); refresh(); },
  });
  const disconnect = useMutation({
    mutationFn: (purge: boolean) => api.delete<{ revoked: string; revokeError: string | null; purged: number }>(`${BASE}/connection?revoke=1${purge ? '&purge=1' : ''}`),
    onSuccess: (r) => { toast.success(r.revoked === 'OK' ? 'Desconectado y permiso revocado en Meta' : `Desconectado aquí. Meta no aceptó revocar: ${r.revokeError ?? ''}`); setLastRun(null); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (!isDev) return <div className="mx-auto max-w-3xl p-8"><EmptyState title="Solo para desarrolladores" hint="Esta herramienta interna necesita una sesión con rol DEV." /></div>;
  if (status.isLoading) return <Loading label="Leyendo el estado de la integración…" />;
  if (status.error) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <EmptyState
          title="Integración interna apagada"
          hint={(status.error as ApiError).status === 404 ? 'El API no expone esta ruta: falta META_DEV_ENABLED=1 en apps/api/.env (y nunca en producción).' : errMsg(status.error)}
        />
      </div>
    );
  }
  const s = status.data!;
  const cfg = s.config;
  const run = lastRun ?? s.runs[0] ?? null;
  const noInsights = run?.status !== 'ERROR' && run?.counts?.INSIGHT && run.counts.INSIGHT.total === 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <p className="mb-4 border-2 border-warn bg-paper px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em]">{s.label} · no visible para clientes · solo lectura</p>
      <PageHeader kicker="Herramienta interna · localhost" title="Meta Ads" accent="laboratorio" actions={<StatusBadge s={conn!} />} />

      {cfg.missing.length > 0 && (
        <Card title="Falta configuración" kicker="apps/api/.env" className="mb-6">
          <ul className="list-disc pl-5 text-sm">{cfg.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="mt-3 text-sm">URI de redirección que debe estar registrada en Meta Developers (Facebook Login → Configuración → URI de redireccionamiento de OAuth válidos):</p>
          <p className="mt-1 font-mono text-xs [overflow-wrap:anywhere]">{cfg.redirectUri ?? cfg.redirectError}</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Conexión" kicker={`Graph ${cfg.version} · app ${cfg.appId ?? 'sin configurar'}`}>
          {conn?.status === 'DISCONNECTED' && <p className="text-sm">No conectado. Al conectar se abre Facebook para autorizar la app con tu cuenta de desarrollo.</p>}
          {(conn?.status === 'EXPIRED' || conn?.status === 'REVOKED') && (
            <p className="mb-3 border-2 border-bad px-3 py-2 text-sm">
              {conn.status === 'EXPIRED' ? 'El token venció. Meta no permite renovarlo sin volver a autorizar.' : 'La autorización fue revocada en Meta (o cambió la contraseña).'} {conn.lastError}
            </p>
          )}
          {conn?.status !== 'DISCONNECTED' && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-3">Usuario de Meta</dt><dd>{conn?.metaUserName ?? '—'} <span className="text-ink-3">{conn?.metaUserId}</span></dd>
              <dt className="text-ink-3">Permisos concedidos</dt><dd>{conn?.scopes?.join(', ') || '—'}</dd>
              {!!conn?.declined?.length && <><dt className="text-ink-3">Rechazados</dt><dd className="text-bad">{conn.declined.join(', ')}</dd></>}
              <dt className="text-ink-3">Token</dt><dd>{conn?.longLived ? 'larga duración' : 'corta duración'} · vence {dt(conn?.tokenExpiresAt)}{conn?.daysLeft !== null && conn?.daysLeft !== undefined ? ` (${conn.daysLeft} días)` : ''}</dd>
              <dt className="text-ink-3">Acceso a datos hasta</dt><dd>{dt(conn?.dataAccessExpiresAt)}</dd>
              <dt className="text-ink-3">Conectó</dt><dd>{conn?.connectedBy ?? '—'} · {dt(conn?.connectedAt)}</dd>
            </dl>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" disabled={cfg.missing.length > 0 || connect.isPending || connect.isSuccess} onClick={() => connect.mutate()}>
              {connect.isPending || connect.isSuccess ? 'Esperando autorización…' : connected ? 'Volver a autorizar' : 'Conectar Meta Ads'}
            </Button>
            {conn?.status !== 'DISCONNECTED' && (
              <>
                <Button size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => { if (confirm('¿Desconectar? Se revoca el permiso en Meta y se borra el token. Los datos internos se conservan.')) disconnect.mutate(false); }}>Desconectar</Button>
                <Button size="sm" variant="danger" disabled={disconnect.isPending} onClick={() => { if (confirm('¿Desconectar y BORRAR todos los datos internos de prueba (campañas, Insights, historial)?')) disconnect.mutate(true); }}>Desconectar y borrar datos</Button>
              </>
            )}
          </div>
          <p className="mt-3 text-xs text-ink-3">Permisos que se piden: {cfg.scopes.join(', ')}. Solo lectura: no se pausa, activa ni crea nada en Meta.</p>
        </Card>

        <Card title="Cuenta publicitaria de pruebas" kicker={conn?.selectedAccountId ?? 'sin elegir'}>
          {conn?.selectedAccountId && <p className="text-sm"><strong>{conn.selectedAccountName}</strong> · {conn.accountCurrency} · {conn.accountTimezone}</p>}
          <Button className="mt-3" size="sm" variant="outline" disabled={!connected || accounts.isFetching} onClick={() => accounts.refetch()}>{accounts.isFetching ? 'Consultando Meta…' : 'Consultar cuentas autorizadas'}</Button>
          {accounts.error && <p className="mt-2 text-sm text-bad">{errMsg(accounts.error)}{errCode(accounts.error)?.startsWith('AUTH_') ? ' — vuelve a autorizar.' : ''}</p>}
          {accounts.data && (accounts.data.length === 0
            ? <p className="mt-3 text-sm">Meta no devolvió cuentas publicitarias para este usuario.</p>
            : (
              <ul className="mt-3 divide-y divide-line border-2 border-ink">
                {accounts.data.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <span><strong>{a.name}</strong> <span className="font-mono text-xs text-ink-3">{a.id}</span> · {a.status} · {a.currency} · {a.timezone}</span>
                    {a.id === conn?.selectedAccountId ? <Badge tone="ok">Elegida</Badge> : <Button size="sm" variant="ghost" disabled={select.isPending} onClick={() => select.mutate(a.id)}>Elegir</Button>}
                  </li>
                ))}
              </ul>
            ))}
          <div className="mt-5 border-t-2 border-line pt-4">
            <p className="kicker">Sincronización manual</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {[30, 60].map((d) => (
                <Button key={d} size="sm" variant={(days ?? cfg.defaultDays) === d ? 'primary' : 'ghost'} onClick={() => setDays(d)}>{d} días</Button>
              ))}
              <Button size="sm" disabled={!connected || !conn?.selectedAccountId || sync.isPending || conn?.syncing} onClick={() => sync.mutate()}>
                {sync.isPending || conn?.syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
              </Button>
            </div>
            <p className="mt-2 text-sm text-ink-3">Última sincronización: {dt(conn?.lastSyncAt)}{conn?.lastSyncStatus ? ` · ${conn.lastSyncStatus}` : ''}</p>
          </div>
        </Card>
      </div>

      {run && (
        <Card className="mt-6" title={run.status === 'OK' ? 'Sincronización completada' : run.status === 'PARTIAL' ? 'Sincronización parcial' : run.status === 'RUNNING' ? 'Sincronizando' : 'Error de sincronización'} kicker={`${run.since} → ${run.until} · ${run.days} días`}>
          {run.error && <p className="text-sm text-bad">{run.errorKind}: {run.error}</p>}
          <RunCounts counts={run.counts ?? {}} />
          {noInsights && <p className="mt-3 border-2 border-line px-3 py-2 text-sm"><strong>Sin datos disponibles:</strong> Meta aceptó la consulta de Insights y devolvió <code>data: []</code>. No hay métricas en ese rango; no se rellenó nada.</p>}
          {run.warnings?.length > 0 && <ul className="mt-3 list-disc pl-5 text-sm text-ink-2">{run.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
        </Card>
      )}

      <div className="mt-8">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'campanas', label: `Campañas (${s.stored.CAMPAIGN ?? 0})` },
            { id: 'conjuntos', label: `Conjuntos (${s.stored.ADSET ?? 0})` },
            { id: 'anuncios', label: `Anuncios (${s.stored.AD ?? 0})` },
            { id: 'insights', label: `Insights (${s.stored.INSIGHT ?? 0})` },
            { id: 'crudo', label: 'Respuestas de Meta' },
            { id: 'credencial', label: 'Credencial' },
            { id: 'historial', label: 'Historial' },
          ]}
        />
        <div className="mt-4">
          {tab === 'campanas' && <Objects level="CAMPAIGN" enabled={!!conn?.selectedAccountId} />}
          {tab === 'conjuntos' && <Objects level="ADSET" enabled={!!conn?.selectedAccountId} />}
          {tab === 'anuncios' && <Objects level="AD" enabled={!!conn?.selectedAccountId} />}
          {tab === 'insights' && <Insights enabled={!!conn?.selectedAccountId} />}
          {tab === 'crudo' && <Raw enabled={connected} initialDays={days ?? cfg.defaultDays} />}
          {tab === 'credencial' && <Credential connected={connected} />}
          {tab === 'historial' && <History />}
        </div>
      </div>
    </div>
  );
}

function Objects({ level, enabled }: { level: 'CAMPAIGN' | 'ADSET' | 'AD'; enabled: boolean }) {
  const q = useQuery({ queryKey: ['meta-dev', 'objects', level], queryFn: () => api.get<Obj[]>(`${BASE}/objects?level=${level}`), enabled, retry: false });
  if (!enabled) return <EmptyState title="Sin cuenta elegida" hint="Elige la cuenta de pruebas y sincroniza." />;
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <EmptyState title="Sin datos" hint="Todavía no se sincronizó nada en este nivel, o Meta no devolvió elementos." />;
  return (
    <Table head={['Nombre', 'ID', 'Estado', 'Estado efectivo', level === 'CAMPAIGN' ? 'Objetivo' : 'Campaña', ...(level === 'AD' ? ['Conjunto'] : []), 'Sincronizado']}>
      {q.data.map((o) => (
        <tr key={o.id}>
          <td className="px-4 py-2">{o.name}</td>
          <td className="px-4 py-2 font-mono text-xs">{o.id}</td>
          <td className="px-4 py-2">{o.status ?? '—'}</td>
          <td className="px-4 py-2">{o.effectiveStatus ?? '—'}</td>
          <td className="px-4 py-2 font-mono text-xs">{level === 'CAMPAIGN' ? o.objective ?? '—' : o.campaignId ?? '—'}</td>
          {level === 'AD' && <td className="px-4 py-2 font-mono text-xs">{o.adsetId ?? '—'}</td>}
          <td className="px-4 py-2 text-xs">{dt(o.syncedAt)}</td>
        </tr>
      ))}
    </Table>
  );
}

function Insights({ enabled }: { enabled: boolean }) {
  const q = useQuery({ queryKey: ['meta-dev', 'insights'], queryFn: () => api.get<{ currency: string | null; rows: InsightRow[]; totals: Array<{ campaignId: string; campaignName: string | null; days: number; impressions: number | null; clicks: number | null; spend: number | null }> }>(`${BASE}/insights`), enabled, retry: false });
  if (!enabled) return <EmptyState title="Sin cuenta elegida" hint="Elige la cuenta de pruebas y sincroniza." />;
  if (q.isLoading) return <Loading />;
  if (!q.data?.rows.length) return <EmptyState title="Sin datos disponibles" hint="Meta no devolvió métricas para el rango sincronizado (data: []). Es un resultado válido: la cuenta no tuvo entrega en esos días." />;
  const cur = q.data.currency ?? '';
  return (
    <div className="space-y-6">
      <Table head={['Campaña', 'Días con datos', 'Impresiones', 'Clics', `Gasto ${cur}`]}>
        {q.data.totals.map((t) => (
          <tr key={t.campaignId}>
            <td className="px-4 py-2">{t.campaignName ?? t.campaignId}</td>
            <td className="px-4 py-2">{t.days}</td>
            <td className="px-4 py-2">{num(t.impressions)}</td>
            <td className="px-4 py-2">{num(t.clicks)}</td>
            <td className="px-4 py-2">{num(t.spend, 2)}</td>
          </tr>
        ))}
      </Table>
      <p className="text-xs text-ink-3">Totales = suma de los días que Meta reportó. El alcance no se suma (son personas únicas por día). «—» = Meta no informó ese dato.</p>
      <Table head={['Día', 'Campaña', 'Impr.', 'Clics', 'Gasto', 'CPC', 'CPM', 'CTR %', 'Alcance', 'Acciones']}>
        {q.data.rows.map((r) => (
          <tr key={`${r.campaignId}-${r.dateStart}`}>
            <td className="px-4 py-2 font-mono text-xs">{r.dateStart}</td>
            <td className="px-4 py-2">{r.campaignName ?? r.campaignId}</td>
            <td className="px-4 py-2">{num(r.impressions)}</td>
            <td className="px-4 py-2">{num(r.clicks)}</td>
            <td className="px-4 py-2">{num(r.spend, 2)}</td>
            <td className="px-4 py-2">{num(r.cpc, 2)}</td>
            <td className="px-4 py-2">{num(r.cpm, 2)}</td>
            <td className="px-4 py-2">{num(r.ctr, 2)}</td>
            <td className="px-4 py-2">{num(r.reach)}</td>
            <td className="px-4 py-2 text-xs">{r.actions.length ? r.actions.map((a) => `${a.action_type}: ${a.value}`).join(' · ') : '—'}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

const RAW_KINDS = [
  ['me', 'Usuario (/me)'], ['permissions', 'Permisos'], ['accounts', 'Cuentas'], ['campaigns', 'Campañas'], ['adsets', 'Conjuntos'], ['ads', 'Anuncios'], ['insights', 'Insights'],
] as const;

interface RawResult { ok: boolean; kind: string; live: boolean; saved: boolean; maxRows: number; range: { days: number; since: string; until: string } | null; calls: CallLog[]; body?: unknown; error?: unknown }

function Raw({ enabled, initialDays }: { enabled: boolean; initialDays: number }) {
  const [kind, setKind] = useState<string | null>(null);
  const [rawDays, setRawDays] = useState(initialDays);
  const q = useQuery({
    queryKey: ['meta-dev', 'raw', kind, rawDays],
    queryFn: () => api.get<RawResult>(`${BASE}/raw?kind=${kind}&days=${rawDays}`),
    enabled: enabled && !!kind,
    retry: false,
  });
  if (!enabled) return <EmptyState title="No conectado" hint="Conecta Meta para consultar en vivo." />;
  return (
    // Borde punteado: no es una sincronización ni queda en el historial
    <div className="border-2 border-dashed border-ink-3 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.1em]">Consulta en vivo · No se guarda · Máx. 25 filas</p>
      <p className="mt-1 text-sm text-ink-3">Una sola página directa a Meta, para revisar la respuesta. No forma parte del historial de sincronizaciones. El token y el appsecret_proof nunca se muestran.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="kicker">Días para Insights</span>
        {[30, 60].map((d) => <Button key={d} size="sm" variant={rawDays === d ? 'primary' : 'ghost'} onClick={() => setRawDays(d)}>{d} días</Button>)}
      </div>
      <div className="mb-4 mt-3 flex flex-wrap gap-2">
        {RAW_KINDS.map(([k, label]) => <Button key={k} size="sm" variant={kind === k ? 'primary' : 'outline'} onClick={() => { setKind(k); if (kind === k) q.refetch(); }}>{label}</Button>)}
      </div>
      {q.isFetching && <Loading label="Consultando Meta…" />}
      {q.data && (
        <div className="space-y-3">
          <p className="text-sm" data-testid="raw-range">
            {q.data.range
              ? <>Rango enviado a Meta: <strong>{q.data.range.since} → {q.data.range.until}</strong> · {q.data.range.days} días seleccionados</>
              : 'Esta consulta no usa rango de fechas.'}
          </p>
          <CallsTable calls={q.data.calls} />
          <pre className="max-h-[480px] overflow-auto border-2 border-ink bg-paper p-3 text-xs">{JSON.stringify(q.data.ok ? q.data.body : q.data.error, null, 2)}</pre>
        </div>
      )}
      {q.error && <p className="text-sm text-bad">{errMsg(q.error)}</p>}
    </div>
  );
}

function Credential({ connected }: { connected: boolean }) {
  const [live, setLive] = useState(false);
  const q = useQuery({ queryKey: ['meta-dev', 'credential', live], queryFn: () => api.get<Record<string, unknown>>(`${BASE}/credential${live ? '?live=1' : ''}`), retry: false });
  return (
    <div>
      <p className="mb-3 text-sm text-ink-3">Comprueba cómo está guardado el token sin mostrarlo. «Verificar en Meta» usa debug_token desde el backend.</p>
      <Button size="sm" variant="outline" disabled={!connected || q.isFetching} onClick={() => { if (live) q.refetch(); else setLive(true); }}>Verificar en Meta</Button>
      {q.data && <pre className="mt-3 overflow-auto border-2 border-ink bg-paper p-3 text-xs">{JSON.stringify(q.data, null, 2)}</pre>}
      {q.error && <p className="mt-2 text-sm text-bad">{errMsg(q.error)}</p>}
    </div>
  );
}

function History() {
  const q = useQuery({ queryKey: ['meta-dev', 'runs'], queryFn: () => api.get<Run[]>(`${BASE}/runs`), retry: false });
  if (q.isLoading) return <Loading />;
  if (!q.data?.length) return <EmptyState title="Sin sincronizaciones" hint="Todavía no se ejecutó ninguna." />;
  return (
    <div className="space-y-6">
      <p className="text-xs font-semibold uppercase tracking-[0.1em]">Historial de sincronizaciones · guardado · cada tarjeta muestra solo las llamadas de esa sincronización</p>
      {q.data.map((r) => (
        <Card key={r.id} title={`${r.status} · ${dt(r.startedAt)}`} kicker={`${r.since} → ${r.until} · ${r.startedBy}`}>
          {r.error && <p className="text-sm text-bad">{r.errorKind}: {r.error}</p>}
          <RunCounts counts={r.counts} />
          {r.warnings.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm">{r.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          <div className="mt-3"><CallsTable calls={r.calls ?? []} /></div>
        </Card>
      ))}
    </div>
  );
}
