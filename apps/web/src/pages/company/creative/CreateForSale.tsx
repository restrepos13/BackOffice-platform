import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Scissors, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api, uploadFile } from '../../../lib/api';
import { FORMATS, type DesignDoc, type FormatKey } from '../../../lib/creative';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Select, Textarea } from '../../../components/ui';
import { useCompanyScope, withScope } from '../shared';
import { AssetThumb } from './Editor';
import { DocPreview } from './ArtDirector';

/**
 * «Crear para vender»: describe lo que quieres lograr, elige tus fotos y
 * BackOffice prepara propuestas con tu producto real y tu marca. Después se
 * edita en el editor y se lleva a Ads. Nada comercial se inventa: precios del
 * catálogo y ofertas solo si la persona las confirma.
 */

interface Photo { id: string; name: string; width: number | null; height: number | null; source: string; derivedFromId: string | null; kind?: string }
interface Start {
  materials: { photos: Photo[]; catalog: Array<{ id: string; name: string; price: number | null; hasImage: boolean }> };
  brand: { hasLogo: boolean; colorsConfirmed: boolean; colors: Array<{ hex: string }>; note: string | null };
  ai: { available: boolean; note: string };
  cutout: { configured: boolean; provider: string | null; credits: number; note?: string };
  credits: { monthlyLeft: number; extra: number };
  ads: { contracted: boolean; connected: boolean };
  limits: { description: number; photos: number };
}
type Destination = 'WHATSAPP' | 'WEBSITE' | 'STORE' | 'SOCIAL' | null;
interface Intent {
  objective: string; productId: string | null; productName: string | null; productPrice: number | null; productDescription: string | null;
  audience: string | null; destination: Destination; offer: string | null; offerConfirmed: boolean; offerValidity: string | null;
  callToAction: string | null; requestedFormats: FormatKey[]; assetIds: string[];
  missingInformation: Array<{ key: string; question: string; blocking: boolean }>; source: 'RULES' | 'AI';
}
interface IntentRes { intent: Intent; art: { goal: string; content: Record<string, unknown> }; ai: { used: boolean; note: string | null } }
interface Proposal { family: string; label: string; variant: number; reason: string; omitted: string[]; doc: DesignDoc; composition: Record<string, unknown>; checks: Array<{ severity: string; message: string }> }
interface ProposalsRes { proposals: Proposal[]; note: string | null; unavailable: Array<{ label: string; why: string }> }

const OBJECTIVE: Record<string, string> = { SALES: 'Vender más', BOOKINGS: 'Conseguir reservas', AWARENESS: 'Darte a conocer', EVENT: 'Promocionar un evento', ENGAGEMENT: 'Interacción en redes' };
const DEST: Array<{ key: Exclude<Destination, null>; label: string }> = [
  { key: 'WHATSAPP', label: 'WhatsApp' }, { key: 'WEBSITE', label: 'Tu web' }, { key: 'STORE', label: 'Tu local' }, { key: 'SOCIAL', label: 'Redes sociales' },
];
const DRAFT_KEY = 'bo_creative_create_draft';
const msgOf = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Algo falló.');

/** Error que se queda a la vista (no solo un aviso que desaparece), con reintento. */
function Problem({ error, onRetry, retryLabel = 'Reintentar' }: { error: unknown; onRetry?: () => void; retryLabel?: string }) {
  const text = msgOf(error);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-l-4 border-bad bg-paper px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">{text} <span className="text-ink-3">Lo que escribiste y tus fotos siguen aquí.</span></span>
      {/créditos/i.test(text) && <Link to="/app/mi-plan" className="text-xs font-semibold underline">Ver Mi plan</Link>}
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>{retryLabel}</Button>}
    </div>
  );
}
const money = (n: number | null) => (n ? `$${Math.round(n).toLocaleString('es-CO')}` : '');

/** Recupera lo escrito si la página se recargó o hubo un error (solo en este navegador). */
function loadDraft(): { description: string; selected: string[] } {
  try {
    const v = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? '{}');
    return { description: typeof v.description === 'string' ? v.description : '', selected: Array.isArray(v.selected) ? v.selected.map(String).slice(0, 6) : [] };
  } catch {
    return { description: '', selected: [] };
  }
}

