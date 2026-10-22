import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Film, Link2, Lock, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, uploadFile } from '../../lib/api';
import { authedBlobUrl } from '../../lib/creative';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Input, Loading, Modal, PageHeader, Select } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Biblioteca de recursos compartida por Creative y Ads Intelligence.
 * Ads la usa sin Creative (sube sus imágenes y videos); con los dos, lo de uno
 * se ve en el otro. Un recurso vinculado a una campaña o anuncio no se borra.
 */

interface Asset {
  id: string;
  name: string;
  kind: 'LOGO' | 'IMAGE' | 'REFERENCE' | 'VIDEO';
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  source: 'UPLOAD' | 'CATALOG' | 'DESIGN';
  originModule: 'CREATIVE' | 'ADS';
  designId: string | null;
  designVersion: number | null;
  derivedFromId: string | null;
  ratios: string[];
  createdBy: string | null;
  createdAt: string;
  linkCount: number;
  locked: boolean;
}

interface Detail extends Asset {
  available: boolean;
  versions: Array<{ id: string; designVersion: number | null; createdAt: string; current: boolean }>;
  links: Array<{ id: string; adEntityId: string; provider: string; level: string; name: string; status: string | null; missing: boolean; createdAt: string }>;
}

interface ListResponse {
  products: { creative: boolean; ads: boolean };
  limits: { maxImageBytes: number; maxVideoBytes: number; maxAssets: number; total: number };
  assets: Asset[];
}

const ORIGIN = { CREATIVE: 'Creative', ADS: 'Ads Intelligence' } as const;
const LEVEL = { CAMPAIGN: 'Campaña', ADSET: 'Conjunto', AD: 'Anuncio' } as Record<string, string>;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

function sourceLabel(a: Asset) {
  if (a.source === 'DESIGN') return `Diseño de Creative · v${a.designVersion ?? '?'}`;
  if (a.source === 'CATALOG') return 'Foto del catálogo';
  return `Subido en ${ORIGIN[a.originModule]}`;
}

