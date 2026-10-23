import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '../../../components/ui';
import { PickCompany, useCompanyScope } from '../shared';
import {
  CHANNEL_LABEL, PRIORITY_LABEL, type ProductionSummary, type TeamResponse, StatusBadge, fmtDate, fromLocalInput, prodApi, useProdMutation,
} from './shared';

const STATUS_FILTERS = [
  ['OPEN', 'Abiertas'], ['NUEVA,BRIEF_INCOMPLETO', 'Brief por completar (incluye nuevas)'], ['NUEVA', 'Nuevas'], ['BRIEF_INCOMPLETO', 'Brief incompleto'], ['BRIEF_COMPLETO', 'Brief completo'], ['BUSCANDO_RECURSOS', 'Buscando recursos'],
  ['PROPUESTA_EN_PREPARACION', 'Propuesta en preparación'], ['COTIZACION_PENDIENTE_APROBACION', 'Cotización por aprobar'], ['COTIZACION_APROBADA', 'Cotización aprobada'],
  ['COTIZACION_ENVIADA', 'Cotización enviada'], ['PENDIENTE_RESPUESTA_CLIENTE', 'Esperando al cliente'], ['ACEPTADA_POR_CLIENTE', 'Aceptada'],
  ['CONFIRMACION_DE_RECURSOS_PENDIENTE', 'Confirmando recursos'], ['CONFIRMADA', 'Confirmada'], ['EN_PRODUCCION', 'En producción'], ['PENDIENTE_ENTREGA', 'Pendiente de entrega'],
  ['EN_PAUSA', 'En pausa'], ['CERRADA', 'Cerradas'], ['PERDIDA', 'Perdidas'], ['CANCELADA', 'Canceladas'],
] as const;

