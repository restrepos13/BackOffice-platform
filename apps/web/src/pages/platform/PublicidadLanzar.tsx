import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, ImageUp, Link2, MessageCircle, MousePointerClick } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, uploadFile } from '../../lib/api';
import { fmtDateTime, fmtMoney } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, Select, Switch, Textarea } from '../../components/ui';

/**
 * Lanzar campañas de BackOffice en Meta (solo equipo). El servidor valida,
 * arma lo que va a Meta y lo crea todo en PAUSA; activar es un paso aparte
 * con confirmación. Aquí no se calcula nada que decida dinero.
 */

type Goal = 'SIGNUPS' | 'WHATSAPP';

export interface AdsSetup {
  connected: boolean;
  account: { id: string; name: string; currency: string; timezone: string | null; status: number } | null;
  prefs: { pageId?: string; pageName?: string; instagramUserId?: string; maxDailyBudget?: number };
  pages: Array<{ id: string; name: string; instagramUserId: string | null }>;
  pagesError: string | null;
  landingBase: string;
}

export interface LaunchRow {
  id: string;
  createdAt: string;
  createdBy: string;
  status: 'CREATING' | 'FAILED' | 'PAUSED' | 'ACTIVE' | 'ARCHIVED';
  processing: boolean;
  goalLabel: string;
  accountId: string;
  currency: string;
  utmCampaign: string;
  link: string | null;
  ids: { campaign?: string; adset?: string; creative?: string; ad?: string };
  error: string | null;
  draft: { name: string; goal: Goal; dailyBudget: number; startDate?: string; endDate?: string; countries: string[]; headline: string };
  history: Array<{ at: string; by: string; event: string; detail?: string }>;
}

interface Preview {
  valid: boolean;
  errors: string[];
  account: { id: string; name: string; currency: string };
  summary: { goal: string; utmCampaign: string; link: string | null; dailyBudget: number; maxDailyBudget: number; pageId: string; status: string } | null;
}

const CTAS: Record<string, string> = { SIGN_UP: 'Registrarte', LEARN_MORE: 'Más información', GET_QUOTE: 'Pedir cotización', CONTACT_US: 'Contáctanos' };
const LIMITS = { primaryText: 600, headline: 100, description: 120 };

const STATUS: Record<LaunchRow['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' }> = {
  CREATING: { label: 'Creando', tone: 'info' },
  FAILED: { label: 'Falló', tone: 'bad' },
  PAUSED: { label: 'En pausa', tone: 'neutral' },
  ACTIVE: { label: 'Activa', tone: 'ok' },
  ARCHIVED: { label: 'Archivada', tone: 'neutral' },
};

const errorList = (e: unknown) => (e instanceof ApiError && e.errors?.length ? e.errors : [e instanceof Error ? e.message : 'Error']);

function emptyDraft() {
  return {
    name: '', goal: 'SIGNUPS' as Goal, dailyBudget: '', startDate: '', endDate: '', countries: 'CO',
    advantageAudience: true, ageMin: '18', ageMax: '65', gender: 'ALL',
    primaryText: '', headline: '', description: '', cta: 'SIGN_UP', imageHash: '',
  };
}
type Draft = ReturnType<typeof emptyDraft>;

/* ─── Asistente ───────────────────────────────────────────────────── */

