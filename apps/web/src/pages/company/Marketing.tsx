import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Clapperboard, Hash, Megaphone, Plus, Sparkles, Video, Wand2,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import type {
  ContentPiece, MarketingCampaign, MarketingSummary, VideoJob,
} from '../../lib/types';
import {
  Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Select,
  Stat, Tabs, Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';
import { MediaImage } from '../../components/media';
import { PieceSocialPanel, SocialHeader, useSocialStatus } from '../../components/SocialStudio';

const TYPE_LABELS: Record<string, string> = {
  REEL: 'Reel', POST: 'Post', STORY: 'Historia', AD: 'Anuncio',
};
const STATUS_LABELS: Record<string, string> = {
  IDEA: 'Idea', BORRADOR: 'Borrador', LISTO: 'Listo',
  PROGRAMADO: 'Programado', PUBLICANDO: 'Publicando', PUBLICADO: 'Publicado', ERROR: 'Error al publicar',
};
const CHANNELS = ['instagram', 'tiktok', 'facebook', 'youtube'];

function statusTone(s: string): 'ok' | 'warn' | 'info' | 'neutral' | 'ink' | 'bad' {
  switch (s) {
    case 'PUBLICADO': case 'ACTIVA': return 'ok';
    case 'PROGRAMADO': case 'LISTO': return 'info';
    case 'BORRADOR': case 'PAUSADA': case 'PUBLICANDO': return 'warn';
    case 'ERROR': return 'bad';
    case 'CERRADA': return 'ink';
    default: return 'neutral';
  }
}

/** ISO → valor de <input type="datetime-local"> en la hora local del navegador. */
function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ─── Modal de pieza ─────────────────────────────────────────────────── */

function PieceModal({ piece: initial, campaigns, companyId, q, onClose }: {
  piece: ContentPiece | null;
  campaigns: MarketingCampaign[];
  companyId: string | null;
  q: string;
  onClose: () => void;
}) {
  const [piece, setPiece] = useState<ContentPiece | null>(initial);
  const { data: social } = useSocialStatus(q);
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    title: piece?.title ?? '',
    type: piece?.type ?? 'REEL',
    channel: piece?.channel ?? 'instagram',
    campaignId: piece?.campaignId ?? '',
    brief: piece?.brief ?? '',
    copy: piece?.copy ?? '',
    script: piece?.script ?? '',
    hashtags: (piece?.hashtags ?? []).join(' '),
    status: piece?.status ?? 'IDEA',
    scheduledAt: toLocalInput(piece?.scheduledAt),
  });
  const set = (patch: Partial<typeof form>) => setForm((p) => ({ ...p, ...patch }));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['mk-pieces'] });
    queryClient.invalidateQueries({ queryKey: ['mk-summary'] });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: form.title, type: form.type, channel: form.channel || null,
        campaignId: form.campaignId || null, brief: form.brief,
        copy: form.copy, script: form.script,
        hashtags: form.hashtags.split(/[\s,]+/).filter(Boolean),
        status: form.status,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
        ...(companyId ? { companyId } : {}),
      };
      return piece
        ? api.patch<ContentPiece>(`/marketing/pieces/${piece.id}`, body)
        : api.post<ContentPiece>('/marketing/pieces', body);
    },
    onSuccess: () => {
      toast.success('Pieza guardada');
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const generate = useMutation({
    mutationFn: () => api.post<ContentPiece>(`/marketing/pieces/${piece!.id}/generate-copy`),
    onSuccess: (updated) => {
      toast.success('Copy generado con la IA de la empresa');
      set({
        title: updated.title, copy: updated.copy ?? '',
        script: updated.script ?? form.script,
        hashtags: updated.hashtags.join(' '),
        status: updated.status,
      });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const render = useMutation({
    mutationFn: () => api.post<VideoJob>(`/marketing/pieces/${piece!.id}/render-video`),
    onSuccess: () => {
      toast.success('Reel encolado en el generador de video');
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error', { duration: 8000 }),
  });

  return (
    <Modal open onClose={onClose} wide kicker="Contenido" title={piece ? piece.title : 'Nueva pieza'}>
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Tipo">
            <Select value={form.type} onChange={(e) => set({ type: e.target.value as any })}>
              {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Canal">
            <Select value={form.channel} onChange={(e) => set({ channel: e.target.value })}>
              {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Campaña">
            <Select value={form.campaignId} onChange={(e) => set({ campaignId: e.target.value })}>
              <option value="">Sin campaña</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Título / idea" required>
          <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="5 errores al pedir catering para eventos" />
        </Field>
        <Field label="Brief para la IA" hint="Contexto, oferta, tono — la IA lo usa para escribir el copy y el guion">
          <Textarea rows={2} value={form.brief} onChange={(e) => set({ brief: e.target.value })} />
        </Field>

        {piece && !social?.addon.enabled && (
          <div className="flex flex-wrap gap-2 border-2 border-line bg-bone p-3">
            <Button size="sm" variant="outline" disabled={generate.isPending} onClick={() => generate.mutate()}>
              <Wand2 size={13} /> {generate.isPending ? 'Escribiendo…' : 'Generar copy con la IA'}
            </Button>
            {form.type === 'REEL' && (
              <Button size="sm" variant="outline" disabled={render.isPending || !form.script} onClick={() => render.mutate()}>
                <Clapperboard size={13} /> {render.isPending ? 'Encolando…' : 'Generar video del reel'}
              </Button>
            )}
            <p className="w-full text-xs text-ink-3">
              El copy usa la llave DeepInfra de la empresa (BYOK). El video requiere el
              generador conectado por el equipo BackOffice.
            </p>
          </div>
        )}

        <Field label="Copy / caption">
          <Textarea rows={3} value={form.copy} onChange={(e) => set({ copy: e.target.value })} placeholder="Se genera con la IA o se escribe a mano…" />
        </Field>
        {form.type === 'REEL' && (
          <Field label="Guion del reel" hint="30-45 segundos hablados; el generador de video lo usa como narración">
            <Textarea rows={3} value={form.script} onChange={(e) => set({ script: e.target.value })} />
          </Field>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Hashtags" hint="Separados por espacio">
            <Input value={form.hashtags} onChange={(e) => set({ hashtags: e.target.value })} placeholder="#catering #eventos" />
          </Field>
          <Field label="Estado">
            <Select value={form.status} onChange={(e) => set({ status: e.target.value as any })}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Field>
          <Field label="Programada para">
            <Input type="datetime-local" value={form.scheduledAt} onChange={(e) => set({ scheduledAt: e.target.value })} />
          </Field>
        </div>
        {piece && (
          <PieceSocialPanel
            piece={piece}
            q={q}
            onChanged={(p) => {
              if (p) {
                setPiece(p);
                set({ title: p.title, copy: p.copy ?? form.copy, hashtags: p.hashtags.join(' '), status: p.status, scheduledAt: p.scheduledAt ? toLocalInput(p.scheduledAt) : form.scheduledAt });
              }
              invalidate();
            }}
          />
        )}

        {piece?.assetUrl && (
          <p className="border-2 border-ok bg-ok-soft px-3 py-2 text-sm text-ok">
            Video listo: <a className="underline" href={piece.assetUrl} target="_blank" rel="noreferrer">ver/descargar</a>
          </p>
        )}
        <Button className="w-full" disabled={!form.title.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar pieza'}
        </Button>
      </div>
    </Modal>
  );
}

/* ─── Modal de campaña ───────────────────────────────────────────────── */

function CampaignModal({ campaign, companyId, onClose }: {
  campaign: MarketingCampaign | null;
  companyId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    objective: campaign?.objective ?? '',
    status: campaign?.status ?? 'BORRADOR',
    channels: campaign?.channels ?? ['instagram'],
    budgetUsd: campaign?.budgetUsd != null ? String(campaign.budgetUsd) : '',
    startsAt: campaign?.startsAt ? campaign.startsAt.slice(0, 10) : '',
    endsAt: campaign?.endsAt ? campaign.endsAt.slice(0, 10) : '',
    notes: campaign?.notes ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((p) => ({ ...p, ...patch }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, objective: form.objective, status: form.status,
        channels: form.channels,
        budgetUsd: form.budgetUsd ? Number(form.budgetUsd) : null,
        startsAt: form.startsAt || null, endsAt: form.endsAt || null,
        notes: form.notes,
        ...(companyId ? { companyId } : {}),
      };
      return campaign
        ? api.patch(`/marketing/campaigns/${campaign.id}`, body)
        : api.post('/marketing/campaigns', body);
    },
    onSuccess: () => {
      toast.success('Campaña guardada');
      queryClient.invalidateQueries({ queryKey: ['mk-campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['mk-summary'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <Modal open onClose={onClose} kicker="Campañas" title={campaign ? campaign.name : 'Nueva campaña'}>
      <div className="space-y-4">
        <Field label="Nombre" required>
          <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Lanzamiento menú de fin de año" />
        </Field>
        <Field label="Objetivo">
          <Input value={form.objective} onChange={(e) => set({ objective: e.target.value })} placeholder="Ventas, alcance, leads…" />
        </Field>
        <div>
          <p className="kicker mb-2">Canales</p>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => (
              <button
                key={c} type="button"
                onClick={() => set({
                  channels: form.channels.includes(c)
                    ? form.channels.filter((x) => x !== c)
                    : [...form.channels, c],
                })}
                className={clsx(
                  'cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em]',
                  form.channels.includes(c) ? 'bg-ink text-bone' : 'bg-paper hover:bg-bone-2',
                )}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Inicio">
            <Input type="date" value={form.startsAt} onChange={(e) => set({ startsAt: e.target.value })} />
          </Field>
          <Field label="Fin">
            <Input type="date" value={form.endsAt} onChange={(e) => set({ endsAt: e.target.value })} />
          </Field>
          <Field label="Presupuesto (USD)" hint="Para anuncios pagos">
            <Input type="number" min={0} value={form.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value })} />
          </Field>
          <Field label="Estado">
            <Select value={form.status} onChange={(e) => set({ status: e.target.value as any })}>
              {['BORRADOR', 'ACTIVA', 'PAUSADA', 'CERRADA'].map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Notas">
          <Textarea rows={2} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <Button className="w-full" disabled={!form.name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar campaña'}
        </Button>
      </div>
    </Modal>
  );
}

/* ─── Página ─────────────────────────────────────────────────────────── */

export default function Marketing() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const [tab, setTab] = useState('contenido');
  const [editingPiece, setEditingPiece] = useState<ContentPiece | null | 'new'>(null);
  const [editingCampaign, setEditingCampaign] = useState<MarketingCampaign | null | 'new'>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const { data: summary } = useQuery({
    queryKey: ['mk-summary', q],
    queryFn: () => api.get<MarketingSummary>(withScope('/marketing/summary', q)),
    enabled: ready,
  });
  const { data: campaigns } = useQuery({
    queryKey: ['mk-campaigns', q],
    queryFn: () => api.get<MarketingCampaign[]>(withScope('/marketing/campaigns', q)),
    enabled: ready,
  });
  const piecesPath = withScope(`/marketing/pieces?x=1${statusFilter ? `&status=${statusFilter}` : ''}`, q);
  const { data: pieces, isLoading } = useQuery({
    queryKey: ['mk-pieces', piecesPath],
    queryFn: () => api.get<ContentPiece[]>(piecesPath),
    enabled: ready,
    refetchInterval: 30_000, // los videos en proceso actualizan estado
  });

  if (!ready) return <PickCompany />;

  return (
    <>
      <PageHeader
        kicker="Contenido y campañas"
        title="Marketing"
        actions={
          canWrite ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditingCampaign('new')}>
                <Megaphone size={13} /> Nueva campaña
              </Button>
              <Button size="sm" onClick={() => setEditingPiece('new')}>
                <Plus size={13} /> Nueva pieza
              </Button>
            </>
          ) : undefined
        }
      />

      <SocialHeader q={q} canWrite={canWrite} />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Campañas activas" value={summary?.campañasActivas ?? 0} />
        <Stat label="Piezas totales" value={summary?.totalPiezas ?? 0} />
        <Stat label="Programadas" value={summary?.piezas?.PROGRAMADO ?? 0} />
        <Stat
          label="Generador de video"
          value={summary?.videoGeneratorReady ? 'Conectado' : 'Pendiente'}
          tone={summary?.videoGeneratorReady ? 'ok' : 'warn'}
          hint={summary?.videoGeneratorReady ? 'Reels con IA disponibles' : 'Lo conecta el equipo BackOffice'}
        />
      </div>

      <div className="mb-5">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'contenido', label: 'Contenido' },
            { id: 'campanas', label: 'Campañas' },
          ]}
        />
      </div>

      {tab === 'contenido' && (
        <>
          <div className="mb-4 flex flex-wrap gap-3">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="max-w-[190px]" aria-label="Filtrar por estado">
              <option value="">Todos los estados</option>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          {isLoading ? (
            <Loading />
          ) : (pieces?.length ?? 0) === 0 ? (
            <EmptyState
              title="Sin piezas de contenido"
              hint="Crea una idea (reel, post, historia o anuncio) y deja que la IA de la empresa escriba el copy, los hashtags y el guion."
              action={canWrite ? <Button onClick={() => setEditingPiece('new')}>Crear la primera</Button> : undefined}
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {pieces?.map((piece) => (
                <button
                  key={piece.id}
                  onClick={() => setEditingPiece(piece)}
                  className="cursor-pointer border-2 border-ink bg-paper text-left transition-shadow hover:shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]"
                >
                  <div className="flex items-center justify-between gap-2 border-b-2 border-ink bg-bone-2 px-4 py-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
                      {piece.type === 'REEL' ? <Video size={13} /> : piece.type === 'AD' ? <Megaphone size={13} /> : <Sparkles size={13} />}
                      {TYPE_LABELS[piece.type]} · {piece.channel ?? 'sin canal'}
                    </span>
                    <Badge tone={statusTone(piece.status)}>{STATUS_LABELS[piece.status]}</Badge>
                  </div>
                  {piece.hasAsset && (
                    <MediaImage id={piece.id} path={`/social/pieces/${piece.id}/asset`} alt={piece.title} className="h-40 w-full border-b-2 border-ink" />
                  )}
                  <div className="px-4 py-3">
                    <p className="font-semibold leading-snug">{piece.title}</p>
                    {piece.copy && (
                      <p className="mt-1 line-clamp-2 text-xs text-ink-3">{piece.copy}</p>
                    )}
                    {piece.hashtags.length > 0 && (
                      <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] text-info">
                        <Hash size={11} /> {piece.hashtags.slice(0, 4).join(' ')}
                      </p>
                    )}
                    {piece.scheduledAt && (
                      <p className="mt-1.5 text-[11px] uppercase tracking-wider text-ink-3">
                        {piece.status === 'PUBLICADO' ? 'Publicada' : 'Programada'} · {fmtDateTime(piece.publishedAt ?? piece.scheduledAt)}
                        {piece.targets?.length ? ` · ${piece.targets.map((t) => (t === 'facebook' ? 'FB' : 'IG')).join(' + ')}` : ''}
                      </p>
                    )}
                    {piece.publishError && <p className="mt-1 line-clamp-2 text-[11px] text-bad">{piece.publishError}</p>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'campanas' && (
        (campaigns?.length ?? 0) === 0 ? (
          <EmptyState
            title="Sin campañas"
            hint="Una campaña agrupa piezas de contenido con un objetivo (lanzamiento, temporada, promoción) y su presupuesto de pauta."
            action={canWrite ? <Button onClick={() => setEditingCampaign('new')}>Crear la primera</Button> : undefined}
          />
        ) : (
          <div className="space-y-3">
            {campaigns?.map((campaign) => (
              <button
                key={campaign.id}
                onClick={() => setEditingCampaign(campaign)}
                className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper px-5 py-3 text-left hover:bg-bone-2"
              >
                <div className="min-w-0">
                  <p className="display text-lg leading-tight">{campaign.name}</p>
                  <p className="text-xs text-ink-3">
                    {campaign.objective ?? 'Sin objetivo'} · {campaign.channels.join(', ') || 'sin canales'}
                    {campaign.budgetUsd ? ` · ${campaign.budgetUsd} USD` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-ink-3">
                    {campaign.publishedCount ?? 0}/{campaign.pieceCount ?? 0} publicadas
                  </span>
                  <Badge tone={statusTone(campaign.status)}>{campaign.status}</Badge>
                </div>
              </button>
            ))}
          </div>
        )
      )}

      {editingPiece && (
        <PieceModal
          piece={editingPiece === 'new' ? null : editingPiece}
          campaigns={campaigns ?? []}
          companyId={companyId}
          q={q}
          onClose={() => setEditingPiece(null)}
        />
      )}
      {editingCampaign && (
        <CampaignModal
          campaign={editingCampaign === 'new' ? null : editingCampaign}
          companyId={companyId}
          onClose={() => setEditingCampaign(null)}
        />
      )}
    </>
  );
}
