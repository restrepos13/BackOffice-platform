import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import type { SocialStatus } from '../../../lib/types';
import { CATEGORY_LABELS, STATUS_LABELS } from '../../../lib/creative';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, Select, Switch, Textarea } from '../../../components/ui';
import { useCompanyScope, withScope } from '../shared';

/**
 * Publicaciones en redes (calendario con aprobaciones y reglas de publicación).
 * Viven en Ads: Creative diseña y Ads publica. Archivo aparte para que Ads no
 * cargue el editor de diseño.
 */

const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export interface Policy { paused: boolean; autonomyEnabled: boolean; autoCategories: string[]; restrictedTopics: string[]; pricesNeedReview: boolean; networks: string[]; maxPerDay: number; fromHour: number; toHour: number }
interface Piece {
  id: string; title: string; copy: string | null; status: string; category: string | null; scheduledAt: string | null; publishedAt: string | null;
  targets: string[]; reviewNote: string | null; approvedBy: string | null; autoApproved: boolean | null; publishError: string | null; designId: string | null;
}

const STATUS_TONE: Record<string, 'neutral' | 'warn' | 'ok' | 'info' | 'bad'> = {
  EN_REVISION: 'warn', APROBADO: 'ok', PROGRAMADO: 'info', PUBLICANDO: 'info', PUBLICADO: 'ok', ERROR: 'bad',
};

export function Calendar({ q }: { q: string }) {
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

export function Rules({ q, policy }: { q: string; policy: Policy }) {
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

