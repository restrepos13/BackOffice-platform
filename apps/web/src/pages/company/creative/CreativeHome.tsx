import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, uploadFile } from '../../../lib/api';
import type { SocialStatus } from '../../../lib/types';
import { CATEGORY_LABELS, FONTS, FORMATS, type FormatKey, STATUS_LABELS, authedBlobUrl } from '../../../lib/creative';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Stat, Switch, Tabs, Textarea } from '../../../components/ui';
import { PickCompany, useCompanyScope, withScope } from '../shared';
import { AssetThumb } from './Editor';
import CreativeStart from './CreativeStart';
import CreateForSale from './CreateForSale';
import { ArtDirector } from './ArtDirector';
import { VisualIdentityCard } from './VisualIdentity';
import { OpportunityList } from '../../../components/opportunities/Opportunities';

/**
 * BackOffice Creative: diseños editables, identidad de marca, recursos,
 * calendario con aprobaciones, reglas de publicación y créditos.
 */

interface DesignRow { id: string; name: string; format: FormatKey; version: number; hasExport: boolean; updatedAt: string; updatedBy: string | null }
interface Templates { templates: Array<{ key: string; name: string; category: string; hint: string }>; formats: Array<{ key: FormatKey; label: string; width: number; height: number }> }
interface Policy { paused: boolean; autonomyEnabled: boolean; autoCategories: string[]; restrictedTopics: string[]; pricesNeedReview: boolean; networks: string[]; maxPerDay: number; fromHour: number; toHour: number }
interface Brand {
  version: number; name: string; description: string; logos: Array<{ assetId: string; label: string }>; colors: Array<{ hex: string; label: string }>;
  fonts: string[]; tone: string; audience: string; ctas: string[]; offers: Array<{ text: string; price: number | null; validUntil: string | null }>;
  restrictions: string[]; vocabulary: string[]; avoidWords: string[]; products: Array<{ name: string; price: number | null }>;
  protected: { logo?: boolean; colors?: boolean }; policy: Policy; suggestions: Record<string, any> | null;
}
interface Asset { id: string; name: string; kind: string; width: number | null; height: number | null }
interface Piece {
  id: string; title: string; copy: string | null; status: string; category: string | null; scheduledAt: string | null; publishedAt: string | null;
  targets: string[]; reviewNote: string | null; approvedBy: string | null; autoApproved: boolean | null; publishError: string | null; designId: string | null;
}

/** Pestañas de la vista del equipo BackOffice (como siempre). */
const TABS = [
  { id: 'crear', label: 'Crear' }, { id: 'inicio', label: 'Inicio' }, { id: 'oportunidades', label: 'Oportunidades' }, { id: 'disenos', label: 'Diseños' }, { id: 'marca', label: 'Marca' }, { id: 'recursos', label: 'Recursos' },
  { id: 'calendario', label: 'Calendario' }, { id: 'reglas', label: 'Reglas' }, { id: 'creditos', label: 'Créditos' },
];

/** Secciones de Creative (el menú lateral las lista; aquí solo se titula la pantalla). */
const SECTIONS: Record<string, { kicker: string; title: string }> = {
  crear: { kicker: 'BackOffice Creative', title: 'Crear para vender' },
  inicio: { kicker: 'BackOffice Creative', title: 'Inicio' },
  oportunidades: { kicker: 'Inicio', title: 'Oportunidades' },
  disenos: { kicker: 'Diseños', title: 'Mis diseños' },
  marca: { kicker: 'Marca', title: 'Identidad de marca' },
  calendario: { kicker: 'Calendario y publicación', title: 'Calendario' },
  reglas: { kicker: 'Calendario y publicación', title: 'Reglas de publicación' },
  creditos: { kicker: 'Calendario y publicación', title: 'Créditos de contenido' },
};