export default function CreateForSale({ q }: { q: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const scope = (p: string) => withScope(p, q);
  const start = useQuery({ queryKey: ['creative-create-start', q], queryFn: () => api.get<Start>(scope('/creative/create/start')) });
  const initial = useRef(loadDraft()).current;
  const [description, setDescription] = useState(initial.description);
  const [selected, setSelected] = useState<string[]>(initial.selected);
  const [res, setRes] = useState<IntentRes | null>(null);
  // Con qué texto y fotos se interpretó: si cambian, la interpretación (y las propuestas) quedan viejas
  const [basis, setBasis] = useState('');
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [format, setFormat] = useState<FormatKey>('IG_POST');
  const [seed, setSeed] = useState(0);
  const [proposals, setProposals] = useState<ProposalsRes | null>(null);

  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ description, selected })); } catch { /* sin almacenamiento: se sigue igual */ }
  }, [description, selected]);

  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Algo falló. Tu descripción y tus fotos siguen aquí: intenta de nuevo.');
  const refreshStart = () => queryClient.invalidateQueries({ queryKey: ['creative-create-start'] });
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<{ asset: Photo }>(scope('/library/assets'), 'file', file, { name: file.name.replace(/\.[^.]+$/, ''), kind: 'IMAGE', module: 'CREATIVE' }),
    onSuccess: (r) => { refreshStart(); setSelected((s) => [r.asset.id, ...s.filter((x) => x !== r.asset.id)].slice(0, 6)); toast.success('Foto guardada en tu biblioteca'); },
    onError: err,
  });
  const cutout = useMutation({
    mutationFn: (assetId: string) => api.post<{ created: boolean; asset: Photo; credits?: number }>(scope('/creative/create/cutout'), { assetId }),
    onSuccess: (r, from) => {
      refreshStart();
      setSelected((s) => s.map((x) => (x === from ? r.asset.id : x)));
      toast.success(r.created ? `Fondo quitado. Tu foto original sigue intacta${r.credits ? ` · ${r.credits} crédito(s)` : ''}.` : 'Ya tenías este recorte: lo usamos sin volver a cobrar.');
    },
  });
  const interpret = useMutation({
    mutationFn: (o: Record<string, unknown>) => api.post<IntentRes>(scope('/creative/create/intent'), { description, assetIds: selected, overrides: o }),
    onSuccess: (r) => {
      setRes(r);
      setBasis(JSON.stringify([description.trim(), selected]));
      setProposals(null);
      const preferred = r.intent.requestedFormats.find((f) => f in FORMATS);
      if (preferred && !res) setFormat(preferred);
    },
  });
  const propose = useMutation({
    mutationFn: (v: { seed: number; format: FormatKey }) => api.post<ProposalsRes>(scope('/creative/art/proposals'), { goal: res!.art.goal, format: v.format, content: res!.art.content, seed: v.seed }),
    onSuccess: setProposals,
  });
  const use = useMutation({
    mutationFn: (p: Proposal) => api.post<{ id: string }>(scope('/creative/designs'), { format, doc: p.doc, composition: p.composition, name: String(res?.art.content.headline || 'Pieza para vender').slice(0, 60) }),
    onSuccess: (d) => { try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* nada */ } navigate(`/app/creative/editor/${d.id}`); },
  });

  if (start.isLoading) return <Loading label="Preparando tu espacio…" />;
  if (start.error || !start.data) return <Card title="Crear"><p className="text-sm">{start.error instanceof Error ? start.error.message : 'No disponible'}</p></Card>;
  const s = start.data;
  const photos = s.materials.photos;
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(-s.limits.photos)));
  const intent = res?.intent;
  const applyOverride = (patch: Record<string, unknown>) => { const next = { ...overrides, ...patch }; setOverrides(next); interpret.mutate(next); };
  const blocking = intent?.missingInformation.some((m) => m.blocking);
  const stale = !!res && basis !== JSON.stringify([description.trim(), selected]);
  const prepare = () => { setOverrides({}); interpret.mutate({}); };
  const formats = (intent?.requestedFormats.length ? intent.requestedFormats : (Object.keys(FORMATS) as FormatKey[])).filter((f) => f in FORMATS);

  return (
    <div className="space-y-6">
      {/* 1. Qué quieres lograr + materiales */}
      <Card kicker="Crear para vender" title="¿Qué quieres promocionar?">
        <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-3">
            <Field label="Cuéntalo como se lo dirías a tu equipo" hint={`${description.length}/${s.limits.description}`}>
              <Textarea rows={5} maxLength={s.limits.description} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canWrite}
                placeholder="Quiero promocionar los tacos al pastor este fin de semana y conseguir más pedidos por WhatsApp. Tengo fotos del producto." />
            </Field>
            <p className="text-xs text-ink-3"><Badge tone={s.ai.available ? 'info' : 'neutral'}>{s.ai.available ? 'Con IA' : 'Con reglas'}</Badge> {s.ai.note}</p>
            {s.brand.note && <p className="text-xs text-ink-3">{s.brand.note} <Link to="/app/creative?tab=marca" className="underline">Configurar marca (opcional)</Link></p>}
            <Button disabled={!canWrite || description.trim().length < 8 || interpret.isPending} onClick={prepare}>
              {interpret.isPending && !res ? 'Entendiendo lo que necesitas…' : res && stale ? 'Actualizar propuesta' : 'Preparar propuesta'}
            </Button>
            {interpret.isError && !res && <Problem error={interpret.error} onRetry={prepare} />}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">Tus fotos {selected.length ? `(${selected.length} elegida${selected.length > 1 ? 's' : ''})` : ''}</p>
              {canWrite && (
                <label className="inline-flex cursor-pointer items-center gap-1 border-2 border-ink px-2.5 py-1 text-xs font-semibold">
                  <Upload size={14} /> {upload.isPending ? 'Subiendo…' : 'Subir foto'}
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Subir foto" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
                </label>
              )}
            </div>
            {photos.length ? (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="photos">
                {photos.map((p) => {
                  const on = selected.includes(p.id);
                  return (
                    <div key={p.id} className={clsx('relative border-2', on ? 'border-ink' : 'border-transparent')} aria-pressed={on}>
                      <AssetThumb asset={{ ...p, kind: 'IMAGE' } as any} q={q} onClick={() => toggle(p.id)} />
                      {p.source === 'CUTOUT' && <span className="absolute left-1 top-1"><Badge tone="info">Sin fondo</Badge></span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState title="Todavía no tienes fotos" hint="Sube una foto real de tu producto o de tu local. También puedes seguir sin foto: la propuesta se arma con tu texto y tu marca." />
            )}
            {selected.length > 0 && (
              <div className="border-2 border-line bg-paper p-2 text-xs">
                {s.cutout.configured ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" disabled={!canWrite || cutout.isPending || photos.find((p) => p.id === selected[0])?.source === 'CUTOUT'} onClick={() => cutout.mutate(selected[0])}>
                      <Scissors size={14} /> {cutout.isPending ? 'Quitando el fondo…' : 'Quitar fondo a la primera foto'}
                    </Button>
                    <span className="text-ink-3">Usa {s.cutout.credits} crédito(s) · te quedan {s.credits.monthlyLeft + s.credits.extra}. Tu original no se modifica.</span>
                  </span>
                ) : <span className="text-ink-3">{s.cutout.note}</span>}
                {cutout.isError && <div className="mt-2"><Problem error={cutout.error} /></div>}
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* 2. Lo que entendimos (editable) */}
      {intent && (
        <Card kicker={intent.source === 'AI' ? 'Interpretado con IA y validado' : 'Interpretado con reglas'} title="Esto es lo que entendimos">
          {res?.ai.note && <p className="mb-3 text-xs text-warn">{res.ai.note}</p>}
          {stale && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-l-4 border-warn px-3 py-2 text-sm" data-testid="stale">
              <span className="flex-1">Cambiaste la descripción o las fotos: esto ya no corresponde a lo que escribiste.</span>
              <Button size="sm" variant="outline" disabled={interpret.isPending} onClick={prepare}>Volver a interpretar</Button>
            </div>
          )}
          {interpret.isError && res && <div className="mb-3"><Problem error={interpret.error} onRetry={() => interpret.mutate(overrides)} /></div>}
          <div className="grid gap-4 md:grid-cols-3" data-testid="intent">
            <Field label="Objetivo"><p className="py-2 text-sm font-semibold">{OBJECTIVE[intent.objective] ?? intent.objective}</p></Field>
            <Field label="Producto" hint={intent.productId ? `Del catálogo${intent.productPrice ? ` · ${money(intent.productPrice)} (precio confirmado)` : ''}` : 'No lo encontramos en tu catálogo'}>
              <Select value={intent.productId ?? ''} disabled={!canWrite} onChange={(e) => applyOverride(e.target.value ? { productId: e.target.value } : {})}>
                <option value="">{intent.productDescription ? `«${intent.productDescription}» (sin catálogo)` : 'Elegir de mi catálogo…'}</option>
                {s.materials.catalog.map((p) => <option key={p.id} value={p.id}>{p.name}{p.price ? ` · ${money(p.price)}` : ''}</option>)}
              </Select>
            </Field>
            <Field label="¿Dónde te contactan?">
              <Select value={intent.destination ?? ''} disabled={!canWrite} onChange={(e) => applyOverride({ destination: e.target.value })}>
                <option value="">Sin definir</option>
                {DEST.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </Select>
            </Field>
          </div>
          {intent.offer && (
            <div className={clsx('mt-4 border-2 p-3 text-sm', intent.offerConfirmed ? 'border-ok' : 'border-warn')}>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={intent.offerConfirmed} disabled={!canWrite} onChange={(e) => applyOverride({ offer: intent.offer, offerConfirmed: e.target.checked })} />
                <span>Confirmo que la oferta <b>«{intent.offer}»</b>{intent.offerValidity ? ` (${intent.offerValidity})` : ''} es real y vigente. <span className="text-ink-3">Sin confirmar no la ponemos en la pieza.</span></span>
              </label>
            </div>
          )}
          {intent.missingInformation.length > 0 && (
            <ul className="mt-4 space-y-1 text-sm" data-testid="missing">
              {intent.missingInformation.map((m) => <li key={m.key} className={m.blocking ? 'text-bad' : 'text-ink-2'}>{m.blocking ? '● ' : '○ '}{m.question}</li>)}
            </ul>
          )}
          {intent.productId === null && !intent.productDescription && (
            <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = String(new FormData(e.currentTarget).get('product') ?? '').trim(); if (v) applyOverride({ productDescription: v }); }}>
              <Input name="product" placeholder="¿Qué producto o servicio?" aria-label="Producto o servicio" maxLength={60} disabled={!canWrite} />
              <Button size="sm" type="submit" variant="outline" disabled={!canWrite || interpret.isPending}>Usar</Button>
            </form>
          )}
          <div className="mt-5 flex flex-wrap items-end gap-3 border-t-2 border-line pt-4">
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Formato</p>
              <div className="flex flex-wrap gap-1.5">
                {formats.map((k) => (
                  <button key={k} type="button" onClick={() => { setFormat(k); setProposals(null); }} aria-pressed={format === k}
                    className={clsx('cursor-pointer border-2 px-2.5 py-1 text-xs', format === k ? 'border-ink bg-ink text-bone' : 'border-line')}>{FORMATS[k].label}</button>
                ))}
              </div>
            </div>
            <Button disabled={!canWrite || blocking || stale || propose.isPending || interpret.isPending} onClick={() => { setSeed(0); propose.mutate({ seed: 0, format }); }}>
              {propose.isPending ? 'Componiendo con tu marca…' : 'Ver propuestas'}
            </Button>
            {blocking && <span className="text-xs text-bad">Completa lo marcado con ● para continuar.</span>}
          </div>
          {propose.isError && !proposals && <div className="mt-3"><Problem error={propose.error} onRetry={() => propose.mutate({ seed, format })} /></div>}
        </Card>
      )}

      {/* 3. Propuestas */}
      {proposals && (
        <Card kicker="Propuestas con tu marca y tus fotos" title="Elige una para editar">
          {proposals.note && <p className="mb-3 border-l-4 border-info px-3 py-2 text-sm">{proposals.note}</p>}
          {(propose.isError || use.isError) && <div className="mb-3"><Problem error={propose.isError ? propose.error : use.error} onRetry={propose.isError ? () => propose.mutate({ seed, format }) : undefined} /></div>}
          {!proposals.proposals.length ? (
            <EmptyState title="No salieron propuestas con estos datos" hint={proposals.unavailable.map((u) => `${u.label}: ${u.why}`).join(' · ') || 'Prueba con otra foto o agrega el producto.'} />
          ) : (
            <div className="grid gap-4 md:grid-cols-3" data-testid="proposals">
              {proposals.proposals.map((p) => (
                <div key={`${p.family}-${p.variant}`} className="flex flex-col border-2 border-ink bg-paper">
                  <div className="flex items-center justify-center overflow-hidden bg-bone-2 p-2"><DocPreview doc={p.doc} q={q} width={200} /></div>
                  <div className="flex flex-1 flex-col gap-1 p-3 text-sm">
                    <p className="font-semibold">{p.label}</p>
                    <p className="text-xs text-ink-2">{p.reason}</p>
                    {p.checks.length > 0 && <p className="text-xs text-warn">{p.checks.length} aviso{p.checks.length > 1 ? 's' : ''} de calidad: los ves en el editor.</p>}
                    <Button size="sm" className="mt-auto" disabled={!canWrite || use.isPending || stale} onClick={() => use.mutate(p)}>{use.isPending && use.variables === p ? 'Abriendo…' : 'Editar esta'}</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2 text-sm">
            <Button variant="outline" disabled={propose.isPending || stale} onClick={() => { const n = seed + 1; setSeed(n); propose.mutate({ seed: n, format }); }}>Otras variantes</Button>
            {format !== 'STORY' && <Button variant="outline" disabled={propose.isPending || stale} onClick={() => { setFormat('STORY'); setSeed(0); propose.mutate({ seed: 0, format: 'STORY' }); }}>Versión para historias</Button>}
            {format !== 'IG_PORTRAIT' && <Button variant="outline" disabled={propose.isPending || stale} onClick={() => { setFormat('IG_PORTRAIT'); setSeed(0); propose.mutate({ seed: 0, format: 'IG_PORTRAIT' }); }}>Versión vertical</Button>}
          </div>
          <p className="mt-3 text-xs text-ink-3">Después de editarla puedes exportarla, guardarla en tu biblioteca{s.ads.contracted ? ' o usarla en un anuncio (Ads la crea en pausa)' : ''}. Los cambios de estilo libre («más elegante») todavía no se aplican solos: los haces en el editor.</p>
        </Card>
      )}
    </div>
  );
}