function Preview({ asset, q, className, controls }: { asset: Asset; q: string; className: string; controls?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    authedBlobUrl(`/api${withScope(`/library/assets/${asset.id}/file`, q)}`).then((u) => {
      url = u;
      if (!alive) return;
      if (u) setSrc(u); else setFailed(true);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset.id, q]);
  if (failed) return <div className={`flex items-center justify-center bg-bone-2 text-xs text-ink-3 ${className}`}>Archivo no disponible</div>;
  if (!src) return <div className={`animate-pulse bg-bone-2 ${className}`} />;
  if (asset.kind === 'VIDEO') return <video src={src} className={`bg-ink object-contain ${className}`} muted playsInline controls={controls} preload="metadata" />;
  return <img src={src} alt={asset.name} className={`bg-bone-2 object-contain ${className}`} />;
}

export default function Library() {
  const { q, ready, canWrite } = useCompanyScope();
  const qc = useQueryClient();
  const [kind, setKind] = useState('');
  const [origin, setOrigin] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ['library', q, kind, origin],
    queryFn: () => api.get<ListResponse>(withScope(`/library/assets?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(origin ? { origin } : {}) })}`, q)),
    enabled: ready,
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<{ duplicate: boolean; asset: Asset }>(withScope('/library/assets', q), 'file', file, { name: file.name.replace(/\.[^.]+$/, '') }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['library'] });
      toast.success(r.duplicate ? 'Ese archivo ya estaba en tu biblioteca' : 'Recurso agregado');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo subir'),
  });
  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading />;
  const { products, limits } = data;
  const shown = data.assets.filter((a) => !text.trim() || a.name.toLowerCase().includes(text.trim().toLowerCase()));
  const intro = products.creative && products.ads
    ? 'Lo que subes aquí, o guardas desde el editor de Creative, lo ves en Creative y en Publicidad.'
    : products.ads
      ? 'Tus imágenes y videos para anuncios. No necesitas Creative para usarla.'
      : 'Tus imágenes, logos y versiones de diseños guardadas desde el editor.';

  return (
    <div>
      <PageHeader
        kicker="Recursos compartidos"
        title="Biblioteca"
        actions={canWrite && (
          <label className="inline-flex cursor-pointer items-center gap-2 border-2 border-ink bg-ink px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-bone hover:bg-transparent hover:text-ink">
            <Upload size={14} /> {upload.isPending ? 'Subiendo…' : 'Subir imagen o video'}
            <input type="file" className="hidden" accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime" disabled={upload.isPending}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f); }} />
          </label>
        )}
      />
      <p className="mb-4 max-w-3xl text-sm text-ink-2">{intro}</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input placeholder="Buscar por nombre" value={text} onChange={(e) => setText(e.target.value)} className="max-w-xs" aria-label="Buscar recursos" />
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Tipo" className="max-w-[200px]">
          <option value="">Todos los tipos</option>
          <option value="IMAGE">Imágenes</option>
          <option value="VIDEO">Videos</option>
          <option value="LOGO">Logos</option>
        </Select>
        {products.creative && products.ads && (
          <Select value={origin} onChange={(e) => setOrigin(e.target.value)} aria-label="Origen" className="max-w-[240px]">
            <option value="">De Creative y de Publicidad</option>
            <option value="CREATIVE">Solo de Creative</option>
            <option value="ADS">Solo de Publicidad</option>
          </Select>
        )}
        <span className="ml-auto text-xs text-ink-3">
          {limits.total} de {limits.maxAssets} recursos · imágenes PNG, JPG o WEBP hasta {mb(limits.maxImageBytes)} · videos MP4 o MOV hasta {mb(limits.maxVideoBytes)}
        </span>
      </div>

      {!shown.length ? (
        <EmptyState
          title={data.assets.length ? 'Nada coincide con el filtro' : 'Tu biblioteca está vacía'}
          hint={data.assets.length ? undefined : products.creative
            ? 'Sube imágenes o videos, o guarda un diseño desde el editor de Creative con «A la biblioteca».'
            : 'Sube las imágenes y videos que usas en tus anuncios.'}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((a) => (
            <button key={a.id} onClick={() => setOpen(a.id)} className="cursor-pointer border-2 border-ink bg-paper text-left hover:bg-bone-2">
              <div className="relative">
                <Preview asset={a} q={q} className="aspect-square w-full" />
                {a.kind === 'VIDEO' && <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-bone"><Film size={11} /> {a.durationSec ? `${a.durationSec} s` : 'Video'}</span>}
                {a.locked && <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-bone"><Lock size={11} /> En uso</span>}
              </div>
              <div className="border-t-2 border-ink p-2">
                <p className="truncate text-[13px] font-semibold">{a.name}</p>
                <p className="truncate text-[11px] text-ink-3">{a.width && a.height ? `${a.width}×${a.height}` : 'Medidas sin leer'} · {sourceLabel(a)}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && <AssetDetail id={open} q={q} canWrite={canWrite} ads={products.ads} onClose={() => setOpen(null)} />}
    </div>
  );
}

function AssetDetail({ id, q, canWrite, ads, onClose }: { id: string; q: string; canWrite: boolean; ads: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: a } = useQuery({ queryKey: ['library-asset', id, q], queryFn: () => api.get<Detail>(withScope(`/library/assets/${id}`, q)) });
  const [name, setName] = useState<string | null>(null);
  const [entityId, setEntityId] = useState('');
  const { data: entities } = useQuery({
    queryKey: ['library-entities', q],
    queryFn: () => api.get<Array<{ id: string; name: string; level: string; provider: string; mode: string; status: string | null }>>(withScope('/library/ad-entities', q)),
    enabled: ads && canWrite,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['library'] });
    qc.invalidateQueries({ queryKey: ['library-asset', id] });
  };
  const rename = useMutation({ mutationFn: () => api.patch(withScope(`/library/assets/${id}`, q), { name }), onSuccess: () => { refresh(); setName(null); toast.success('Nombre guardado'); }, onError: (e: Error) => toast.error(e.message) });
  const link = useMutation({ mutationFn: () => api.post(withScope(`/library/assets/${id}/links`, q), { adEntityId: entityId }), onSuccess: () => { refresh(); setEntityId(''); toast.success('Vinculado'); }, onError: (e: Error) => toast.error(e.message) });
  const unlink = useMutation({ mutationFn: (linkId: string) => api.delete(withScope(`/library/assets/${id}/links/${linkId}`, q)), onSuccess: () => { refresh(); toast.success('Desvinculado'); }, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: () => api.delete(withScope(`/library/assets/${id}`, q)), onSuccess: () => { qc.invalidateQueries({ queryKey: ['library'] }); toast.success('Recurso borrado'); onClose(); }, onError: (e: Error) => toast.error(e.message) });

  return (
    <Modal open onClose={onClose} kicker={a ? sourceLabel(a) : 'Recurso'} title={a?.name ?? 'Cargando…'} wide>
      {!a ? <Loading /> : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <Preview asset={a} q={q} className="max-h-[420px] w-full border-2 border-ink" controls />
            {!a.available && <p className="mt-2 border-2 border-bad bg-bad-soft px-3 py-2 text-sm text-bad">El archivo ya no está disponible en el servidor. Súbelo de nuevo.</p>}
          </div>
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-ink-3">Tipo</dt><dd>{a.kind === 'VIDEO' ? 'Video' : a.kind === 'LOGO' ? 'Logo' : 'Imagen'} · {a.mimeType.split('/')[1].toUpperCase()}</dd>
              <dt className="text-ink-3">Medidas</dt><dd>{a.width && a.height ? `${a.width}×${a.height} px` : 'No se pudieron leer del archivo'}{a.durationSec ? ` · ${a.durationSec} s` : ''}</dd>
              <dt className="text-ink-3">Peso</dt><dd>{mb(a.sizeBytes)}</dd>
              <dt className="text-ink-3">Origen</dt><dd>{sourceLabel(a)}</dd>
              <dt className="text-ink-3">Agregado</dt><dd>{fmtDate(a.createdAt)}{a.createdBy ? ` · ${a.createdBy}` : ''}</dd>
            </dl>
            {!!a.ratios.length && (
              <div>
                <p className="kicker mb-1">Sirve para</p>
                <div className="flex flex-wrap gap-1">{a.ratios.map((r) => <Badge key={r}>{r}</Badge>)}</div>
                <p className="mt-1 text-[11px] text-ink-3">Orientativo: cada plataforma valida el archivo cuando lo subes al anuncio.</p>
              </div>
            )}
            {a.versions.length > 1 && (
              <div>
                <p className="kicker mb-1">Versiones del diseño</p>
                <p className="text-ink-2">{a.versions.map((v) => `v${v.designVersion ?? '?'}${v.current ? ' (esta)' : ''}`).join(' → ')}</p>
                <p className="text-[11px] text-ink-3">Cada versión es un recurso aparte: cambiar el diseño no modifica lo que ya usa un anuncio.</p>
              </div>
            )}

            {(ads || a.links.length > 0) && (
              <div>
                <p className="kicker mb-1">Campañas y anuncios</p>
                {!a.links.length && <p className="text-ink-3">Aún no está vinculado a ninguna.</p>}
                <ul className="space-y-1">
                  {a.links.map((l) => (
                    <li key={l.id} className="flex items-center justify-between gap-2 border-2 border-line px-2 py-1">
                      <span className="min-w-0 truncate">{LEVEL[l.level] ?? l.level} · {l.name}{l.missing ? ' (ya no está en la cuenta)' : l.status ? ` · ${l.status}` : ''}</span>
                      {canWrite && ads && <Button size="sm" variant="ghost" onClick={() => unlink.mutate(l.id)} disabled={unlink.isPending}>Quitar</Button>}
                    </li>
                  ))}
                </ul>
                {canWrite && ads && (
                  entities?.length ? (
                    <div className="mt-2 flex gap-2">
                      <Select value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label="Campaña o anuncio">
                        <option value="">Elige campaña o anuncio…</option>
                        {entities.map((e) => <option key={e.id} value={e.id}>{LEVEL[e.level] ?? e.level} · {e.name}{e.mode === 'DEMO' ? ' (demostración)' : ''}</option>)}
                      </Select>
                      <Button size="sm" disabled={!entityId || link.isPending} onClick={() => link.mutate()}><Link2 size={14} /> Vincular</Button>
                    </div>
                  ) : <p className="mt-2 text-[11px] text-ink-3">Conecta una cuenta en <Link to="/app/ads" className="underline">Publicidad</Link> para vincular este recurso a tus campañas.</p>
                )}
                <p className="mt-1 text-[11px] text-ink-3">El vínculo es un registro de BackOffice: no sube el archivo a la plataforma publicitaria.</p>
              </div>
            )}

            {canWrite && (
              <div className="space-y-2 border-t-2 border-line pt-3">
                <div className="flex gap-2">
                  <Input value={name ?? a.name} onChange={(e) => setName(e.target.value)} aria-label="Nombre del recurso" />
                  <Button size="sm" variant="outline" disabled={name === null || !name.trim() || rename.isPending} onClick={() => rename.mutate()}>Renombrar</Button>
                </div>
                <Button size="sm" variant="danger" disabled={a.locked || remove.isPending} onClick={() => { if (confirm('¿Borrar este recurso? No se puede deshacer.')) remove.mutate(); }}>
                  <Trash2 size={14} /> Borrar
                </Button>
                {a.locked && <p className="text-[11px] text-ink-3">Está vinculado a una campaña o anuncio: quítalo de ahí antes de borrarlo.</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
