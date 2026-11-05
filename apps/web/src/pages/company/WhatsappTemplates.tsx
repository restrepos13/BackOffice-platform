import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, api } from '../../lib/api';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Textarea } from '../../components/ui';
import {
  CATEGORY_LABEL, MetaBillingNotice, MetaCategory, MetaConnectButton, MetaNotice, perMessage, useMetaConfig,
} from '../../components/whatsapp/meta';
import { PickCompany, useCompanyScope, withScope } from './shared';

/**
 * Plantillas de WhatsApp (Meta directo) y lo que Meta le cobra a la empresa.
 * Las plantillas viven en la cuenta de WhatsApp Business de la empresa;
 * BackOffice las crea, sigue su revisión y las usa solas al aprobarse.
 */

interface TemplateRow {
  key: string;
  label: string;
  body: string;
  category: MetaCategory;
  provider: 'META' | 'TWILIO' | 'NONE';
  usable: boolean;
  status: string;
  statusLabel: string;
  rejected?: string;
  previousCategory: MetaCategory | null;
  quality: string | null;
  variables: number;
  costPerMessageUsd: number;
  usedFor: string | null;
}

interface LibraryRow {
  key: string;
  label: string;
  category: 'UTILIDAD' | 'MARKETING';
  body: string;
  usedFor: string;
  variables: string[];
  recommended: boolean;
  costPerMessageUsd: number;
}

interface TemplatesResponse {
  connected: boolean;
  displayPhone: string | null;
  templates: TemplateRow[];
  library: LibraryRow[];
  rates: Record<MetaCategory, number>;
  notice: MetaNotice;
}

