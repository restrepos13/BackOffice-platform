import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../../lib/api';
import { Badge, Card, EmptyState, Loading } from '../../../components/ui';
import { Explainer } from '../../../components/Explainer';
import { Term } from '../../../components/Term';
import ScheduleCall from '../../../components/ScheduleCall';
import { withScope } from '../shared';

interface Group { key: string; label: string; designs: number; impressions: number; clicks: number; spend: number; conversations: number; ctr: number | null; cpc: number | null; costPerConversation: number | null }
interface Result { designId: string; name: string; familyLabel: string | null; format: string; impressions: number; clicks: number; spend: number; conversations: number; leads: number; days: number }
interface WhatWorksData {
  connection: { adsContracted: boolean; adAccounts: number; demoOnly: boolean; pageConnected: boolean };
  designsInAds: number; designsWithResults: number; byFamily: Group[]; byFormat: Group[]; top: Result[];
  recommendations: string[]; note: string | null; minImpressions: number; currency: string;
}

const pct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(2)} %`);
const money = (n: number | null, c: string) => (n === null ? '—' : new Intl.NumberFormat('es-CO', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(n));
const int = (n: number) => n.toLocaleString('es-CO');

/**
 * Creative aprende de Meta (solo lectura): qué estilos y formatos de tus
 * diseños consiguen más clics y conversaciones. Publicar y pautar se hace en Ads.
 */
export function WhatWorks({ q }: { q: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['creative-what-works', q], queryFn: () => api.get<WhatWorksData>(withScope('/creative/create/what-works', q)) });
  if (isLoading) return <Loading label="Revisando tus resultados en Meta…" />;
  if (error || !data) return <Card title="Qué te funciona"><p className="text-sm">{error instanceof Error ? error.message : 'No disponible'}</p></Card>;
  const c = data.connection;
  return (
    <div className="space-y-6">
      <Explainer
        id="creative-what-works"
        title="¿Cómo sabe Creative qué te funciona?"
        summary={<>Cuando una pieza hecha aquí se usa en un anuncio, Meta nos cuenta cuántas personas la vieron, cuántas le dieron clic y cuántas te escribieron. Con eso comparamos <b>estilos de diseño</b> y <b>formatos</b> y te decimos cuáles repetir. Aquí solo se lee: publicar y pautar se hace en Ads.</>}
      />

      {!c.adAccounts && (
        <Card kicker="Conexión con Meta" title={c.demoOnly ? 'Estás viendo datos de prueba' : 'Conecta Meta para aprender de tus resultados'}>
          <p className="text-sm text-ink-2">
            {c.demoOnly
              ? 'Tu cuenta de Meta está en modo de prueba: los números no son reales, así que no los usamos para recomendarte.'
              : 'Para saber qué diseños te traen clientes necesitamos leer los resultados de tu cuenta publicitaria de Meta (solo lectura: Creative no publica ni gasta nada).'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {c.adsContracted
              ? <Link to="/app/ads?tab=cuentas" className="inline-flex items-center border-2 border-ink bg-ink px-3 py-1.5 text-sm font-semibold text-bone">Conectar en Ads</Link>
              : <ScheduleCall q={q} topic="ADS" label="Que el equipo conecte mi Meta (solo lectura)" size="sm" />}
          </div>
        </Card>
      )}

      {data.note && <p className="border-l-4 border-info px-3 py-2 text-sm">{data.note}</p>}

      {data.recommendations.length > 0 && (
        <Card kicker="Recomendaciones con tus números" title="Qué hacer en tu próxima pieza">
          <ul className="space-y-2 text-sm">
            {data.recommendations.map((r) => <li key={r} className="border-l-4 border-ok px-3 py-1">{r}</li>)}
          </ul>
          <p className="mt-3 text-xs text-ink-3">Solo comparamos grupos con al menos {int(data.minImpressions)} impresiones: con menos, la diferencia puede ser suerte.</p>
        </Card>
      )}

      {data.designsWithResults > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <GroupTable title="Por estilo de diseño" groups={data.byFamily} currency={data.currency} />
          <GroupTable title="Por formato" groups={data.byFormat} currency={data.currency} />
        </div>
      )}

      {data.top.length > 0 && (
        <Card kicker="Tus diseños en anuncios" title="Los que mejor funcionan">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {data.top.map((r) => (
              <Link key={r.designId} to={`/app/creative/editor/${r.designId}`} className="block border-2 border-line p-3 hover:border-ink">
                <p className="truncate font-semibold">{r.name}</p>
                <p className="mt-1 flex flex-wrap gap-1">{r.familyLabel && <Badge tone="neutral">{r.familyLabel}</Badge>}<Badge tone="neutral">{r.days} días</Badge></p>
                <p className="mt-2 text-xs text-ink-2">{int(r.impressions)} <Term id="impressions">impresiones</Term> · {int(r.clicks)} clics · <Term id="ctr">CTR</Term> {pct(r.impressions ? r.clicks / r.impressions : null)}</p>
                {(r.conversations + r.leads) > 0 && <p className="text-xs text-ink-2">{int(r.conversations + r.leads)} personas te escribieron o dejaron sus datos</p>}
              </Link>
            ))}
          </div>
        </Card>
      )}

      {!data.designsInAds && c.adAccounts > 0 && (
        <EmptyState title="Todavía no hay anuncios hechos con tus diseños" hint="Abre un diseño, toca «Usar en anuncio» y créalo en Ads. Cuando Meta reporte resultados, aparecerán aquí." />
      )}
    </div>
  );
}

function GroupTable({ title, groups, currency }: { title: string; groups: Group[]; currency: string }) {
  return (
    <Card kicker="Comparación" title={title}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
              <th className="py-2">Grupo</th>
              <th className="py-2 text-right"><Term id="impressions">Impresiones</Term></th>
              <th className="py-2 text-right"><Term id="ctr">CTR</Term></th>
              <th className="py-2 text-right"><Term id="cpc">CPC</Term></th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key} className="border-b border-line">
                <td className="py-2 pr-2">{g.label} <span className="text-xs text-ink-3">· {g.designs} diseño{g.designs === 1 ? '' : 's'}</span></td>
                <td className="py-2 text-right tabular-nums">{int(g.impressions)}</td>
                <td className="py-2 text-right tabular-nums">{pct(g.ctr)}</td>
                <td className="py-2 text-right tabular-nums">{money(g.cpc, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
