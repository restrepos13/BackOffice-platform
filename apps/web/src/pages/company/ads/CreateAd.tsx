import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, uploadFile } from '../../../lib/api';
import { authedBlobUrl } from '../../../lib/creative';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, Select, Switch, Textarea } from '../../../components/ui';
import { useCompanyScope, withScope } from '../shared';
import type { AccountAccess } from './MetaConnectGuide';

/**
 * Crear un anuncio completo de la mano de la plataforma: cuenta y página,
 * objetivo, público y presupuesto, fechas, imagen y texto con revisión
 * (código siempre; IA si la empresa tiene su proveedor), y creación en Meta
 * en PAUSA. Activar es otra decisión, con confirmación.
 */

type Goal = 'WHATSAPP' | 'WEBSITE';
interface Hints { costPerResult: number | null; expected: { low: number; high: number } | null; bestDays: string[]; basis: string }
interface Setup {
  accounts: Array<{ id: string; name: string; externalId: string; currency: string; access: AccountAccess }>;
  account: { id: string; name: string; externalId: string; currency: string; timezone: string | null; access: AccountAccess } | null;
  pages: Array<{ id: string; name: string; instagramUserId: string | null }>;
  pagesError: string | null;
  goals: Array<{ key: Goal; label: string; resultLabel: string }>;
  ctas: Array<{ key: string; label: string }>;
  maxDailyBudget: number | null;
  ai: { available: boolean; provider: string; model: string; note: string };
  today: string;
  hints: Record<Goal, Hints> | null;
}
interface CheckItem { key: string; level: 'OK' | 'WARN' | 'BAD'; area: string; title: string; detail: string; fix?: string }
interface Review {
  code: { score: number; items: CheckItem[]; facts: { width: number; height: number } | null };
  ai: { status: 'OK'; model: string; review: { summary: string; score: number | null; strengths: string[]; improvements: Array<{ area: string; problem: string; suggestion: string; priority: string }>; suggestedCopy: { primaryText: string | null; headline: string | null }; policyRisk: { level: string; reason: string | null }; seen: string | null } }
    | { status: 'NO_KEY' | 'UNAVAILABLE' | 'ERROR'; message: string };
}
export interface Launch {
  id: string; status: 'CREATING' | 'PAUSED' | 'ACTIVE' | 'FAILED'; goalLabel: string; error: string | null; link: string | null;
  draft: { name: string; dailyBudget: number; startDate?: string; endDate?: string }; ids: Record<string, string>;
  createdBy: string; createdAt: string; reviewScore: number | null; reviewedWithAi: boolean; processing: boolean;
}

const fmt = (v: number | null | undefined, currency = 'COP') =>
  v === null || v === undefined ? '—' : currency === 'COP' ? `$${Math.round(v).toLocaleString('es-CO')}` : `${v.toLocaleString('es-CO', { maximumFractionDigits: 2 })} ${currency}`;
const amount = (s: string) => Number(String(s).replace(/[^\d]/g, '')) || 0;

const STEPS = ['Cuenta y página', 'Objetivo', 'Público y presupuesto', 'Fechas', 'Imagen y texto', 'Revisar y crear'];
const STATUS: Record<Launch['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  CREATING: { label: 'Creando…', tone: 'info' }, PAUSED: { label: 'En pausa', tone: 'neutral' }, ACTIVE: { label: 'Activo', tone: 'ok' }, FAILED: { label: 'Falló', tone: 'bad' },
};
const LEVEL: Record<CheckItem['level'], { tone: 'ok' | 'warn' | 'bad'; label: string }> = { OK: { tone: 'ok', label: 'Bien' }, WARN: { tone: 'warn', label: 'Mejorable' }, BAD: { tone: 'bad', label: 'Corregir' } };

