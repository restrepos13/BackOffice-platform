import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtMoney, timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Stat, Switch, Textarea } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Cobranza humanizada (complemento): lo que te deben, los recordatorios que
 * salen solos por WhatsApp y lo que ya se recuperó.
 */

interface Config { firstReminderDays: number; repeatEveryDays: number; maxReminders: number; templateKey: string | null; message: string; sendHour: number; autoFromOrders: boolean }
interface Receivable {
  id: string; contactId: string; contactName: string; optOut: boolean; concept: string; amount: number; dueDate: string; status: 'PENDING' | 'PAID';
  remindersSent: number; lastReminderAt: string | null; paidAt: string | null; fromOrder: boolean; overdueDays: number;
}
interface Summary {
  auto: boolean;
  config: Config;
  templates: Array<{ key: string; name: string; body: string }>;
  totals: { pendingCount: number; pendingAmount: number; overdueAmount: number; remindersSent: number; recoveredAmount: number; recoveredCount: number };
  receivables: Receivable[];
}

export default function Collections() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['collections', q], queryFn: () => api.get<Summary>(withScope('/addons/collections', q)), enabled: ready });
  const [form, setForm] = useState<Config | null>(null);
  const [adding, setAdding] = useState<{ search: string; contactId: string; concept: string; amount: string; dueDate: string } | null>(null);
  const { data: contacts } = useQuery({
    queryKey: ['contacts-search', q, adding?.search ?? ''],
    queryFn: () => api.get<Array<{ id: string; name: string; phone: string | null }>>(withScope(`/contacts?search=${encodeURIComponent(adding?.search ?? '')}`, q)),
    enabled: ready && !!adding,
  });
  useEffect(() => {
    if (data && !form) setForm(data.config);
  }, [data, form]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['collections'] });

  const save = useMutation({
    mutationFn: () => api.put<Config>(withScope('/addons/collections/config', q), form),
    onSuccess: (c) => { setForm(c); refresh(); toast.success('Cobranza guardada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ sent: number; skipped: number; reason: string | null }>(withScope('/addons/collections/run', q), {}),
    onSuccess: (r) => { refresh(); if (r.reason) toast.error(r.reason); else toast.success(`${r.sent} recordatorios en camino${r.skipped ? ` · ${r.skipped} no se pudieron enviar` : ''}`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const create = useMutation({
    mutationFn: () => api.post(withScope('/addons/collections/receivables', q), adding),
    onSuccess: () => { setAdding(null); refresh(); toast.success('Cuenta agregada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: string }) => api.patch(withScope(`/addons/collections/receivables/${v.id}`, q), { status: v.status }),
    onSuccess: () => { refresh(); toast.success('Actualizado'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const auto = useMutation({
    mutationFn: (on: boolean) => api.put<{ auto: boolean }>(withScope('/addons/collections/auto', q), { auto: on }),
    onSuccess: (r) => { queryClient.invalidateQueries({ queryKey: ['collections'] }); toast.success(r.auto ? 'Listo: desde ahora recuerda los pagos pendientes solo, todos los días' : 'Envíos automáticos apagados'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (error) return <Card title="Cobranza humanizada"><p className="text-sm">{error instanceof Error ? error.message : 'No disponible'} <Link to="/app/mi-plan" className="font-semibold underline">Ir a Mi plan</Link></p></Card>;
  if (isLoading || !data || !form) return <Loading />;
  const t = data.totals;
  const pending = data.receivables.filter((r) => r.status === 'PENDING');
  const paid = data.receivables.filter((r) => r.status === 'PAID').slice(0, 15);

  return (
    <>
      <PageHeader
        kicker="Incluido en tu plan"
        title="Cobranza"
        accent="humanizada"
        actions={canWrite && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setAdding({ search: '', contactId: '', concept: '', amount: '', dueDate: new Date().toISOString().slice(0, 10) })}><Plus size={14} /> Cuenta por cobrar</Button>
            <Button disabled={!pending.length || run.isPending} onClick={() => run.mutate()}><Play size={14} /> {run.isPending ? 'Enviando…' : 'Recordar ahora'}</Button>
          </div>
        )}
      />

      <div className={`mb-6 flex flex-wrap items-center justify-between gap-3 border-2 p-4 ${data.auto ? 'border-ink bg-ok-soft' : 'border-line bg-paper'}`}>
        <div className="text-sm">
          <p className="font-semibold">{data.auto ? 'Envíos automáticos encendidos' : 'Envíos automáticos apagados'}</p>
          <p className="text-ink-2">{data.auto ? `Cada día a las ${form.sendHour}:00 recuerda los pagos pendientes solo, respetando tus límites.` : 'Incluido en tu plan. Revisa los ajustes y enciéndelo cuando quieras; mientras tanto puedes enviar a mano.'}</p>
        </div>
        {canWrite && <Switch checked={data.auto} disabled={auto.isPending} onChange={(v) => auto.mutate(v)} label="Envíos automáticos" showLabel />}
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Por cobrar" value={fmtMoney(t.pendingAmount)} hint={`${t.pendingCount} cuentas`} />
        <Stat label="Vencido" value={fmtMoney(t.overdueAmount)} tone={t.overdueAmount ? 'warn' : undefined} />
        <Stat label="Recordatorios enviados" value={t.remindersSent} hint="Últimos 90 días" />
        <Stat label="Recuperado" value={fmtMoney(t.recoveredAmount)} hint={`${t.recoveredCount} pagos después de un recordatorio`} tone={t.recoveredAmount ? 'ok' : undefined} />
      </div>

      <Card kicker="Lo que te deben" title="Cuentas por cobrar" className="mb-6">
        {pending.length === 0 ? <p className="text-sm text-ink-3">No tienes cuentas pendientes. {form.autoFromOrders ? 'Los pedidos sin pagar aparecen aquí solos.' : ''}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b-2 border-ink text-left text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  <th className="py-2">Cliente</th><th className="py-2">Concepto</th><th className="py-2 text-right">Valor</th><th className="py-2 pl-6">Vence</th><th className="py-2">Recordatorios</th><th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id} className="border-b border-line align-top">
                    <td className="py-2.5">{r.contactName}{r.optOut && <span className="block text-xs text-bad">Pidió no recibir mensajes</span>}</td>
                    <td className="py-2.5">{r.concept}{r.fromOrder && <span className="block text-[11px] text-ink-3">De un pedido</span>}</td>
                    <td className="py-2.5 text-right font-semibold tabular-nums">{fmtMoney(r.amount)}</td>
                    <td className="whitespace-nowrap py-2.5 pl-6">
                      {new Date(r.dueDate).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}
                      {r.overdueDays > 0 && <span className="mt-1 block"><Badge tone="warn">Vencida hace {r.overdueDays} {r.overdueDays === 1 ? 'día' : 'días'}</Badge></span>}
                    </td>
                    <td className="py-2.5 text-xs">{r.remindersSent} de {form.maxReminders}{r.lastReminderAt ? ` · último ${timeAgo(r.lastReminderAt)}` : ''}</td>
                    <td className="py-2.5 text-right">
                      {canWrite && (
                        <span className="flex justify-end gap-1 whitespace-nowrap">
                          <Button size="sm" variant="outline" onClick={() => setStatus.mutate({ id: r.id, status: 'PAID' })}>Ya pagó</Button>
                          {!r.fromOrder && <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: r.id, status: 'CANCELLED' })}>Quitar</Button>}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {paid.length > 0 && (
          <p className="mt-4 text-xs text-ink-3">Pagadas hace poco: {paid.map((r) => `${r.contactName} (${fmtMoney(r.amount)})`).join(' · ')}</p>
        )}
      </Card>

      <Card kicker="Cómo recuerda" title="Ajustes">
        <fieldset disabled={!canWrite} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Primer recordatorio" hint="Días después de vencer"><Input type="number" min={0} max={30} value={form.firstReminderDays} onChange={(e) => setForm({ ...form, firstReminderDays: Number(e.target.value) })} /></Field>
            <Field label="Repetir cada" hint="Días"><Input type="number" min={1} max={15} value={form.repeatEveryDays} onChange={(e) => setForm({ ...form, repeatEveryDays: Number(e.target.value) })} /></Field>
            <Field label="Máximo de recordatorios"><Input type="number" min={1} max={6} value={form.maxReminders} onChange={(e) => setForm({ ...form, maxReminders: Number(e.target.value) })} /></Field>
            <Field label="Hora de envío">
              <Select value={form.sendHour} onChange={(e) => setForm({ ...form, sendHour: Number(e.target.value) })}>
                {Array.from({ length: 13 }, (_, i) => i + 8).map((h) => <option key={h} value={h}>{h}:00</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Plantilla aprobada (fuera de las 24 h)" hint="Categoría utilidad. Sin ella solo se recuerda a quien escribió hace poco.">
            <Select value={form.templateKey ?? ''} onChange={(e) => setForm({ ...form, templateKey: e.target.value || null })}>
              <option value="">Ninguna</option>
              {data.templates.map((x) => <option key={x.key} value={x.key}>{x.name}</option>)}
            </Select>
          </Field>
          <Field label="Mensaje (dentro de las 24 h)" hint="Variables: {{nombre}} {{empresa}} {{valor}} {{concepto}} {{fecha}} {{pago}}">
            <Textarea rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          </Field>
          <Switch checked={form.autoFromOrders} onChange={(v) => setForm({ ...form, autoFromOrders: v })} label="Cobrar solos los pedidos sin pagar" showLabel />
          {canWrite && <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>}
        </fieldset>
      </Card>

      <Modal open={!!adding} onClose={() => setAdding(null)} kicker="Cobranza" title="Nueva cuenta por cobrar">
        {adding && (
          <div className="space-y-4">
            <Field label="Cliente">
              <Input placeholder="Buscar por nombre o teléfono" value={adding.search} onChange={(e) => setAdding({ ...adding, search: e.target.value, contactId: '' })} />
            </Field>
            {!!contacts?.length && !adding.contactId && (
              <ul className="max-h-40 divide-y divide-line overflow-y-auto border-2 border-line text-sm">
                {contacts.slice(0, 8).map((c) => (
                  <li key={c.id}><button type="button" className="w-full cursor-pointer px-3 py-2 text-left hover:bg-bone-2" onClick={() => setAdding({ ...adding, contactId: c.id, search: c.name })}>{c.name} <span className="text-xs text-ink-3">{c.phone}</span></button></li>
                ))}
              </ul>
            )}
            <Field label="Concepto"><Input placeholder="Cuota de octubre" value={adding.concept} onChange={(e) => setAdding({ ...adding, concept: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Valor"><Input inputMode="numeric" placeholder="$ 0" value={adding.amount} onChange={(e) => setAdding({ ...adding, amount: e.target.value })} /></Field>
              <Field label="Vence"><Input type="date" value={adding.dueDate} onChange={(e) => setAdding({ ...adding, dueDate: e.target.value })} /></Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAdding(null)}>Cancelar</Button>
              <Button disabled={create.isPending || !adding.contactId} onClick={() => create.mutate()}>Guardar</Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