export default function CreativeHome() {
  const { ready, q, canWrite, isPlatform } = useCompanyScope();
  const [params, setParams] = useSearchParams();
  // «Crear» es la entrada principal: describir, elegir fotos y obtener una propuesta
  const raw = params.get('tab') ?? 'crear';
  const tab = raw in SECTIONS ? raw : raw === 'recursos' ? raw : 'crear';
  const brand = useQuery({ queryKey: ['brand', q], queryFn: () => api.get<Brand>(withScope('/creative/brand', q)), enabled: ready, retry: false });
  // Los recursos viven en la Biblioteca compartida (antes había una lista aparte aquí)
  if (tab === 'recursos' && !isPlatform) return <Navigate to="/app/biblioteca" replace />;
  if (!ready) return <PickCompany />;
  if (brand.error) return <Card title="Creative"><p className="text-sm">{brand.error instanceof Error ? brand.error.message : 'No disponible'} <Link to="/app/mi-plan" className="underline">Ir a Mi plan</Link></p></Card>;
  return (
    <>
      {isPlatform ? (
        <>
          <PageHeader kicker="Oportunidades, diseño y publicación" title="Creative" accent="de tu negocio" />
          <Tabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
        </>
      ) : <PageHeader kicker={SECTIONS[tab].kicker} title={SECTIONS[tab].title} />}
      <div className={isPlatform ? 'mt-5' : undefined}>
        {tab === 'crear' && <CreateForSale q={q} />}
        {tab === 'inicio' && <CreativeStart q={q} />}
        {tab === 'oportunidades' && <OpportunityList scope={(p) => withScope(p, q)} query={{ source: params.get('source') ?? undefined }} canWrite={canWrite} />}
        {tab === 'disenos' && <Designs q={q} />}
        {tab === 'marca' && (brand.data ? <div className="space-y-6"><BrandForm q={q} brand={brand.data} /><VisualIdentityCard q={q} colors={brand.data.colors} /></div> : <Loading />)}
        {tab === 'recursos' && isPlatform && <Assets q={q} />}
        {tab === 'calendario' && <Calendar q={q} />}
        {tab === 'reglas' && (brand.data ? <Rules q={q} policy={brand.data.policy} /> : <Loading />)}
        {tab === 'creditos' && <Credits q={q} />}
      </div>
    </>
  );
}

/* ── Diseños ── */

function Thumb({ d }: { d: DesignRow }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (d.hasExport) authedBlobUrl(`/api/creative/designs/${d.id}/export`).then((u) => alive && setSrc(u));
    return () => { alive = false; };
  }, [d.id, d.hasExport, d.version]);
  const f = FORMATS[d.format];
  return (
    <span className="flex items-center justify-center overflow-hidden bg-bone-2" style={{ aspectRatio: `${f.width}/${f.height}`, maxHeight: 260 }}>
      {src ? <img alt={d.name} src={src} className="h-full w-full object-contain" /> : <span className="text-xs text-ink-3">{f.label}</span>}
    </span>
  );
}