export function NewProductionModal({ q, open, onClose, canAssign }: { q: string; open: boolean; onClose: () => void; canAssign: boolean }) {
  const navigate = useNavigate();
  const empty = { clientName: '', brand: '', contactName: '', contactPhone: '', contactEmail: '', channel: 'WHATSAPP', referredBy: '', ownerId: '', priority: 'NORMAL', requestedDate: '', notes: '', description: '', isTest: false };
  const [f, setF] = useState(empty);
  const team = useQuery({ queryKey: ['production-team', q], queryFn: () => prodApi.get<TeamResponse>(q, '/team'), enabled: open });
  const create = useProdMutation(q, () => prodApi.post<any>(q, '', {
    clientName: f.clientName, brand: f.brand || undefined, contactName: f.contactName || undefined, contactPhone: f.contactPhone || undefined,
    contactEmail: f.contactEmail || undefined, channel: f.channel, referredBy: f.channel === 'REFERRAL' ? f.referredBy || undefined : undefined,
    ownerId: f.ownerId || undefined, priority: f.priority, requestedDate: f.requestedDate ? fromLocalInput(f.requestedDate) : undefined, notes: f.notes || undefined,
    brief: f.description ? { description: f.description } : undefined, isTest: f.isTest,
  }), 'Solicitud creada');
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open={open} onClose={onClose} kicker="Producciones" title="Nueva solicitud" wide>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const r: any = await create.mutateAsync(undefined).catch(() => null);
          if (r?.production?.id) {
            setF(empty);
            onClose();
            navigate(`/app/productions/${r.production.id}`);
          }
        }}
      >
        <p className="text-sm text-ink-2">Solo el cliente es obligatorio. El brief se completa después, en la ficha.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cliente o marca" required><Input value={f.clientName} onChange={set('clientName')} maxLength={120} required /></Field>
          <Field label="Marca (si es distinta)"><Input value={f.brand} onChange={set('brand')} maxLength={120} /></Field>
          <Field label="Persona de contacto"><Input value={f.contactName} onChange={set('contactName')} maxLength={120} /></Field>
          <Field label="Teléfono"><Input value={f.contactPhone} onChange={set('contactPhone')} maxLength={40} /></Field>
          <Field label="Correo"><Input type="email" value={f.contactEmail} onChange={set('contactEmail')} maxLength={160} /></Field>
          <Field label="Canal de origen">
            <Select value={f.channel} onChange={set('channel')}>{Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          {f.channel === 'REFERRAL' && <Field label="Referido por"><Input value={f.referredBy} onChange={set('referredBy')} maxLength={120} /></Field>}
          {canAssign && (
            <Field label="Responsable (booker)">
              <Select value={f.ownerId} onChange={set('ownerId')}>
                <option value="">Sin asignar</option>
                {team.data?.users.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Prioridad">
            <Select value={f.priority} onChange={set('priority')}>{Object.entries(PRIORITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
          <Field label="Fecha solicitada (si se conoce)"><Input type="datetime-local" value={f.requestedDate} onChange={set('requestedDate')} /></Field>
        </div>
        <Field label="Qué pidió el cliente"><Textarea rows={3} value={f.description} onChange={set('description')} maxLength={2000} /></Field>
        <Field label="Notas internas"><Textarea rows={2} value={f.notes} onChange={set('notes')} maxLength={4000} /></Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.isTest} onChange={(e) => setF({ ...f, isTest: e.target.checked })} />
          Es un registro de prueba (no cuenta en el inicio ni en las métricas)
        </label>
        <div className="flex gap-2">
          <Button type="submit" disabled={create.isPending || !f.clientName.trim()}>{create.isPending ? 'Creando…' : 'Crear solicitud'}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function ProductionsList() {
  const { ready, q } = useCompanyScope();
  const [sp] = useSearchParams();
  const [filters, setFilters] = useState({ q: '', status: sp.get('status') ?? 'OPEN', ownerId: sp.get('ownerId') ?? '', channel: '', from: '', to: '', sort: 'updated', includeTest: false, page: 1 });
  const [creating, setCreating] = useState(false);
  const params = new URLSearchParams({
    ...(filters.q ? { q: filters.q } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
    ...(filters.channel ? { channel: filters.channel } : {}), ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: `${filters.to}T23:59:59` } : {}),
    sort: filters.sort, includeTest: String(filters.includeTest), page: String(filters.page), pageSize: '25',
  });
  const list = useQuery({ queryKey: ['productions', q, params.toString()], queryFn: () => prodApi.get<{ total: number; page: number; pageSize: number; items: ProductionSummary[] }>(q, `?${params}`), enabled: ready });
  const team = useQuery({ queryKey: ['production-team', q], queryFn: () => prodApi.get<TeamResponse>(q, '/team'), enabled: ready });
  const can = new Set(team.data?.me.permissions ?? []);
  const set = (k: keyof typeof filters) => (e: { target: { value: string } }) => setFilters({ ...filters, [k]: e.target.value, page: 1 });

  if (!ready) return <PickCompany />;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;

  return (
    <>
      <PageHeader kicker="Producciones" title="Solicitudes" actions={can.has('edit') ? <Button onClick={() => setCreating(true)}>+ Nueva solicitud</Button> : undefined} />
      <div className="mb-4 grid gap-2 md:grid-cols-4 lg:grid-cols-7">
        <Input aria-label="Buscar" placeholder="Buscar código, marca o contacto" value={filters.q} onChange={set('q')} className="md:col-span-2" />
        <Select aria-label="Estado" value={filters.status} onChange={set('status')}>
          <option value="">Todos los estados</option>
          {STATUS_FILTERS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select aria-label="Responsable" value={filters.ownerId} onChange={set('ownerId')}>
          <option value="">Todos los responsables</option>
          <option value="none">Sin responsable</option>
          {team.data?.users.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        <Select aria-label="Canal" value={filters.channel} onChange={set('channel')}>
          <option value="">Todos los canales</option>
          {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input aria-label="Fecha desde" type="date" value={filters.from} onChange={set('from')} />
        <Input aria-label="Fecha hasta" type="date" value={filters.to} onChange={set('to')} />
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm">
        <label className="flex items-center gap-2">
          Ordenar por
          <Select aria-label="Orden" value={filters.sort} onChange={set('sort')} className="!w-auto">
            <option value="updated">Última actualización</option>
            <option value="nextAction">Próxima acción</option>
            <option value="requestedDate">Fecha de producción</option>
          </Select>
        </label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={filters.includeTest} onChange={(e) => setFilters({ ...filters, includeTest: e.target.checked, page: 1 })} /> Incluir registros de prueba</label>
      </div>

      {list.isLoading ? <Loading /> : list.isError ? (
        <EmptyState title="No se pudo cargar" hint={(list.error as Error).message} />
      ) : !list.data?.items.length ? (
        <EmptyState title="Sin solicitudes" hint={filters.q || filters.status !== 'OPEN' ? 'Ninguna coincide con los filtros.' : 'Cuando llegue una solicitud, regístrala aquí. Las integraciones pueden crearlas después.'} action={can.has('edit') ? <Button onClick={() => setCreating(true)}>Crear la primera</Button> : undefined} />
      ) : (
        <div className="overflow-x-auto border-2 border-ink bg-paper">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b-2 border-ink text-left text-xs uppercase tracking-[0.08em] text-ink-3">
                <th className="px-3 py-2">Código</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">Estado</th><th className="px-3 py-2">Responsable</th>
                <th className="px-3 py-2">Canal</th><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Próxima acción</th><th className="px-3 py-2">Actualizada</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-bone">
                  <td className="px-3 py-2 font-mono"><Link to={`/app/productions/${p.id}`} className="font-semibold underline-offset-2 hover:underline">{p.code}</Link>{p.isTest && <span className="ml-1"><Badge tone="warn">Prueba</Badge></span>}</td>
                  <td className="px-3 py-2"><Link to={`/app/productions/${p.id}`} className="hover:underline">{p.clientName}</Link>{p.contactName && <span className="block text-xs text-ink-3">{p.contactName}</span>}</td>
                  <td className="px-3 py-2"><StatusBadge status={p.status} label={p.statusLabel} /></td>
                  <td className="px-3 py-2">{p.ownerName ?? <span className="text-warn">Sin asignar</span>}</td>
                  <td className="px-3 py-2">{CHANNEL_LABEL[p.channel] ?? p.channel}</td>
                  <td className="px-3 py-2">{fmtDate(p.requestedDate)}</td>
                  <td className="px-3 py-2">{p.nextAction ?? '—'}{p.nextActionDueAt && <span className="block text-xs text-ink-3">{fmtDate(p.nextActionDueAt, true)}</span>}</td>
                  <td className="px-3 py-2 text-xs text-ink-3">{fmtDate(p.updatedAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.total > list.data.pageSize && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span>{list.data.total} solicitudes · página {list.data.page} de {pages}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="outline" disabled={filters.page <= 1} onClick={() => setFilters({ ...filters, page: filters.page - 1 })}>Anterior</Button>
            <Button size="sm" variant="outline" disabled={filters.page >= pages} onClick={() => setFilters({ ...filters, page: filters.page + 1 })}>Siguiente</Button>
          </span>
        </div>
      )}
      <NewProductionModal q={q} open={creating} onClose={() => setCreating(false)} canAssign={can.has('assign')} />
    </>
  );
}
