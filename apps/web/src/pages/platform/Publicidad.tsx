import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import { Button, Card, Field, Input, Loading, Modal, PageHeader, Tabs } from '../../components/ui';
import { AdsSetup, LaunchList, LaunchSetup, LaunchWizard } from './PublicidadLanzar';
import { AlertSettings, CampaignRow, RangeQuery, Results, ResultsView, TrackingLink, todayInZone } from './PublicidadResultados';

/**
 * Publicidad de BackOffice en Meta (equipo): la pauta propia por campaña y por
 * anuncio (PublicidadResultados) y, sobre todo, cuánto cuesta cada registro y
 * cada empresa que paga. Las pestañas de lanzamiento crean campañas propias en
 * pausa (PublicidadLanzar).
 */

type Tab = 'results' | 'launch' | 'launches' | 'setup';

export default function Publicidad() {
  const queryClient = useQueryClient();
  const [rangeQ, setRangeQ] = useState<RangeQuery>({ range: '30' });
  const [tab, setTab] = useState<Tab>('results');
  const [connectOpen, setConnectOpen] = useState(false);
  const [creds, setCreds] = useState({ accountId: '', token: '' });
  // «Hoy» en Bogotá (la zona de la cuenta), nunca con toISOString
  const [manual, setManual] = useState({ date: todayInZone('America/Bogota'), campaign: '', spend: '', notes: '' });
  const qs = (refresh = false) => {
    const p = new URLSearchParams({ range: rangeQ.range });
    if (rangeQ.range === 'custom' && rangeQ.since && rangeQ.until) { p.set('since', rangeQ.since); p.set('until', rangeQ.until); }
    if (refresh) p.set('refresh', '1');
    return p.toString();
  };
  const { data, isLoading, isError, error: loadError, refetch } = useQuery({ queryKey: ['ads', rangeQ], queryFn: () => api.get<Results>(`/platform/ads?${qs()}`) });
  const refreshMeta = useMutation({
    mutationFn: () => api.get<Results>(`/platform/ads?${qs(true)}`),
    onSuccess: (r) => { queryClient.setQueryData(['ads', rangeQ], r); toast.success('Datos de Meta actualizados'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo actualizar'),
  });
  const setup = useQuery({ queryKey: ['ads', 'setup'], queryFn: () => api.get<AdsSetup>('/platform/ads/setup'), enabled: tab !== 'results' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ads'] });

  const connect = useMutation({
    mutationFn: () => api.post<{ account: { name: string } }>('/platform/ads/connect', creds),
    onSuccess: (r) => {
      toast.success(`Conectada: ${r.account.name}`);
      setConnectOpen(false);
      setCreds({ accountId: '', token: '' });
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const disconnect = useMutation({ mutationFn: () => api.delete('/platform/ads/connect'), onSuccess: refresh });
  const addManual = useMutation({
    mutationFn: () => api.post('/platform/ads/manual', manual),
    onSuccess: () => {
      toast.success('Gasto anotado');
      setManual({ ...manual, spend: '', notes: '' });
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const removeManual = useMutation({ mutationFn: (id: string) => api.delete(`/platform/ads/manual/${id}`), onSuccess: refresh });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/platform/ads/campaigns/${id}/status`, { status, confirm: status === 'ACTIVE' }),
    onSuccess: (_r, v) => {
      toast.success(v.status === 'PAUSED' ? 'Campaña pausada en Meta' : 'Campaña activada en Meta');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isError) {
    return (
      <Card kicker="Publicidad" title="No se pudo cargar">
        <p className="text-sm text-ink-2">{loadError instanceof Error ? loadError.message : 'Error al leer los resultados.'}</p>
        <Button className="mt-3" variant="outline" onClick={() => refetch()}>Reintentar</Button>
      </Card>
    );
  }
  if (isLoading || !data) return <Loading label="Leyendo la pauta en Meta…" />;
  const base = `${window.location.origin}/registro`;
  const onStatus = (c: CampaignRow) => {
    const next = c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    if (confirm(next === 'PAUSED' ? `¿Pausar "${c.name}" en Meta?` : `¿Activar "${c.name}" en Meta? Empezará a gastar su presupuesto.`)) setStatus.mutate({ id: c.id, status: next });
  };

  return (
    <>
      <PageHeader
        kicker={data.connected && data.account ? `${data.account.name} · ${data.account.id}` : 'Meta Ads de BackOffice'}
        title="Publicidad"
        actions={
          <div className="flex gap-2">
            {data.connected
              ? <Button variant="outline" onClick={() => { if (confirm('¿Desconectar la cuenta publicitaria?')) disconnect.mutate(); }}>Desconectar</Button>
              : <Button onClick={() => setConnectOpen(true)}>Conectar Meta Ads</Button>}
          </div>
        }
      />

      <div className="mb-6">
        <Tabs
          tabs={[
            { id: 'results', label: 'Resultados' },
            { id: 'launch', label: 'Lanzar campaña' },
            { id: 'launches', label: 'Lanzamientos' },
            { id: 'setup', label: 'Configuración' },
          ]}
          active={tab}
          onChange={(t) => setTab(t as Tab)}
        />
      </div>

      {tab !== 'results' && (
        !data.connected ? (
          <Card kicker="Sin conexión" title="Conecta la cuenta publicitaria">
            <p className="text-sm text-ink-2">Para lanzar campañas hace falta la cuenta publicitaria conectada con un token que tenga <b>ads_management</b>.</p>
            <Button className="mt-3" onClick={() => setConnectOpen(true)}>Conectar Meta Ads</Button>
          </Card>
        ) : setup.isLoading || !setup.data ? <Loading /> : tab === 'launch' ? (
          !setup.data.prefs.pageId || !setup.data.prefs.maxDailyBudget ? (
            <Card kicker="Falta un paso" title="Elige la página y el tope de gasto">
              <p className="text-sm text-ink-2">Antes del primer lanzamiento define qué página publica los anuncios y cuánto puede gastar como máximo cada campaña al día.</p>
              <Button className="mt-3" onClick={() => setTab('setup')}>Ir a Configuración</Button>
            </Card>
          ) : <LaunchWizard setup={setup.data} onCreated={() => setTab('launches')} />
        ) : tab === 'launches' ? <LaunchList setup={setup.data} /> : (
          <div className="space-y-6">
            <LaunchSetup key={JSON.stringify(setup.data.prefs)} setup={setup.data} />
            <AlertSettings key={JSON.stringify(data.thresholds)} value={data.thresholds} currency={data.currency} />
          </div>
        )
      )}

      {tab === 'results' && (<>
      <ResultsView data={data} query={rangeQ} onQuery={setRangeQ} onRefresh={() => refreshMeta.mutate()} refreshing={refreshMeta.isPending} onStatus={onStatus} />

      {!data.connected && (
        <Card kicker="Sin conexión" title="Conecta la cuenta publicitaria" className="mt-6">
          <p className="text-sm text-ink-2">Con la cuenta conectada verás el gasto y los resultados de cada campaña y anuncio. Mientras tanto puedes anotar el gasto a mano abajo y el costo por registro se calcula igual.</p>
          <Button className="mt-3" onClick={() => setConnectOpen(true)}>Conectar Meta Ads</Button>
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <TrackingLink base={base} />

        <Card kicker="Gasto anotado a mano" title="Otros gastos de publicidad">
          <div className="grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)_120px_auto]">
            <Input type="date" value={manual.date} onChange={(e) => setManual({ ...manual, date: e.target.value })} aria-label="Fecha" />
            <Input placeholder="Campaña (utm_campaign)" value={manual.campaign} onChange={(e) => setManual({ ...manual, campaign: e.target.value })} aria-label="Campaña" />
            <Input inputMode="numeric" placeholder="$ Gasto" value={manual.spend} onChange={(e) => setManual({ ...manual, spend: e.target.value })} aria-label="Gasto" />
            <Button variant="outline" disabled={addManual.isPending || !manual.spend || !manual.campaign} onClick={() => addManual.mutate()}>Anotar</Button>
          </div>
          <ul className="mt-3 divide-y divide-line text-sm">
            {data.manual.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 py-2">
                <span>{m.date} · {m.campaign}</span>
                <span className="flex items-center gap-2">
                  <b className="tabular-nums">{fmtMoney(m.spend, data.currency)}</b>
                  <button type="button" aria-label="Borrar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => removeManual.mutate(m.id)}><Trash2 size={13} /></button>
                </span>
              </li>
            ))}
            {!data.manual.length && <li className="py-2 text-ink-3">Nada anotado en este rango.</li>}
          </ul>
        </Card>
      </div>
      </>)}

      <Modal open={connectOpen} onClose={() => setConnectOpen(false)} kicker="Meta Ads" title="Conectar la cuenta publicitaria">
        <div className="space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-ink-2">
            <li>En el Business Manager de Meta, crea un usuario del sistema con acceso a la cuenta publicitaria.</li>
            <li>Genera un token con <b>ads_read</b> y <b>ads_management</b> (para lanzar, activar y pausar desde aquí), y asígnale la página que publica.</li>
            <li>Copia el ID de la cuenta publicitaria (empieza por act_).</li>
          </ol>
          <Field label="ID de la cuenta publicitaria"><Input placeholder="act_1234567890" value={creds.accountId} onChange={(e) => setCreds({ ...creds, accountId: e.target.value })} /></Field>
          <Field label="Token de acceso" hint="Se guarda cifrado"><Input type="password" value={creds.token} onChange={(e) => setCreds({ ...creds, token: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConnectOpen(false)}>Cancelar</Button>
            <Button disabled={connect.isPending || !creds.accountId || !creds.token} onClick={() => connect.mutate()}>{connect.isPending ? 'Probando…' : 'Conectar'}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