export function CreateAd({ q }: { q: string }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const [accountId, setAccountId] = useState('');
  const setup = useQuery({ queryKey: ['ads-create-setup', q, accountId], queryFn: () => api.get<Setup>(withScope(`/ads/create/setup${accountId ? `?accountId=${accountId}` : ''}`, q)) });
  const launches = useQuery({ queryKey: ['ads-launches', q], queryFn: () => api.get<Launch[]>(withScope('/ads/create/launches', q)) });
  const [step, setStep] = useState(0);
  const [f, setF] = useState({
    name: '', goal: 'WHATSAPP' as Goal, websiteUrl: '', cta: 'ORDER_NOW', countries: 'CO', advantageAudience: true, ageMin: '18', ageMax: '65', gender: 'ALL',
    dailyBudget: '', startDate: '', endDate: '', primaryText: '', headline: '', description: '', pageId: '', instagramUserId: '',
  });
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const [asset, setAsset] = useState<{ id: string; name: string; width: number | null; height: number | null } | null>(null);
  // Imagen que llega desde Creative (?asset=…&design=…): se valida en el servidor al crear
  const [params] = useSearchParams();
  const fromAsset = params.get('asset');
  const [designId, setDesignId] = useState<string | null>(params.get('design'));
  const incoming = useQuery({
    queryKey: ['library-asset', fromAsset, q],
    queryFn: () => api.get<{ id: string; name: string; width: number | null; height: number | null; available: boolean; designId: string | null; kind: string }>(withScope(`/library/assets/${fromAsset}`, q)),
    enabled: !!fromAsset, retry: false,
  });
  useEffect(() => {
    const a = incoming.data;
    if (!a) return;
    if (!a.available) { toast.error('La imagen de Creative ya no está disponible: vuelve a usarla desde el editor.'); return; }
    setAsset({ id: a.id, name: a.name, width: a.width, height: a.height });
    if (a.designId && a.designId !== designId) setDesignId(a.designId);
  }, [incoming.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [preview, setPreview] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [cap, setCap] = useState('');
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [activate, setActivate] = useState<Launch | null>(null);
  const s = setup.data;
  const currency = s?.account?.currency ?? 'COP';

  // Página por defecto: la primera que ve la conexión
  useEffect(() => {
    if (s?.pages.length && !f.pageId) set({ pageId: s.pages[0].id, instagramUserId: s.pages[0].instagramUserId ?? '' });
  }, [s?.pages]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!asset) return setPreview(null);
    let alive = true;
    authedBlobUrl(`/api${withScope(`/library/assets/${asset.id}/file`, q)}`).then((u) => alive && setPreview(u));
    return () => { alive = false; };
  }, [asset, q]);

  const draft = useMemo(() => ({
    name: f.name, goal: f.goal, websiteUrl: f.websiteUrl, cta: f.goal === 'WHATSAPP' ? 'WHATSAPP_MESSAGE' : f.cta,
    countries: f.countries.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean), advantageAudience: f.advantageAudience,
    ageMin: Number(f.ageMin), ageMax: Number(f.ageMax), gender: f.gender, dailyBudget: f.dailyBudget,
    startDate: f.startDate || undefined, endDate: f.endDate || undefined, primaryText: f.primaryText, headline: f.headline, description: f.description || undefined,
  }), [f]);
  const body = { accountId: s?.account?.id, pageId: f.pageId, instagramUserId: f.instagramUserId || undefined, assetId: asset?.id, designId: designId ?? undefined, draft };

  const err = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');
  const refresh = () => { queryClient.invalidateQueries({ queryKey: ['ads-launches'] }); queryClient.invalidateQueries({ queryKey: ['ads-week'] }); };
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<{ asset: { id: string; name: string; width: number | null; height: number | null } }>(withScope('/library/assets', q), 'file', file, { name: file.name.replace(/\.[^.]+$/, ''), kind: 'IMAGE', module: 'ADS' }),
    onSuccess: (r) => { setAsset(r.asset); setDesignId(null); setReview(null); toast.success('Imagen guardada en tu biblioteca'); },
    onError: err,
  });
  const doReview = useMutation({ mutationFn: () => api.post<Review>(withScope('/ads/create/review', q), body), onSuccess: setReview, onError: err });
  const doPreview = useMutation({ mutationFn: () => api.post<{ valid: boolean; errors: string[]; summary: any; hints: Hints }>(withScope('/ads/create/preview', q), body), onError: err });
  const saveCap = useMutation({ mutationFn: () => api.put(withScope('/ads/create/budget-cap', q), { maxDailyBudget: cap }), onSuccess: () => { setup.refetch(); toast.success('Tope diario guardado'); }, onError: err });
  const create = useMutation({
    mutationFn: () => api.post<Launch>(withScope('/ads/create/launches', q), { ...body, review, confirm: true }),
    onSuccess: (l) => {
      setConfirmCreate(false);
      refresh();
      if (l.status === 'FAILED') toast.error(`No se completó en Meta: ${l.error ?? ''}. Puedes reintentar: sigue donde quedó.`);
      else { toast.success('Anuncio creado en Meta, en pausa. Actívalo cuando quieras.'); setStep(0); setAsset(null); setReview(null); set({ name: '', primaryText: '', headline: '', description: '' }); }
    },
    onError: (e) => { setConfirmCreate(false); err(e); },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'activate' | 'pause' | 'retry' | 'archive' }) =>
      action === 'archive' ? api.delete(withScope(`/ads/create/launches/${id}`, q)) : api.post(withScope(`/ads/create/launches/${id}/${action}`, q), action === 'activate' ? { confirm: true } : undefined),
    onSuccess: (_r, v) => { setActivate(null); refresh(); toast.success({ activate: 'Anuncio activado', pause: 'Anuncio en pausa', retry: 'Reintento hecho', archive: 'Quitado de la lista (en Meta no se borró nada)' }[v.action]); },
    onError: (e) => { setActivate(null); refresh(); err(e); },
  });

  if (setup.isLoading || !s) return <Loading />;
  if (!s.account) {
    return <EmptyState title="Primero conecta tu cuenta publicitaria" hint="Para crear anuncios, BackOffice necesita acceso a tu cuenta de Meta con permisos completos." action={<Link to="/app/ads?tab=cuentas" className="underline">Ir a Cuentas publicitarias</Link>} />;
  }
  const access = s.account.access;
  const canManage = !access.verified || access.manage;
  const hints = s.hints?.[f.goal];
  const goal = s.goals.find((g) => g.key === f.goal);
  const budget = amount(f.dailyBudget);
  const expected = hints?.costPerResult && budget ? { low: Math.floor((budget / hints.costPerResult) * 0.7), high: Math.ceil((budget / hints.costPerResult) * 1.3) } : null;

  return (
    <div className="space-y-6">
      <LaunchList launches={launches.data ?? []} currency={currency} canWrite={canWrite} onAction={(id, action) => (action === 'activate' ? setActivate((launches.data ?? []).find((l) => l.id === id) ?? null) : act.mutate({ id, action }))} busy={act.isPending} />

      <Card kicker="De la mano de BackOffice" title="Crear un anuncio">
        {designId && asset && (
          <p className="mb-4 border-2 border-info bg-paper px-3 py-2 text-sm" data-testid="from-creative">
            Imagen de Creative: <b>{asset.name}</b>. Ya está cargada en el paso 5; completa cuenta, objetivo, público, presupuesto y fechas.
          </p>
        )}
        {fromAsset && incoming.error && <p className="mb-4 text-sm text-bad">No pudimos cargar la imagen de Creative: {incoming.error instanceof Error ? incoming.error.message : 'no disponible'}.</p>}
        {!canManage && (
          <p className="mb-4 border-2 border-bad bg-paper px-3 py-2 text-sm" role="alert">
            Tu conexión con Meta no tiene permiso para crear anuncios. <Link to="/app/ads?tab=cuentas" className="underline">Vuelve a conectarla con permisos completos</Link>.
          </p>
        )}
        <ol className="mb-5 flex flex-wrap gap-2 text-xs" aria-label="Pasos">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button type="button" onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}
                className={clsx('cursor-pointer border-2 px-2.5 py-1 font-semibold', i === step ? 'border-ink bg-ink text-bone' : i < step ? 'border-ink' : 'border-line text-ink-3')}>
                {i + 1}. {label}
              </button>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {s.accounts.length > 1 && (
              <Field label="Cuenta publicitaria">
                <Select value={s.account.id} onChange={(e) => setAccountId(e.target.value)}>
                  {s.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.externalId}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Página de Facebook que publica el anuncio" hint={s.pagesError ?? 'Si tu página tiene Instagram conectado, el anuncio también sale ahí.'}>
              {s.pages.length ? (
                <Select value={f.pageId} onChange={(e) => { const p = s.pages.find((x) => x.id === e.target.value); set({ pageId: e.target.value, instagramUserId: p?.instagramUserId ?? '' }); }}>
                  {s.pages.map((p) => <option key={p.id} value={p.id}>{p.name}{p.instagramUserId ? ' · con Instagram' : ''}</option>)}
                </Select>
              ) : <Input placeholder="ID de la página (solo números)" value={f.pageId} onChange={(e) => set({ pageId: e.target.value.replace(/\D/g, '') })} />}
            </Field>
            <Field label="Nombre de la campaña" hint="Solo lo ves tú; ayuda a encontrarla en Meta y en los reportes.">
              <Input value={f.name} maxLength={120} placeholder="Ej.: 2x1 martes de hamburguesas" onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              {s.goals.map((g) => (
                <button key={g.key} type="button" onClick={() => set({ goal: g.key })} aria-pressed={f.goal === g.key}
                  className={clsx('cursor-pointer border-2 p-4 text-left', f.goal === g.key ? 'border-ink bg-bone-2' : 'border-line')}>
                  <b className="block">{g.label}</b>
                  <span className="text-sm text-ink-2">{g.key === 'WHATSAPP' ? 'La gente toca el anuncio y te escribe. Tu página debe estar vinculada a tu número de WhatsApp Business.' : 'Lleva a tu página de reservas o pedidos. Agregamos una marca (UTM) para que veas en tu web qué vino de este anuncio.'}</span>
                </button>
              ))}
            </div>
            {f.goal === 'WEBSITE' && (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Dirección de tu web"><Input placeholder="https://turestaurante.com/reservas" value={f.websiteUrl} onChange={(e) => set({ websiteUrl: e.target.value })} /></Field>
                <Field label="Botón del anuncio">
                  <Select value={f.cta} onChange={(e) => set({ cta: e.target.value })}>{s.ctas.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
                </Field>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-4">
              <Field label="Países (código de 2 letras, separados por coma)" hint="Ej.: CO, o US para Estados Unidos."><Input value={f.countries} onChange={(e) => set({ countries: e.target.value })} /></Field>
              <Switch checked={f.advantageAudience} onChange={(v) => set({ advantageAudience: v, ...(v && Number(f.ageMin) > 25 ? { ageMin: '18' } : {}) })} label="Público Advantage+ (recomendado): Meta busca a quién mostrarlo" />
              <div className="grid grid-cols-3 gap-3">
                <Field label="Edad mínima"><Input type="number" min={18} max={65} value={f.ageMin} onChange={(e) => set({ ageMin: e.target.value })} /></Field>
                {!f.advantageAudience && <Field label="Edad máxima"><Input type="number" min={18} max={65} value={f.ageMax} onChange={(e) => set({ ageMax: e.target.value })} /></Field>}
                {!f.advantageAudience && (
                  <Field label="Género"><Select value={f.gender} onChange={(e) => set({ gender: e.target.value })}><option value="ALL">Todos</option><option value="FEMALE">Mujeres</option><option value="MALE">Hombres</option></Select></Field>
                )}
              </div>
            </div>
            <div className="space-y-4">
              {s.maxDailyBudget ? (
                <p className="text-sm">Tu tope diario por anuncio: <b>{fmt(s.maxDailyBudget, currency)}</b>. BackOffice nunca lo supera.</p>
              ) : (
                <div className="border-2 border-warn bg-paper p-3 text-sm">
                  <p className="mb-2">Define primero tu tope de presupuesto diario: es el máximo que un anuncio puede gastar al día desde BackOffice.</p>
                  <div className="flex gap-2"><Input placeholder="Ej.: 100.000" value={cap} onChange={(e) => setCap(e.target.value)} /><Button size="sm" disabled={!cap || saveCap.isPending} onClick={() => saveCap.mutate()}>Guardar tope</Button></div>
                </div>
              )}
              <Field label={`Presupuesto diario (${currency})`}><Input inputMode="numeric" placeholder="Ej.: 40.000" value={f.dailyBudget} onChange={(e) => set({ dailyBudget: e.target.value })} /></Field>
              <div className="border-2 border-line bg-paper p-3 text-sm" data-testid="budget-hint">
                <b>Recomendación por tu historial</b>
                {hints?.costPerResult ? (
                  <p className="mt-1">Cada {goal?.resultLabel.replace(/s$/, '')} te ha costado en promedio {fmt(hints.costPerResult, currency)}.{expected ? ` Con ${fmt(budget, currency)} al día esperarías entre ${expected.low} y ${expected.high} ${goal?.resultLabel} diarios.` : ''}</p>
                ) : null}
                <p className="mt-1 text-xs text-ink-3">{hints?.basis}</p>
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Empieza" hint="Vacío: arranca cuando lo actives."><Input type="date" min={s.today} value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
              <Field label="Termina" hint="Vacío: sigue hasta que lo pauses."><Input type="date" min={f.startDate || s.today} value={f.endDate} onChange={(e) => set({ endDate: e.target.value })} /></Field>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="text-ink-3">Atajos:</span>
              {[['Esta semana', 0, 6], ['Fin de semana', -1, -1], ['2 semanas', 0, 13]].map(([label, a, b]) => (
                <button key={String(label)} type="button" className="cursor-pointer border-2 border-line px-2 py-0.5" onClick={() => set(rangeFor(s.today, Number(a), Number(b)))}>{String(label)}</button>
              ))}
            </div>
            {hints?.bestDays.length ? <p className="text-sm">Según tu historial, rinden mejor los <b>{hints.bestDays.join(' y ')}</b>: si es una promoción corta, inclúyelos.</p> : null}
            <p className="text-xs text-ink-3">Las fechas quedan en la zona horaria de tu cuenta ({s.account.timezone ?? 'la de tu cuenta'}). Puedes ver todo lo programado en «Programación semanal».</p>
          </div>
        )}

        {step === 4 && (
          <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
            <div className="space-y-3">
              <Field label="Imagen publicitaria" hint="JPG o PNG, ideal 1080 × 1350 (vertical 4:5) o 1080 × 1080. Se guarda en tu biblioteca.">
                <input type="file" accept="image/jpeg,image/png" aria-label="Subir imagen publicitaria" onChange={(e) => { const file = e.target.files?.[0]; if (file) upload.mutate(file); }} />
              </Field>
              {upload.isPending && <p className="text-sm">Subiendo…</p>}
              {asset && (
                <figure className="border-2 border-ink">
                  {preview ? <img src={preview} alt={`Vista previa de ${asset.name}`} className="max-h-80 w-full object-contain" /> : <div className="h-40" />}
                  <figcaption className="border-t-2 border-ink px-2 py-1 text-xs">{asset.name} · {asset.width} × {asset.height} px</figcaption>
                </figure>
              )}
            </div>
            <div className="space-y-3">
              <Field label={`Texto principal (${f.primaryText.length}/125 visibles)`}><Textarea rows={4} value={f.primaryText} maxLength={600} onChange={(e) => set({ primaryText: e.target.value })} placeholder="2x1 en hamburguesas todos los martes. Escríbenos y reserva tu mesa." /></Field>
              <Field label={`Título (${f.headline.length}/40 visibles)`}><Input value={f.headline} maxLength={100} onChange={(e) => set({ headline: e.target.value })} placeholder="Martes 2x1" /></Field>
              <Field label="Descripción (opcional)"><Input value={f.description} maxLength={120} onChange={(e) => set({ description: e.target.value })} /></Field>
              <div className="border-2 border-line bg-paper p-3 text-xs text-ink-2">
                {s.ai.available
                  ? <><Badge tone="info">Con IA</Badge> {s.ai.note}</>
                  : <><Badge tone="warn">Solo reglas</Badge> {s.ai.note} <Link to="/app/settings" className="underline">Configurar mi proveedor de IA</Link></>}
              </div>
              <Button disabled={!asset || doReview.isPending} onClick={() => doReview.mutate()}>{doReview.isPending ? 'Revisando…' : 'Revisar anuncio'}</Button>
            </div>
            {review && <ReviewPanel review={review} onUse={(patch) => set(patch)} />}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <Button variant="outline" disabled={doPreview.isPending} onClick={() => doPreview.mutate()}>{doPreview.isPending ? 'Verificando…' : 'Verificar todo'}</Button>
            {doPreview.data && (doPreview.data.valid ? (
              <div className="space-y-2 text-sm" data-testid="ready">
                <p><Badge tone="ok">Listo</Badge> {doPreview.data.summary.goal} · {fmt(doPreview.data.summary.dailyBudget, currency)} al día{doPreview.data.summary.startDate ? ` · del ${doPreview.data.summary.startDate}${doPreview.data.summary.endDate ? ` al ${doPreview.data.summary.endDate}` : ''}` : ''}</p>
                {doPreview.data.summary.link && <p className="break-all text-xs text-ink-3">Enlace con seguimiento: {doPreview.data.summary.link}</p>}
                {!review && <p className="text-warn">Todavía no revisaste el anuncio (paso 5). Puedes crearlo igual, pero conviene revisarlo.</p>}
                <Button disabled={!canWrite || !canManage} onClick={() => setConfirmCreate(true)}>Crear en Meta (en pausa)</Button>
              </div>
            ) : (
              <ul className="list-disc space-y-1 pl-5 text-sm text-bad" data-testid="errors">{doPreview.data.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            ))}
          </div>
        )}

        <div className="mt-6 flex justify-between border-t-2 border-line pt-4">
          <Button variant="outline" disabled={step === 0} onClick={() => setStep(step - 1)}>← Atrás</Button>
          {step < STEPS.length - 1 && <Button onClick={() => setStep(step + 1)}>Siguiente →</Button>}
        </div>
      </Card>

      <Modal open={confirmCreate} onClose={() => setConfirmCreate(false)} kicker="Confirmación" title="Crear el anuncio en Meta">
        <div className="space-y-4 text-sm">
          <p>Se crean en tu cuenta <b>{s.account.name}</b>: la imagen, la campaña, el conjunto, el creativo y el anuncio. <b>Todo queda en pausa</b>: no gasta nada hasta que lo actives.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmCreate(false)}>Cancelar</Button>
            <Button disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? 'Creando en Meta…' : 'Sí, crear en pausa'}</Button>
          </div>
        </div>
      </Modal>
      <Modal open={!!activate} onClose={() => setActivate(null)} kicker="Gasta presupuesto" title="Activar el anuncio">
        {activate && (
          <div className="space-y-4 text-sm">
            <p>«{activate.draft.name}» empezará a gastar hasta <b>{fmt(activate.draft.dailyBudget, currency)} al día</b>{activate.draft.endDate ? ` hasta el ${activate.draft.endDate}` : ' hasta que lo pauses'}. Meta lo revisa antes de mostrarlo (suele tardar minutos u horas).</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setActivate(null)}>Cancelar</Button>
              <Button variant="danger" disabled={act.isPending} onClick={() => act.mutate({ id: activate.id, action: 'activate' })}>Sí, activar</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Rango de fechas desde hoy (a, b en días) o el próximo fin de semana (-1). */
function rangeFor(today: string, a: number, b: number) {
  const add = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  if (a === -1) {
    const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
    const toFri = (5 - wd + 7) % 7;
    return { startDate: add(today, toFri), endDate: add(today, toFri + 2) };
  }
  return { startDate: add(today, a), endDate: add(today, b) };
}

function ReviewPanel({ review, onUse }: { review: Review; onUse: (p: { primaryText?: string; headline?: string }) => void }) {
  const ai = review.ai;
  return (
    <div className="space-y-4 lg:col-span-2" data-testid="review">
      <div className="flex flex-wrap items-center gap-3">
        <b>Revisión por reglas: {review.code.score}/100</b>
        {ai.status === 'OK' ? <Badge tone="info">Con IA · {ai.model.split('/').pop()}</Badge> : <Badge tone="warn">Sin IA</Badge>}
      </div>
      {ai.status !== 'OK' && <p className="text-sm text-ink-2">{ai.message} Las reglas revisan formato, tamaño, luz, contraste, largo del texto y políticas conocidas de Meta, pero no entienden la imagen ni la oferta como una IA.</p>}
      <ul className="divide-y divide-line border-2 border-line">
        {review.code.items.map((i) => (
          <li key={`${i.area}-${i.key}`} className="flex gap-3 px-3 py-2 text-sm">
            <Badge tone={LEVEL[i.level].tone}>{LEVEL[i.level].label}</Badge>
            <span><b>{i.title}.</b> {i.detail}{i.fix ? <span className="block text-ink-2">→ {i.fix}</span> : null}</span>
          </li>
        ))}
      </ul>
      {ai.status === 'OK' && (
        <div className="space-y-3 border-2 border-ink p-4 text-sm">
          <p className="kicker">Recomendaciones de la IA (tu proveedor)</p>
          {ai.review.seen && <p className="text-ink-2">Lo que ve en la imagen: {ai.review.seen}</p>}
          <p>{ai.review.summary}{ai.review.score ? ` (${ai.review.score}/10)` : ''}</p>
          {ai.review.strengths.length > 0 && <p><b>Funciona:</b> {ai.review.strengths.join(' · ')}</p>}
          <ol className="list-decimal space-y-1 pl-5">
            {ai.review.improvements.map((m) => <li key={m.problem}><b>{m.problem}</b> → {m.suggestion} <span className="text-xs text-ink-3">({m.priority.toLowerCase()})</span></li>)}
          </ol>
          {(ai.review.suggestedCopy.primaryText || ai.review.suggestedCopy.headline) && (
            <div className="border-t-2 border-line pt-3">
              <p className="mb-1 font-semibold">Texto sugerido</p>
              {ai.review.suggestedCopy.primaryText && <p className="mb-1">«{ai.review.suggestedCopy.primaryText}» <Button size="sm" variant="ghost" onClick={() => onUse({ primaryText: ai.review.suggestedCopy.primaryText! })}>Usar</Button></p>}
              {ai.review.suggestedCopy.headline && <p>Título: «{ai.review.suggestedCopy.headline}» <Button size="sm" variant="ghost" onClick={() => onUse({ headline: ai.review.suggestedCopy.headline! })}>Usar</Button></p>}
            </div>
          )}
          <p className={clsx('text-xs', ai.review.policyRisk.level === 'BAJO' ? 'text-ink-3' : 'text-bad')}>Riesgo de rechazo por políticas: {ai.review.policyRisk.level.toLowerCase()}{ai.review.policyRisk.reason ? ` — ${ai.review.policyRisk.reason}` : ''}</p>
        </div>
      )}
    </div>
  );
}

function LaunchList({ launches, currency, canWrite, onAction, busy }: { launches: Launch[]; currency: string; canWrite: boolean; onAction: (id: string, a: 'activate' | 'pause' | 'retry' | 'archive') => void; busy: boolean }) {
  if (!launches.length) return null;
  return (
    <Card kicker="Creados desde BackOffice" title="Tus anuncios">
      <ul className="divide-y divide-line" data-testid="launches">
        {launches.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
            <span>
              <b>{l.draft.name}</b> <Badge tone={STATUS[l.status].tone}>{STATUS[l.status].label}</Badge>
              <span className="block text-xs text-ink-3">
                {l.goalLabel} · {fmt(l.draft.dailyBudget, currency)}/día{l.draft.startDate ? ` · ${l.draft.startDate}${l.draft.endDate ? ` → ${l.draft.endDate}` : ''}` : ''}
                {l.reviewScore !== null ? ` · revisión ${l.reviewScore}/100${l.reviewedWithAi ? ' + IA' : ''}` : ' · sin revisión'}
              </span>
              {l.error && <span className="block text-xs text-bad">{l.error}</span>}
            </span>
            {canWrite && (
              <span className="flex gap-1">
                {l.status === 'PAUSED' && <Button size="sm" disabled={busy} onClick={() => onAction(l.id, 'activate')}>Activar</Button>}
                {l.status === 'ACTIVE' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(l.id, 'pause')}>Pausar</Button>}
                {l.status === 'FAILED' && <Button size="sm" variant="outline" disabled={busy} onClick={() => onAction(l.id, 'retry')}>Reintentar</Button>}
                {l.status !== 'ACTIVE' && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction(l.id, 'archive')}>Quitar</Button>}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
