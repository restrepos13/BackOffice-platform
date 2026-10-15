import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, ExternalLink, FileText, Globe, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, uploadFile } from '../../lib/api';
import { fmtDate, fmtMoney } from '../../lib/format';
import type {
  Branch, Company, KnowledgeDoc, PaymentConfig, Product, Promotion, SetupProposal,
} from '../../lib/types';
import {
  Badge, Button, EmptyState, Field, Input, Loading, Modal, Select, Switch, Table, Textarea,
} from '../../components/ui';
import { withScope } from './shared';

/* ─── Config sobre orderConfig (compartido con OrdersSettings) ────── */

export function useOrderConfig(companyId: string | null) {
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
      queryClient.invalidateQueries({ queryKey: ['companies'] }); // menú (p. ej. Domicilios)
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return { company, config: (company?.orderConfig ?? {}) as Record<string, any>, isLoading, save };
}

const errorToast = (e: unknown) => toast.error(e instanceof Error ? e.message : 'Error');

/* ─── Promociones y cupones ─────────────────────────────────────────── */

const PROMO_KIND: Record<Promotion['kind'], string> = {
  PERCENT: '% de descuento', FIXED: 'Valor fijo', FREE_DELIVERY: 'Domicilio gratis',
};

function promoValue(p: Pick<Promotion, 'kind' | 'value'>) {
  return p.kind === 'PERCENT' ? `${p.value}%` : p.kind === 'FIXED' ? fmtMoney(p.value) : 'Envío gratis';
}

