import { Explainer } from '../../../components/Explainer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy, ImagePlus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, uploadFile } from '../../../lib/api';
import type { SocialStatus } from '../../../lib/types';
import { CATEGORY_LABELS, FONTS, FORMATS, type FormatKey, STATUS_LABELS, authedBlobUrl } from '../../../lib/creative';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Stat, Switch, Tabs, Textarea } from '../../../components/ui';
import { PickCompany, useCompanyScope, withScope } from '../shared';
import { AssetThumb } from './Editor';
import CreateForSale from './CreateForSale';
import { ArtDirector } from './ArtDirector';
import { VisualIdentityCard } from './VisualIdentity';
import { WhatWorks } from './WhatWorks';
import type { Policy } from './Publishing';
import { DocPreview } from './ArtDirector';
import type { DesignDoc } from '../../../lib/creative';

/**
 * BackOffice Creative: diseños editables, identidad de marca, recursos,
 * calendario con aprobaciones, reglas de publicación y créditos.
 */

interface DesignRow { id: string; name: string; format: FormatKey; version: number; hasExport: boolean; updatedAt: string; updatedBy: string | null }
interface Templates { templates: Array<{ key: string; name: string; category: string; hint: string }>; formats: Array<{ key: FormatKey; label: string; width: number; height: number }> }
interface Brand {
  version: number; name: string; description: string; logos: Array<{ assetId: string; label: string }>; colors: Array<{ hex: string; label: string }>;
  fonts: string[]; tone: string; audience: string; ctas: string[]; offers: Array<{ text: string; price: number | null; validUntil: string | null }>;
  restrictions: string[]; vocabulary: string[]; avoidWords: string[]; products: Array<{ name: string; price: number | null }>;
  protected: { logo?: boolean; colors?: boolean }; policy: Policy; suggestions: Record<string, any> | null;
}
interface Asset { id: string; name: string; kind: string; width: number | null; height: number | null }

/** Pestañas de la vista del equipo BackOffice (como siempre). */
// Oportunidades vive en Ads y el calendario de publicación también (Creative diseña; Ads publica)
const TABS = [
  { id: 'crear', label: 'Crear' }, { id: 'disenos', label: 'Diseños' }, { id: 'resultados', label: 'Qué te funciona' }, { id: 'marca', label: 'Marca' }, { id: 'recursos', label: 'Recursos' },
  { id: 'creditos', label: 'Créditos' },
];

/** Secciones de Creative (el menú lateral las lista; aquí solo se titula la pantalla). */
const SECTIONS: Record<string, { kicker: string; title: string }> = {
  crear: { kicker: 'BackOffice Creative', title: 'Crear para vender' },
  disenos: { kicker: 'Diseños', title: 'Mis diseños' },
  resultados: { kicker: 'Aprende de tus resultados', title: 'Qué te funciona' },
  marca: { kicker: 'Marca', title: 'Identidad de marca' },
  creditos: { kicker: 'Contenido', title: 'Créditos de contenido' },
};

export default function CreativeHome() {
  const { ready, q, canWrite, isPlatform } = useCompanyScope();
  const [params, setParams] = useSearchParams();
  // «Crear» es la entrada principal: describir, elegir fotos y obtener una propuesta
  const raw = params.get('tab') ?? 'crear';
  const tab = raw in SECTIONS ? raw : raw === 'recursos' ? raw : 'crear';
  const brand = useQuery({ queryKey: ['brand', q], queryFn: () => api.get<Brand>(withScope('/creative/brand', q)), enabled: ready, retry: false });
  // Enlaces viejos: el calendario y las reglas de publicación se mudaron a Ads (después de los hooks)
  if (raw === 'calendario') return <Navigate to="/app/ads?tab=organico" replace />;
  if (raw === 'reglas') return <Navigate to="/app/ads?tab=reglas" replace />;
  // Los recursos viven en la Biblioteca compartida (antes había una lista aparte aquí)
  if (tab === 'recursos' && !isPlatform) return <Navigate to="/app/biblioteca" replace />;
  if (!ready) return <PickCompany />;
  if (brand.error) return <Card title="Creative"><p className="text-sm">{brand.error instanceof Error ? brand.error.message : 'No disponible'} <Link to="/app/mi-plan" className="underline">Ir a Mi plan</Link></p></Card>;
  return (
    <>
      {isPlatform ? (
        <>
          <PageHeader kicker="Diseño, marca y contenido" title="Creative" accent="de tu negocio" />
          <Tabs tabs={TABS} active={tab} onChange={(t) => setParams({ tab: t })} />
        </>
      ) : <PageHeader kicker={SECTIONS[tab].kicker} title={SECTIONS[tab].title} />}
      <div className={isPlatform ? 'mt-5' : undefined}>
        {tab === 'crear' && <CreateForSale q={q} />}
        {tab === 'disenos' && <Designs q={q} />}
        {tab === 'resultados' && <WhatWorks q={q} />}
        {tab === 'marca' && (brand.data ? <div className="space-y-6"><BrandForm q={q} brand={brand.data} /><details className="border-2 border-line bg-paper"><summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Personalidad visual (opcional): cómo quieres que se sientan tus diseños</summary><div className="p-3"><VisualIdentityCard q={q} colors={brand.data.colors} /></div></details></div> : <Loading />)}
        {tab === 'recursos' && isPlatform && <Assets q={q} />}
        {tab === 'creditos' && <Credits q={q} />}
      </div>
    </>
  );
}