export function LaunchWizard({ setup, onCreated }: { setup: AdsSetup; onCreated: () => void }) {
  const [d, setD] = useState<Draft>(emptyDraft);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [image, setImage] = useState<{ url: string; name: string } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const currency = setup.account?.currency ?? 'COP';
  const set = (patch: Partial<Draft>) => { setD((x) => ({ ...x, ...patch })); setPreview(null); };
  useEffect(() => () => { if (image) URL.revokeObjectURL(image.url); }, [image]);

  const body = useMemo(() => ({
    ...d,
    countries: d.countries.split(',').map((c) => c.trim()).filter(Boolean),
    ageMin: Number(d.ageMin), ageMax: Number(d.ageMax),
  }), [d]);

  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<{ hash: string }>('/platform/ads/images', 'file', file),
    onSuccess: (r) => { set({ imageHash: r.hash }); toast.success('Imagen subida a la cuenta publicitaria'); },
    onError: (e) => { setImage(null); toast.error(e instanceof Error ? e.message : 'No se pudo subir'); },
  });
  const review = useMutation({
    mutationFn: () => api.post<Preview>('/platform/ads/launches/preview', { draft: body }),
    onSuccess: (r) => { setPreview(r); setErrors(r.errors); },
    onError: (e) => setErrors(errorList(e)),
  });
  const create = useMutation({
    mutationFn: () => api.post<LaunchRow>('/platform/ads/launches', { draft: body, confirm: true }),
    onSuccess: (r) => {
      setConfirmOpen(false);
      if (r.status === 'FAILED') toast.error(`Meta rechazó un paso: ${r.error ?? ''}. Quedó en Lanzamientos para reintentar.`);
      else toast.success('Campaña creada en Meta, en pausa');
      setD(emptyDraft()); setImage(null); setPreview(null); setErrors([]);
      onCreated();
    },
    onError: (e) => { setConfirmOpen(false); setErrors(errorList(e)); },
  });

  const pick = (file?: File) => {
    if (!file) return;
    if (!/^image\/(jpeg|png)$/.test(file.type)) return toast.error('Usa una imagen JPG o PNG');
    if (file.size > 8 * 1024 * 1024) return toast.error('La imagen pesa más de 8 MB');
    setImage({ url: URL.createObjectURL(file), name: file.name });
    set({ imageHash: '' });
    upload.mutate(file);
  };

  const cap = setup.prefs.maxDailyBudget;
  const budget = Number(String(d.dailyBudget).replace(/[^\d]/g, '')) || 0;
  const days = d.endDate ? Math.max(0, Math.round((Date.parse(d.endDate) - Date.parse(d.startDate || new Date().toISOString().slice(0, 10))) / 86400e3) + 1) : null;
  const pageName = setup.prefs.pageName || 'BackOffice';

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <Card kicker="Paso 1" title="Objetivo">
          <div className="grid gap-3 sm:grid-cols-2">
            {([
              ['SIGNUPS', 'Registros en la web', 'Lleva a /registro con el enlace de seguimiento. Cada registro y empresa queda cruzado con la campaña.', MousePointerClick],
              ['WHATSAPP', 'Conversaciones por WhatsApp', 'Abre un chat con nuestro WhatsApp. La página debe estar vinculada al número en el Business Manager.', MessageCircle],
            ] as const).map(([id, label, hint, Icon]) => (
              <button
                key={id}
                type="button"
                aria-pressed={d.goal === id}
                onClick={() => set({ goal: id })}
                className={clsx('cursor-pointer border-2 p-4 text-left transition-colors', d.goal === id ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink')}
              >
                <Icon size={18} />
                <p className="mt-2 text-sm font-semibold">{label}</p>
                <p className={clsx('mt-1 text-xs', d.goal === id ? 'text-bone/75' : 'text-ink-3')}>{hint}</p>
              </button>
            ))}
          </div>
          <div className="mt-4">
            <Field label="Nombre de la campaña" required hint="También arma el utm_campaign del enlace, así los registros se cruzan solos">
              <Input value={d.name} maxLength={120} placeholder="CRM WhatsApp · Noviembre" onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card kicker="Paso 2" title="Presupuesto y fechas">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={`Presupuesto diario (${currency})`} required hint={cap ? `Tope: ${fmtMoney(cap, currency)} al día` : 'Define el tope en Configuración'}>
              <Input inputMode="decimal" value={d.dailyBudget} placeholder="30.000" onChange={(e) => set({ dailyBudget: e.target.value })} />
            </Field>
            <Field label="Inicio" hint="Vacío: arranca al activarla">
              <Input type="date" value={d.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </Field>
            <Field label="Fin" hint="Opcional">
              <Input type="date" value={d.endDate} min={d.startDate || undefined} onChange={(e) => set({ endDate: e.target.value })} />
            </Field>
          </div>
          {cap != null && budget > cap && <p className="mt-2 text-xs font-semibold text-bad">Supera el tope diario: no se podrá crear.</p>}
          {days != null && budget > 0 && currency === 'COP' && (
            <p className="mt-2 text-xs text-ink-3">Máximo en {days} días: <b className="text-ink">{fmtMoney(budget * days, currency)}</b> (un día puntual Meta puede gastar hasta un 75 % más, sin pasar 7 veces el diario en la semana).</p>
          )}
        </Card>

        <Card kicker="Paso 3" title="Público">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Field label="Países" hint="Códigos de 2 letras separados por coma (CO, MX, PE…)">
              <Input value={d.countries} onChange={(e) => set({ countries: e.target.value.toUpperCase() })} />
            </Field>
            <div className="pb-2">
              <Switch showLabel checked={d.advantageAudience} onChange={(v) => set({ advantageAudience: v, ageMin: v ? String(Math.min(Number(d.ageMin) || 18, 25)) : d.ageMin })} label="Público Advantage+ (Meta lo amplía)" />
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Edad mínima" hint={d.advantageAudience ? 'Con Advantage+: de 18 a 25' : undefined}>
              <Input type="number" min={18} max={d.advantageAudience ? 25 : 65} value={d.ageMin} onChange={(e) => set({ ageMin: e.target.value })} />
            </Field>
            {!d.advantageAudience && (
              <>
                <Field label="Edad máxima">
                  <Input type="number" min={18} max={65} value={d.ageMax} onChange={(e) => set({ ageMax: e.target.value })} />
                </Field>
                <Field label="Género">
                  <Select value={d.gender} onChange={(e) => set({ gender: e.target.value })}>
                    <option value="ALL">Todos</option>
                    <option value="FEMALE">Mujeres</option>
                    <option value="MALE">Hombres</option>
                  </Select>
                </Field>
              </>
            )}
          </div>
        </Card>

        <Card kicker="Paso 4" title="Anuncio">
          <div className="grid gap-3">
            <div>
              <span className="kicker mb-1 block">Imagen <span className="text-bad">*</span></span>
              <label className="flex cursor-pointer items-center gap-3 border-2 border-dashed border-ink bg-bone px-4 py-3 text-sm hover:bg-paper">
                <ImageUp size={16} />
                <span className="min-w-0 flex-1 truncate">
                  {upload.isPending ? 'Subiendo a Meta…' : image ? image.name : 'JPG o PNG, hasta 8 MB (1080×1080 o 1080×1350 recomendado)'}
                </span>
                {d.imageHash && <Badge tone="ok">Lista</Badge>}
                <input type="file" accept="image/jpeg,image/png" className="sr-only" aria-label="Imagen del anuncio" onChange={(e) => pick(e.target.files?.[0])} />
              </label>
            </div>
            <Field label="Texto principal" required hint={`${d.primaryText.length}/${LIMITS.primaryText}`}>
              <Textarea rows={4} maxLength={LIMITS.primaryText} value={d.primaryText} placeholder="Tus chats de WhatsApp, pedidos y clientes en un solo lugar." onChange={(e) => set({ primaryText: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Título" required hint={`${d.headline.length}/${LIMITS.headline}`}>
                <Input maxLength={LIMITS.headline} value={d.headline} placeholder="Prueba BackOffice" onChange={(e) => set({ headline: e.target.value })} />
              </Field>
              {d.goal === 'SIGNUPS' ? (
                <Field label="Botón">
                  <Select value={d.cta} onChange={(e) => set({ cta: e.target.value })}>
                    {Object.entries(CTAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
              ) : (
                <Field label="Botón"><Input value="Enviar mensaje de WhatsApp" disabled /></Field>
              )}
            </div>
            <Field label="Descripción" hint="Opcional · aparece bajo el título en algunas ubicaciones">
              <Input maxLength={LIMITS.description} value={d.description} onChange={(e) => set({ description: e.target.value })} />
            </Field>
          </div>
        </Card>

        {errors.length > 0 && (
          <div role="alert" className="border-2 border-bad bg-bad-soft px-4 py-3 text-sm text-bad">
            <p className="font-semibold">Revisa antes de crear:</p>
            <ul className="mt-1 list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}

        {preview?.valid && preview.summary && (
          <Card kicker="Revisión" title="Esto se creará en Meta">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div><dt className="kicker">Cuenta</dt><dd>{preview.account.name} · {preview.account.id}</dd></div>
              <div><dt className="kicker">Objetivo</dt><dd>{preview.summary.goal}</dd></div>
              <div><dt className="kicker">Presupuesto</dt><dd>{fmtMoney(preview.summary.dailyBudget, preview.account.currency)} al día (tope {fmtMoney(preview.summary.maxDailyBudget, preview.account.currency)})</dd></div>
              <div><dt className="kicker">Estructura</dt><dd>1 campaña · 1 conjunto · 1 anuncio</dd></div>
              {preview.summary.link && <div className="sm:col-span-2"><dt className="kicker">Destino</dt><dd className="break-all font-mono text-xs">{preview.summary.link}</dd></div>}
            </dl>
            <p className="mt-3 border-l-4 border-ink pl-3 text-xs text-ink-2">Todo se crea <b>en pausa</b>: no gasta nada hasta que lo actives en Lanzamientos. Meta revisa el anuncio antes de publicarlo.</p>
          </Card>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" disabled={review.isPending || upload.isPending} onClick={() => review.mutate()}>{review.isPending ? 'Revisando…' : 'Revisar'}</Button>
          <Button disabled={!preview?.valid || create.isPending} onClick={() => setConfirmOpen(true)}>Crear en Meta (en pausa)</Button>
        </div>
      </div>

      <aside className="xl:sticky xl:top-4 xl:self-start">
        <p className="kicker mb-2">Vista aproximada</p>
        <div className="border-2 border-ink bg-paper text-sm" data-testid="ad-preview">
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="grid h-8 w-8 place-items-center bg-ink text-xs font-bold text-bone">{pageName.slice(0, 1).toUpperCase()}</span>
            <span><b>{pageName}</b><span className="block text-[11px] text-ink-3">Publicidad</span></span>
          </div>
          <p className="whitespace-pre-line px-3 pb-2">{d.primaryText || <span className="text-ink-3">Texto principal…</span>}</p>
          <div className="aspect-square bg-bone-2">{image && <img src={image.url} alt="" className="h-full w-full object-cover" />}</div>
          <div className="flex items-center justify-between gap-2 bg-bone px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[11px] uppercase text-ink-3">{d.goal === 'WHATSAPP' ? 'WhatsApp' : setup.landingBase.replace(/^https?:\/\//, '')}</span>
              <b className="block truncate">{d.headline || 'Título'}</b>
            </span>
            <span className="shrink-0 border border-ink px-2 py-1 text-[11px] font-semibold">{d.goal === 'WHATSAPP' ? 'Enviar mensaje' : CTAS[d.cta]}</span>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">Referencia: Meta ajusta el formato según la ubicación (Feed, Stories, Reels).</p>
      </aside>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} kicker="Meta Ads" title="¿Crear la campaña en Meta?">
        <div className="space-y-4 text-sm">
          <p>Se crearán la campaña, el conjunto y el anuncio <b>en pausa</b> en la cuenta {setup.account?.name}. No se gasta nada hasta activarla.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>Cancelar</Button>
            <Button disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creando en Meta…' : 'Sí, crear en pausa'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ─── Lanzamientos ────────────────────────────────────────────────── */

export function LaunchList({ setup }: { setup: AdsSetup }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['ads', 'launches'], queryFn: () => api.get<LaunchRow[]>('/platform/ads/launches') });
  const [activate, setActivate] = useState<LaunchRow | null>(null);
  const [budget, setBudget] = useState<{ row: LaunchRow; value: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ads'] });
  const onError = (e: unknown) => toast.error(errorList(e).join(' · '));
  const after = (ok: string) => (r: LaunchRow) => {
    if (r.error) toast.error(`Meta: ${r.error}`);
    else toast.success(ok);
    refresh();
  };

  const act = useMutation({ mutationFn: (id: string) => api.post<LaunchRow>(`/platform/ads/launches/${id}/activate`, { confirm: true }), onSuccess: (r) => { setActivate(null); after('Campaña activada en Meta')(r); }, onError });
  const pause = useMutation({ mutationFn: (id: string) => api.post<LaunchRow>(`/platform/ads/launches/${id}/pause`), onSuccess: after('Campaña pausada'), onError });
  const retry = useMutation({ mutationFn: (id: string) => api.post<LaunchRow>(`/platform/ads/launches/${id}/retry`), onSuccess: after('Creada en Meta, en pausa'), onError });
  const archive = useMutation({ mutationFn: (id: string) => api.delete<LaunchRow>(`/platform/ads/launches/${id}`), onSuccess: () => { toast.success('Archivado'); refresh(); }, onError });
  const saveBudget = useMutation({
    mutationFn: (b: { id: string; value: string }) => api.put<LaunchRow>(`/platform/ads/launches/${b.id}/budget`, { dailyBudget: b.value, confirm: true }),
    onSuccess: (r) => { setBudget(null); after('Presupuesto actualizado')(r); },
    onError,
  });

  if (isLoading || !data) return <Loading />;
  if (!data.length) return <EmptyState title="Aún no hay lanzamientos" hint="Crea el primero en «Lanzar campaña». Todo se crea en pausa." />;
  const busy = act.isPending || pause.isPending || retry.isPending || archive.isPending;

  return (
    <div className="space-y-3">
      {data.map((l) => (
        <div key={l.id} className="border-2 border-ink bg-paper p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 font-semibold">
                {l.draft.name}
                <Badge tone={STATUS[l.status].tone}>{l.processing ? 'Procesando…' : STATUS[l.status].label}</Badge>
              </p>
              <p className="mt-1 text-xs text-ink-3">
                {l.goalLabel} · {fmtMoney(l.draft.dailyBudget, l.currency)} al día · {l.draft.countries.join(', ')}
                {l.draft.endDate ? ` · hasta ${l.draft.endDate}` : ''} · por {l.createdBy}, {fmtDateTime(l.createdAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {l.status === 'FAILED' && <Button size="sm" disabled={busy || l.processing} onClick={() => retry.mutate(l.id)}>Reintentar</Button>}
              {l.status === 'PAUSED' && l.ids.ad && <Button size="sm" disabled={busy || l.processing} onClick={() => setActivate(l)}>Activar</Button>}
              {l.status === 'ACTIVE' && <Button size="sm" variant="outline" disabled={busy || l.processing} onClick={() => pause.mutate(l.id)}>Pausar</Button>}
              {(l.status === 'ACTIVE' || l.status === 'PAUSED') && l.ids.adset && (
                <Button size="sm" variant="ghost" disabled={busy || l.processing} onClick={() => setBudget({ row: l, value: String(l.draft.dailyBudget) })}>Presupuesto</Button>
              )}
              {l.status !== 'ACTIVE' && (
                <Button size="sm" variant="ghost" disabled={busy || l.processing} onClick={() => { if (confirm('¿Archivar? Solo se quita de esta lista; en Meta no se borra nada.')) archive.mutate(l.id); }}>Archivar</Button>
              )}
            </div>
          </div>

          {l.error && <p className="mt-3 border-l-4 border-bad pl-3 text-xs text-bad">{l.error}</p>}
          {l.status === 'FAILED' && (
            <p className="mt-2 text-xs text-ink-3">Creado: {(['campaign', 'adset', 'creative', 'ad'] as const).filter((s) => l.ids[s]).length} de 4 pasos. El reintento continúa desde el que falló, sin duplicar.</p>
          )}

          {l.link && (
            <div className="mt-3 flex items-center gap-2 border-2 border-line bg-bone px-3 py-1.5 text-xs">
              <Link2 size={12} className="shrink-0" />
              <span className="truncate font-mono">{l.link}</span>
              <button type="button" aria-label="Copiar enlace" className="cursor-pointer text-ink-3 hover:text-ink" onClick={() => navigator.clipboard?.writeText(l.link!).then(() => toast.success('Enlace copiado'))}><Copy size={12} /></button>
            </div>
          )}

          <button type="button" className="mt-2 cursor-pointer text-xs font-semibold text-ink-2 underline-offset-2 hover:underline" aria-expanded={open === l.id} onClick={() => setOpen(open === l.id ? null : l.id)}>
            {open === l.id ? 'Ocultar historial' : 'Historial e IDs de Meta'}
          </button>
          {open === l.id && (
            <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
              <ul className="space-y-1">
                {l.history.slice().reverse().map((h, i) => (
                  <li key={i}><span className="text-ink-3">{fmtDateTime(h.at)} · {h.by}</span> — {h.event}{h.detail ? `: ${h.detail}` : ''}</li>
                ))}
              </ul>
              <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-1 font-mono">
                {(['campaign', 'adset', 'creative', 'ad'] as const).map((s) => (
                  <div key={s} className="contents"><dt className="text-ink-3">{s}</dt><dd className="truncate">{l.ids[s] ?? '—'}</dd></div>
                ))}
              </dl>
            </div>
          )}
        </div>
      ))}

      <Modal open={!!activate} onClose={() => setActivate(null)} kicker="Gasta presupuesto" title="¿Activar la campaña?">
        {activate && (
          <div className="space-y-4 text-sm">
            <p>
              <b>{activate.draft.name}</b> empezará a gastar hasta <b>{fmtMoney(activate.draft.dailyBudget, activate.currency)} al día</b>
              {activate.draft.endDate ? ` hasta el ${activate.draft.endDate}` : ' sin fecha de fin'}, apenas Meta apruebe el anuncio.
            </p>
            <p className="text-xs text-ink-3">Se activan el anuncio, el conjunto y por último la campaña. Puedes pausarla en cualquier momento.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActivate(null)}>Cancelar</Button>
              <Button disabled={act.isPending} onClick={() => act.mutate(activate.id)}>{act.isPending ? 'Activando…' : 'Sí, activar'}</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!budget} onClose={() => setBudget(null)} kicker={budget?.row.draft.name} title="Presupuesto diario">
        {budget && (
          <div className="space-y-4 text-sm">
            <Field label={`Nuevo presupuesto (${budget.row.currency})`} hint={setup.prefs.maxDailyBudget ? `Tope: ${fmtMoney(setup.prefs.maxDailyBudget, budget.row.currency)} · actual: ${fmtMoney(budget.row.draft.dailyBudget, budget.row.currency)}` : undefined}>
              <Input inputMode="decimal" value={budget.value} onChange={(e) => setBudget({ ...budget, value: e.target.value })} />
            </Field>
            <p className="text-xs text-ink-3">Cambiar el presupuesto puede reiniciar el aprendizaje de Meta. Mejor cambios graduales.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setBudget(null)}>Cancelar</Button>
              <Button disabled={saveBudget.isPending || !budget.value} onClick={() => saveBudget.mutate({ id: budget.row.id, value: budget.value })}>Guardar en Meta</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ─── Configuración ───────────────────────────────────────────────── */

export function LaunchSetup({ setup }: { setup: AdsSetup }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    pageId: setup.prefs.pageId ?? '',
    pageName: setup.prefs.pageName ?? '',
    instagramUserId: setup.prefs.instagramUserId ?? '',
    maxDailyBudget: setup.prefs.maxDailyBudget ? String(setup.prefs.maxDailyBudget) : '',
  });
  const save = useMutation({
    mutationFn: () => api.put('/platform/ads/setup', form),
    onSuccess: () => { toast.success('Configuración guardada'); queryClient.invalidateQueries({ queryKey: ['ads'] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const currency = setup.account?.currency ?? 'COP';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card kicker="Para lanzar" title="Página y tope de gasto">
        <div className="grid gap-4">
          {setup.pages.length > 0 ? (
            <Field label="Página de Facebook que publica" required>
              <Select
                value={form.pageId}
                onChange={(e) => {
                  const p = setup.pages.find((x) => x.id === e.target.value);
                  setForm({ ...form, pageId: e.target.value, pageName: p?.name ?? '', instagramUserId: p?.instagramUserId ?? '' });
                }}
              >
                <option value="">Elige una página</option>
                {setup.pages.map((p) => <option key={p.id} value={p.id}>{p.name}{p.instagramUserId ? ' · con Instagram' : ''}</option>)}
              </Select>
            </Field>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="ID de la página de Facebook" required><Input inputMode="numeric" value={form.pageId} onChange={(e) => setForm({ ...form, pageId: e.target.value.trim() })} /></Field>
              <Field label="Nombre de la página"><Input value={form.pageName} onChange={(e) => setForm({ ...form, pageName: e.target.value })} /></Field>
            </div>
          )}
          {setup.pagesError && <p className="text-xs text-warn">{setup.pagesError}</p>}
          <Field label="ID de la cuenta de Instagram" hint="Opcional. Sin ella el anuncio sale en Instagram con la identidad de la página.">
            <Input inputMode="numeric" value={form.instagramUserId} onChange={(e) => setForm({ ...form, instagramUserId: e.target.value.trim() })} />
          </Field>
          <Field label={`Tope de presupuesto diario por campaña (${currency})`} required hint="Ningún lanzamiento, activación ni cambio de presupuesto puede pasarlo">
            <Input inputMode="decimal" value={form.maxDailyBudget} placeholder="100.000" onChange={(e) => setForm({ ...form, maxDailyBudget: e.target.value })} />
          </Field>
          <div className="flex justify-end">
            <Button disabled={save.isPending || !form.maxDailyBudget} onClick={() => save.mutate()}>Guardar</Button>
          </div>
        </div>
      </Card>
      <Card kicker="Requisitos en Meta" title="Antes del primer lanzamiento">
        <ul className="list-disc space-y-2 pl-4 text-xs text-ink-2">
          <li>El token de la cuenta conectada necesita <b>ads_management</b> (crear y activar), no solo ads_read.</li>
          <li>El usuario del sistema debe tener la <b>página asignada</b> con permiso para crear anuncios.</li>
          <li>Para WhatsApp, la página debe estar <b>vinculada al número de WhatsApp Business</b>.</li>
          <li>Los registros llegan a <span className="break-all font-mono">{setup.landingBase}/registro</span>. Se cambia con PUBLIC_WEB_URL en Dev Tools.</li>
        </ul>
      </Card>
    </div>
  );
}