export function PromotionsTab({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<Promotion> | null>(null);
  const { data: promos, isLoading } = useQuery({
    queryKey: ['promotions', q],
    queryFn: () => api.get<Promotion[]>(withScope('/promotions', q)),
  });
  const { data: products } = useQuery({
    queryKey: ['products-all', q],
    queryFn: () => api.get<Product[]>(withScope('/catalog/products?all=1', q)),
  });
  const save = useMutation({
    mutationFn: (p: Partial<Promotion>) => {
      const body = { ...p, startsAt: p.startsAt || null, endsAt: p.endsAt || null };
      return p.id ? api.patch(withScope(`/promotions/${p.id}`, q), body) : api.post(withScope('/promotions', q), body);
    },
    onSuccess: () => {
      toast.success('Promoción guardada');
      queryClient.invalidateQueries({ queryKey: ['promotions'] });
      setEditing(null);
    },
    onError: errorToast,
  });
  const toggle = useMutation({
    mutationFn: (p: Promotion) => api.patch(withScope(`/promotions/${p.id}`, q), { ...p, active: !p.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['promotions'] }),
    onError: errorToast,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(withScope(`/promotions/${id}`, q)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['promotions'] }),
    onError: errorToast,
  });
  if (isLoading) return <Loading />;
  const now = Date.now();
  const state = (p: Promotion) => {
    if (!p.active) return { label: 'Pausada', tone: 'neutral' as const };
    if (p.endsAt && new Date(p.endsAt).getTime() < now) return { label: 'Vencida', tone: 'bad' as const };
    if (p.startsAt && new Date(p.startsAt).getTime() > now) return { label: 'Programada', tone: 'info' as const };
    if (p.maxUses != null && p.usedCount >= p.maxUses) return { label: 'Agotada', tone: 'warn' as const };
    return { label: 'Activa', tone: 'ok' as const };
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-ink-2">
          El asistente aplica el cupón cuando el cliente lo menciona y ofrece las promociones públicas.
          Sin código = se aplica sola a todos los pedidos que cumplan las condiciones.
        </p>
        {canWrite && (
          <Button size="sm" onClick={() => setEditing({ name: '', kind: 'PERCENT', value: 10, public: true, active: true, productIds: [] })}>
            + Nueva promoción
          </Button>
        )}
      </div>
      {promos?.length ? (
        <Table head={['Promoción', 'Descuento', 'Condiciones', 'Usos', 'Estado', '']}>
          {promos.map((p) => {
            const st = state(p);
            return (
              <tr key={p.id}>
                <td className="px-4 py-3">
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-xs text-ink-3">{p.code ? <span className="font-mono font-semibold text-ink">{p.code}</span> : 'Automática'}{p.public ? ' · se anuncia' : ' · privada'}</p>
                </td>
                <td className="px-4 py-3 tabular-nums">{promoValue(p)}</td>
                <td className="px-4 py-3 text-xs text-ink-2">
                  {p.minSubtotal ? `Desde ${fmtMoney(p.minSubtotal)}` : 'Sin mínimo'}
                  {p.productIds.length ? ` · ${p.productIds.length} productos` : ''}
                  {p.endsAt ? ` · hasta ${fmtDate(p.endsAt)}` : ''}
                </td>
                <td className="px-4 py-3 tabular-nums">{p.usedCount}{p.maxUses != null ? ` / ${p.maxUses}` : ''}</td>
                <td className="px-4 py-3"><Badge tone={st.tone}>{st.label}</Badge></td>
                <td className="px-4 py-3 text-right">
                  {canWrite && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(p)}>{p.active ? 'Pausar' : 'Activar'}</Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing({ ...p, startsAt: p.startsAt?.slice(0, 16) ?? '', endsAt: p.endsAt?.slice(0, 16) ?? '' })}>Editar</Button>
                      <Button size="sm" variant="ghost" aria-label={`Eliminar ${p.name}`} onClick={() => window.confirm('¿Eliminar esta promoción?') && remove.mutate(p.id)}>
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
      ) : (
        <EmptyState title="Sin promociones" hint="Crea un cupón (ALMUERZO10) o una promo automática como domicilio gratis desde $50.000." />
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} kicker="Promociones" title={editing?.id ? 'Editar promoción' : 'Nueva promoción'}>
        {editing && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nombre" required><Input value={editing.name ?? ''} placeholder="Martes de combo" onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Código de cupón" hint="Vacío = se aplica sola"><Input value={editing.code ?? ''} placeholder="ALMUERZO10" onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })} /></Field>
              <Field label="Tipo">
                <Select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Promotion['kind'] })}>
                  {Object.entries(PROMO_KIND).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </Select>
              </Field>
              {editing.kind !== 'FREE_DELIVERY' && (
                <Field label={editing.kind === 'PERCENT' ? 'Porcentaje' : 'Valor (COP)'}>
                  <Input type="number" min={0} value={editing.value ?? ''} onChange={(e) => setEditing({ ...editing, value: Number(e.target.value) })} />
                </Field>
              )}
              <Field label="Pedido mínimo"><Input type="number" min={0} value={editing.minSubtotal ?? ''} onChange={(e) => setEditing({ ...editing, minSubtotal: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
              <Field label="Usos máximos" hint="Vacío = ilimitado"><Input type="number" min={0} value={editing.maxUses ?? ''} onChange={(e) => setEditing({ ...editing, maxUses: e.target.value === '' ? null : Number(e.target.value) })} /></Field>
              <Field label="Desde"><Input type="datetime-local" value={editing.startsAt ?? ''} onChange={(e) => setEditing({ ...editing, startsAt: e.target.value })} /></Field>
              <Field label="Hasta"><Input type="datetime-local" value={editing.endsAt ?? ''} onChange={(e) => setEditing({ ...editing, endsAt: e.target.value })} /></Field>
            </div>
            <Field label="Solo para estos productos" hint="Ninguno = todo el pedido">
              <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                {products?.map((pr) => {
                  const on = editing.productIds?.includes(pr.id);
                  return (
                    <button
                      key={pr.id}
                      type="button"
                      onClick={() => setEditing({ ...editing, productIds: on ? editing.productIds!.filter((x) => x !== pr.id) : [...(editing.productIds ?? []), pr.id] })}
                      className={`border-2 px-2 py-0.5 text-xs ${on ? 'border-ink bg-ink text-bone' : 'border-line hover:border-ink'}`}
                    >
                      {pr.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Descripción para el cliente"><Textarea rows={2} value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <Switch checked={!!editing.public} onChange={(v) => setEditing({ ...editing, public: v })} label="Se anuncia en el menú y el asistente la ofrece" />
            <Button className="w-full" disabled={!editing.name || save.isPending} onClick={() => save.mutate(editing)}>
              {save.isPending ? 'Guardando…' : 'Guardar promoción'}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ─── Menú digital con QR ───────────────────────────────────────────── */

export function MenuTab({ q, companyId, canWrite }: { q: string; companyId: string | null; canWrite: boolean }) {
  const { config, isLoading, save } = useOrderConfig(companyId);
  const [draft, setDraft] = useState<{ enabled: boolean; title: string; note: string; whatsappPhone: string } | null>(null);
  const { data: info, refetch } = useQuery({
    queryKey: ['menu-info', q],
    queryFn: () => api.get<{ url: string; enabled: boolean; whatsapp: string | null; qrSvg: string }>(withScope('/menu/info', q)),
  });
  useEffect(() => {
    if (!isLoading && draft === null) {
      const m = config.menu ?? {};
      setDraft({ enabled: !!m.enabled, title: m.title ?? '', note: m.note ?? '', whatsappPhone: m.whatsappPhone ?? '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading]);
  if (isLoading || !draft) return <Loading />;

  const downloadQr = () => {
    if (!info) return;
    const blob = new Blob([info.qrSvg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'menu-qr.svg';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <fieldset disabled={!canWrite} className="space-y-4">
        <div className="flex items-center justify-between border-2 border-ink bg-paper px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Menú digital publicado</p>
            <p className="text-xs text-ink-3">Fotos, precios y agotados en vivo. El cliente arma el pedido y lo envía por WhatsApp.</p>
          </div>
          <Switch checked={draft.enabled} onChange={(v) => setDraft({ ...draft, enabled: v })} label="Publicado" />
        </div>
        <Field label="Título" hint="Ej.: Almuerzos de la semana">
          <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        </Field>
        <Field label="Nota" hint="Horario, zonas, medios de pago">
          <Textarea rows={2} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        </Field>
        <Field label="WhatsApp que recibe los pedidos" hint={`Vacío = el de tu línea${info?.whatsapp ? ` (${info.whatsapp})` : ''}`}>
          <Input value={draft.whatsappPhone} placeholder="573001234567" onChange={(e) => setDraft({ ...draft, whatsappPhone: e.target.value })} />
        </Field>
        {canWrite && (
          <Button
            disabled={save.isPending}
            onClick={() => save.mutate(
              { ...config, menu: { ...draft, title: draft.title || undefined, note: draft.note || undefined, whatsappPhone: draft.whatsappPhone || undefined } },
              { onSuccess: () => refetch() },
            )}
          >
            {save.isPending ? 'Guardando…' : 'Guardar menú'}
          </Button>
        )}
      </fieldset>
      <aside className="space-y-3 border-2 border-ink bg-paper p-4">
        <p className="kicker">QR para mesas y redes</p>
        {info ? (
          <>
            <div className="mx-auto w-48 border-2 border-ink bg-white p-2" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
            <div className="flex items-center gap-2 border-2 border-line bg-bone-2 px-2 py-1.5 text-xs">
              <span className="truncate">{info.url}</span>
              <button className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Copiar link" onClick={() => navigator.clipboard?.writeText(info.url).then(() => toast.success('Link copiado'))}>
                <Copy size={12} />
              </button>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1" onClick={downloadQr}><Download size={12} /> QR</Button>
              <a href={info.url} target="_blank" rel="noopener noreferrer" className="flex-1">
                <Button size="sm" variant="outline" className="w-full" disabled={!info.enabled}><ExternalLink size={12} /> Ver</Button>
              </a>
            </div>
            {!info.enabled && <p className="text-xs text-warn">Publícalo para que el link funcione.</p>}
            {!info.whatsapp && <p className="text-xs text-bad">Falta un WhatsApp para recibir los pedidos.</p>}
          </>
        ) : <Loading />}
      </aside>
    </div>
  );
}

/* ─── Pagos: Wompi de la empresa, transferencia y efectivo ─────────── */

export function PaymentsTab({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const { data: cfg, isLoading } = useQuery({
    queryKey: ['payment-config', q],
    queryFn: () => api.get<PaymentConfig>(withScope('/payments/config', q)),
  });
  const [form, setForm] = useState<{ env: 'test' | 'prod'; publicKey: string; integritySecret: string; eventsSecret: string; manualInstructions: string; acceptCash: boolean } | null>(null);
  useEffect(() => {
    if (cfg && !form) {
      setForm({
        env: cfg.env ?? 'test', publicKey: cfg.publicKey ?? '', integritySecret: '', eventsSecret: '',
        manualInstructions: cfg.manualInstructions ?? '', acceptCash: cfg.acceptCash ?? true,
      });
    }
  }, [cfg, form]);
  const save = useMutation({
    mutationFn: () => api.patch(withScope('/payments/config', q), {
      ...form,
      integritySecret: form?.integritySecret || undefined,
      eventsSecret: form?.eventsSecret || undefined,
    }),
    onSuccess: () => {
      toast.success('Pagos guardados');
      setForm((f) => f && { ...f, integritySecret: '', eventsSecret: '' });
      queryClient.invalidateQueries({ queryKey: ['payment-config'] });
    },
    onError: errorToast,
  });
  if (isLoading || !cfg || !form) return <Loading />;
  return (
    <fieldset disabled={!canWrite} className="grid max-w-5xl gap-6 lg:grid-cols-2">
      <div className="space-y-4 border-2 border-ink bg-paper p-4">
        <div className="flex items-center justify-between">
          <p className="kicker">Link de pago · Wompi</p>
          <Badge tone={cfg.onlineReady ? 'ok' : 'neutral'}>{cfg.onlineReady ? 'Listo' : 'Sin configurar'}</Badge>
        </div>
        <p className="text-xs text-ink-3">
          El dinero llega directo a tu cuenta de Wompi (PSE, Nequi, tarjetas, Bancolombia). El asistente envía el link
          y el pedido se marca pagado solo cuando Wompi lo confirma.
        </p>
        <Field label="Ambiente">
          <Select value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value as 'test' | 'prod' })}>
            <option value="test">Pruebas (sandbox)</option>
            <option value="prod">Producción</option>
          </Select>
        </Field>
        <Field label="Llave pública"><Input value={form.publicKey} placeholder="pub_test_…" onChange={(e) => setForm({ ...form, publicKey: e.target.value.trim() })} /></Field>
        <Field label="Secreto de integridad" hint={cfg.hasIntegritySecret ? 'Guardado (cifrado). Escribe uno nuevo para reemplazarlo.' : 'Wompi → Desarrolladores → Secretos'}>
          <Input type="password" autoComplete="off" value={form.integritySecret} onChange={(e) => setForm({ ...form, integritySecret: e.target.value })} />
        </Field>
        <Field label="Secreto de eventos" hint={cfg.hasEventsSecret ? 'Guardado (cifrado).' : 'Para verificar las notificaciones de pago'}>
          <Input type="password" autoComplete="off" value={form.eventsSecret} onChange={(e) => setForm({ ...form, eventsSecret: e.target.value })} />
        </Field>
        {cfg.webhookUrl && (
          <Field label="URL de eventos (pégala en Wompi)">
            <div className="flex items-center gap-2 border-2 border-line bg-bone-2 px-2 py-1.5 text-xs">
              <span className="truncate font-mono">{cfg.webhookUrl}</span>
              <button type="button" className="cursor-pointer text-ink-3 hover:text-ink" aria-label="Copiar" onClick={() => navigator.clipboard?.writeText(cfg.webhookUrl!).then(() => toast.success('Copiado'))}><Copy size={12} /></button>
            </div>
          </Field>
        )}
      </div>
      <div className="space-y-4">
        <div className="space-y-4 border-2 border-ink bg-paper p-4">
          <p className="kicker">Transferencia</p>
          <Field label="Instrucciones" hint="El asistente las envía cuando el cliente paga por transferencia. Si manda la foto del comprobante, la IA la lee.">
            <Textarea rows={4} value={form.manualInstructions} placeholder="Nequi 300 123 4567 a nombre de Delicias Andinas SAS. Envía la foto del comprobante por aquí." onChange={(e) => setForm({ ...form, manualInstructions: e.target.value })} />
          </Field>
          <Switch checked={form.acceptCash} onChange={(v) => setForm({ ...form, acceptCash: v })} label="Acepto efectivo contra entrega" />
        </div>
        {canWrite && (
          <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar pagos'}</Button>
        )}
      </div>
    </fieldset>
  );
}

/* ─── Documentos de conocimiento (texto, web, PDF) ─────────────────── */

export function KnowledgeDocs({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'text' | 'url' | 'pdf' | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState('');
  const { data: docs } = useQuery({
    queryKey: ['knowledge', q],
    queryFn: () => api.get<KnowledgeDoc[]>(withScope('/knowledge', q)),
  });
  const reset = () => { setMode(null); setTitle(''); setText(''); setUrl(''); setFile(null); };
  const add = useMutation({
    mutationFn: () => {
      if (mode === 'pdf' && file) return uploadFile(withScope('/knowledge/pdf', q), 'file', file, title ? { title } : undefined);
      if (mode === 'url') return api.post(withScope('/knowledge/url', q), { url, title: title || undefined });
      return api.post(withScope('/knowledge/text', q), { title, text });
    },
    onSuccess: () => {
      toast.success('Documento aprendido');
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      reset();
    },
    onError: errorToast,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(withScope(`/knowledge/${id}`, q)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['knowledge'] }),
    onError: errorToast,
  });
  const search = useMutation({
    mutationFn: () => api.post<Array<{ text: string; score: number; doc: string }>>(withScope('/knowledge/search', q), { query }),
    onError: errorToast,
  });
  const icon = { TEXT: FileText, URL: Globe, PDF: FileText } as const;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="kicker">Documentos</p>
          <p className="max-w-2xl text-sm text-ink-2">Carta completa, políticas, la web del negocio: el asistente busca aquí antes de responder.</p>
        </div>
        {canWrite && (
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => setMode('text')}>+ Texto</Button>
            <Button size="sm" variant="outline" onClick={() => setMode('url')}>+ Página web</Button>
            <Button size="sm" variant="outline" onClick={() => setMode('pdf')}>+ PDF</Button>
          </div>
        )}
      </div>
      <div className="divide-y divide-line border-2 border-ink bg-paper">
        {docs?.map((d) => {
          const Icon = icon[d.source] ?? FileText;
          return (
            <div key={d.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold"><Icon size={13} /> {d.title}</p>
                <p className="truncate text-xs text-ink-3">
                  {d.source === 'URL' && d.url ? `${d.url} · ` : ''}{d.chars.toLocaleString('es-CO')} caracteres · {d.chunks} fragmentos · {fmtDate(d.createdAt)}
                </p>
              </div>
              {canWrite && (
                <Button size="sm" variant="ghost" aria-label={`Eliminar ${d.title}`} onClick={() => window.confirm('¿Olvidar este documento?') && remove.mutate(d.id)}>
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          );
        })}
        {docs?.length === 0 && <p className="px-4 py-6 text-center text-sm text-ink-3">Sin documentos todavía.</p>}
      </div>
      <div className="flex gap-2">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Prueba una pregunta: ¿tienen opción vegetariana?" />
        <Button size="sm" variant="outline" disabled={!query.trim() || search.isPending} onClick={() => search.mutate()}>Buscar</Button>
      </div>
      {search.data && (
        <div className="space-y-2">
          {search.data.length === 0 && <p className="text-sm text-ink-3">No encontró nada: el asistente diría que no sabe y pasaría a un humano.</p>}
          {search.data.map((r, i) => (
            <div key={i} className="border-2 border-line bg-bone-2 p-3 text-sm">
              <p className="kicker mb-1">{r.doc} · relevancia {r.score}</p>
              <p className="line-clamp-4 whitespace-pre-wrap text-ink-2">{r.text}</p>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!mode} onClose={reset} kicker="Conocimiento" title={mode === 'url' ? 'Aprender de una página web' : mode === 'pdf' ? 'Subir PDF' : 'Pegar texto'}>
        <div className="space-y-4">
          <Field label="Título" hint={mode === 'text' ? undefined : 'Opcional'}><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          {mode === 'text' && <Field label="Contenido"><Textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} /></Field>}
          {mode === 'url' && <Field label="Dirección" hint="Página pública (no se aceptan direcciones internas)"><Input value={url} placeholder="https://minegocio.com/menu" onChange={(e) => setUrl(e.target.value)} /></Field>}
          {mode === 'pdf' && (
            <Field label="Archivo PDF" hint="Máx. 10 MB, con texto (no escaneado)">
              <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            </Field>
          )}
          <Button
            className="w-full"
            disabled={add.isPending || (mode === 'text' ? !title || text.length < 20 : mode === 'url' ? !url : !file)}
            onClick={() => add.mutate()}
          >
            {add.isPending ? 'Leyendo…' : 'Aprender'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/* ─── Sucursales (despacho desde la más cercana) ───────────────────── */

export function BranchesPanel({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Partial<Branch> | null>(null);
  const { data: branches } = useQuery({
    queryKey: ['branches', q],
    queryFn: () => api.get<Branch[]>(withScope('/delivery/branches', q)),
  });
  const save = useMutation({
    mutationFn: (b: Partial<Branch>) => b.id ? api.patch(withScope(`/delivery/branches/${b.id}`, q), b) : api.post(withScope('/delivery/branches', q), b),
    onSuccess: () => {
      toast.success('Sucursal guardada');
      queryClient.invalidateQueries({ queryKey: ['branches'] });
      setEditing(null);
    },
    onError: errorToast,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(withScope(`/delivery/branches/${id}`, q)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['branches'] }),
    onError: errorToast,
  });
  const geocode = useMutation({
    mutationFn: (address: string) => api.post<{ lat: number; lng: number; formatted: string }>(withScope('/delivery/geocode', q), { address }),
    onSuccess: (hit) => setEditing((b) => b && { ...b, lat: hit.lat, lng: hit.lng }),
    onError: errorToast,
  });
  return (
    <div className="space-y-3 border-2 border-ink bg-paper p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="kicker">Sucursales</p>
          <p className="text-xs text-ink-3">Con varias cocinas, cada pedido sale de la más cercana (tarifa y tiempo desde ahí).</p>
        </div>
        {canWrite && <Button size="sm" variant="outline" onClick={() => setEditing({ name: '', address: '', active: true })}>+ Sucursal</Button>}
      </div>
      {branches?.map((b) => (
        <div key={b.id} className="flex items-center justify-between gap-2 border-t border-line pt-2 text-sm">
          <div className="min-w-0">
            <p className="font-semibold">{b.name} {!b.active && <Badge tone="neutral">Inactiva</Badge>}</p>
            <p className="truncate text-xs text-ink-3">{b.address ?? `${b.lat.toFixed(4)}, ${b.lng.toFixed(4)}`}</p>
          </div>
          {canWrite && (
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(b)}>Editar</Button>
              <Button size="sm" variant="ghost" aria-label={`Eliminar ${b.name}`} onClick={() => window.confirm('¿Eliminar sucursal?') && remove.mutate(b.id)}><Trash2 size={13} /></Button>
            </div>
          )}
        </div>
      ))}
      {branches?.length === 0 && <p className="text-xs text-ink-3">Sin sucursales: todo sale del punto de despacho.</p>}
      <Modal open={!!editing} onClose={() => setEditing(null)} kicker="Domicilios" title={editing?.id ? 'Editar sucursal' : 'Nueva sucursal'}>
        {editing && (
          <div className="space-y-4">
            <Field label="Nombre" required><Input value={editing.name ?? ''} placeholder="Sede Laureles" onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Dirección">
              <div className="flex gap-2">
                <Input value={editing.address ?? ''} placeholder="Cra 70 #44-10, Laureles, Medellín" onChange={(e) => setEditing({ ...editing, address: e.target.value })} />
                <Button size="sm" variant="outline" disabled={!editing.address || geocode.isPending} onClick={() => geocode.mutate(editing.address!)}>Ubicar</Button>
              </div>
            </Field>
            {editing.lat != null && editing.lng != null
              ? <p className="text-xs text-ok">Ubicada en {editing.lat.toFixed(5)}, {editing.lng.toFixed(5)}</p>
              : <p className="text-xs text-warn">Ubícala para poder despachar desde aquí.</p>}
            <Field label="Teléfono"><Input value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></Field>
            <Switch checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Activa" />
            <Button className="w-full" disabled={!editing.name || editing.lat == null || save.isPending} onClick={() => save.mutate(editing)}>
              {save.isPending ? 'Guardando…' : 'Guardar sucursal'}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ─── Zonas por barrio ──────────────────────────────────────────────── */

export interface ZoneDraft { name: string; fee: number | string; keywords: string }

export function ZonesEditor({ zones, onChange, disabled }: { zones: ZoneDraft[]; onChange: (z: ZoneDraft[]) => void; disabled?: boolean }) {
  return (
    <div className="space-y-2">
      {zones.map((z, i) => (
        <div key={i} className="grid gap-2 border-2 border-line p-2 sm:grid-cols-[160px_120px_1fr_auto]">
          <Input value={z.name} placeholder="Zona 1" aria-label="Nombre de la zona" disabled={disabled} onChange={(e) => onChange(zones.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <Input type="number" min={0} value={z.fee} placeholder="Tarifa" aria-label="Tarifa" disabled={disabled} onChange={(e) => onChange(zones.map((x, j) => (j === i ? { ...x, fee: e.target.value } : x)))} />
          <Input value={z.keywords} placeholder="Laureles, Estadio, Conquistadores" aria-label="Barrios" disabled={disabled} onChange={(e) => onChange(zones.map((x, j) => (j === i ? { ...x, keywords: e.target.value } : x)))} />
          {!disabled && <Button size="sm" variant="ghost" aria-label="Quitar zona" onClick={() => onChange(zones.filter((_, j) => j !== i))}><Trash2 size={13} /></Button>}
        </div>
      ))}
      {!disabled && (
        <Button size="sm" variant="outline" onClick={() => onChange([...zones, { name: `Zona ${zones.length + 1}`, fee: '', keywords: '' }])}>+ Zona</Button>
      )}
    </div>
  );
}

/* ─── Configurar con IA ─────────────────────────────────────────────── */

export function AiSetupWizard({ open, onClose, q }: { open: boolean; onClose: () => void; q: string }) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState('');
  const [proposal, setProposal] = useState<SetupProposal | null>(null);
  const [createAssistant, setCreateAssistant] = useState(true);
  const preview = useMutation({
    mutationFn: () => api.post<SetupProposal>(withScope('/ai-setup/preview', q), { description }),
    onSuccess: setProposal,
    onError: errorToast,
  });
  const apply = useMutation({
    mutationFn: () => api.post<{ productsCreated: number; productsSkipped: number; faqsAdded: number; scheduleSet: boolean; deliveryNeedsOrigin: boolean; botId: string | null }>(
      withScope('/ai-setup/apply', q), { proposal, createAssistant },
    ),
    onSuccess: (r) => {
      toast.success(`Listo: ${r.productsCreated} productos, ${r.faqsAdded} preguntas${r.scheduleSet ? ', horario' : ''}${r.botId ? ' y asistente' : ''}`);
      if (r.productsSkipped) toast.info(`${r.productsSkipped} productos ya existían y no se duplicaron`);
      if (r.deliveryNeedsOrigin) toast.info('Falta ubicar el punto de despacho en la pestaña Domicilios');
      queryClient.invalidateQueries();
      setProposal(null);
      setDescription('');
      onClose();
    },
    onError: errorToast,
  });
  const days = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  return (
    <Modal open={open} onClose={onClose} kicker="Configuración rápida" title="Configurar con IA" wide>
      {!proposal ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            Cuéntale a la IA tu negocio como se lo contarías a un empleado nuevo: qué vendes y a qué precio, horario,
            domicilios y preguntas típicas. Arma el catálogo, el horario, las preguntas frecuentes y el asistente; tú revisas antes de guardar.
          </p>
          <Textarea
            rows={9}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={'Vendemos almuerzos ejecutivos en Laureles, de lunes a viernes de 11 a 3. Bandeja paisa 18.000, ajiaco 16.000, menú vegetariano 15.000. Domicilio 3.000 hasta 3 km y 1.000 por km adicional, máximo 6 km. Pagos por Nequi o efectivo…'}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-3">{description.length} caracteres (mín. 30)</span>
            <Button disabled={description.trim().length < 30 || preview.isPending} onClick={() => preview.mutate()}>
              <Sparkles size={13} /> {preview.isPending ? 'Analizando…' : 'Generar propuesta'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          <section>
            <p className="kicker mb-2">Productos ({proposal.products.length})</p>
            <div className="max-h-56 space-y-1.5 overflow-y-auto">
              {proposal.products.map((p, i) => (
                <div key={i} className="grid grid-cols-[1fr_120px_120px_auto] items-center gap-2">
                  <Input value={p.name} aria-label="Producto" onChange={(e) => setProposal({ ...proposal, products: proposal.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input value={p.category ?? ''} placeholder="Categoría" aria-label="Categoría" onChange={(e) => setProposal({ ...proposal, products: proposal.products.map((x, j) => (j === i ? { ...x, category: e.target.value || null } : x)) })} />
                  <Input type="number" value={p.price ?? ''} placeholder="Precio" aria-label="Precio" onChange={(e) => setProposal({ ...proposal, products: proposal.products.map((x, j) => (j === i ? { ...x, price: e.target.value === '' ? null : Number(e.target.value) } : x)) })} />
                  <Button size="sm" variant="ghost" aria-label="Quitar" onClick={() => setProposal({ ...proposal, products: proposal.products.filter((_, j) => j !== i) })}><Trash2 size={13} /></Button>
                </div>
              ))}
            </div>
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="border-2 border-line p-3 text-sm">
              <p className="kicker mb-1">Horario</p>
              {proposal.schedule
                ? <p>{proposal.schedule.days.map((d) => days[d]).join(', ')} · {proposal.schedule.open} a {proposal.schedule.close}</p>
                : <p className="text-ink-3">No lo mencionaste: queda igual.</p>}
              <p className="kicker mb-1 mt-3">Domicilios</p>
              {proposal.delivery?.enabled
                ? <p>Base {fmtMoney(proposal.delivery.baseFee ?? 0)}{proposal.delivery.perKm ? ` + ${fmtMoney(proposal.delivery.perKm)}/km` : ''}{proposal.delivery.maxKm ? ` · hasta ${proposal.delivery.maxKm} km` : ''}</p>
                : <p className="text-ink-3">Sin domicilios.</p>}
            </section>
            <section className="border-2 border-line p-3 text-sm">
              <p className="kicker mb-1">Preguntas frecuentes ({proposal.faqs.length})</p>
              <ul className="max-h-32 space-y-1 overflow-y-auto text-xs">
                {proposal.faqs.map((f, i) => <li key={i}><b>{f.question}</b> — {f.answer}</li>)}
              </ul>
            </section>
          </div>
          {proposal.assistant && (
            <section className="border-2 border-line p-3 text-sm">
              <Switch checked={createAssistant} onChange={setCreateAssistant} label={`Crear el asistente «${proposal.assistant.name}» (tono ${proposal.assistant.tone})`} />
              <p className="mt-2 text-xs italic text-ink-3">"{proposal.assistant.welcome}"</p>
            </section>
          )}
          <div className="flex justify-between gap-2 border-t-2 border-ink pt-4">
            <Button variant="outline" onClick={() => setProposal(null)}>Volver a describir</Button>
            <Button disabled={apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? 'Aplicando…' : 'Aplicar al negocio'}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
