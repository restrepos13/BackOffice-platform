import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtDateTime, fmtMoney, fmtNum, fmtUsd } from '../../lib/format';
import type {
  Broadcast, CampaignPreview, CampaignSegment, Company, Integration, Pipeline, Product,
} from '../../lib/types';
import {
  Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Stat,
  Switch, Table, Tabs, Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

const STATUS: Record<Broadcast['status'], { label: string; tone: 'ok' | 'warn' | 'info' | 'neutral' | 'bad' }> = {
  DRAFT: { label: 'Borrador', tone: 'neutral' },
  SCHEDULED: { label: 'Programada', tone: 'info' },
  SENDING: { label: 'Enviando', tone: 'warn' },
  SENT: { label: 'Enviada', tone: 'ok' },
  CANCELLED: { label: 'Cancelada', tone: 'bad' },
};

const VARIABLES = ['{nombre}', '{empresa}'];

/* ─── Constructor de segmento ────────────────────────────────────────── */

function SegmentBuilder({ value, onChange, q }: {
  value: CampaignSegment;
  onChange: (s: CampaignSegment) => void;
  q: string;
}) {
  const { data: pipelines } = useQuery({
    queryKey: ['pipelines', q],
    queryFn: () => api.get<Pipeline[]>(withScope('/pipelines', q)),
  });
  const { data: products } = useQuery({
    queryKey: ['products', q],
    queryFn: () => api.get<Product[]>(withScope('/catalog/products?all=1', q)),
  });
  const stages = useMemo(() => {
    const map = new Map<string, string>();
    pipelines?.forEach((p) => p.stages.forEach((s) => map.set(s.key, s.label)));
    return [...map.entries()];
  }, [pipelines]);
  const toggle = (list: string[] | undefined, key: string) =>
    list?.includes(key) ? list.filter((k) => k !== key) : [...(list ?? []), key];

  return (
    <div className="space-y-4">
      <Field label="Etapa del contacto" hint="Vacío = todas">
        <div className="flex flex-wrap gap-1.5">
          {stages.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onChange({ ...value, stages: toggle(value.stages, key) })}
              className={`border-2 px-2.5 py-1 text-xs font-semibold ${value.stages?.includes(key) ? 'border-ink bg-ink text-bone' : 'border-line bg-paper text-ink-2 hover:border-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Etiquetas" hint="Separadas por coma">
          <Input
            value={(value.tags ?? []).join(', ')}
            placeholder="vip, almuerzos"
            onChange={(e) => onChange({ ...value, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
          />
        </Field>
        <Field label="No piden hace (días)" hint="Reactivar clientes dormidos">
          <Input type="number" min={0} value={value.inactiveDays ?? ''}
            onChange={(e) => onChange({ ...value, inactiveDays: Number(e.target.value) || undefined })} />
        </Field>
        <Field label="Con actividad en los últimos (días)">
          <Input type="number" min={0} value={value.activeWithinDays ?? ''}
            onChange={(e) => onChange({ ...value, activeWithinDays: Number(e.target.value) || undefined })} />
        </Field>
        <Field label="Pidieron este producto">
          <Select
            value={value.productIds?.[0] ?? ''}
            onChange={(e) => onChange({ ...value, productIds: e.target.value ? [e.target.value] : undefined })}
          >
            <option value="">Cualquiera</option>
            {products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
      </div>
      <Switch showLabel
        checked={!!value.customersOnly}
        onChange={(v) => onChange({ ...value, customersOnly: v || undefined })}
        label="Solo quienes ya compraron alguna vez"
      />
    </div>
  );
}

/* ─── Nueva campaña ─────────────────────────────────────────────────── */

function NewCampaignModal({ open, onClose, q, lines }: {
  open: boolean;
  onClose: () => void;
  q: string;
  lines: Integration[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [integrationId, setIntegrationId] = useState('');
  const [segment, setSegment] = useState<CampaignSegment>({});
  const [message, setMessage] = useState('Hola {nombre}, esta semana tenemos el menú nuevo. ¿Te reservo tu almuerzo?');
  const [templateKey, setTemplateKey] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');

  useEffect(() => {
    if (!integrationId && lines[0]) setIntegrationId(lines[0].id);
  }, [lines, integrationId]);

  const preview = useQuery({
    queryKey: ['campaign-preview', q, integrationId, templateKey, JSON.stringify(segment)],
    queryFn: () => api.post<CampaignPreview>(withScope('/campaigns/preview', q), { segment, integrationId, templateKey }),
    enabled: open && !!integrationId,
  });

  const create = useMutation({
    mutationFn: async (sendNow: boolean) => {
      const b = await api.post<Broadcast>(withScope('/campaigns', q), {
        name, integrationId, segment, message, templateKey: templateKey || undefined,
        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
      });
      if (sendNow && !scheduledAt) await api.post(`/campaigns/${b.id}/send`);
      return { sendNow };
    },
    onSuccess: ({ sendNow }) => {
      toast.success(scheduledAt ? 'Campaña programada' : sendNow ? 'Campaña en envío' : 'Borrador guardado');
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      onClose();
      setName('');
      setSegment({});
      setScheduledAt('');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const p = preview.data;
  const sample = message.replace(/\{nombre\}/gi, p?.sample[0]?.split(' ')[0] ?? 'Ana');

  return (
    <Modal open={open} onClose={onClose} kicker="WhatsApp" title="Nueva campaña" wide>
      <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre interno" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Menú de la semana" />
            </Field>
            <Field label="Línea que envía" required>
              <Select value={integrationId} onChange={(e) => setIntegrationId(e.target.value)}>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="border-2 border-line p-4">
            <p className="kicker mb-3">Para quién</p>
            <SegmentBuilder value={segment} onChange={setSegment} q={q} />
          </div>
          <Field label="Mensaje" hint={`Variables: ${VARIABLES.join(' ')} · el cliente puede responder SALIR para darse de baja`}>
            <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Plantilla aprobada (opcional)" hint="Necesaria para escribir fuera de la ventana de 24 h">
              <Select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
                <option value="">Sin plantilla</option>
                {p?.templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </Select>
            </Field>
            <Field label="Programar (opcional)">
              <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            </Field>
          </div>
        </div>

        <aside className="space-y-3">
          <div className="border-2 border-ink bg-paper p-4">
            <p className="kicker">Alcance</p>
            {preview.isLoading ? <p className="mt-2 text-sm text-ink-3">Calculando…</p> : p && (
              <>
                <p className="display mt-1 text-4xl tabular-nums">{fmtNum(p.count)}</p>
                <p className="text-xs text-ink-3">contactos</p>
                <dl className="mt-3 space-y-1 text-xs">
                  <div className="flex justify-between"><dt>Dentro de 24 h (gratis)</dt><dd className="font-semibold tabular-nums">{p.inWindow}</dd></div>
                  <div className="flex justify-between"><dt>Fuera de la ventana</dt><dd className="font-semibold tabular-nums">{p.outWindow}</dd></div>
                  {p.willSkip > 0 && (
                    <div className="flex justify-between text-warn"><dt>Se omiten (sin plantilla)</dt><dd className="font-semibold tabular-nums">{p.willSkip}</dd></div>
                  )}
                  <div className="flex justify-between border-t border-line pt-1"><dt>Costo Meta estimado</dt><dd className="font-semibold tabular-nums">{fmtUsd(p.estimatedCostUsd)}</dd></div>
                </dl>
                {p.sample.length > 0 && <p className="mt-3 text-[11px] text-ink-3">Ej.: {p.sample.join(', ')}</p>}
              </>
            )}
          </div>
          <div className="border-2 border-line bg-bone-2 p-3">
            <p className="kicker mb-2">Vista previa</p>
            <div className="ml-auto max-w-[240px] whitespace-pre-wrap bg-paper p-2.5 text-[13px] shadow-sm">{sample}</div>
          </div>
        </aside>
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2 border-t-2 border-ink pt-4">
        <Button variant="outline" disabled={!name || !integrationId || create.isPending} onClick={() => create.mutate(false)}>
          {scheduledAt ? 'Programar' : 'Guardar borrador'}
        </Button>
        {!scheduledAt && (
          <Button
            disabled={!name || !integrationId || !p?.count || create.isPending}
            onClick={() => {
              if (window.confirm(`¿Enviar ahora a ${p?.count} contactos?`)) create.mutate(true);
            }}
          >
            Enviar ahora
          </Button>
        )}
      </div>
    </Modal>
  );
}

/* ─── Detalle con métricas ──────────────────────────────────────────── */

function CampaignDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: b } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<Broadcast>(`/campaigns/${id}`),
    refetchInterval: (query) => (query.state.data?.status === 'SENDING' ? 3000 : false),
  });
  const action = useMutation({
    mutationFn: (kind: 'send' | 'cancel' | 'retarget') => api.post(`/campaigns/${id}/${kind}`, {}),
    onSuccess: (_d, kind) => {
      toast.success(kind === 'send' ? 'Envío iniciado' : kind === 'cancel' ? 'Campaña cancelada' : 'Recordatorio creado como borrador');
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign', id] });
      if (kind === 'retarget') onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const s = b?.stats;
  const pct = (n: number) => (s && s.sent ? `${Math.round((n / s.sent) * 100)}%` : '—');
  return (
    <Modal open onClose={onClose} kicker="Campaña" title={b?.name ?? '…'} wide>
      {!b ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[b.status].tone}>{STATUS[b.status].label}</Badge>
            {b.scheduledAt && b.status === 'SCHEDULED' && <span className="text-xs text-ink-3">Sale {fmtDateTime(b.scheduledAt)}</span>}
            {b.startedAt && <span className="text-xs text-ink-3">Enviada {fmtDateTime(b.startedAt)}</span>}
          </div>
          {s && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Enviados" value={fmtNum(s.sent)} hint={`${s.recipients} destinatarios`} />
              <Stat label="Leídos" value={fmtNum(s.read)} hint={pct(s.read)} />
              <Stat label="Respuestas" value={fmtNum(s.replied)} hint={pct(s.replied)} tone={s.replied ? 'ok' : undefined} />
              <Stat label="Ventas 72 h" value={fmtMoney(s.revenue)} hint={`${s.orders} pedidos`} tone={s.orders ? 'ok' : undefined} />
            </div>
          )}
          {s && (s.failed > 0 || s.skipped > 0) && (
            <p className="text-xs text-ink-3">
              {s.failed} fallidos · {s.skipped} omitidos{b.skipReasons?.length ? ` (${[...new Set(b.skipReasons)].join(', ')})` : ''}
            </p>
          )}
          <div className="border-2 border-line bg-bone-2 p-3 text-sm whitespace-pre-wrap">{b.message}</div>
          <div className="flex flex-wrap justify-end gap-2">
            {['DRAFT', 'SCHEDULED'].includes(b.status) && (
              <>
                <Button variant="danger" size="sm" onClick={() => action.mutate('cancel')}>Cancelar</Button>
                <Button size="sm" onClick={() => window.confirm(`¿Enviar ahora a ${b.recipientsCount} contactos?`) && action.mutate('send')}>
                  Enviar ahora
                </Button>
              </>
            )}
            {b.status === 'SENDING' && <Button variant="danger" size="sm" onClick={() => action.mutate('cancel')}>Detener envío</Button>}
            {b.status === 'SENT' && (
              <Button size="sm" variant="outline" onClick={() => action.mutate('retarget')}>
                Recordatorio a quienes no respondieron
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─── Seguimiento automático (orderConfig.followUps) ───────────────── */

interface FollowUpRule { id: string; enabled: boolean; afterHours: number; message: string; when: 'no_reply' | 'draft_open' }

function FollowUps({ companyId, canWrite }: { companyId: string | null; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data: company } = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => api.get<Company>(`/companies/${companyId}`),
    enabled: !!companyId,
  });
  const [rules, setRules] = useState<FollowUpRule[] | null>(null);
  useEffect(() => {
    if (company && rules === null) setRules(((company.orderConfig ?? {}) as any).followUps ?? []);
  }, [company, rules]);
  const save = useMutation({
    mutationFn: () => api.patch(`/companies/${companyId}`, { orderConfig: { ...(company?.orderConfig ?? {}), followUps: rules } }),
    onSuccess: () => {
      toast.success('Seguimiento guardado');
      queryClient.invalidateQueries({ queryKey: ['company', companyId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  if (!rules) return <Loading />;
  const update = (i: number, patch: Partial<FollowUpRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-ink-2">
        Si el cliente deja de responder después de un mensaje del asistente, se le escribe <b>una sola vez</b> por regla.
        Solo dentro de la ventana de 24 h de WhatsApp (sin costo de Meta) y nunca a quien pidió la baja.
      </p>
      {rules.map((r, i) => (
        <div key={r.id} className="space-y-3 border-2 border-ink bg-paper p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Switch showLabel checked={r.enabled} onChange={(v) => update(i, { enabled: v })} label={r.enabled ? 'Activa' : 'Pausada'} disabled={!canWrite} />
            {canWrite && <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>Quitar</Button>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cuándo">
              <Select value={r.when} disabled={!canWrite} onChange={(e) => update(i, { when: e.target.value as FollowUpRule['when'] })}>
                <option value="no_reply">El cliente no respondió</option>
                <option value="draft_open">Dejó un pedido a medias</option>
              </Select>
            </Field>
            <Field label="Después de (horas)" hint="Entre 1 y 23">
              <Input type="number" min={1} max={23} value={r.afterHours} disabled={!canWrite}
                onChange={(e) => update(i, { afterHours: Math.min(23, Math.max(1, Number(e.target.value) || 1)) })} />
            </Field>
          </div>
          <Field label="Mensaje">
            <Textarea rows={2} value={r.message} disabled={!canWrite} onChange={(e) => update(i, { message: e.target.value })} />
          </Field>
        </div>
      ))}
      {rules.length === 0 && <EmptyState title="Sin reglas de seguimiento" hint="Agrega una para recuperar pedidos que se quedan a medias." />}
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => setRules([...rules, {
              id: `r${Date.now().toString(36)}`, enabled: true, afterHours: 2, when: 'draft_open',
              message: '¿Seguimos con tu pedido? Si quieres te lo dejo listo en un minuto.',
            }])}
          >
            + Agregar regla
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>
        </div>
      )}
    </div>
  );
}

/* ─── Página ────────────────────────────────────────────────────────── */

export default function Campaigns() {
  const { q, ready, canWrite, companyId } = useCompanyScope();
  const [tab, setTab] = useState('campanas');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: campaigns, isLoading } = useQuery({
    queryKey: ['campaigns', q],
    queryFn: () => api.get<Broadcast[]>(withScope('/campaigns', q)),
    enabled: ready,
    refetchInterval: (query) => (query.state.data?.some((c) => c.status === 'SENDING') ? 4000 : false),
  });
  const { data: integrations } = useQuery({
    queryKey: ['integrations', q],
    queryFn: () => api.get<Integration[]>(withScope('/integrations', q)),
    enabled: ready,
  });
  const lines = (integrations ?? []).filter((i) => i.type === 'WHATSAPP');
  if (!ready) return <PickCompany />;

  return (
    <div>
      <PageHeader
        kicker="Crecimiento"
        title="Campañas"
        accent="WhatsApp"
        actions={canWrite && tab === 'campanas' && (
          <Button disabled={!lines.length} onClick={() => setCreating(true)}>+ Nueva campaña</Button>
        )}
      />
      <Tabs
        tabs={[{ id: 'campanas', label: 'Campañas' }, { id: 'seguimiento', label: 'Seguimiento automático' }]}
        active={tab}
        onChange={setTab}
      />
      <div className="mt-6">
        {tab === 'seguimiento' ? <FollowUps companyId={companyId} canWrite={canWrite} /> : isLoading ? <Loading /> : (
          <>
            {!lines.length && (
              <p className="mb-4 border-2 border-warn bg-paper p-3 text-sm">Conecta una línea de WhatsApp en Integraciones para enviar campañas.</p>
            )}
            {campaigns?.length ? (
              <Table head={['Campaña', 'Estado', 'Contactos', 'Costo Meta', 'Creada', '']}>
                {campaigns.map((c) => (
                  <tr key={c.id} className="cursor-pointer hover:bg-bone-2" onClick={() => setOpenId(c.id)}>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{c.name}</p>
                      <p className="max-w-md truncate text-xs text-ink-3">{c.message}</p>
                    </td>
                    <td className="px-4 py-3"><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></td>
                    <td className="px-4 py-3 tabular-nums">{fmtNum(c.recipientsCount)}</td>
                    <td className="px-4 py-3 tabular-nums">{fmtUsd(c.estimatedCostUsd)}</td>
                    <td className="px-4 py-3 text-xs text-ink-3">{fmtDateTime(c.createdAt)}{c.createdBy ? ` · ${c.createdBy}` : ''}</td>
                    <td className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider">Ver</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <EmptyState
                title="Aún no hay campañas"
                hint="Envía el menú de la semana, reactiva clientes que no piden hace días o anuncia una promoción."
              />
            )}
          </>
        )}
      </div>
      <NewCampaignModal open={creating} onClose={() => setCreating(false)} q={q} lines={lines} />
      {openId && <CampaignDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