/* ── Diseños ── */

/** Vista previa del diseño: la imagen exportada si existe; si no, el diseño dibujado tal como está guardado. */
function Thumb({ d, q }: { d: DesignRow; q: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (d.hasExport) authedBlobUrl(`/api/creative/designs/${d.id}/export`).then((u) => alive && setSrc(u)).catch(() => undefined);
    return () => { alive = false; };
  }, [d.id, d.hasExport, d.version]);
  const live = useQuery({
    queryKey: ['design-preview', d.id, d.version],
    queryFn: () => api.get<{ doc: DesignDoc }>(`/creative/designs/${d.id}`),
    enabled: !d.hasExport,
    staleTime: 5 * 60_000,
  });
  const f = FORMATS[d.format];
  const width = 220;
  return (
    <span className="flex items-center justify-center overflow-hidden bg-bone-2" style={{ aspectRatio: `${f.width}/${f.height}`, maxHeight: 260 }}>
      {src ? <img alt={d.name} src={src} className="h-full w-full object-contain" />
        : live.data?.doc ? <span className="pointer-events-none" style={{ transform: `scale(${Math.min(1, 260 / ((live.data.doc.height * width) / live.data.doc.width))})` }}><DocPreview doc={live.data.doc} q={q} width={width} /></span>
        : <span className="text-xs text-ink-3">{live.isLoading ? 'Cargando vista previa…' : f.label}</span>}
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
              <Link to={`/app/creative/editor/${d.id}`}><Thumb d={d} q={q} /></Link>
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

type BrandStep = 'basico' | 'look' | 'voz' | 'avanzado';
const BRAND_STEPS: Array<{ id: BrandStep; label: string; hint: string; done: (b: Brand) => boolean }> = [
  { id: 'basico', label: 'Lo básico', hint: 'Nombre, a quién le vendes y tu logo. Con esto ya podemos diseñar.', done: (b) => !!b.name && !!b.logos.length },
  { id: 'look', label: 'Cómo se ve', hint: 'Tus colores y letras. Si no los tienes claros, usamos una paleta provisional y la cambias cuando quieras.', done: (b) => b.colors.length > 0 && b.fonts.length > 0 },
  { id: 'voz', label: 'Cómo habla', hint: 'El tono y las frases que usas para invitar a comprar o escribirte.', done: (b) => !!b.tone && b.ctas.length > 0 },
  { id: 'avanzado', label: 'Opcional', hint: 'Reglas que los diseños deben respetar y ofertas vigentes. No hace falta para empezar.', done: (b) => b.restrictions.length > 0 || b.offers.length > 0 },
];

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
  const [step, setStep] = useState<BrandStep>('basico');
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card kicker={`Versión ${brand.version || 'nueva'}`} title="Identidad de marca">
        {/* Por pasos cortos: lo básico primero; lo avanzado no hace falta para empezar */}
        <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Pasos de la marca">
          {BRAND_STEPS.map((st, i) => (
            <button key={st.id} type="button" role="tab" aria-selected={step === st.id} onClick={() => setStep(st.id)}
              className={clsx('cursor-pointer border-2 px-3 py-1.5 text-xs font-semibold', step === st.id ? 'border-ink bg-ink text-bone' : 'border-line')}>
              {i + 1}. {st.label} {st.done(f) && <Check size={12} className="inline" aria-label="completo" />}
            </button>
          ))}
        </div>
        <p className="mb-4 text-xs text-ink-3">{BRAND_STEPS.find((x) => x.id === step)!.hint}</p>
        <fieldset disabled={!canWrite} className="space-y-4">
          {step === 'basico' && (
            <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre comercial"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Público objetivo"><Input value={f.audience} onChange={(e) => set({ audience: e.target.value })} /></Field>
          </div>
          <Field label="Descripción"><Textarea rows={2} value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
          <Field label="Logo">
            <Select value={f.logos[0]?.assetId ?? ''} onChange={(e) => set({ logos: e.target.value ? [{ assetId: e.target.value, label: 'Principal' }] : [] })}>
              <option value="">Sin logo (súbelo en Recursos)</option>
              {(assets ?? []).map((a) => <option key={a.id} value={a.id}>{a.kind === 'LOGO' ? 'Logo · ' : ''}{a.name}</option>)}
            </Select>
          </Field>
            </>
          )}
          {step === 'look' && (
            <>
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
            </>
          )}
          {step === 'voz' && (
            <>
          <Field label="Tono de comunicación" hint="Ej.: cercano, juvenil, sin tecnicismos"><Input value={f.tone} onChange={(e) => set({ tone: e.target.value })} /></Field>
          <Field label="Llamadas a la acción" hint="Separadas por coma"><Input value={f.ctas.join(', ')} onChange={(e) => set({ ctas: csv(e.target.value) })} /></Field>
          <Field label="Palabras de la marca" hint="Separadas por coma"><Input value={f.vocabulary.join(', ')} onChange={(e) => set({ vocabulary: csv(e.target.value) })} /></Field>
          <Field label="Palabras que nunca usamos"><Input value={f.avoidWords.join(', ')} onChange={(e) => set({ avoidWords: csv(e.target.value) })} /></Field>
            </>
          )}
          {step === 'avanzado' && (
            <>
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
            </>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t-2 border-line pt-4">
            {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar marca'}</Button>}
            {step !== 'avanzado' && <Button variant="ghost" onClick={() => setStep(BRAND_STEPS[BRAND_STEPS.findIndex((x) => x.id === step) + 1].id)}>Siguiente paso →</Button>}
          </div>
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

function Credits({ q }: { q: string }) {
  const { data } = useQuery({ queryKey: ['creative-credits', q], queryFn: () => api.get<{ monthly: { limit: number; used: number; left: number }; extra: number; costs: Record<string, number>; moves: Array<{ id: string; kind: string; operation: string; credits: number; bucket: string; note: string | null; createdAt: string }> }>(withScope('/creative/credits', q)) });
  if (!data) return <Loading />;
  const KIND: Record<string, string> = { RESERVE: 'Apartado mientras se hacía', COMMIT: 'Usado', RELEASE: 'Devuelto (algo falló)', GRANT: 'Agregado' };
  const OP: Record<string, string> = { IMAGE: 'imagen con IA o recorte', VIDEO: 'video con IA', TEXT: 'texto', EXTRA: 'paquete' };
  const left = data.monthly.left + data.extra;
  return (
    <>
      <Explainer
        id="creative-credits"
        title="¿Qué son los créditos de contenido?"
        summary={<>Son las «fichas» para lo que hace la inteligencia artificial por ti: <b>crear una imagen, quitarle el fondo a una foto o hacer un video</b>. Diseñar, editar, cambiar textos y exportar <b>no gasta créditos</b>. Cada mes recibes un cupo nuevo; si se acaba, puedes pedir un paquete extra.</>}
        steps={[
          <>Una imagen o un recorte usa <b>{data.costs.IMAGE} crédito{data.costs.IMAGE === 1 ? '' : 's'}</b>; un video, <b>{data.costs.VIDEO}</b>.</>,
          <>Antes de gastar, BackOffice te dice cuánto cuesta y cuántos te quedan.</>,
          <>Si algo falla, el crédito se devuelve solo. Nunca se cobra dos veces lo mismo.</>,
        ]}
      />
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Te quedan" value={left} hint={`${data.monthly.left} de tu cupo del mes${data.extra ? ` + ${data.extra} extra` : ''}`} tone={left === 0 ? 'bad' : left <= 2 ? 'warn' : undefined} />
        <Stat label="Cupo de cada mes" value={data.monthly.limit} hint="Se renueva el día 1" />
        <Stat label="Créditos extra" value={data.extra} hint="Paquetes que compraste; no vencen con el mes" />
      </div>
      {left === 0 && <p className="mb-6 border-l-4 border-warn px-3 py-2 text-sm">Se te acabaron los créditos de este mes. Puedes seguir diseñando y exportando; para imágenes con IA o recortes, espera al día 1 o pide un paquete en <Link to="/app/mi-plan" className="font-semibold underline">Mi plan</Link>.</p>}
      <Card kicker="Últimos movimientos" title="Historial">
        {!data.moves.length ? <p className="text-sm text-ink-3">Sin movimientos todavía.</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.moves.map((m) => <li key={m.id} className="flex justify-between py-1.5"><span>{KIND[m.kind] ?? m.kind} · {OP[m.operation] ?? m.operation}{m.note ? ` · ${m.note}` : ''}</span><span className="tabular-nums">{m.kind === 'RELEASE' || m.kind === 'GRANT' ? '+' : '−'}{m.credits} · {new Date(m.createdAt).toLocaleDateString('es-CO')}</span></li>)}
          </ul>
        )}
      </Card>
    </>
  );
}
