import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Badge, Button, Card, Field, Loading, Select, Textarea } from '../../../components/ui';
import { useCompanyScope, withScope } from '../shared';

/**
 * Estilo visual de la marca. Cada valor muestra si lo confirmaste tú, si es
 * una sugerencia (por tu rubro y tu tono) o un valor neutro. Las sugerencias
 * no se guardan hasta que las aceptes. Nada de esto es obligatorio.
 */

type Source = 'CONFIRMED' | 'SUGGESTED' | 'DEFAULT';
interface Resolved<T> { value: T; source: Source; why?: string }
interface Visual {
  positioning?: string | null; personality?: string[]; photoStyle?: string | null; density?: string | null; alignment?: string | null; logoPlacement?: string | null;
  colorRoles?: { primary?: string; accent?: string; background?: string; text?: string }; references?: string[]; forbidden?: string[];
}
interface VisualRes {
  saved: Visual | null; sector: string; version: number;
  resolved: { personality: Resolved<string[]>; positioning: Resolved<string | null>; photoStyle: Resolved<string>; density: Resolved<string>; alignment: Resolved<string>; logoPlacement: Resolved<string>; colors: Record<string, string>; fonts: { title: string; body: string } };
}

const OPTIONS = {
  positioning: [['ECONOMICO', 'Económico'], ['ACCESIBLE', 'Accesible'], ['PREMIUM', 'Premium'], ['ARTESANAL', 'Artesanal'], ['CORPORATIVO', 'Corporativo'], ['JUVENIL', 'Juvenil']],
  personality: [['ELEGANTE', 'Elegante'], ['ENERGICA', 'Enérgica'], ['CALIDA', 'Cálida'], ['PROFESIONAL', 'Profesional'], ['DIVERTIDA', 'Divertida'], ['MINIMALISTA', 'Minimalista'], ['NATURAL', 'Natural'], ['AUDAZ', 'Audaz']],
  photoStyle: [['PROTAGONISTA', 'Fotos grandes y protagonistas'], ['ENMARCADA', 'Fotos enmarcadas'], ['SUAVE', 'Fotos pequeñas que acompañan'], ['SIN_FOTO', 'Casi sin fotos']],
  density: [['AIREADA', 'Mucho aire'], ['EQUILIBRADA', 'Equilibrada'], ['COMPACTA', 'Compacta']],
  alignment: [['CENTRADA', 'Centrada'], ['IZQUIERDA', 'Alineada a la izquierda'], ['ASIMETRICA', 'Asimétrica']],
  logoPlacement: [['ARRIBA_DERECHA', 'Arriba a la derecha'], ['ARRIBA_IZQUIERDA', 'Arriba a la izquierda'], ['ABAJO_DERECHA', 'Abajo a la derecha'], ['ABAJO_CENTRO', 'Abajo al centro']],
} as const;
const label = (k: keyof typeof OPTIONS, v?: string | null) => (OPTIONS[k] as readonly (readonly [string, string])[]).find(([x]) => x === v)?.[1] ?? '—';
const SRC: Record<Source, [string, 'ok' | 'info' | 'neutral']> = { CONFIRMED: ['Confirmado', 'ok'], SUGGESTED: ['Sugerido', 'info'], DEFAULT: ['Por defecto', 'neutral'] };