function Designs({ q }: { q: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const { data, isLoading } = useQuery({ queryKey: ['designs', q], queryFn: () => api.get<DesignRow[]>(withScope('/creative/designs', q)) });
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(params.get('nuevo') === '1' && canWrite);
  const [format, setFormat] = useState<FormatKey>('IG_POST');
  const create = useMutation({
    mutationFn: (templateKey: string | null) => api.post<{ id: string }>(withScope('/creative/designs', q), { format, templateKey }),
    onSuccess: (d) => navigate(`/app/creative/editor/${d.id}`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const dup = useMutation({
    mutationFn: (id: string) => api.post(`/creative/designs/${id}/duplicate`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['designs'] }); toast.success('Diseño duplicado'); },
  });
  const archive = useMutation({
    mutationFn: (id: string) => api.delete(`/creative/designs/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['designs'] }); toast.success('Diseño archivado'); },
  });
  if (isLoading || !data) return <Loading />;
  return (
    <>
      {canWrite && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => setCreating(true)}><Plus size={14} /> Nuevo diseño</Button>
          <Button variant="ghost" disabled={create.isPending} onClick={() => create.mutate(null)}>Empezar en blanco</Button>
          <Select value={format} onChange={(e) => setFormat(e.target.value as FormatKey)} className="!w-48" aria-label="Formato">
            {(Object.keys(FORMATS) as FormatKey[]).map((k) => <option key={k} value={k}>{FORMATS[k].label}</option>)}
          </Select>
        </div>
      )}
      {!data.length ? (
        <EmptyState title="Aún no tienes diseños" hint="Cuéntanos qué quieres comunicar y te proponemos composiciones con tu marca. Todo queda editable." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {data.map((d) => (
            <div key={d.id} className="flex flex-col border-2 border-ink bg-paper">
              <Link to={`/app/creative/editor/${d.id}`}><Thumb d={d} /></Link>
              <div className="flex items-start justify-between gap-2 p-2 text-sm">
                <span className="min-w-0">
                  <Link to={`/app/creative/editor/${d.id}`} className="block truncate font-semibold hover:underline">{d.name}</Link>
                  <span className="text-[11px] text-ink-3">{FORMATS[d.format].label} · v{d.version}</span>
                </span>
                {canWrite && (
                  <span className="flex shrink-0 gap-1">
                    <button type="button" aria-label="Duplicar" className="cursor-pointer p-1" onClick={() => dup.mutate(d.id)}><Copy size={13} /></button>
                    <button type="button" aria-label="Archivar" className="cursor-pointer p-1" onClick={() => { if (confirm('¿Archivar este diseño?')) archive.mutate(d.id); }}><Trash2 size={13} /></button>
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <ArtDirector open={creating} onClose={() => setCreating(false)} q={q} initialFormat={format} />
    </>
  );
}

/* ── Marca ── */

const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

function BrandForm({ q, brand }: { q: string; brand: Brand }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [f, setF] = useState(brand);
  useEffect(() => setF(brand), [brand]);
  const { data: assets } = useQuery({ queryKey: ['brand-assets', q], queryFn: () => api.get<Asset[]>(withScope('/creative/assets', q)) });
  const save = useMutation({
    mutationFn: () => api.put<Brand>(withScope('/creative/brand', q), { ...f, expectedVersion: brand.version }),
    onSuccess: (b) => { queryClient.setQueryData(['brand', q], b); toast.success('Marca guardada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const suggest = useMutation({
    mutationFn: () => api.post(withScope('/creative/brand/suggest', q)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['brand'] }),
  });
  const s = brand.suggestions;
  const set = (patch: Partial<Brand>) => setF({ ...f, ...patch });
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card kicker={`Versión ${brand.version || 'nueva'}`} title="Identidad de marca">
        <fieldset disabled={!canWrite} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre comercial"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Público objetivo"><Input value={f.audience} onChange={(e) => set({ audience: e.target.value })} /></Field>
          </div>
          <Field label="Descripción"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <Field label="Tono de comunicación" hint="Ej.: cercano, juvenil, sin tecnicismos"><Input value={f.tone} onChange={(e) => set({ tone: e.target.value })} /></Field>
          <div>
            <p className="kicker mb-1">Colores</p>
            <div className="flex flex-wrap items-center gap-2">
              {f.colors.map((c, i) => (
                <span key={i} className="flex items-center gap-1 border-2 border-line px-1.5 py-1">
                  <input type="color" aria-label={`Color ${i + 1}`} value={c.hex} onChange={(e) => set({ colors: f.colors.map((x, j) => (j === i ? { ...x, hex: e.target.value.toUpperCase() } : x)) })} className="h-6 w-8" />
                  <input value={c.label} placeholder="Nombre" onChange={(e) => set({ colors: f.colors.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} className="w-20 bg-transparent text-xs" />
                  <button type="button" aria-label="Quitar color" className="cursor-pointer text-xs" onClick={() => set({ colors: f.colors.filter((_, j) => j !== i) })}>×</button>
                </span>
              ))}
              {f.colors.length < 8 && <Button size="sm" variant="outline" onClick={() => set({ colors: [...f.colors, { hex: '#1A1A1A', label: '' }] })}>+ Color</Button>}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Field key={i} label={i === 0 ? 'Fuente de títulos' : 'Fuente de textos'}>
                <Select value={f.fonts[i] ?? ''} onChange={(e) => { const fonts = [...f.fonts]; fonts[i] = e.target.value; set({ fonts: fonts.filter(Boolean) }); }}>
                  <option value="">Elegir…</option>
                  {FONTS.map((x) => <option key={x} value={x}>{x}</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <Field label="Logo">
            <Select value={f.logos[0]?.assetId ?? ''} onChange={(e) => set({ logos: e.target.value ? [{ assetId: e.target.value, label: 'Principal' }] : [] })}>
              <option value="">Sin logo (súbelo en Recursos)</option>
              {(assets ?? []).map((a) => <option key={a.id} value={a.id}>{a.kind === 'LOGO' ? 'Logo · ' : ''}{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Llamadas a la acción" hint="Separadas por coma"><Input value={f.ctas.join(', ')} onChange={(e) => set({ ctas: csv(e.target.value) })} /></Field>
          <Field label="Palabras de la marca" hint="Separadas por coma"><Input value={f.vocabulary.join(', ')} onChange={(e) => set({ vocabulary: csv(e.target.value) })} /></Field>
          <Field label="Palabras que nunca usamos"><Input value={f.avoidWords.join(', ')} onChange={(e) => set({ avoidWords: csv(e.target.value) })} /></Field>
          <Field label="Restricciones" hint="Una por línea (visuales o de comunicación)"><Textarea rows={3} value={f.restrictions.join('\n')} onChange={(e) => set({ restrictions: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></Field>
          <div>
            <p className="kicker mb-1">Ofertas confirmadas</p>
            {f.offers.map((o, i) => (
              <div key={i} className="mb-1 grid grid-cols-[1fr_110px_140px_auto] gap-1">
                <Input value={o.text} placeholder="Qué ofreces" onChange={(e) => set({ offers: f.offers.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                <Input inputMode="numeric" value={o.price ?? ''} placeholder="Precio" onChange={(e) => set({ offers: f.offers.map((x, j) => (j === i ? { ...x, price: Number(e.target.value.replace(/\D/g, '')) || null } : x)) })} />
                <Input type="date" value={o.validUntil ?? ''} onChange={(e) => set({ offers: f.offers.map((x, j) => (j === i ? { ...x, validUntil: e.target.value || null } : x)) })} />
                <Button size="sm" variant="ghost" onClick={() => set({ offers: f.offers.filter((_, j) => j !== i) })}>×</Button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={() => set({ offers: [...f.offers, { text: '', price: null, validUntil: null }] })}>+ Oferta</Button>
          </div>
          <div className="flex flex-wrap gap-4">
            <Switch checked={!!f.protected.logo} onChange={(v) => set({ protected: { ...f.protected, logo: v } })} label="Proteger el logo en los diseños" showLabel />
            <Switch checked={!!f.protected.colors} onChange={(v) => set({ protected: { ...f.protected, colors: v } })} label="Solo colores de la marca" showLabel />
          </div>
          {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar marca'}</Button>}
        </fieldset>
      </Card>
      <Card kicker="Sugerencias (no se aplican solas)" title="Ayuda para empezar">
        <p className="mb-3 text-sm text-ink-2">Proponemos datos a partir de tu registro y tu catálogo. Tú decides qué usar; nada cambia sin tu clic.</p>
        {canWrite && <Button size="sm" variant="outline" disabled={suggest.isPending} onClick={() => suggest.mutate()}>Proponer desde mis datos</Button>}
        {s && (
          <ul className="mt-3 space-y-2 text-sm">
            {s.description && <li className="border-l-2 border-info pl-2">Descripción: {s.description} <button type="button" className="underline" onClick={() => set({ description: s.description })}>Usar</button></li>}
            {s.tone && <li className="border-l-2 border-info pl-2">Tono: {s.tone} <button type="button" className="underline" onClick={() => set({ tone: s.tone })}>Usar</button></li>}
            {!!s.colors?.length && <li className="border-l-2 border-info pl-2">Color principal {s.colors[0].hex} <button type="button" className="underline" onClick={() => set({ colors: [...s.colors, ...f.colors].slice(0, 8) })}>Usar</button></li>}
            {!!s.products?.length && <li className="border-l-2 border-info pl-2">{s.products.length} productos del catálogo <button type="button" className="underline" onClick={() => set({ products: s.products })}>Usar</button></li>}
            <li className="text-[11px] text-ink-3">{s.source}</li>
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ── Recursos ── */

function Assets({ q }: { q: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [kind, setKind] = useState('IMAGE');
  const { data, isLoading } = useQuery({ queryKey: ['brand-assets', q], queryFn: () => api.get<Asset[]>(withScope('/creative/assets', q)) });
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile(withScope('/creative/assets', q), 'file', file, { kind, name: file.name }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['brand-assets'] }); toast.success('Recurso subido'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo subir'),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/creative/assets/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['brand-assets'] }),
  });
  if (isLoading || !data) return <Loading />;
  return (
    <>
      {canWrite && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="!w-40">
            <option value="IMAGE">Imagen</option><option value="LOGO">Logo</option><option value="REFERENCE">Referencia</option>
          </Select>
          <label className="inline-flex cursor-pointer items-center gap-2 border-2 border-ink bg-paper px-3 py-2 text-sm">
            <ImagePlus size={14} /> {upload.isPending ? 'Subiendo…' : 'Subir (PNG, JPG, WEBP · máx. 8 MB)'}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          </label>
          <p className="text-xs text-ink-3">Sube solo imágenes que tengas derecho a usar. Son privadas de tu empresa.</p>
        </div>
      )}
      {!data.length ? <EmptyState title="Sin recursos" hint="Sube tu logo y fotos de tus productos." /> : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {data.map((a) => (
            <div key={a.id} className="relative">
              <AssetThumb asset={a} q={q} />
              {canWrite && <button type="button" aria-label="Borrar" className="absolute right-1 top-1 cursor-pointer border-2 border-ink bg-paper p-0.5" onClick={() => { if (confirm('¿Borrar este recurso? Los diseños que lo usan mostrarán un espacio vacío.')) del.mutate(a.id); }}><Trash2 size={12} /></button>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* ── Calendario y aprobaciones ── */

const STATUS_TONE: Record<string, 'neutral' | 'warn' | 'ok' | 'info' | 'bad'> = {
  EN_REVISION: 'warn', APROBADO: 'ok', PROGRAMADO: 'info', PUBLICANDO: 'info', PUBLICADO: 'ok', ERROR: 'bad',
};

function Calendar({ q }: { q: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [status, setStatus] = useState('');
  const [network, setNetwork] = useState('');
  const [schedule, setSchedule] = useState<Piece | null>(null);
  const qs = [q, status && `status=${status}`, network && `network=${network}`].filter(Boolean).join('&');
  const { data, isLoading } = useQuery({ queryKey: ['creative-calendar', qs], queryFn: () => api.get<Piece[]>(`/creative/calendar${qs ? `?${qs}` : ''}`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['creative-calendar'] });
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) => api.post<{ status: string; reasons?: string[] }>(`/creative/pieces/${id}/${action}`, body ?? {}),
    onSuccess: (r) => { refresh(); toast.success(r.status === 'EN_REVISION' ? `En revisión: ${r.reasons?.join(' · ')}` : `Estado: ${STATUS_LABELS[r.status] ?? r.status}`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const publishNow = useMutation({
    mutationFn: (id: string) => api.post(withScope(`/social/pieces/${id}/publish`, q)),
    onSuccess: () => { refresh(); toast.success('Publicando…'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.patch(withScope(`/marketing/pieces/${id}`, q), { status: 'BORRADOR', scheduledAt: null }),
    onSuccess: () => { refresh(); toast.success('Programación cancelada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const { data: social } = useQuery({ queryKey: ['social-status', q], queryFn: () => api.get<SocialStatus>(withScope('/social/status', q)), retry: false });
  const pending = useMemo(() => (data ?? []).filter((p) => p.status === 'EN_REVISION'), [data]);
  if (isLoading || !data) return <Loading />;
  return (
    <>
      {social && !social.connection?.connected && (
        <div className="mb-5 border-2 border-warn bg-paper px-4 py-3 text-sm">
          Para programar o publicar, primero conecta tu página de Facebook e Instagram. Mientras tanto puedes diseñar y aprobar.{' '}
          <Link to="/app/marketing" className="font-semibold underline">Conectar en Marketing</Link>
        </div>
      )}
      {pending.length > 0 && (
        <Card kicker="Cola de aprobaciones" title={`${pending.length} esperando revisión`} className="mb-6">
          <ul className="divide-y divide-line text-sm">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span><b>{p.title}</b><span className="block text-xs text-warn">{p.reviewNote}</span>{p.copy && <span className="block text-xs text-ink-2">{p.copy.slice(0, 160)}</span>}</span>
                {canWrite && (
                  <span className="flex gap-1">
                    <Button size="sm" onClick={() => act.mutate({ id: p.id, action: 'approve' })}>Aprobar</Button>
                    <Button size="sm" variant="outline" onClick={() => { const note = prompt('¿Qué hay que cambiar?') ?? ''; act.mutate({ id: p.id, action: 'reject', body: { note } }); }}>Pedir cambios</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="!w-44"><option value="">Todos los estados</option>{Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select value={network} onChange={(e) => setNetwork(e.target.value)} className="!w-40"><option value="">Todas las redes</option><option value="instagram">Instagram</option><option value="facebook">Facebook</option></Select>
      </div>
      {!data.length ? <EmptyState title="Calendario vacío" hint="Crea un diseño y usa «Al calendario»." /> : (
        <div className="overflow-x-auto border-2 border-ink bg-paper">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-wider text-ink-3"><th className="p-2">Pieza</th><th className="p-2">Estado</th><th className="p-2">Fecha</th><th className="p-2">Redes</th><th className="p-2" /></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id} className="border-b border-line align-top">
                  <td className="p-2"><b>{p.title}</b><span className="block text-[11px] text-ink-3">{CATEGORY_LABELS[p.category ?? ''] ?? 'Sin categoría'}{p.approvedBy ? ` · aprobó ${p.approvedBy}` : ''}</span>{p.publishError && <span className="block text-xs text-bad">{p.publishError}</span>}{p.status === 'BORRADOR' && p.reviewNote && <span className="block text-xs text-warn">Pidieron cambios: {p.reviewNote}</span>}</td>
                  <td className="p-2"><Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{STATUS_LABELS[p.status] ?? p.status}</Badge></td>
                  <td className="p-2 text-xs">{p.scheduledAt ? new Date(p.scheduledAt).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
                  <td className="p-2 text-xs">{p.targets.join(', ') || '—'}</td>
                  <td className="p-2 text-right">
                    {canWrite && (
                      <span className="flex flex-wrap justify-end gap-1">
                        {['BORRADOR', 'LISTO', 'IDEA'].includes(p.status) && <Button size="sm" variant="outline" onClick={() => act.mutate({ id: p.id, action: 'submit', body: { category: p.category } })}>Pedir aprobación</Button>}
                        {['APROBADO', 'PROGRAMADO', 'ERROR'].includes(p.status) && <Button size="sm" variant="outline" onClick={() => setSchedule(p)}>{p.status === 'PROGRAMADO' ? 'Reprogramar' : 'Programar'}</Button>}
                        {['APROBADO', 'ERROR'].includes(p.status) && <Button size="sm" onClick={() => { if (confirm('¿Publicar ahora en las redes elegidas?')) publishNow.mutate(p.id); }}>Publicar ya</Button>}
                        {p.status === 'PROGRAMADO' && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(p.id)}>Cancelar</Button>}
                        {p.designId && <Link to={`/app/creative/editor/${p.designId}`} className="self-center text-xs underline">Diseño</Link>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ScheduleModal piece={schedule} q={q} onClose={() => setSchedule(null)} onDone={refresh} />
    </>
  );
}

function ScheduleModal({ piece, q, onClose, onDone }: { piece: Piece | null; q: string; onClose: () => void; onDone: () => void }) {
  const [when, setWhen] = useState('');
  const [targets, setTargets] = useState<string[]>(['instagram', 'facebook']);
  useEffect(() => { if (piece) { setWhen(piece.scheduledAt ? piece.scheduledAt.slice(0, 16) : ''); setTargets(piece.targets.length ? piece.targets : ['instagram', 'facebook']); } }, [piece]);
  const save = useMutation({
    mutationFn: () => api.post(withScope(`/social/pieces/${piece!.id}/schedule`, q), { scheduledAt: new Date(when).toISOString(), targets }),
    onSuccess: () => { toast.success('Programado'); onDone(); onClose(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open={!!piece} onClose={onClose} kicker="Publicación" title="Programar">
      <div className="space-y-3">
        <Field label="Fecha y hora (hora de tu empresa)"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <div className="flex gap-2">
          {['instagram', 'facebook'].map((t) => (
            <button key={t} type="button" onClick={() => setTargets((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]))} className={clsx('cursor-pointer border-2 px-3 py-1.5 text-sm capitalize', targets.includes(t) ? 'border-ink bg-ink text-bone' : 'border-line')}>{t}</button>
          ))}
        </div>
        <p className="text-xs text-ink-3">Se publica con la API oficial de Meta. Si algo falla verás el error aquí y podrás reintentar.</p>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={onClose}>Cancelar</Button><Button disabled={!when || !targets.length || save.isPending} onClick={() => save.mutate()}>Programar</Button></div>
      </div>
    </Modal>
  );
}

/* ── Reglas ── */

function Rules({ q, policy }: { q: string; policy: Policy }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [p, setP] = useState(policy);
  useEffect(() => setP(policy), [policy]);
  const save = useMutation({
    mutationFn: () => api.put(withScope('/creative/policy', q), p),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['brand'] }); toast.success('Reglas guardadas'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Card kicker="Publicación híbrida" title="Qué puede publicarse solo">
      <fieldset disabled={!canWrite} className="space-y-4 text-sm">
        <p className="text-ink-2">La primera publicación siempre la aprueba una persona. Después, solo se publica sin revisión lo que esté en estas reglas.</p>
        <Switch checked={p.paused} onChange={(v) => setP({ ...p, paused: v })} label="Pausar todas las publicaciones" showLabel />
        <Switch checked={p.autonomyEnabled} onChange={(v) => setP({ ...p, autonomyEnabled: v })} label="Permitir publicación automática" showLabel />
        <div>
          <p className="kicker mb-1">Categorías que pueden publicarse solas</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <button key={k} type="button" onClick={() => setP({ ...p, autoCategories: p.autoCategories.includes(k) ? p.autoCategories.filter((x) => x !== k) : [...p.autoCategories, k] })} className={clsx('cursor-pointer border-2 px-2.5 py-1 text-xs', p.autoCategories.includes(k) ? 'border-ink bg-ink text-bone' : 'border-line')}>{v}</button>
            ))}
          </div>
        </div>
        <Switch checked={p.pricesNeedReview} onChange={(v) => setP({ ...p, pricesNeedReview: v })} label="Precios, descuentos y promociones siempre a revisión" showLabel />
        <Field label="Temas restringidos" hint="Separados por coma: siempre van a revisión"><Input value={p.restrictedTopics.join(', ')} onChange={(e) => setP({ ...p, restrictedTopics: csv(e.target.value) })} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Máximo por día"><Input type="number" min={1} max={20} value={p.maxPerDay} onChange={(e) => setP({ ...p, maxPerDay: Number(e.target.value) })} /></Field>
          <Field label="Desde (hora)"><Input type="number" min={0} max={23} value={p.fromHour} onChange={(e) => setP({ ...p, fromHour: Number(e.target.value) })} /></Field>
          <Field label="Hasta (hora)"><Input type="number" min={1} max={24} value={p.toHour} onChange={(e) => setP({ ...p, toHour: Number(e.target.value) })} /></Field>
        </div>
        <div className="flex gap-2">
          {['instagram', 'facebook'].map((n) => (
            <Switch key={n} checked={p.networks.includes(n)} onChange={(v) => setP({ ...p, networks: v ? [...p.networks, n] : p.networks.filter((x) => x !== n) })} label={`Publicar en ${n}`} showLabel />
          ))}
        </div>
        {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>Guardar reglas</Button>}
      </fieldset>
    </Card>
  );
}

/* ── Créditos ── */

function Credits({ q }: { q: string }) {
  const { data } = useQuery({ queryKey: ['creative-credits', q], queryFn: () => api.get<{ monthly: { limit: number; used: number; left: number }; extra: number; costs: Record<string, number>; moves: Array<{ id: string; kind: string; operation: string; credits: number; bucket: string; note: string | null; createdAt: string }> }>(withScope('/creative/credits', q)) });
  if (!data) return <Loading />;
  const KIND: Record<string, string> = { RESERVE: 'Reservado', COMMIT: 'Consumido', RELEASE: 'Devuelto', GRANT: 'Agregado' };
  return (
    <>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Cupo del mes" value={`${data.monthly.left} de ${data.monthly.limit}`} hint="Viene con Redes sociales con IA" />
        <Stat label="Créditos extra" value={data.extra} hint="Paquetes adicionales" />
        <Stat label="Tarifas" value={`Imagen ${data.costs.IMAGE} · Video ${data.costs.VIDEO}`} hint="Editar y exportar no gasta créditos" />
      </div>
      <Card kicker="Últimos movimientos" title="Historial">
        {!data.moves.length ? <p className="text-sm text-ink-3">Sin movimientos todavía.</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.moves.map((m) => <li key={m.id} className="flex justify-between py-1.5"><span>{KIND[m.kind] ?? m.kind} · {m.operation}{m.note ? ` · ${m.note}` : ''}</span><span className="tabular-nums">{m.kind === 'RELEASE' || m.kind === 'GRANT' ? '+' : '−'}{m.credits} · {new Date(m.createdAt).toLocaleDateString('es-CO')}</span></li>)}
          </ul>
        )}
      </Card>
    </>
  );
}
