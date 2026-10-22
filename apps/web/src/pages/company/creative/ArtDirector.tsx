import { useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { Ellipse, Layer, Line, Rect, Stage, Text } from 'react-konva';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { FORMATS, type DesignDoc, type FormatKey, type ImageEl, loadFonts } from '../../../lib/creative';
import { Badge, Button, Field, Input, Loading, Modal, Select, Textarea } from '../../../components/ui';
import { withScope } from '../shared';
import { AssetThumb, Background, ImageNode } from './Editor';

/**
 * Nuevo diseño con dirección de arte: objetivo → contenido mínimo →
 * propuestas visualmente distintas (con su porqué) → editor.
 * El motor es determinista (servidor); aquí solo se pide y se muestra.
 */

interface Catalog { goals: Array<{ key: string; label: string }> }
interface Proposal {
  family: string; label: string; purpose: string; variant: number; reason: string; omitted: string[];
  doc: DesignDoc; composition: { family: string; variant: number; goal: string; seed: number };
  checks: Array<{ code: string; severity: string; message: string }>;
}
interface ProposalsRes { proposals: Proposal[]; note: string | null; unavailable: Array<{ family: string; label: string; why: string }> }
interface Asset { id: string; name: string; kind: string; width: number | null; height: number | null }
interface BrandLite { products: Array<{ name: string; price: number | null }>; ctas: string[]; offers: Array<{ text: string; price: number | null; validUntil: string | null }> }

/** Vista previa fiel y de solo lectura de un documento (mismo dibujo que el editor). */
export function DocPreview({ doc, q, width }: { doc: DesignDoc; q: string; width: number }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { loadFonts().then(() => setReady(true)); }, []);
  const scale = width / doc.width;
  if (!ready) return <div style={{ width, height: doc.height * scale }} className="bg-bone-2" />;
  return (
    <Stage width={width} height={doc.height * scale} scaleX={scale} scaleY={scale} listening={false}>
      <Layer listening={false}>
        <Background doc={doc} q={q} />
        {doc.elements.filter((e) => e.visible).map((e) => {
          const c = { id: e.id, x: e.x, y: e.y, rotation: e.rotation, opacity: e.opacity };
          if (e.type === 'text') return <Text key={e.id} {...c} text={e.text} width={e.width} fontFamily={e.fontFamily} fontSize={e.fontSize} fontStyle={e.fontStyle} align={e.align} lineHeight={e.lineHeight} letterSpacing={e.letterSpacing} fill={e.fill} wrap="word" />;
          if (e.type === 'image') return <ImageNode key={e.id} el={e as ImageEl} q={q} common={c} />;
          if (e.type === 'rect') return <Rect key={e.id} {...c} width={e.width} height={e.height} fill={e.fill} stroke={e.stroke} strokeWidth={e.strokeWidth} cornerRadius={e.cornerRadius} />;
          if (e.type === 'ellipse') return <Ellipse key={e.id} {...c} x={e.x + e.width / 2} y={e.y + e.height / 2} radiusX={e.width / 2} radiusY={e.height / 2} fill={e.fill} />;
          return <Line key={e.id} {...c} points={[0, 0, e.width, 0]} stroke={e.stroke} strokeWidth={e.strokeWidth} lineCap="round" />;
        })}
      </Layer>
    </Stage>
  );
}

const NEEDS: Record<string, Array<'kicker' | 'body' | 'price' | 'cta' | 'validity' | 'date' | 'place' | 'quote' | 'author' | 'points' | 'items' | 'photos'>> = {
  PRODUCT: ['photos', 'price', 'body', 'cta', 'kicker'],
  PROMO: ['price', 'validity', 'photos', 'cta', 'kicker'],
  TIP: ['body', 'points', 'kicker'],
  NEWS: ['photos', 'body', 'cta', 'kicker'],
  EVENT: ['date', 'place', 'photos', 'cta'],
  BRAND: ['kicker', 'photos'],
  TESTIMONIAL: ['quote', 'author', 'photos'],
  STEPS: ['points', 'cta'],
  BENEFITS: ['points', 'photos', 'cta'],
  CATALOG: ['items', 'cta', 'kicker'],
  INFO: ['points', 'body', 'cta', 'kicker'],
};

