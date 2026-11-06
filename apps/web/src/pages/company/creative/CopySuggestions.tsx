import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../../../components/ui';
import { withScope } from '../shared';

/**
 * «Sugerir textos»: variaciones de copy para Meta Ads (titular, texto,
 * descripción y botón) desde una pieza de Creative o desde el anuncio que se
 * arma en Ads. Cada tarjeta se puede editar, usar o descartar. Los límites y
 * los botones permitidos vienen del servidor (los mismos que valida Meta).
 */

export type Destination = 'WHATSAPP' | 'WEBSITE';

export interface SuggestedCopy {
  headline: string;
  primaryText: string;
  description: string;
  cta: string;
  ctaLabel: string;
  angle: string;
  review: { needsReview: boolean; reasons: string[] };
  warnings: string[];
}

interface SuggestResult {
  variations: SuggestedCopy[];
  discarded: { limits: number; policies: number };
  source: 'EMPRESA' | 'GENERICA';
  model: string;
  quota: { used: number; limit: number } | null;
  limits: Record<'headline' | 'primaryText' | 'description', { min: number; max: number }>;
  ctas: Array<{ key: string; label: string }>;
}

const GOALS: Array<[string, string]> = [
  ['PRODUCT', 'Mostrar un producto'], ['PROMO', 'Promoción u oferta'], ['BENEFITS', 'Beneficios'], ['NEWS', 'Novedad o anuncio'],
  ['EVENT', 'Evento o fecha'], ['BRAND', 'Frase de marca'], ['CATALOG', 'Varios productos'], ['INFO', 'Información del servicio'], ['TIP', 'Consejo útil'],
];

/** Al pasar una pieza a Ads, el texto elegido viaja con ella (CreateAd lo precarga). */
export const adCopyKey = (designId: string) => `bo_ad_copy_${designId}`;

const over = (value: string, max: number) => (value.length > max ? `Pasa del límite visible de Meta (${max})` : undefined);

