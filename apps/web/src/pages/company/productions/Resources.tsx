import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Textarea } from '../../../components/ui';
import { PickCompany, useCompanyScope } from '../shared';
import { RESOURCE_KIND_LABEL, type TeamResponse, UNIT_LABEL, VALUE_STATUS_LABEL, fmtMoney, prodApi, useProdMutation } from './shared';

/** Catálogo: modelos, locaciones, fotógrafos y proveedores. Sin tarifas por defecto. */
export default function ProductionResources() {
  const { ready, q } = useCompanyScope();
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const [rateFor, setRateFor] = useState<any | null>(null);
  const list = useQuery({ queryKey: ['production-resources', q, kind, text], queryFn: () => prodApi.get<any[]>(q, `/resources?${new URLSearchParams({ ...(kind ? { kind } : {}), ...(text ? { q: text } : {}) })}`), enabled: ready });
  const team = useQuery({ queryKey: ['production-team', q], queryFn: () => prodApi.get<TeamResponse>(q, '/team'), enabled: ready });
  const can = new Set(team.data?.me.permissions ?? []);
  if (!ready) return <PickCompany />;
  return (
    <>
      <PageHeader kicker="Producciones" title="Modelos y proveedores" actions={can.has('resources') ? <Button onClick={() => setEditing({ kind: kind || 'MODEL', name: '', active: true, owned: false, attrs: {}, fileRefs: [] })}>+ Agregar</Button> : undefined} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Tipo" className="!w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">Todos los tipos</option>
          {Object.entries(RESOURCE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input aria-label="Buscar recurso" className="!w-72" placeholder="Buscar por nombre o contacto" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <p className="mb-4 text-sm text-ink-2">Las tarifas solo se ven con permiso financiero y nunca se completan solas: si no hay un valor confirmado, queda pendiente. Las fotos se referencian (Dropbox o enlace) sin copiarlas.</p>
      {list.isLoading ? <Loading /> : !list.data?.length ? (
        <EmptyState title="Sin recursos" hint="Agrega los modelos, la locación propia, fotógrafos y proveedores con los que trabaja la agencia." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((r) => (
            <div key={r.id} className="border-2 border-ink bg-paper p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-xs text-ink-3">{RESOURCE_KIND_LABEL[r.kind]}{r.owned ? ' · propia' : ''}{r.contactName ? ` · ${r.contactName}` : ''}</p>
                </div>
                <Badge tone={r.active ? 'ok' : 'neutral'}>{r.active ? 'Activo' : 'Inactivo'}</Badge>
              </div>
              {(r.phone || r.email) && <p className="mt-1 text-xs">{[r.phone, r.email].filter(Boolean).join(' · ')}</p>}
              {r.notes && <p className="mt-1 text-xs text-ink-2">{r.notes}</p>}
              {Object.entries(r.attrs ?? {}).filter(([, v]) => v).length > 0 && <p className="mt-1 text-xs text-ink-3">{Object.entries(r.attrs).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
              <p className="mt-1 text-xs text-ink-3">{r.fileRefs.length} archivo(s) referenciados</p>
              {r.ratesHidden ? <p className="mt-2 text-xs text-ink-3">Tarifas ocultas para tu perfil.</p> : (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {(r.rates ?? []).length === 0 && <li className="text-ink-3">Sin tarifas registradas.</li>}
                  {(r.rates ?? []).map((x: any) => <li key={x.id}>{x.kind === 'COST' ? 'Costo' : 'Precio'} · {UNIT_LABEL[x.unit] ?? x.unit}: <b>{fmtMoney(x.amount, x.currency)}</b> ({VALUE_STATUS_LABEL[x.status] ?? (x.status === 'HISTORICAL' ? 'Histórico' : x.status)})</li>)}
                </ul>
              )}
              <div className="mt-3 flex gap-2">
                {can.has('resources') && <Button size="sm" variant="outline" onClick={() => setEditing(r)}>Editar</Button>}
                {can.has('rates') && <Button size="sm" variant="ghost" onClick={() => setRateFor(r)}>+ Tarifa</Button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <ResourceModal q={q} resource={editing} onClose={() => setEditing(null)} />}
      {rateFor && <RateModal q={q} resource={rateFor} onClose={() => setRateFor(null)} />}
    </>
  );
}

function ResourceModal({ q, resource, onClose }: { q: string; resource: any; onClose: () => void }) {
  const [f, setF] = useState({ ...resource, attrsText: Object.entries(resource.attrs ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'), refsText: (resource.fileRefs ?? []).map((x: any) => `${x.provider} | ${x.ref} | ${x.label ?? ''}`).join('\n') });
  const save = useProdMutation(q, () => {
    const attrs = Object.fromEntries(String(f.attrsText).split('\n').map((l: string) => l.split(':')).filter((p: string[]) => p.length >= 2 && p[0].trim()).map((p: string[]) => [p[0].trim(), p.slice(1).join(':').trim()]));
    const fileRefs = String(f.refsText).split('\n').map((l: string) => l.split('|').map((x) => x.trim())).filter((p: string[]) => p[1]).map(([provider, ref, label]: string[]) => ({ provider: (provider || 'OTHER').toUpperCase(), ref, label: label || undefined }));
    const body = { kind: f.kind, name: f.name, contactName: f.contactName, phone: f.phone, email: f.email, notes: f.notes, active: f.active, owned: f.owned, attrs, fileRefs };
    return resource.id ? prodApi.patch(q, `/resources/${resource.id}`, body) : prodApi.post(q, '/resources', body);
  }, 'Recurso guardado');
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} kicker="Catálogo" title={resource.id ? 'Editar recurso' : 'Nuevo recurso'} wide>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); await save.mutateAsync(undefined).then(onClose).catch(() => undefined); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo"><Select value={f.kind} onChange={set('kind')}>{Object.entries(RESOURCE_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Field label="Nombre" required><Input value={f.name ?? ''} onChange={set('name')} /></Field>
          <Field label="Contacto"><Input value={f.contactName ?? ''} onChange={set('contactName')} /></Field>
          <Field label="Teléfono"><Input value={f.phone ?? ''} onChange={set('phone')} /></Field>
          <Field label="Correo"><Input value={f.email ?? ''} onChange={set('email')} /></Field>
          <div className="flex items-end gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Activo</label>
            {f.kind === 'LOCATION' && <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.owned} onChange={(e) => setF({ ...f, owned: e.target.checked })} /> Locación propia</label>}
          </div>
        </div>
        <Field label="Atributos (uno por línea, «clave: valor»)" hint="Ej.: ciudad: Medellín · especialidad: moda"><Textarea rows={3} value={f.attrsText} onChange={set('attrsText')} /></Field>
        <Field label="Archivos (uno por línea, «DROPBOX | ruta | etiqueta» o «URL | https://… | etiqueta»)" hint="Solo referencias: no se descargan ni se verifican"><Textarea rows={3} value={f.refsText} onChange={set('refsText')} /></Field>
        <Field label="Notas"><Textarea rows={2} value={f.notes ?? ''} onChange={set('notes')} /></Field>
        <div className="flex gap-2"><Button type="submit" disabled={save.isPending || !String(f.name ?? '').trim()}>Guardar</Button><Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button></div>
      </form>
    </Modal>
  );
}

function RateModal({ q, resource, onClose }: { q: string; resource: any; onClose: () => void }) {
  const [f, setF] = useState({ kind: 'COST', unit: 'FULL_DAY', amount: '', status: 'PENDING', notes: '' });
  const save = useProdMutation(q, () => prodApi.post(q, `/resources/${resource.id}/rates`, { ...f, amount: f.amount === '' ? null : Number(f.amount) }), 'Tarifa registrada');
  return (
    <Modal open onClose={onClose} kicker={resource.name} title="Registrar tarifa">
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); await save.mutateAsync(undefined).then(onClose).catch(() => undefined); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tipo"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="COST">Costo (lo que cobra el proveedor)</option><option value="PRICE">Precio al cliente</option></Select></Field>
          <Field label="Unidad"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{['HOUR', 'HALF_DAY', 'FULL_DAY', 'DAY', 'PROJECT', 'OTHER'].map((k) => <option key={k} value={k}>{UNIT_LABEL[k]}</option>)}</Select></Field>
          <Field label="Valor (vacío = pendiente)"><Input type="number" min={0} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label="Estado"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="PENDING">Pendiente de confirmar</option><option value="CONFIRMED">Confirmado</option><option value="HISTORICAL">Histórico (referencia)</option></Select></Field>
        </div>
        <Field label="Notas"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Ej.: tarifa negociada en la producción PR-0003" /></Field>
        <div className="flex gap-2"><Button type="submit" disabled={save.isPending}>Registrar</Button><Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button></div>
      </form>
    </Modal>
  );
}
