import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, Link2, Pause, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney, fmtNum } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Stat } from '../../components/ui';

/**
 * Publicidad de BackOffice en Meta (equipo): gasto, resultados y, sobre todo,
 * cuánto cuesta cada registro y cada empresa que llega desde los anuncios.
 * El cruce sale de los enlaces con UTM que se arman aquí mismo.
 */

interface Campaign {
  id: string; name: string; status: string; effectiveStatus: string; objective: string;
  spend: number; impressions: number; reach: number; clicks: number; ctr: number; cpc: number;
  leads: number; conversations: number; linkClicks: number;
  signups: number; companies: number; costPerSignup: number | null; costPerCompany: number | null;
}
interface AdsData {
  days: number;
  connected: boolean;
  account: { id: string; name: string; currency: string; status: number } | null;
  error: string | null;
  campaigns: Campaign[];
  manual: Array<{ id: string; date: string; campaign: string; spend: number; notes: string }>;
  totals: { spend: number; signupsFromMeta: number; companiesFromMeta: number; signupsTotal: number; costPerSignup: number | null; costPerCompany: number | null };
  attribution: Array<{ campaign: string; sessions: number; done: number }>;
}

function slug(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

export default function Publicidad() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const [connectOpen, setConnectOpen] = useState(false);
  const [creds, setCreds] = useState({ accountId: '', token: '' });
  const [manual, setManual] = useState({ date: new Date().toISOString().slice(0, 10), campaign: '', spend: '', notes: '' });
  const [link, setLink] = useState({ source: 'facebook', campaign: '' });
  const { data, isLoading } = useQuery({ queryKey: ['ads', days], queryFn: () => api.get<AdsData>(`/platform/ads?days=${days}`) });
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
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/platform/ads/campaigns/${id}/status`, { status }),
    onSuccess: (_r, v) => {
      toast.success(v.status === 'PAUSED' ? 'Campaña pausada en Meta' : 'Campaña activada en Meta');
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !data) return <Loading />;
  const base = `${window.location.origin}/registro`;
  const utmLink = `${base}?utm_source=${link.source}&utm_medium=paid&utm_campaign=${slug(link.campaign) || 'nombre-campana'}`;

  return (
    <>
      <PageHeader
        kicker={data.connected && data.account ? `${data.account.name} · ${data.account.id}` : 'Meta Ads de BackOffice'}
        title="Publicidad"
        actions={
          <div className="flex gap-2">
            <Select className="!w-40" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Rango">
              <option value={7}>Últimos 7 días</option>
              <option value={14}>Últimos 14 días</option>
              <option value={30}>Últimos 30 días</option>
              <option value={90}>Últimos 90 días</option>
            </Select>
            {data.connected
              ? <Button variant="outline" onClick={() => { if (confirm('¿Desconectar la cuenta publicitaria?')) disconnect.mutate(); }}>Desconectar</Button>
              : <Button onClick={() => setConnectOpen(true)}>Conectar Meta Ads</Button>}
          </div>
        }
      />

      {data.error && <p className="mb-4 border-2 border-bad bg-bad-soft px-4 py-3 text-sm text-bad">No pudimos leer Meta: {data.error}. Revisa que el token siga vigente.</p>}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Gasto" value={fmtMoney(data.totals.spend)} hint={data.connected ? 'Meta + anotado a mano' : 'Anotado a mano'} />
        <Stat label="Registros desde Meta" value={fmtNum(data.totals.signupsFromMeta)} hint={`de ${fmtNum(data.totals.signupsTotal)} en total`} />
        <Stat label="Empresas creadas" value={fmtNum(data.totals.companiesFromMeta)} hint="Llegaron por anuncios" />
        <Stat label="Costo por registro" value={data.totals.costPerSignup != null ? fmtMoney(data.totals.costPerSignup) : '—'} />
        <Stat label="Costo por empresa" value={data.totals.costPerCompany != null ? fmtMoney(data.totals.costPerCompany) : '—'} tone={data.totals.costPerCompany != null ? 'ok' : undefined} />
      </div>

      {data.connected ? (
        <Card kicker="Campañas en Meta" title="Resultados" className="mb-6">
          {data.campaigns.length === 0 ? <p className="text-sm text-ink-3">La cuenta no tiene campañas.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    <th className="py-2">Campaña</th>
                    <th className="py-2 text-right">Gasto</th>
                    <th className="py-2 text-right">Alcance</th>
                    <th className="py-2 text-right">Clics · CTR</th>
                    <th className="py-2 text-right">Leads / chats</th>
                    <th className="py-2 text-right">Registros</th>
                    <th className="py-2 text-right">Empresas</th>
                    <th className="py-2 text-right">Costo por empresa</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c) => (
                    <tr key={c.id} className="border-b border-line">
                      <td className="py-2.5 pr-3">
                        <p className="font-semibold">{c.name}</p>
                        <p className="text-[11px] text-ink-3">
                          <Badge tone={c.effectiveStatus === 'ACTIVE' ? 'ok' : 'neutral'}>{c.effectiveStatus === 'ACTIVE' ? 'Activa' : c.effectiveStatus === 'PAUSED' ? 'Pausada' : c.effectiveStatus}</Badge>{' '}
                          {c.objective?.replace('OUTCOME_', '').toLowerCase()}
                        </p>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{fmtMoney(c.spend)}</td>
                      <td className="py-2.5 text-right tabular-nums">{fmtNum(c.reach)}</td>
                      <td className="py-2.5 text-right tabular-nums">{fmtNum(c.clicks)} · {c.ctr.toFixed(2)}%</td>
                      <td className="py-2.5 text-right tabular-nums">{fmtNum(c.leads)} / {fmtNum(c.conversations)}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.signups}</td>
                      <td className="py-2.5 text-right tabular-nums font-semibold">{c.companies}</td>
                      <td className="py-2.5 text-right tabular-nums">{c.costPerCompany != null ? fmtMoney(c.costPerCompany) : '—'}</td>
                      <td className="py-2.5 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={setStatus.isPending}
                          onClick={() => {
                            const next = c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
                            if (confirm(`¿${next === 'PAUSED' ? 'Pausar' : 'Activar'} "${c.name}" en Meta?`)) setStatus.mutate({ id: c.id, status: next });
                          }}
                          aria-label={c.status === 'ACTIVE' ? 'Pausar' : 'Activar'}
                        >
                          {c.status === 'ACTIVE' ? <Pause size={13} /> : <Play size={13} />}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-ink-3">Registros y empresas se cruzan por el nombre de la campaña en Meta y el utm_campaign del enlace (sin importar mayúsculas).</p>
        </Card>
      ) : (
        <Card kicker="Sin conexión" title="Conecta la cuenta publicitaria" className="mb-6">
          <p className="text-sm text-ink-2">
            Con la cuenta conectada verás aquí el gasto y los resultados de cada campaña, y podrás pausarlas. Mientras tanto puedes anotar el gasto a mano
            abajo y el costo por registro se calcula igual.
          </p>
          <Button className="mt-3" onClick={() => setConnectOpen(true)}>Conectar Meta Ads</Button>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card kicker="Para cada anuncio" title="Enlace con seguimiento">
          <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
            <Field label="Dónde">
              <Select value={link.source} onChange={(e) => setLink({ ...link, source: e.target.value })}>
                <option value="facebook">Facebook</option>
                <option value="instagram">Instagram</option>
              </Select>
            </Field>
            <Field label="Nombre de la campaña" hint="Igual que en Meta, así se cruzan solos">
              <Input value={link.campaign} placeholder="Lanzamiento octubre" onChange={(e) => setLink({ ...link, campaign: e.target.value })} />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-2 border-2 border-line bg-bone px-3 py-2 text-xs">
            <Link2 size={13} className="shrink-0" />
            <span className="truncate font-mono">{utmLink}</span>
            <button type="button" className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Copiar enlace" onClick={() => navigator.clipboard?.writeText(utmLink).then(() => toast.success('Enlace copiado'))}>
              <Copy size={13} />
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-3">Úsalo como destino del anuncio. Cada persona que llegue por ahí queda marcada en Registros con su campaña.</p>
        </Card>

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
                  <b className="tabular-nums">{fmtMoney(m.spend)}</b>
                  <button type="button" aria-label="Borrar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => removeManual.mutate(m.id)}><Trash2 size={13} /></button>
                </span>
              </li>
            ))}
            {!data.manual.length && <li className="py-2 text-ink-3">Nada anotado en este rango.</li>}
          </ul>
        </Card>
      </div>

      {data.attribution.length > 0 && (
        <Card kicker="Quiénes llegaron por anuncios" title="Registros por campaña" className="mt-6">
          <ul className="space-y-1 text-sm">
            {data.attribution.sort((a, b) => b.sessions - a.sessions).map((a) => (
              <li key={a.campaign} className={clsx('flex justify-between border-b border-line py-1.5')}>
                <span>{a.campaign}</span>
                <span className="tabular-nums">{a.sessions} registros · <b>{a.done}</b> empresas</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal open={connectOpen} onClose={() => setConnectOpen(false)} kicker="Meta Ads" title="Conectar la cuenta publicitaria">
        <div className="space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-ink-2">
            <li>En el Business Manager de Meta, crea un usuario del sistema con acceso a la cuenta publicitaria.</li>
            <li>Genera un token con los permisos <b>ads_read</b> (y <b>ads_management</b> si quieres pausar campañas desde aquí).</li>
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