function CopyCard({ v, limits, ctas, fixedCta, useLabel, onUse, onDiscard }: {
  v: SuggestedCopy; limits: SuggestResult['limits']; ctas: SuggestResult['ctas']; fixedCta: boolean; useLabel: string;
  onUse: (v: SuggestedCopy) => void; onDiscard: () => void;
}) {
  const [d, setD] = useState(v);
  const set = (patch: Partial<SuggestedCopy>) => setD((x) => ({ ...x, ...patch }));
  const tooLong = d.headline.length > limits.headline.max || d.primaryText.length > limits.primaryText.max || d.description.length > limits.description.max;
  return (
    <article className="flex flex-col gap-3 border-2 border-ink bg-paper p-4 shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]">
      <div className="flex flex-wrap items-center gap-1.5">
        {d.angle && <Badge tone="neutral">{d.angle}</Badge>}
        {d.review.needsReview && <Badge tone="warn">Pide revisión</Badge>}
      </div>
      <Field label={`Título · ${d.headline.length}/${limits.headline.max}`} error={over(d.headline, limits.headline.max)}>
        <Input value={d.headline} aria-invalid={d.headline.length > limits.headline.max} onChange={(e) => set({ headline: e.target.value })} />
      </Field>
      <Field label={`Texto principal · ${d.primaryText.length}/${limits.primaryText.max}`} error={over(d.primaryText, limits.primaryText.max)}>
        <Textarea rows={3} value={d.primaryText} aria-invalid={d.primaryText.length > limits.primaryText.max} onChange={(e) => set({ primaryText: e.target.value })} />
      </Field>
      <Field label={`Descripción · ${d.description.length}/${limits.description.max}`} error={over(d.description, limits.description.max)}>
        <Input value={d.description} aria-invalid={d.description.length > limits.description.max} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Botón">
        {fixedCta || ctas.length < 2
          ? <p className="border-2 border-line bg-bone px-3 py-2 text-sm">{d.ctaLabel}</p>
          : <Select value={d.cta} onChange={(e) => set({ cta: e.target.value, ctaLabel: ctas.find((c) => c.key === e.target.value)?.label ?? e.target.value })}>{ctas.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>}
      </Field>
      {(d.review.reasons.length > 0 || d.warnings.length > 0) && (
        <ul className="space-y-0.5 border-l-4 border-warn pl-3 text-xs text-ink-2">
          {[...d.review.reasons, ...d.warnings].map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      <div className="mt-auto flex flex-wrap gap-2 border-t-2 border-line pt-3">
        <Button size="sm" disabled={tooLong} onClick={() => onUse(d)} title={tooLong ? 'Acorta el texto: pasa del límite visible de Meta' : undefined}><Check size={13} /> {useLabel}</Button>
        <Button size="sm" variant="outline" onClick={() => {
          void navigator.clipboard?.writeText(`${d.headline}\n\n${d.primaryText}\n\n${d.description}`).then(() => toast.success('Texto copiado'), () => toast.error('No se pudo copiar'));
        }}><Copy size={13} /> Copiar</Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}><X size={13} /> Descartar</Button>
      </div>
    </article>
  );
}

export function CopySuggestions({ q, designId, destination: fixed, product: initialProduct = '', useLabel = 'Usar', onUse, buttonLabel = 'Sugerir textos', size = 'sm' }: {
  q: string;
  designId?: string | null;
  /** En Ads el destino ya lo eligió el anuncio; en Creative se elige aquí */
  destination?: Destination;
  product?: string;
  useLabel?: string;
  onUse: (v: SuggestedCopy) => void;
  buttonLabel?: string;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState('PRODUCT');
  const [dest, setDest] = useState<Destination>(fixed ?? 'WHATSAPP');
  const [product, setProduct] = useState(initialProduct);
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [cards, setCards] = useState<Array<{ key: number; v: SuggestedCopy }>>([]);
  const destination = fixed ?? dest;

  const status = useQuery({
    queryKey: ['copy-status', q],
    queryFn: () => api.get<{ source: 'EMPRESA' | 'GENERICA' | 'NINGUNA'; quota: { used: number; limit: number } | null }>(withScope('/creative/copy/status', q)),
    enabled: open,
  });

  const suggest = useMutation({
    mutationFn: () => api.post<SuggestResult>(withScope('/creative/copy/suggest', q), {
      goal, destination, product: product.trim() || undefined, designId: designId ?? undefined, count: 3,
    }),
    onSuccess: (r) => {
      setResult(r);
      setCards(r.variations.map((v, i) => ({ key: Date.now() + i, v })));
      status.refetch();
      if (!r.variations.length) toast.error('La IA no dio textos que cumplan las reglas. Intenta de nuevo o cambia el objetivo.');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudieron sugerir textos'),
  });

  const quota = result?.quota ?? status.data?.quota ?? null;
  const source = result?.source ?? status.data?.source;

  return (
    <>
      <Button size={size} variant="outline" onClick={() => setOpen(true)}><Sparkles size={14} /> {buttonLabel}</Button>
      <Modal open={open} onClose={() => setOpen(false)} kicker="Textos para Meta Ads" title="Sugerir textos" wide>
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.4fr_auto] md:items-end">
            <Field label="Objetivo">
              <Select value={goal} onChange={(e) => setGoal(e.target.value)}>{GOALS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
            </Field>
            <Field label="El anuncio lleva a">
              {fixed
                ? <p className="border-2 border-line bg-bone px-3 py-2 text-sm">{fixed === 'WHATSAPP' ? 'WhatsApp del negocio' : 'Tu página web'}</p>
                : <Select value={dest} onChange={(e) => setDest(e.target.value as Destination)}><option value="WHATSAPP">WhatsApp del negocio</option><option value="WEBSITE">Tu página web</option></Select>}
            </Field>
            <Field label="Producto o servicio (opcional)">
              <Input value={product} maxLength={120} placeholder="Ej.: torta de chocolate por encargo" onChange={(e) => setProduct(e.target.value)} />
            </Field>
            <Button disabled={suggest.isPending || source === 'NINGUNA' || (quota != null && quota.used >= quota.limit)} onClick={() => suggest.mutate()}>
              <Sparkles size={14} /> {suggest.isPending ? 'Escribiendo…' : cards.length ? 'Otras ideas' : 'Sugerir'}
            </Button>
          </div>

          <p className="text-xs text-ink-3">
            {source === 'EMPRESA'
              ? 'Con la IA de tu empresa (se registra en tu consumo de IA). '
              : source === 'GENERICA'
                ? `Con la IA de prueba de BackOffice: no se te cobra${quota ? ` · ${Math.max(0, quota.limit - quota.used)} de ${quota.limit} usos disponibles hoy` : ''}. Solo recibe datos de tu negocio y de la pieza, sin datos de clientes. `
                : source === 'NINGUNA'
                  ? 'Tu empresa todavía no tiene IA para sugerir textos: escríbelos a mano o pídele a BackOffice que te active la IA de prueba. '
                  : ''}
            {designId ? 'Usa los textos de esta pieza como punto de partida. ' : ''}
            Cada texto respeta lo que Meta muestra completo en el celular y pasa por tus reglas de publicación.
          </p>

          {result && (result.discarded.limits > 0 || result.discarded.policies > 0) && (
            <p className="border-l-4 border-ink pl-3 text-xs text-ink-2">
              Se descartaron {result.discarded.limits + result.discarded.policies} ideas
              {result.discarded.limits ? ` (${result.discarded.limits} no cabían en los límites de Meta)` : ''}
              {result.discarded.policies ? ` (${result.discarded.policies} chocaban con tus reglas o con las políticas de Meta)` : ''}.
            </p>
          )}

          {cards.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-3">
              {cards.map(({ key, v }) => (
                <CopyCard
                  key={key} v={v} limits={result!.limits} ctas={result!.ctas} fixedCta={destination === 'WHATSAPP'} useLabel={useLabel}
                  onUse={(x) => { onUse(x); setOpen(false); }}
                  onDiscard={() => setCards((c) => c.filter((x) => x.key !== key))}
                />
              ))}
            </div>
          ) : (
            !suggest.isPending && <p className="border-2 border-dashed border-line p-6 text-center text-sm text-ink-3">Elige el objetivo y toca «Sugerir»: salen tres versiones distintas para comparar.</p>
          )}
        </div>
      </Modal>
    </>
  );
}
