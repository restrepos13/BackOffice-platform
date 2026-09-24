import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { Company, Product, ProductionArea } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Switch, Tabs, Textarea,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const TEMPLATE_KEYS: Array<{ key: string; label: string; vars: string }> = [
  { key: 'nuevo_pedido', label: 'Nuevo pedido (a las áreas)', vars: '{{cliente}} {{items}} {{fecha}} {{hora}}' },
  { key: 'recordatorio_area', label: 'Recordatorio a áreas', vars: '{{cliente}} {{items}} {{fecha}} {{hora}}' },
  { key: 'recordatorio_despacho', label: 'Recordatorio a despacho', vars: '{{cliente}} {{items}} {{fecha}} {{hora}} {{direccion}}' },
  { key: 'recordatorio_cliente', label: 'Recordatorio al cliente (día de entrega)', vars: '{{contacto}} {{items}} {{hora}}' },
];

/* ─── Productos ─────────────────────────────────────────────────────── */

function ProductsTab({ q, companyId, canWrite }: { q: string; companyId: string | null; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Product | null | 'new'>(null);
  const { data: products, isLoading } = useQuery({
    queryKey: ['products-all', q],
    queryFn: () => api.get<Product[]>(withScope('/catalog/products?all=1', q)),
  });
  const { data: areas } = useQuery({
    queryKey: ['areas', q],
    queryFn: () => api.get<ProductionArea[]>(withScope('/catalog/areas', q)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/catalog/products/${id}`),
    onSuccess: () => {
      toast.success('Producto eliminado');
      queryClient.invalidateQueries({ queryKey: ['products-all'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-3">
      {canWrite && (
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus size={13} /> Nuevo producto
        </Button>
      )}
      <div className="divide-y divide-line border-2 border-ink bg-paper">
        {products?.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {p.name} <span className="font-normal text-ink-3">· {p.unit}</span>
                {!p.active && <Badge tone="neutral">Inactivo</Badge>}
              </p>
              <p className="text-xs text-ink-3">
                {p.category ?? 'Sin categoría'}
                {p.productionArea ? ` · Área: ${p.productionArea.name}` : ' · Sin área asignada'}
                {p.presentations.length ? ` · ${p.presentations.join(' / ')}` : ''}
              </p>
            </div>
            {canWrite && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(p)}>Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(p.id)} aria-label={`Eliminar ${p.name}`}>
                  <Trash2 size={13} />
                </Button>
              </div>
            )}
          </div>
        ))}
        {(products?.length ?? 0) === 0 && (
          <p className="px-4 py-6 text-center text-sm text-ink-3">Sin productos en el catálogo.</p>
        )}
      </div>

      {editing && (
        <ProductModal
          product={editing === 'new' ? null : editing}
          areas={areas ?? []}
          companyId={companyId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProductModal({ product, areas, companyId, onClose }: {
  product: Product | null;
  areas: ProductionArea[];
  companyId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category ?? '');
  const [unit, setUnit] = useState(product?.unit ?? 'unidad');
  const [description, setDescription] = useState(product?.description ?? '');
  const [areaId, setAreaId] = useState(product?.productionAreaId ?? '');
  const [presentations, setPresentations] = useState((product?.presentations ?? []).join(', '));
  const [active, setActive] = useState(product?.active ?? true);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, category, unit, description, active,
        productionAreaId: areaId || null,
        presentations: presentations.split(',').map((s) => s.trim()).filter(Boolean),
        ...(companyId ? { companyId } : {}),
      };
      return product
        ? api.patch(`/catalog/products/${product.id}`, body)
        : api.post('/catalog/products', body);
    },
    onSuccess: () => {
      toast.success('Producto guardado');
      queryClient.invalidateQueries({ queryKey: ['products-all'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <Modal open onClose={onClose} kicker="Catálogo" title={product ? product.name : 'Nuevo producto'}>
      <div className="space-y-4">
        <Field label="Nombre" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Categoría" hint="Sirve para las reglas de distribución">
            <Input value={category ?? ''} onChange={(e) => setCategory(e.target.value)} placeholder="desayunos, almuerzos…" />
          </Field>
          <Field label="Unidad">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="porción, unidad, bandeja…" />
          </Field>
        </div>
        <Field label="Área de producción por defecto">
          <Select value={areaId ?? ''} onChange={(e) => setAreaId(e.target.value)}>
            <option value="">Sin área (usar reglas)</option>
            {areas.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Presentaciones" hint="Separadas por coma">
          <Input value={presentations} onChange={(e) => setPresentations(e.target.value)} placeholder="individual, bandeja x10…" />
        </Field>
        <Field label="Descripción" hint="La IA la usa para ofrecer el producto">
          <Textarea rows={2} value={description ?? ''} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex items-center gap-3">
          <Switch checked={active} onChange={setActive} label="Producto activo" />
          <span className="text-sm">{active ? 'Activo (la IA lo ofrece)' : 'Inactivo'}</span>
        </div>
        <Button className="w-full" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar producto'}
        </Button>
      </div>
    </Modal>
  );
}

/* ─── Áreas ─────────────────────────────────────────────────────────── */

function AreasTab({ q, companyId, canWrite }: { q: string; companyId: string | null; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ProductionArea | null | 'new'>(null);
  const { data: areas, isLoading } = useQuery({
    queryKey: ['areas', q],
    queryFn: () => api.get<ProductionArea[]>(withScope('/catalog/areas', q)),
  });

  if (isLoading) return <Loading />;

  return (
    <div className="space-y-3">
      {canWrite && (
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus size={13} /> Nueva área
        </Button>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {areas?.map((a) => (
          <article key={a.id} className="border-2 border-ink bg-paper p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="display text-lg leading-tight">{a.name}</p>
                {a.description && <p className="text-xs text-ink-3">{a.description}</p>}
              </div>
              {canWrite && (
                <Button size="sm" variant="outline" onClick={() => setEditing(a)}>Editar</Button>
              )}
            </div>
            <p className="mt-2 text-xs text-ink-2">
              Aviso por <strong>{a.notifyChannel}</strong>
              {a.notifyTarget ? ` → ${a.notifyTarget}` : ''} · recordatorio {a.reminderHoursBefore} h antes
            </p>
            {(a.responsibles?.length ?? 0) > 0 && (
              <p className="mt-1 text-xs text-ink-3">
                Responsables: {a.responsibles.map((r) => r.name).join(', ')}
              </p>
            )}
          </article>
        ))}
      </div>
      {(areas?.length ?? 0) === 0 && (
        <p className="py-6 text-center text-sm text-ink-3">Sin áreas de producción.</p>
      )}

      {editing && (
        <AreaModal
          area={editing === 'new' ? null : editing}
          companyId={companyId}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AreaModal({ area, companyId, onClose }: {
  area: ProductionArea | null;
  companyId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(area?.name ?? '');
  const [description, setDescription] = useState(area?.description ?? '');
  const [notifyChannel, setNotifyChannel] = useState(area?.notifyChannel ?? 'PANEL');
  const [notifyTarget, setNotifyTarget] = useState(area?.notifyTarget ?? '');
  const [hoursBefore, setHoursBefore] = useState(String(area?.reminderHoursBefore ?? 24));
  const [responsibles, setResponsibles] = useState(
    (area?.responsibles ?? []).map((r) => r.name).join(', '),
  );

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, description, notifyChannel, notifyTarget,
        reminderHoursBefore: Number(hoursBefore),
        responsibles: responsibles.split(',').map((s) => ({ name: s.trim() })).filter((r) => r.name),
        ...(companyId ? { companyId } : {}),
      };
      return area
        ? api.patch(`/catalog/areas/${area.id}`, body)
        : api.post('/catalog/areas', body);
    },
    onSuccess: () => {
      toast.success('Área guardada');
      queryClient.invalidateQueries({ queryKey: ['areas'] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <Modal open onClose={onClose} kicker="Producción" title={area ? area.name : 'Nueva área'}>
      <div className="space-y-4">
        <Field label="Nombre" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cocina, Empaque, Despacho…" />
        </Field>
        <Field label="Descripción">
          <Input value={description ?? ''} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Canal de aviso">
            <Select value={notifyChannel} onChange={(e) => setNotifyChannel(e.target.value as any)}>
              <option value="PANEL">Panel (vista por área)</option>
              <option value="EMAIL">Correo</option>
              <option value="WHATSAPP">WhatsApp</option>
            </Select>
          </Field>
          <Field label="Destino del aviso" hint="Correo o número según el canal">
            <Input value={notifyTarget ?? ''} onChange={(e) => setNotifyTarget(e.target.value)} />
          </Field>
        </div>
        <Field label="Recordatorio (horas antes de la entrega)">
          <Input type="number" min={1} value={hoursBefore} onChange={(e) => setHoursBefore(e.target.value)} />
        </Field>
        <Field label="Responsables" hint="Nombres separados por coma">
          <Input value={responsibles} onChange={(e) => setResponsibles(e.target.value)} />
        </Field>
        <Button className="w-full" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar área'}
        </Button>
      </div>
    </Modal>
  );
}

/* ─── Config sobre orderConfig (agenda, reglas, plantillas, FAQs) ───── */

function useOrderConfig(companyId: string | null) {
  const queryClient = useQueryClient();
  const { data: company, isLoading } = useQuery({
    queryKey: ['company', companyId],
    queryFn: () => api.get<Company>(`/companies/${companyId}`),
    enabled: !!companyId,
  });
  const save = useMutation({
    mutationFn: (orderConfig: Record<string, any>) =>
      api.patch(`/companies/${companyId}`, { orderConfig }),
    onSuccess: () => {
      toast.success('Configuración guardada');
      queryClient.invalidateQueries({ queryKey: ['company', companyId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return { company, config: company?.orderConfig ?? {}, isLoading, save };
}

function AgendaTab({ companyId, canWrite }: { companyId: string | null; canWrite: boolean }) {
  const { config, isLoading, save } = useOrderConfig(companyId);
  const [draft, setDraft] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    if (!isLoading && draft === null) setDraft(JSON.parse(JSON.stringify(config)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (isLoading || !draft) return <Loading />;

  const schedule = draft.schedule ?? { days: [], open: '06:00', close: '16:00' };
  const days: number[] = schedule.days ?? [];
  const slots: any[] = draft.slots ?? [];

  const toggleDay = (d: number) =>
    setDraft({
      ...draft,
      schedule: {
        ...schedule,
        days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort(),
      },
    });

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <p className="kicker mb-2">Días de entrega</p>
        <div className="flex flex-wrap gap-2">
          {DAY_NAMES.map((label, d) => (
            <button
              key={d}
              onClick={() => canWrite && toggleDay(d)}
              className={`cursor-pointer border-2 border-ink px-3 py-1.5 text-xs font-semibold uppercase ${
                days.includes(d) ? 'bg-ink text-bone' : 'bg-paper hover:bg-bone-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Apertura">
          <Input type="time" value={schedule.open ?? ''} onChange={(e) => setDraft({ ...draft, schedule: { ...schedule, open: e.target.value } })} />
        </Field>
        <Field label="Cierre">
          <Input type="time" value={schedule.close ?? ''} onChange={(e) => setDraft({ ...draft, schedule: { ...schedule, close: e.target.value } })} />
        </Field>
        <Field label="Corte de pedidos" hint="Hora límite del día ANTERIOR para pedir">
          <Input type="time" value={draft.orderCutoff ?? ''} onChange={(e) => setDraft({ ...draft, orderCutoff: e.target.value })} />
        </Field>
        <Field label="Anticipación mínima (horas)">
          <Input type="number" min={0} value={draft.minLeadHours ?? 0} onChange={(e) => setDraft({ ...draft, minLeadHours: Number(e.target.value) })} />
        </Field>
        <Field label="Capacidad máxima por franja">
          <Input type="number" min={1} value={draft.maxPerSlot ?? ''} onChange={(e) => setDraft({ ...draft, maxPerSlot: Number(e.target.value) || null })} />
        </Field>
        <Field label="Festivos" hint="Fechas YYYY-MM-DD separadas por coma">
          <Input
            value={(draft.holidays ?? []).join(', ')}
            onChange={(e) => setDraft({ ...draft, holidays: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          />
        </Field>
      </div>

      <div>
        <p className="kicker mb-2">Franjas de entrega</p>
        <div className="space-y-2">
          {slots.map((slot: any, idx: number) => (
            <div key={idx} className="grid gap-2 border-2 border-line p-2 md:grid-cols-[1fr_120px_120px_auto]">
              <Input value={slot.label ?? ''} placeholder="Nombre" aria-label="Nombre de franja"
                onChange={(e) => setDraft({ ...draft, slots: slots.map((s, i) => (i === idx ? { ...s, label: e.target.value, key: e.target.value.toLowerCase().replace(/\s+/g, '_') } : s)) })} />
              <Input type="time" value={slot.from ?? ''} aria-label="Desde"
                onChange={(e) => setDraft({ ...draft, slots: slots.map((s, i) => (i === idx ? { ...s, from: e.target.value } : s)) })} />
              <Input type="time" value={slot.to ?? ''} aria-label="Hasta"
                onChange={(e) => setDraft({ ...draft, slots: slots.map((s, i) => (i === idx ? { ...s, to: e.target.value } : s)) })} />
              <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, slots: slots.filter((_, i) => i !== idx) })}>
                Quitar
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" className="mt-2"
          onClick={() => setDraft({ ...draft, slots: [...slots, { key: '', label: '', from: '06:00', to: '12:00' }] })}>
          + Agregar franja
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Aviso a áreas (h antes)">
          <Input type="number" min={1} value={draft.reminderDefaults?.areaHours ?? 24}
            onChange={(e) => setDraft({ ...draft, reminderDefaults: { ...draft.reminderDefaults, areaHours: Number(e.target.value) } })} />
        </Field>
        <Field label="Aviso a despacho (h antes)">
          <Input type="number" min={1} value={draft.reminderDefaults?.dispatchHours ?? 3}
            onChange={(e) => setDraft({ ...draft, reminderDefaults: { ...draft.reminderDefaults, dispatchHours: Number(e.target.value) } })} />
        </Field>
        <Field label="Aviso al cliente (hora del día)">
          <Input type="number" min={0} max={23} value={draft.reminderDefaults?.clientSameDayHour ?? 7}
            onChange={(e) => setDraft({ ...draft, reminderDefaults: { ...draft.reminderDefaults, clientSameDayHour: Number(e.target.value) } })} />
        </Field>
      </div>

      {canWrite && (
        <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Guardando…' : 'Guardar agenda'}
        </Button>
      )}
    </div>
  );
}

function RulesTab({ companyId, canWrite, q }: { companyId: string | null; canWrite: boolean; q: string }) {
  const { config, isLoading, save } = useOrderConfig(companyId);
  const [rules, setRules] = useState<any[] | null>(null);
  const { data: areas } = useQuery({
    queryKey: ['areas', q],
    queryFn: () => api.get<ProductionArea[]>(withScope('/catalog/areas', q)),
  });
  const { data: products } = useQuery({
    queryKey: ['products-all', q],
    queryFn: () => api.get<Product[]>(withScope('/catalog/products?all=1', q)),
  });

  useEffect(() => {
    if (!isLoading && rules === null) setRules(config.distributionRules ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (isLoading || rules === null) return <Loading />;

  const setRule = (idx: number, patch: Record<string, any>) =>
    setRules(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  return (
    <div className="max-w-4xl space-y-4">
      <p className="text-sm text-ink-2">
        Cada ítem de un pedido se asigna a un área así: primero gana la regla que
        coincida (menor prioridad primero), después el área por defecto del
        producto. Sin coincidencia, el ítem queda sin área y se ve en Pedidos.
      </p>
      <div className="space-y-2">
        {rules.map((rule, idx) => (
          <div key={idx} className="grid items-center gap-2 border-2 border-line p-2 md:grid-cols-[1fr_1fr_90px_90px_1fr_70px_auto]">
            <Select value={rule.productId ?? ''} aria-label="Producto"
              onChange={(e) => setRule(idx, { productId: e.target.value || undefined })}>
              <option value="">Cualquier producto</option>
              {products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Input value={rule.category ?? ''} placeholder="Categoría…" aria-label="Categoría"
              onChange={(e) => setRule(idx, { category: e.target.value || undefined })} />
            <Input type="number" value={rule.minQuantity ?? ''} placeholder="Mín." aria-label="Cantidad mínima"
              onChange={(e) => setRule(idx, { minQuantity: e.target.value ? Number(e.target.value) : undefined })} />
            <Input type="number" value={rule.maxQuantity ?? ''} placeholder="Máx." aria-label="Cantidad máxima"
              onChange={(e) => setRule(idx, { maxQuantity: e.target.value ? Number(e.target.value) : undefined })} />
            <Select value={rule.areaId ?? ''} aria-label="Área destino"
              onChange={(e) => setRule(idx, { areaId: e.target.value })}>
              <option value="" disabled>→ Área…</option>
              {areas?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <Input type="number" value={rule.priority ?? 100} aria-label="Prioridad"
              onChange={(e) => setRule(idx, { priority: Number(e.target.value) })} />
            <Button size="sm" variant="ghost" onClick={() => setRules(rules.filter((_, i) => i !== idx))}>
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setRules([...rules, { areaId: '', priority: 100 }])}>
          + Agregar regla
        </Button>
        {canWrite && (
          <Button size="sm" disabled={save.isPending || rules.some((r) => !r.areaId)}
            onClick={() => save.mutate({ ...config, distributionRules: rules })}>
            {save.isPending ? 'Guardando…' : 'Guardar reglas'}
          </Button>
        )}
      </div>
    </div>
  );
}

function TemplatesTab({ companyId, canWrite }: { companyId: string | null; canWrite: boolean }) {
  const { config, isLoading, save } = useOrderConfig(companyId);
  const [templates, setTemplates] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    if (!isLoading && templates === null) setTemplates(config.reminderTemplates ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (isLoading || templates === null) return <Loading />;

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-ink-2">
        Texto de los recordatorios automáticos. Vacío = plantilla estándar. Las
        variables entre llaves se reemplazan solas.
      </p>
      {TEMPLATE_KEYS.map(({ key, label, vars }) => (
        <Field key={key} label={label} hint={`Variables: ${vars}`}>
          <Textarea
            rows={2}
            value={templates[key] ?? ''}
            placeholder="Usar plantilla estándar"
            onChange={(e) => setTemplates({ ...templates, [key]: e.target.value })}
          />
        </Field>
      ))}
      {canWrite && (
        <Button
          disabled={save.isPending}
          onClick={() => {
            const clean = Object.fromEntries(
              Object.entries(templates).filter(([, v]) => v.trim()),
            );
            save.mutate({ ...config, reminderTemplates: clean });
          }}
        >
          {save.isPending ? 'Guardando…' : 'Guardar plantillas'}
        </Button>
      )}
    </div>
  );
}

function KnowledgeTab({ companyId, canWrite }: { companyId: string | null; canWrite: boolean }) {
  const { config, isLoading, save } = useOrderConfig(companyId);
  const [faqs, setFaqs] = useState<Array<{ question: string; answer: string }> | null>(null);

  useEffect(() => {
    if (!isLoading && faqs === null) setFaqs(config.knowledgeBase ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);

  if (isLoading || faqs === null) return <Loading />;

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-ink-2">
        Preguntas frecuentes que la IA responde sin escalar (formas de pago,
        cobertura, políticas). Solo responde con lo que esté aquí: no inventa.
      </p>
      <div className="space-y-3">
        {faqs.map((faq, idx) => (
          <div key={idx} className="space-y-2 border-2 border-line p-3">
            <div className="flex items-start gap-2">
              <Input
                value={faq.question} placeholder="Pregunta (¿Cómo se paga?)"
                onChange={(e) => setFaqs(faqs.map((f, i) => (i === idx ? { ...f, question: e.target.value } : f)))}
                aria-label="Pregunta"
              />
              <Button size="sm" variant="ghost" onClick={() => setFaqs(faqs.filter((_, i) => i !== idx))}>
                <Trash2 size={13} />
              </Button>
            </div>
            <Textarea
              rows={2} value={faq.answer} placeholder="Respuesta oficial…"
              onChange={(e) => setFaqs(faqs.map((f, i) => (i === idx ? { ...f, answer: e.target.value } : f)))}
              aria-label="Respuesta"
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setFaqs([...faqs, { question: '', answer: '' }])}>
          + Agregar pregunta
        </Button>
        {canWrite && (
          <Button size="sm" disabled={save.isPending}
            onClick={() => save.mutate({
              ...config,
              knowledgeBase: faqs.filter((f) => f.question.trim() && f.answer.trim()),
            })}>
            {save.isPending ? 'Guardando…' : 'Guardar conocimiento'}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ─── Página ────────────────────────────────────────────────────────── */

export default function OrdersSettings() {
  const { ready, q, canWrite, companyId: scopedId } = useCompanyScope();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('productos');
  const companyId = scopedId ?? user?.companyId ?? null;

  if (!ready) return <PickCompany />;

  return (
    <>
      <PageHeader
        kicker="Módulo de pedidos"
        title="Configuración"
        actions={
          <Button size="sm" variant="outline" onClick={() => navigate('/app/orders')}>
            <ArrowLeft size={13} /> Pedidos
          </Button>
        }
      />
      <div className="mb-5">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'productos', label: 'Productos' },
            { id: 'areas', label: 'Áreas' },
            { id: 'reglas', label: 'Distribución' },
            { id: 'agenda', label: 'Agenda' },
            { id: 'plantillas', label: 'Recordatorios' },
            { id: 'conocimiento', label: 'Conocimiento' },
          ]}
        />
      </div>
      {tab === 'productos' && <ProductsTab q={q} companyId={companyId} canWrite={canWrite} />}
      {tab === 'areas' && <AreasTab q={q} companyId={companyId} canWrite={canWrite} />}
      {tab === 'reglas' && <RulesTab companyId={companyId} canWrite={canWrite} q={q} />}
      {tab === 'agenda' && <AgendaTab companyId={companyId} canWrite={canWrite} />}
      {tab === 'plantillas' && <TemplatesTab companyId={companyId} canWrite={canWrite} />}
      {tab === 'conocimiento' && <KnowledgeTab companyId={companyId} canWrite={canWrite} />}
    </>
  );
}
