import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CalendarRange, ExternalLink, ImagePlus, Link2, Send, Sparkles, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { fmtDateTime, fmtMoney } from '../lib/format';
import type { ContentPiece, SocialStatus } from '../lib/types';
import { Badge, Button, Field, Input, Modal, Textarea } from './ui';
import { MediaImage } from './media';

/**
 * Extra "Redes sociales con IA": créditos del mes, conexión con Facebook /
 * Instagram de la empresa, plan del mes con IA y, por pieza, imagen con IA,
 * programación y publicación.
 */

const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error', { duration: 7000 });
const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function useSocialStatus(q: string, enabled = true) {
  return useQuery({
    queryKey: ['social-status', q],
    queryFn: () => api.get<SocialStatus>(`/social/status${q ? `?${q}` : ''}`),
    enabled,
  });
}

/* ── Cabecera: créditos, conexión y plan ── */

export function SocialHeader({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const { data: st } = useSocialStatus(q);
  const [manual, setManual] = useState(false);
  const [planning, setPlanning] = useState(false);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['social-status'] });
    queryClient.invalidateQueries({ queryKey: ['mk-pieces'] });
  };
  const scoped = (path: string) => `${path}${q ? `${path.includes('?') ? '&' : '?'}${q}` : ''}`;

  // Vuelta del login de Facebook
  useEffect(() => {
    const meta = params.get('meta');
    if (!meta) return;
    if (meta === 'ok') toast.success('Tu página quedó conectada');
    else if (meta === 'elegir') toast.info('Elige cuál de tus páginas vas a usar');
    else if (meta === 'sin-paginas') toast.error('Tu cuenta no administra ninguna página de Facebook');
    else toast.error('No se pudo conectar con Facebook. Intenta de nuevo.');
    params.delete('meta');
    setParams(params, { replace: true });
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const request = useMutation({
    mutationFn: () => api.post(scoped('/social/request')),
    onSuccess: () => {
      toast.success('¡Listo! El equipo te contacta para activarlo.');
      refresh();
    },
    onError: err,
  });
  const oauth = useMutation({
    mutationFn: () => api.get<{ url: string }>(scoped('/social/meta/oauth')),
    onSuccess: (r) => { window.location.href = r.url; },
    onError: err,
  });
  const select = useMutation({
    mutationFn: (pageId: string) => api.post(scoped('/social/meta/select'), { pageId }),
    onSuccess: () => { toast.success('Página conectada'); refresh(); },
    onError: err,
  });
  const disconnect = useMutation({
    mutationFn: () => api.delete(scoped('/social/meta')),
    onSuccess: () => { toast.success('Desconectado'); refresh(); },
    onError: err,
  });

  if (!st) return null;
  if (!st.addon.enabled) {
    return (
      <section className="mb-6 grid gap-4 border-2 border-ink bg-ink p-6 text-bone md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-line">Extra · Redes sociales con IA</p>
          <h2 className="display mt-1 text-3xl">Tu contenido, hecho y publicado por IA</h2>
          <p className="mt-2 max-w-2xl text-sm text-line">
            Imágenes y videos creados con IA, textos listos para publicar y un calendario que se publica solo en tu Facebook e Instagram.
            {` ${st.defaults.credits} créditos al mes (una imagen = 1, un video = 4). Desde ${fmtMoney(st.defaults.price)} al mes, IVA incluido.`}
          </p>
        </div>
        {canWrite && (
          <Button variant="outline" className="!border-bone !bg-bone !text-ink" disabled={st.requested || request.isPending} onClick={() => request.mutate()}>
            {st.requested ? 'Solicitud enviada' : 'Quiero activarlo'}
          </Button>
        )}
      </section>
    );
  }

  const used = Math.min(100, Math.round((st.usage.credits / Math.max(1, st.addon.credits)) * 100));
  const conn = st.connection;
  return (
    <section className="mb-6 grid gap-4 lg:grid-cols-3">
      <div className="border-2 border-ink bg-paper p-4">
        <p className="kicker">Créditos de este mes</p>
        <p className="display text-4xl">{st.usage.left}<span className="text-base text-ink-3"> / {st.addon.credits}</span></p>
        <div className="mt-2 h-2 border border-ink bg-bone"><div className="h-full bg-ink" style={{ width: `${used}%` }} /></div>
        <p className="mt-2 text-xs text-ink-3">
          Imagen = {st.creditCost.image} crédito · video = {st.creditCost.video}. Usaste {st.usage.images} imágenes y {st.usage.videos} videos.
          {st.imageProvider === 'SIMULADO' && ' Imágenes en modo prueba.'}
        </p>
      </div>

      <div className="border-2 border-ink bg-paper p-4">
        <p className="kicker">Facebook e Instagram</p>
        {conn?.connected ? (
          <>
            <p className="mt-1 text-lg font-semibold">{conn.pageName || `Página ${conn.pageId}`}</p>
            <p className="text-xs text-ink-3">
              {conn.hasInstagram ? `Instagram @${conn.igUsername}` : 'Sin Instagram profesional vinculado'}
              {conn.sandbox && ' · modo prueba (no publica de verdad)'}
            </p>
            {canWrite && (
              <Button size="sm" variant="ghost" className="mt-2" onClick={() => window.confirm('¿Desconectar tu página?') && disconnect.mutate()}>
                <Unplug size={12} /> Desconectar
              </Button>
            )}
          </>
        ) : conn?.pendingPages?.length ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-sm">¿Cuál página vas a usar?</p>
            {conn.pendingPages.map((p) => (
              <Button key={p.id} size="sm" variant="outline" className="w-full !justify-start" onClick={() => select.mutate(p.id)}>
                {p.name}{p.igUsername ? ` · @${p.igUsername}` : ''}
              </Button>
            ))}
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-2">Conecta tu página para publicar automáticamente.</p>
            {canWrite && (
              <div className="mt-3 flex flex-wrap gap-2">
                {st.oauthAvailable && (
                  <Button size="sm" disabled={oauth.isPending} onClick={() => oauth.mutate()}>
                    <Link2 size={12} /> Conectar con Facebook
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => setManual(true)}>Conexión manual</Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-2 border-ink bg-paper p-4">
        <p className="kicker">Plan del mes</p>
        <p className="mt-1 text-sm text-ink-2">La IA arma tus publicaciones del mes en los días que elijas, con texto e idea de imagen.</p>
        {canWrite && (
          <Button size="sm" className="mt-3" onClick={() => setPlanning(true)}>
            <CalendarRange size={12} /> Armar plan con IA
          </Button>
        )}
      </div>

      {manual && <ManualConnect q={q} onClose={() => setManual(false)} onDone={refresh} />}
      {planning && <PlanModal q={q} left={st.usage.left} onClose={() => setPlanning(false)} onDone={refresh} />}
    </section>
  );
}

function ManualConnect({ q, onClose, onDone }: { q: string; onClose: () => void; onDone: () => void }) {
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [sandbox, setSandbox] = useState(false);
  const save = useMutation({
    mutationFn: () => api.post(`/social/meta/manual${q ? `?${q}` : ''}`, { pageId: pageId.trim(), accessToken: sandbox ? '' : token.trim(), sandbox }),
    onSuccess: () => { toast.success('Página conectada'); onDone(); onClose(); },
    onError: err,
  });
  return (
    <Modal open onClose={onClose} kicker="Meta" title="Conexión manual">
      <div className="space-y-4">
        <p className="text-xs text-ink-2">
          En Meta Business Suite → Configuración → Página, copia el ID de la página. El token de página (con permisos de publicar) lo genera el equipo o tu agencia en developers.facebook.com.
        </p>
        <Field label="ID de la página" required><Input value={pageId} onChange={(e) => setPageId(e.target.value)} placeholder="1234567890" /></Field>
        {!sandbox && (
          <Field label="Token de la página" hint="Se guarda cifrado; nunca se vuelve a mostrar">
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Modo prueba (simula publicar, no sale nada)
        </label>
        <Button className="w-full" disabled={!pageId.trim() || (!sandbox && !token.trim()) || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Verificando…' : 'Conectar'}
        </Button>
      </div>
    </Modal>
  );
}

function PlanModal({ q, left, onClose, onDone }: { q: string; left: number; onClose: () => void; onDone: () => void }) {
  const [weekdays, setWeekdays] = useState<number[]>([1, 3, 5]);
  const [time, setTime] = useState('10:00');
  const [count, setCount] = useState(Math.min(8, Math.max(1, left || 8)));
  const [topic, setTopic] = useState('');
  const [targets, setTargets] = useState<string[]>(['facebook', 'instagram']);
  const plan = useMutation({
    mutationFn: () => api.post<{ created: number }>(`/social/plan${q ? `?${q}` : ''}`, { weekdays, time, count, topic, targets }),
    onSuccess: (r) => {
      toast.success(`${r.created} publicaciones creadas como borrador. Genera sus imágenes y prográmalas.`);
      onDone();
      onClose();
    },
    onError: err,
  });
  return (
    <Modal open onClose={onClose} kicker="Redes sociales con IA" title="Plan del mes">
      <div className="space-y-4">
        <Field label="Días para publicar">
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                onClick={() => setWeekdays(weekdays.includes(i) ? weekdays.filter((x) => x !== i) : [...weekdays, i].sort())}
                className={clsx('cursor-pointer border-2 px-3 py-1 text-xs font-semibold', weekdays.includes(i) ? 'border-ink bg-ink text-bone' : 'border-line hover:border-ink')}
              >
                {d}
              </button>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hora"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
          <Field label="Publicaciones" hint={`Te quedan ${left} créditos para imágenes`}>
            <Input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          </Field>
        </div>
        <Field label="Enfoque del mes" hint="Lanzamiento, temporada, promoción, producto estrella…">
          <Textarea rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Este mes queremos impulsar los almuerzos ejecutivos para empresas" />
        </Field>
        <Field label="Dónde">
          <div className="flex gap-4 text-sm">
            {['facebook', 'instagram'].map((t) => (
              <label key={t} className="flex items-center gap-1.5">
                <input type="checkbox" checked={targets.includes(t)} onChange={(e) => setTargets(e.target.checked ? [...targets, t] : targets.filter((x) => x !== t))} />
                {t === 'facebook' ? 'Facebook' : 'Instagram'}
              </label>
            ))}
          </div>
        </Field>
        <p className="text-xs text-ink-3">Armar el plan no gasta créditos: solo cada imagen o video que generes.</p>
        <Button className="w-full" disabled={!weekdays.length || !targets.length || plan.isPending} onClick={() => plan.mutate()}>
          <Sparkles size={13} /> {plan.isPending ? 'Armando el plan…' : 'Armar plan'}
        </Button>
      </div>
    </Modal>
  );
}

/* ── Por pieza: imagen, texto con IA, programar y publicar ── */

const toLocal = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function PieceSocialPanel({ piece, q, onChanged }: { piece: ContentPiece; q: string; onChanged: (p?: ContentPiece) => void }) {
  const { data: st } = useSocialStatus(q);
  const [prompt, setPrompt] = useState(piece.imagePrompt ?? piece.brief ?? '');
  const [targets, setTargets] = useState<string[]>(piece.targets?.length ? piece.targets : ['facebook', 'instagram']);
  const [when, setWhen] = useState(toLocal(piece.scheduledAt));
  const [version, setVersion] = useState(0);
  const image = useMutation({
    mutationFn: () => api.post<ContentPiece>(`/social/pieces/${piece.id}/image`, { prompt }),
    onSuccess: (p) => { toast.success('Imagen lista'); setVersion((v) => v + 1); onChanged(p); },
    onError: err,
  });
  const copy = useMutation({
    mutationFn: () => api.post<ContentPiece>(`/social/pieces/${piece.id}/copy`),
    onSuccess: (p) => { toast.success('Texto listo'); if (p.imagePrompt) setPrompt(p.imagePrompt); onChanged(p); },
    onError: err,
  });
  const schedule = useMutation({
    mutationFn: () => api.post<ContentPiece>(`/social/pieces/${piece.id}/schedule`, { scheduledAt: new Date(when).toISOString(), targets }),
    onSuccess: (p) => { toast.success(`Programada para ${fmtDateTime(p.scheduledAt!)}`); onChanged(p); },
    onError: err,
  });
  const publish = useMutation({
    mutationFn: () => api.post<ContentPiece>(`/social/pieces/${piece.id}/publish`),
    onSuccess: (p) => {
      if (p.status === 'PUBLICADO') toast.success('¡Publicado!');
      else if (p.status === 'PUBLICANDO') toast.info('Meta está procesando el video; se publica en unos minutos');
      else toast.error(p.publishError ?? 'No se pudo publicar');
      onChanged(p);
    },
    onError: err,
  });
  if (!st?.addon.enabled) return null;
  const connected = !!st.connection?.connected;
  const results = piece.publishResult ?? {};

  return (
    <div className="space-y-3 border-2 border-ink bg-bone p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="kicker">Redes sociales con IA</p>
        <span className="text-[11px] text-ink-3">{st.usage.left} créditos disponibles</span>
      </div>
      <div className="grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
        <div className="aspect-[4/5] border-2 border-ink bg-paper">
          {piece.hasAsset ? (
            <MediaImage key={`${piece.id}-${version}`} id={`${piece.id}-${version}`} path={`/social/pieces/${piece.id}/asset`} alt={piece.title} className="h-full w-full" />
          ) : (
            <div className="flex h-full items-center justify-center p-3 text-center text-xs text-ink-3">Sin imagen todavía</div>
          )}
        </div>
        <div className="space-y-2">
          <Field label="Describe la imagen">
            <Textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Bandeja de almuerzo ejecutivo sobre mesa de madera, luz natural, estilo fotografía de comida" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={image.isPending || prompt.trim().length < 8 || st.usage.left < st.creditCost.image} onClick={() => image.mutate()}>
              <ImagePlus size={13} /> {image.isPending ? 'Creando…' : piece.hasAsset ? 'Otra versión (1 crédito)' : 'Crear imagen (1 crédito)'}
            </Button>
            <Button size="sm" variant="outline" disabled={copy.isPending} onClick={() => copy.mutate()}>
              <Sparkles size={13} /> {copy.isPending ? 'Escribiendo…' : 'Escribir texto con IA'}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 border-t border-line pt-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-end">
        <Field label="Publicar en">
          <div className="flex gap-3 py-2 text-sm">
            {['facebook', 'instagram'].map((t) => (
              <label key={t} className="flex items-center gap-1.5">
                <input type="checkbox" checked={targets.includes(t)} onChange={(e) => setTargets(e.target.checked ? [...targets, t] : targets.filter((x) => x !== t))} />
                {t === 'facebook' ? 'Facebook' : 'Instagram'}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Fecha y hora">
          <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button size="sm" disabled={!connected || !when || !targets.length || schedule.isPending} onClick={() => schedule.mutate()}>Programar</Button>
          <Button size="sm" variant="outline" disabled={!connected || !targets.length || publish.isPending} onClick={() => window.confirm('¿Publicar ahora?') && publish.mutate()}>
            <Send size={12} /> Ya
          </Button>
        </div>
      </div>
      {!connected && <p className="text-xs text-warn">Conecta tu página de Facebook / Instagram arriba para programar.</p>}
      {piece.publishError && <p className="border-2 border-bad bg-bad-soft px-3 py-2 text-xs text-bad">{piece.publishError}</p>}
      {Object.keys(results).length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {Object.entries(results).map(([t, r]) => (
            <Badge key={t} tone={r.id ? 'ok' : 'warn'}>
              {t === 'facebook' ? 'Facebook' : 'Instagram'}: {r.id ? (r.sandbox ? 'publicado (prueba)' : 'publicado') : 'procesando'}
              {r.url && <a href={r.url} target="_blank" rel="noreferrer" className="ml-1 inline-flex"><ExternalLink size={10} /></a>}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/** Para que plataforma/empresa con el panel elijan el estado visible. */
export const SOCIAL_STATUS_LABELS: Record<string, string> = {
  PUBLICANDO: 'Publicando',
  ERROR: 'Error al publicar',
};