interface CostsResponse {
  period: string;
  byCategory: Array<{ category: MetaCategory; count: number; usd: number }>;
  totalUsd: number;
  totalCop: number | null;
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'neutral' | 'info'> = {
  APPROVED: 'ok', PENDING: 'warn', IN_APPEAL: 'info', REJECTED: 'bad', PAUSED: 'warn', DISABLED: 'bad', DELETED: 'neutral', BORRADOR: 'neutral',
};

const monthLabel = (period: string) => new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period}-01T00:00:00Z`));

export default function WhatsappTemplates() {
  const { ready, q, canWrite } = useCompanyScope();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data: cfg } = useMetaConfig(q);
  const { data, isLoading } = useQuery({
    queryKey: ['whatsapp-templates', q],
    queryFn: () => api.get<TemplatesResponse>(withScope('/whatsapp/templates', q)),
    enabled: ready,
  });
  const { data: costs } = useQuery({
    queryKey: ['whatsapp-meta-costs', q],
    queryFn: () => api.get<CostsResponse>(withScope('/whatsapp/meta/costs', q)),
    enabled: ready,
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
  };

  const sync = useMutation({
    mutationFn: () => api.post<{ changed: number }>(withScope('/whatsapp/templates/sync', q)),
    onSuccess: (r) => { refresh(); toast.success(r.changed ? `${r.changed} plantillas actualizadas con lo que dice Meta` : 'Todo al día con Meta'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo consultar a Meta'),
  });
  const install = useMutation({
    mutationFn: (key: string) => api.post(withScope(`/whatsapp/templates/library/${encodeURIComponent(key)}`, q)),
    onSuccess: () => { refresh(); toast.success('Enviada a revisión de Meta. Suele tardar de minutos a unas horas.'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo enviar'),
  });
  const remove = useMutation({
    mutationFn: (key: string) => api.delete(withScope(`/whatsapp/templates/${encodeURIComponent(key)}`, q)),
    onSuccess: () => { refresh(); toast.success('Plantilla eliminada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo eliminar'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading />;
  const trm = cfg?.trm ?? null;

  return (
    <>
      <PageHeader
        kicker="WhatsApp oficial de Meta"
        title="Plantillas y"
        accent="costos de Meta"
        actions={canWrite && data.connected ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw size={12} /> Consultar a Meta</Button>
            <Button onClick={() => setCreating(true)}>+ Nueva plantilla</Button>
          </div>
        ) : undefined}
      />

      <p className="mb-6 max-w-3xl text-sm text-ink-2">
        Para escribirle a un cliente que no te ha escrito en las últimas 24 horas, WhatsApp exige una plantilla aprobada por Meta:
        recordatorios de citas, avisos de pedidos, cobros y campañas. Aquí las creas, ves si Meta las aprobó y cuánto te cobra Meta por cada una.
      </p>

      {!data.connected && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-2 border-ink bg-paper p-4">
          <div className="max-w-xl text-sm">
            <p className="font-semibold">Primero conecta tu número con Meta</p>
            <p className="text-ink-2">Las plantillas viven en tu cuenta de WhatsApp Business. Al conectar tu número, mandamos a revisión las recomendadas para tu negocio.</p>
          </div>
          {canWrite ? <MetaConnectButton q={q} /> : null}
          <Link to="/app/integrations" className="text-xs font-semibold underline">Ir a Integraciones</Link>
        </div>
      )}

      <div className="mb-8">
        <MetaBillingNotice notice={data.notice} rates={data.rates} trm={trm} compact />
      </div>

      {costs && (
        <Card kicker={`Lo que Meta te ha cobrado en ${monthLabel(costs.period)} (estimado)`} title={costs.totalUsd ? `US$${costs.totalUsd.toFixed(2)}${costs.totalCop ? ` · ≈ $${costs.totalCop.toLocaleString('es-CO')}` : ''}` : 'Sin cobros de Meta este mes'} className="mb-8">
          {costs.byCategory.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-3">
              {costs.byCategory.map((c) => (
                <div key={c.category} className="border-2 border-line p-3 text-sm">
                  <p className="text-xs font-semibold uppercase tracking-[0.08em]">{CATEGORY_LABEL[c.category] ?? c.category}</p>
                  <p className="mt-1 font-mono">{c.count.toLocaleString('es-CO')} mensajes · US${c.usd.toFixed(3)}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-xs text-ink-3">Esto lo cobra Meta a la tarjeta de tu cuenta de WhatsApp Business: no aparece en tu factura de BackOffice. Es un cálculo con las tarifas de referencia; la cifra exacta está en tu factura de Meta.</p>
        </Card>
      )}

      <div className="mb-3">
        <p className="kicker">En tu cuenta de WhatsApp Business</p>
        <h2 className="display text-2xl">Tus plantillas</h2>
      </div>
      <div className="mb-8 grid gap-4 md:grid-cols-2">
        {data.templates.map((t) => (
          <Card key={t.key}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="display text-lg">{t.label}</h3>
                <p className="font-mono text-xs text-ink-3">{t.key}{t.provider === 'TWILIO' ? ' · Twilio' : ''}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge tone={STATUS_TONE[t.status] ?? 'neutral'}>{t.statusLabel}</Badge>
                <Badge tone={t.category === 'MARKETING' ? 'warn' : 'neutral'}>{CATEGORY_LABEL[t.category] ?? t.category}</Badge>
              </div>
            </div>
            <p className="mt-3 whitespace-pre-line border-l-4 border-line pl-3 text-sm">{t.body}</p>
            <div className="mt-3 space-y-1 border-t-2 border-line pt-2 text-xs text-ink-3">
              <p>Meta te cobra {perMessage(t.costPerMessageUsd, trm)} cuando la envías a alguien fuera de las 24 h.</p>
              {t.usedFor && <p>Uso en BackOffice: {t.usedFor}</p>}
              {t.previousCategory && t.previousCategory !== t.category && (
                <p className="font-semibold text-warn">Meta la pasó de {CATEGORY_LABEL[t.previousCategory]} a {CATEGORY_LABEL[t.category]}: ahora cuesta más. Si era un aviso, quítale lo promocional y créala de nuevo.</p>
              )}
              {t.rejected && <p className="font-semibold text-bad">{t.rejected}</p>}
              {t.quality === 'RED' && <p className="font-semibold text-bad">Calidad baja: muchas personas la bloquean o reportan. Meta puede pausarla.</p>}
            </div>
            {canWrite && (
              <div className="mt-3 flex justify-end">
                <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => window.confirm(`¿Eliminar «${t.label}»? También se borra de tu cuenta de Meta.`) && remove.mutate(t.key)}>
                  <Trash2 size={12} /> Eliminar
                </Button>
              </div>
            )}
          </Card>
        ))}
        {data.templates.length === 0 && <p className="text-sm text-ink-3 md:col-span-2">Todavía no tienes plantillas.</p>}
      </div>

      {data.library.length > 0 && (
        <>
          <div className="mb-3">
            <p className="kicker">Listas para enviar a revisión</p>
            <h2 className="display text-2xl">Biblioteca de BackOffice</h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-2">Escritas para que Meta las apruebe y para que BackOffice las use solo, en el flujo indicado.</p>
          </div>
          <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.library.map((t) => (
              <Card key={t.key}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="display text-base">{t.label}</h3>
                  <Badge tone={t.category === 'MARKETING' ? 'warn' : 'neutral'}>{CATEGORY_LABEL[t.category]}</Badge>
                </div>
                <p className="mt-2 whitespace-pre-line text-sm text-ink-2">{t.body}</p>
                <p className="mt-2 text-xs text-ink-3">{t.usedFor} · Meta cobra {perMessage(t.costPerMessageUsd, trm)}</p>
                {canWrite && data.connected && (
                  <Button size="sm" variant="outline" className="mt-3 w-full" disabled={install.isPending} onClick={() => install.mutate(t.key)}>Enviar a revisión de Meta</Button>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {creating && <CreateTemplateModal q={q} rates={data.rates} trm={trm} onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); }} />}
    </>
  );
}

const PROMO_WORDS = /\b(promo\w*|descuento\w*|oferta\w*|gratis|2x1|rebaja\w*|aprovecha\w*)\b/i;

function CreateTemplateModal({ q, rates, trm, onClose, onDone }: {
  q: string; rates: Record<MetaCategory, number>; trm: number | null; onClose: () => void; onDone: () => void;
}) {
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<'UTILIDAD' | 'MARKETING'>('UTILIDAD');
  const [body, setBody] = useState('');
  const [examples, setExamples] = useState<string[]>([]);
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmWarning, setConfirmWarning] = useState<string | null>(null);

  const vars = useMemo(() => [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b), [body]);
  const promo = category === 'UTILIDAD' && PROMO_WORDS.test(body);

  const save = useMutation({
    mutationFn: (acceptWarnings: boolean) => api.post(withScope('/whatsapp/templates', q), {
      label, key: label, category, body, examples: vars.map((_, i) => examples[i] ?? ''), footer: footer || undefined,
      buttons: buttons.split(',').map((b) => b.trim()).filter(Boolean), acceptWarnings,
    }),
    onSuccess: () => { toast.success('Enviada a revisión de Meta'); onDone(); },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'NEEDS_CONFIRMATION') { setConfirmWarning(e.message); return; }
      if (e instanceof ApiError && e.errors?.length) { setErrors(e.errors); return; }
      toast.error(e instanceof Error ? e.message : 'No se pudo crear');
    },
  });

  return (
    <Modal open onClose={onClose} kicker="Se envía a revisión de Meta" title="Nueva plantilla" wide>
      <div className="space-y-4">
        <Field label="Nombre" hint="Solo para reconocerla. Ej: Recordatorio de cita" required>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
        </Field>
        <div>
          <span className="kicker mb-1 block">¿Qué tipo de mensaje es?</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {(['UTILIDAD', 'MARKETING'] as const).map((c) => (
              <button key={c} type="button" onClick={() => setCategory(c)} className={`border-2 p-3 text-left text-sm ${category === c ? 'border-ink bg-paper' : 'border-line'}`}>
                <p className="font-semibold">{c === 'UTILIDAD' ? 'Aviso o recordatorio' : 'Promoción o campaña'}</p>
                <p className="text-xs text-ink-3">{c === 'UTILIDAD' ? 'Citas, pedidos, pagos. Sin nada promocional.' : 'Ofertas, novedades, reactivación.'}</p>
                <p className="mt-1 font-mono text-xs">Meta cobra {perMessage(rates[c], trm)}</p>
              </button>
            ))}
          </div>
          {category === 'MARKETING' && <p className="mt-2 text-xs font-semibold text-warn">Las promociones son los mensajes más costosos de Meta, y Meta te los cobra directo, aparte de tu plan.</p>}
        </div>
        <Field label="Texto" hint="Usa {{1}}, {{2}}… donde va lo que cambia (nombre, fecha). No empieces ni termines con una variable." required>
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1024} />
        </Field>
        {promo && <p className="text-xs font-semibold text-warn">Tiene palabras promocionales: Meta podría cobrarla como promoción. Si es un aviso, déjalo solo informativo.</p>}
        {vars.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {vars.map((n, i) => (
              <Field key={n} label={`Ejemplo de {{${n}}}`} hint="Meta lo pide para revisar la plantilla">
                <Input value={examples[i] ?? ''} onChange={(e) => setExamples((prev) => { const next = [...prev]; next[i] = e.target.value; return next; })} />
              </Field>
            ))}
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Pie de página (opcional)" hint="Máximo 60 caracteres, sin variables">
            <Input value={footer} onChange={(e) => setFooter(e.target.value)} maxLength={60} />
          </Field>
          <Field label="Botones de respuesta (opcional)" hint="Separados por coma, máximo 3. Ej: Confirmo, Reprogramar">
            <Input value={buttons} onChange={(e) => setButtons(e.target.value)} />
          </Field>
        </div>
        {errors.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-xs font-semibold text-bad">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        )}
        {confirmWarning && (
          <div className="border-2 border-warn bg-warn-soft p-3 text-sm">
            <p className="font-semibold">{confirmWarning}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setConfirmWarning(null)}>Corregir el texto</Button>
              <Button size="sm" onClick={() => { setConfirmWarning(null); save.mutate(true); }}>Enviarla así</Button>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button disabled={!label.trim() || body.trim().length < 10 || save.isPending} onClick={() => { setErrors([]); save.mutate(false); }}>
            {save.isPending ? 'Enviando…' : 'Enviar a revisión de Meta'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
