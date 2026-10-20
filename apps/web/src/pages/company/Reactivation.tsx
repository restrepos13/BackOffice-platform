import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Stat, Switch, Textarea } from '../../components/ui';
import ScheduleCall from '../../components/ScheduleCall';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Reactivación de clientes dormidos (complemento): a quién le va a escribir,
 * qué le va a decir, y lo que logró (respuestas, clientes recuperados y ventas).
 */

interface Config { thresholds: number[]; templateKey: string | null; message: string; offer: string; maxPerDay: number; sendHour: number; cooldownDays: number }
interface Summary {
  auto: boolean;
  config: Config;
  templates: Array<{ key: string; name: string; body: string }>;
  dormant: { total: number; byStep: Array<{ step: number; count: number }>; sample: Array<{ name: string; dormantDays: number; lastProduct: string | null; basis: string }> };
  results: { sent: number; replied: number; recovered: number; revenue: number; skipped: number };
  recent: Array<{ id: string; name: string; step: number; status: string; skipReason: string | null; amount: number | null; createdAt: string; conversationId: string | null }>;
}

const STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'ok' | 'bad' }> = {
  SENT: { label: 'Enviado', tone: 'neutral' },
  REPLIED: { label: 'Respondió', tone: 'info' },
  RECOVERED: { label: 'Volvió a comprar', tone: 'ok' },
  SKIPPED: { label: 'No se envió', tone: 'bad' },
};