export function VisualIdentityCard({ q, colors }: { q: string; colors: Array<{ hex: string; label: string }> }) {
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const { data } = useQuery({ queryKey: ['brand-visual', q], queryFn: () => api.get<VisualRes>(withScope('/creative/brand/visual', q)) });
  const [v, setV] = useState<Visual>({});
  const [reasons, setReasons] = useState<string[] | null>(null);
  useEffect(() => { if (data) setV(data.saved ?? {}); }, [data]);
  const save = useMutation({
    mutationFn: () => api.put<VisualRes>(withScope('/creative/brand/visual', q), { visual: v, expectedVersion: data?.version }),
    onSuccess: (r) => { queryClient.setQueryData(['brand-visual', q], r); queryClient.invalidateQueries({ queryKey: ['brand'] }); setReasons(null); toast.success('Estilo visual guardado: las próximas propuestas lo usarán.'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo guardar'),
  });
  const suggest = useMutation({
    mutationFn: () => api.post<{ values: Visual; reasons: string[] }>(withScope('/creative/brand/visual/suggest', q)),
    onSuccess: (r) => { setV({ ...v, ...Object.fromEntries(Object.entries(r.values).filter(([k]) => !(v as any)[k] || (Array.isArray((v as any)[k]) && !(v as any)[k].length))) }); setReasons(r.reasons); },
  });
  if (!data) return <Loading />;
  const r = data.resolved;
  const sel = (k: keyof typeof OPTIONS, title: string, current: Resolved<any>) => (
    <Field label={title}>
      <div className="flex items-center gap-2">
        <Select value={(v as any)[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value || null })}>
          <option value="">{`Sin definir (usamos: ${label(k, current.value)})`}</option>
          {OPTIONS[k].map(([x, l]) => <option key={x} value={x}>{l}</option>)}
        </Select>
        <Badge tone={SRC[current.source][1]}>{SRC[current.source][0]}</Badge>
      </div>
    </Field>
  );
  const personality = v.personality ?? [];
  return (
    <Card kicker="Opcional · mejora las propuestas" title="Estilo visual">
      <fieldset disabled={!canWrite} className="space-y-4 text-sm">
        <p className="text-ink-2">Esto decide cómo se componen tus piezas (no solo los colores). Si no defines algo, usamos una sugerencia según tu negocio ({data.sector.toLowerCase()}) y tu tono, y te lo indicamos.</p>
        <div>
          <p className="kicker mb-1">Personalidad (hasta 3) <Badge tone={SRC[r.personality.source][1]}>{SRC[r.personality.source][0]}</Badge></p>
          <div className="flex flex-wrap gap-1.5">
            {OPTIONS.personality.map(([x, l]) => {
              const on = personality.includes(x);
              return <button key={x} type="button" onClick={() => setV({ ...v, personality: on ? personality.filter((p) => p !== x) : [...personality, x].slice(0, 3) })} className={clsx('cursor-pointer border-2 px-2.5 py-1 text-xs', on ? 'border-ink bg-ink text-bone' : 'border-line')}>{l}</button>;
            })}
          </div>
          {!personality.length && <p className="mt-1 text-xs text-ink-3">Hoy usamos: {r.personality.value.map((p) => OPTIONS.personality.find(([x]) => x === p)?.[1] ?? p).join(', ')}{r.personality.why ? ` — ${r.personality.why.toLowerCase()}` : ''}.</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {sel('positioning', 'Posicionamiento', r.positioning)}
          {sel('photoStyle', 'Fotografía', r.photoStyle)}
          {sel('density', 'Espacio', r.density)}
          {sel('alignment', 'Alineación', r.alignment)}
          {sel('logoPlacement', 'Dónde va el logo', r.logoPlacement)}
        </div>
        {colors.length > 1 && (
          <div>
            <p className="kicker mb-1">Función de cada color</p>
            <div className="grid gap-2 sm:grid-cols-4">
              {(['primary', 'accent', 'background', 'text'] as const).map((role) => (
                <Field key={role} label={{ primary: 'Principal', accent: 'Acento', background: 'Fondo claro', text: 'Texto' }[role]}>
                  <Select value={v.colorRoles?.[role] ?? ''} onChange={(e) => setV({ ...v, colorRoles: { ...v.colorRoles, [role]: e.target.value || undefined } })}>
                    <option value="">Automático ({r.colors[role === 'background' ? 'light' : role === 'text' ? 'dark' : role]})</option>
                    {colors.map((c) => <option key={c.hex} value={c.hex}>{c.label || c.hex}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
          </div>
        )}
        <Field label="Cosas que nunca deben aparecer" hint="Una por línea. Ej.: fotos de stock con personas, fondos negros">
          <Textarea rows={2} value={(v.forbidden ?? []).join('\n')} onChange={(e) => setV({ ...v, forbidden: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
        </Field>
        <p className="text-xs text-ink-3">Tipografías: {r.fonts.title} para títulos y {r.fonts.body} para textos (se eligen en tu identidad de marca).</p>
        {reasons && (
          <div className="border-l-4 border-info bg-info-soft/40 px-3 py-2 text-xs">
            <p className="font-semibold">Sugerencia aplicada al formulario (aún sin guardar):</p>
            <ul className="mt-1 list-disc pl-4">{reasons.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={save.isPending} onClick={() => save.mutate()}>Guardar estilo</Button>
            <Button variant="outline" disabled={suggest.isPending} onClick={() => suggest.mutate()}>Sugerir según mi negocio</Button>
          </div>
        )}
      </fieldset>
    </Card>
  );
}