export function ArtDirector({ open, onClose, q, initialFormat = 'IG_POST' }: { open: boolean; onClose: () => void; q: string; initialFormat?: FormatKey }) {
  const navigate = useNavigate();
  const [goal, setGoal] = useState<string | null>(null);
  const [format, setFormat] = useState<FormatKey>(initialFormat);
  const [f, setF] = useState<Record<string, any>>({ points: '', photos: [] as string[], items: [] as Array<{ name: string; price?: string }> });
  const [seed, setSeed] = useState<number | undefined>(undefined);
  const [res, setRes] = useState<ProposalsRes | null>(null);
  const chosen = useRef(false);
  const { data: catalog } = useQuery({ queryKey: ['art-catalog'], queryFn: () => api.get<Catalog>('/creative/art/catalog'), enabled: open });
  const { data: assets } = useQuery({ queryKey: ['brand-assets', q], queryFn: () => api.get<Asset[]>(withScope('/creative/assets', q)), enabled: open });
  const { data: brand } = useQuery({ queryKey: ['brand', q], queryFn: () => api.get<BrandLite>(withScope('/creative/brand', q)), enabled: open });
  const photos = (assets ?? []).filter((a) => a.kind === 'IMAGE');

  const reset = () => { setGoal(null); setRes(null); setSeed(undefined); setF({ points: '', photos: [], items: [] }); chosen.current = false; };
  const close = () => {
    // Vio propuestas y no eligió ninguna: se registra (sin datos personales)
    if (res?.proposals.length && !chosen.current) void api.post(withScope('/creative/design-events', q), { type: 'composition_rejected', families: res.proposals.map((p) => p.family) }).catch(() => undefined);
    reset();
    onClose();
  };
  const content = () => ({
    headline: f.headline, kicker: f.kicker, body: f.body, price: f.price, cta: f.cta, validity: f.validity, place: f.place, quote: f.quote, author: f.author,
    date: f.day ? { day: f.day, month: f.month ?? '' } : undefined,
    points: String(f.points ?? '').split('\n').map((x: string) => x.trim()).filter(Boolean),
    items: f.items, photos: f.photos,
  });
  const ask = useMutation({
    mutationFn: (s?: number) => api.post<ProposalsRes>(withScope('/creative/art/proposals', q), { goal, format, content: content(), seed: s }),
    onSuccess: (r) => setRes(r),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudieron preparar las propuestas'),
  });
  const use = useMutation({
    mutationFn: (p: Proposal) => api.post<{ id: string }>(withScope('/creative/designs', q), { format, doc: p.doc, composition: p.composition, name: f.headline?.slice(0, 60) }),
    onSuccess: (d) => { chosen.current = true; reset(); onClose(); navigate(`/app/creative/editor/${d.id}`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo crear el diseño'),
  });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const needs = goal ? NEEDS[goal] ?? [] : [];
  const showMain = goal === 'TESTIMONIAL' ? false : true;

  return (
    <Modal open={open} onClose={close} kicker="Nuevo diseño" title={res ? 'Elige una dirección' : goal ? 'Lo mínimo para empezar' : '¿Qué quieres comunicar?'} wide>
      {!goal && (
        <div className="grid gap-2 sm:grid-cols-3">
          {(catalog?.goals ?? []).map((g) => (
            <button key={g.key} type="button" onClick={() => setGoal(g.key)} className="cursor-pointer border-2 border-ink bg-paper p-3 text-left text-sm font-semibold hover:bg-bone-2">{g.label}</button>
          ))}
        </div>
      )}

      {goal && !res && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FORMATS) as FormatKey[]).map((k) => (
              <button key={k} type="button" onClick={() => setFormat(k)} className={clsx('cursor-pointer border-2 px-3 py-1.5', format === k ? 'border-ink bg-ink text-bone' : 'border-line')}>{FORMATS[k].label}</button>
            ))}
          </div>
          {(goal === 'PRODUCT' || goal === 'PROMO') && !!brand?.products?.length && (
            <Field label="Producto (opcional)" hint="Trae el nombre y el precio confirmados de tu marca">
              <Select value="" onChange={(e) => { const p = brand.products[Number(e.target.value)]; if (p) setF({ ...f, headline: f.headline || p.name, price: p.price ? `$${Math.round(p.price).toLocaleString('es-CO')}` : f.price }); }}>
                <option value="">Elegir de mis productos…</option>
                {brand.products.map((p, i) => <option key={i} value={i}>{p.name}{p.price ? ` · $${Math.round(p.price).toLocaleString('es-CO')}` : ''}</option>)}
              </Select>
            </Field>
          )}
          {showMain && <Field label="Mensaje principal"><Input value={f.headline ?? ''} onChange={set('headline')} placeholder="Lo que la gente debe leer primero" maxLength={140} /></Field>}
          <div className="grid gap-3 sm:grid-cols-2">
            {needs.includes('quote') && <Field label="Lo que dijo el cliente"><Textarea rows={3} value={f.quote ?? ''} onChange={(e) => setF({ ...f, quote: e.target.value, headline: e.target.value.slice(0, 140) })} maxLength={280} /></Field>}
            {needs.includes('author') && <Field label="Quién lo dijo"><Input value={f.author ?? ''} onChange={set('author')} placeholder="Nombre e inicial" /></Field>}
            {needs.includes('price') && <Field label={goal === 'PROMO' ? 'Precio o descuento' : 'Precio (opcional)'} hint="Solo si está confirmado"><Input value={f.price ?? ''} onChange={set('price')} placeholder="$9.500 o 2x1" /></Field>}
            {needs.includes('validity') && <Field label="Vigencia (opcional)"><Input value={f.validity ?? ''} onChange={set('validity')} placeholder="Hasta el domingo" /></Field>}
            {needs.includes('date') && (
              <Field label="Fecha"><div className="flex gap-1"><Input value={f.day ?? ''} onChange={set('day')} placeholder="08" className="!w-20" /><Input value={f.month ?? ''} onChange={set('month')} placeholder="Nov" /></div></Field>
            )}
            {needs.includes('place') && <Field label="Lugar y hora"><Input value={f.place ?? ''} onChange={set('place')} placeholder="Laureles · sábado 10 a. m." /></Field>}
            {needs.includes('body') && <Field label="Texto de apoyo (opcional)"><Textarea rows={2} value={f.body ?? ''} onChange={set('body')} maxLength={280} /></Field>}
            {needs.includes('points') && <Field label={goal === 'STEPS' ? 'Pasos (uno por línea)' : 'Puntos clave (uno por línea)'} hint="De 2 a 4"><Textarea rows={3} value={f.points} onChange={set('points')} /></Field>}
            {needs.includes('kicker') && <Field label="Etiqueta corta (opcional)"><Input value={f.kicker ?? ''} onChange={set('kicker')} placeholder="Nuevo, Hoy, Consejo…" maxLength={40} /></Field>}
            {needs.includes('cta') && (
              <Field label="Llamada a la acción (opcional)">
                <Input list="ctas" value={f.cta ?? ''} onChange={set('cta')} placeholder="Pide por WhatsApp" maxLength={40} />
                <datalist id="ctas">{(brand?.ctas ?? []).map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
            )}
          </div>
          {needs.includes('items') && (
            <Field label="Productos (2 a 4)">
              <div className="flex flex-wrap gap-1.5">
                {(brand?.products ?? []).map((p, i) => {
                  const on = f.items.some((it: any) => it.name === p.name);
                  return <button key={i} type="button" onClick={() => setF({ ...f, items: on ? f.items.filter((it: any) => it.name !== p.name) : [...f.items, { name: p.name, price: p.price ? `$${Math.round(p.price).toLocaleString('es-CO')}` : undefined }].slice(0, 4) })} className={clsx('cursor-pointer border-2 px-2.5 py-1 text-xs', on ? 'border-ink bg-ink text-bone' : 'border-line')}>{p.name}</button>;
                })}
                {!brand?.products?.length && <p className="text-xs text-ink-3">Agrega productos en tu Marca para armar un catálogo.</p>}
              </div>
            </Field>
          )}
          {needs.includes('photos') && (
            <Field label="Foto (opcional, hasta 2)" hint="Con foto aparecen más direcciones posibles">
              {photos.length ? (
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {photos.map((a) => {
                    const on = f.photos.includes(a.id);
                    return (
                      <button key={a.id} type="button" onClick={() => setF({ ...f, photos: on ? f.photos.filter((x: string) => x !== a.id) : [...f.photos, a.id].slice(-2) })} className={clsx('cursor-pointer border-2', on ? 'border-ink' : 'border-transparent')}>
                        <AssetThumb asset={a} q={q} />
                      </button>
                    );
                  })}
                </div>
              ) : <p className="text-xs text-ink-3">No tienes fotos en Recursos. Puedes seguir sin foto.</p>}
            </Field>
          )}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => setGoal(null)}>Cambiar objetivo</Button>
            <Button disabled={ask.isPending || !(f.headline || f.quote)} onClick={() => ask.mutate(seed)}>{ask.isPending ? 'Componiendo…' : 'Ver propuestas'}</Button>
          </div>
        </div>
      )}

      {res && (
        <div className="space-y-4 text-sm">
          {res.note && <p className="border-l-4 border-info bg-info-soft/40 px-3 py-2">{res.note}</p>}
          <div className={clsx('grid gap-4', res.proposals.length > 1 ? 'md:grid-cols-3' : 'md:grid-cols-2')}>
            {res.proposals.map((p) => (
              <div key={`${p.family}-${p.variant}`} className="flex flex-col border-2 border-ink bg-paper">
                <div className="flex items-center justify-center bg-bone-2 p-2"><DocPreview doc={p.doc} q={q} width={220} /></div>
                <div className="flex flex-1 flex-col gap-1 p-3">
                  <p className="font-semibold">{p.label}</p>
                  <p className="text-xs text-ink-2">{p.reason}</p>
                  {p.omitted.length > 0 && <p className="text-xs text-warn">No entró en este formato: {p.omitted.join(', ').toLowerCase()}. Puedes agregarlo en el editor.</p>}
                  {p.checks.length > 0 && <p className="text-xs text-ink-3">{p.checks.length} aviso{p.checks.length > 1 ? 's' : ''} para revisar antes de exportar</p>}
                  <Button size="sm" className="mt-auto" disabled={use.isPending} onClick={() => use.mutate(p)}>Usar esta</Button>
                </div>
              </div>
            ))}
          </div>
          {res.unavailable.length > 0 && (
            <p className="text-xs text-ink-3">También podría ser: {res.unavailable.map((u) => `${u.label} (${u.why})`).join(' · ')}.</p>
          )}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" onClick={() => setRes(null)}>Cambiar el contenido</Button>
            {res.proposals.length > 0 && <Button variant="outline" disabled={ask.isPending} onClick={() => { const s = (seed ?? 0) + 1; setSeed(s); ask.mutate(s); }}>Otras variantes</Button>}
          </div>
        </div>
      )}
      {ask.isPending && !res && <Loading label="Componiendo propuestas con tu marca…" />}
      {goal && <Badge tone="neutral">{catalog?.goals.find((g) => g.key === goal)?.label}</Badge>}
    </Modal>
  );
}