export default function Reactivation() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['reactivation', q], queryFn: () => api.get<Summary>(withScope('/addons/reactivation', q)), enabled: ready });
  const [form, setForm] = useState<Config | null>(null);
  const [thresholds, setThresholds] = useState('');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (data && !form) {
      setForm(data.config);
      setThresholds(data.config.thresholds.join(', '));
    }
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => api.put<Config>(withScope('/addons/reactivation/config', q), { ...form, thresholds: thresholds.split(/[,\s]+/).map(Number).filter(Boolean) }),
    onSuccess: (c) => {
      setForm(c);
      setThresholds(c.thresholds.join(', '));
      queryClient.invalidateQueries({ queryKey: ['reactivation'] });
      toast.success('Reactivación guardada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ sent: number; skipped: number; reason: string | null }>(withScope('/addons/reactivation/run', q), {}),
    onSuccess: (r) => {
      setConfirm(false);
      queryClient.invalidateQueries({ queryKey: ['reactivation'] });
      if (r.reason) toast.error(r.reason);
      else toast.success(`${r.sent} mensajes en camino${r.skipped ? ` · ${r.skipped} no se pudieron enviar (mira el detalle)` : ''}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const auto = useMutation({
    mutationFn: (on: boolean) => api.put<{ auto: boolean }>(withScope('/addons/reactivation/auto', q), { auto: on }),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['reactivation'] }); toast.success(r.auto ? 'Listo: desde ahora le escribe a tus clientes dormidos solo, todos los días' : 'Envíos automáticos apagados'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (error) return <Card title="Reactivación de clientes"><p className="text-sm">{error instanceof Error ? error.message : 'No disponible'} <Link to="/app/mi-plan" className="font-semibold underline">Ir a Mi plan</Link></p></Card>;
  if (isLoading || !data || !form) return <Loading />;
  const r = data.results;
  const template = data.templates.find((t) => t.key === form.templateKey);

  return (
    <>
      <PageHeader kicker="Incluido en tu plan" title="Reactivación" accent="de clientes" actions={canWrite && <Button disabled={!data.dormant.total} onClick={() => setConfirm(true)}><Play size={14} /> Enviar ahora</Button>} />

      <div className={`mb-6 flex flex-wrap items-center justify-between gap-3 border-2 p-4 ${data.auto ? 'border-ink bg-ok-soft' : 'border-line bg-paper'}`}>
        <div className="text-sm">
          <p className="font-semibold">{data.auto ? 'Envíos automáticos encendidos' : 'Envíos automáticos apagados'}</p>
          <p className="text-ink-2">{data.auto ? `Cada día a las ${form.sendHour}:00 le escribe a tus clientes dormidos solo, respetando tus límites.` : 'Incluido en tu plan. Revisa los ajustes y enciéndelo cuando quieras; mientras tanto puedes enviar a mano.'}</p>
        </div>
        {canWrite && <Switch checked={data.auto} disabled={auto.isPending} onChange={(v) => auto.mutate(v)} label="Envíos automáticos" showLabel />}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <Stat label="Dormidos hoy" value={data.dormant.total} hint={data.dormant.byStep.map((s) => `${s.count} de ${s.step}+ días`).join(' · ')} />
        <Stat label="Mensajes enviados" value={r.sent} hint="Últimos 90 días" />
        <Stat label="Respondieron" value={r.replied} hint={r.sent ? `${Math.round((r.replied / r.sent) * 100)}% de los enviados` : undefined} />
        <Stat label="Volvieron a comprar" value={r.recovered} tone={r.recovered ? 'ok' : undefined} />
        <Stat label="Ventas recuperadas" value={fmtMoney(r.revenue)} tone={r.revenue ? 'ok' : undefined} />
      </div>

      {!template && (
        <div className="mb-6 border-2 border-warn bg-warn-soft px-4 py-3 text-sm">
          Para escribirle a quien no te ha escrito en las últimas 24 horas, Meta exige una <b>plantilla aprobada</b> (categoría marketing).
          Sin ella solo se envía a quien te escribió hace poco. La registramos nosotros contigo ante Meta.
          <span className="mt-2 block"><ScheduleCall q={q} topic="TEMPLATES" size="sm" label="Agéndame para crear la plantilla" /></span>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card kicker="Cómo y cuándo" title="Ajustes">
          <fieldset disabled={!canWrite} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Días sin comprar" hint="Un mensaje por cada uno. Ej.: 30, 60, 90">
                <Input value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
              </Field>
              <Field label="Máximo al día"><Input type="number" min={1} max={200} value={form.maxPerDay} onChange={(e) => setForm({ ...form, maxPerDay: Number(e.target.value) })} /></Field>
              <Field label="Hora de envío">
                <Select value={form.sendHour} onChange={(e) => setForm({ ...form, sendHour: Number(e.target.value) })}>
                  {Array.from({ length: 13 }, (_, i) => i + 8).map((h) => <option key={h} value={h}>{h}:00</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Plantilla aprobada (fuera de las 24 h)">
              <Select value={form.templateKey ?? ''} onChange={(e) => setForm({ ...form, templateKey: e.target.value || null })}>
                <option value="">Ninguna (solo a quien escribió hace poco)</option>
                {data.templates.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
              </Select>
            </Field>
            {template?.body && <p className="text-xs text-ink-3">La plantilla dice: “{template.body}” ({'{{1}}'} = su nombre, {'{{2}}'} = tu oferta o lo último que compró)</p>}
            <Field label="Oferta o gancho (opcional)" hint="Ej.: 10% en tu próximo pedido esta semana">
              <Input value={form.offer} maxLength={200} onChange={(e) => setForm({ ...form, offer: e.target.value })} />
            </Field>
            <Field label="Mensaje (dentro de las 24 h)" hint="Variables: {{nombre}} {{empresa}} {{oferta}} {{producto}}">
              <Textarea rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
            </Field>
            <Field label="Días mínimos entre mensajes a la misma persona">
              <Input type="number" min={7} max={90} value={form.cooldownDays} onChange={(e) => setForm({ ...form, cooldownDays: Number(e.target.value) })} />
            </Field>
            {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>}
          </fieldset>
        </Card>

        <Card kicker="A quiénes les escribiría hoy" title="Clientes dormidos">
          {data.dormant.sample.length === 0 ? <p className="text-sm text-ink-3">Nadie está dormido según tus ajustes. ¡Buena señal!</p> : (
            <ul className="divide-y divide-line text-sm">
              {data.dormant.sample.map((d) => (
                <li key={d.name + d.dormantDays} className="py-2">
                  <p className="font-semibold">{d.name}</p>
                  <p className="text-xs text-ink-3">{d.dormantDays} días sin {d.basis === 'compra' ? 'comprar' : 'escribir'}{d.lastProduct ? ` · último: ${d.lastProduct}` : ''}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-3">Nunca le escribe a quien pidió no recibir mensajes. Con los envíos automáticos encendidos, sale solo a la hora elegida.</p>
        </Card>
      </div>

      <Card kicker="Últimos mensajes" title="Historial" className="mt-6">
        {data.recent.length === 0 ? <p className="text-sm text-ink-3">Todavía no ha enviado mensajes.</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.recent.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <b>{t.name}</b> · escalón {t.step} días · {timeAgo(t.createdAt)}
                  {t.skipReason && <span className="block text-xs text-bad">{t.skipReason}</span>}
                </span>
                <span className="flex items-center gap-2">
                  {t.amount ? <b>{fmtMoney(t.amount)}</b> : null}
                  <Badge tone={STATUS[t.status]?.tone ?? 'neutral'}>{STATUS[t.status]?.label ?? t.status}</Badge>
                  {t.conversationId && <Link to={`/app/inbox?open=${t.conversationId}`} className="text-xs underline">Ver chat</Link>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={confirm} onClose={() => setConfirm(false)} kicker="Reactivación" title="¿Enviar ahora?">
        <div className="space-y-4 text-sm">
          <p>Se le escribe a hasta <b>{Math.min(form.maxPerDay, data.dormant.total)}</b> clientes dormidos (tu máximo del día), respetando a quienes pidieron no recibir mensajes.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirm(false)}>Cancelar</Button>
            <Button disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Enviando…' : 'Sí, enviar'}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
