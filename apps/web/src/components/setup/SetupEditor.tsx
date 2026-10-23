import { clsx } from 'clsx';
import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../lib/api';
import { COMPLEXITY_LABEL, STATUS_LABEL, mergeEvaluated, useSetupCatalog, type Complexity, type ProductKey, type SetupProfile } from '../../lib/setup';
import { Badge, Field, Input, Select } from '../ui';

/**
 * Editor del perfil de incorporación. Lo usan el registro (modo "client",
 * palabras sencillas) y Plataforma (modo "admin": todo a la vista y ajuste de
 * complejidad con motivo). Cada cambio se recalcula en el servidor: la
 * complejidad, las capacidades y la recomendación nunca se calculan aquí.
 */

const STATUS_TONE = { AVAILABLE: 'ok', PARTIAL: 'warn', PLANNED: 'neutral' } as const;

function Tags({ items, onChange, placeholder, label }: { items: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !items.some((i) => i.toLowerCase() === v.toLowerCase())) onChange([...items, v].slice(0, 10));
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-2 border-line bg-paper p-1.5 focus-within:border-ink">
      {items.map((t) => (
        <span key={t} className="inline-flex max-w-full items-center gap-1 border border-ink bg-bone px-2 py-0.5 text-xs">
          <span className="truncate">{t}</span>
          <button type="button" className="cursor-pointer" aria-label={`Quitar ${t}`} onClick={() => onChange(items.filter((x) => x !== t))}><X size={11} /></button>
        </span>
      ))}
      <input
        aria-label={label}
        className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

function Toggle({ on, label, onClick, hint }: { on: boolean; label: string; onClick: () => void; hint?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={hint}
      className={clsx('inline-flex cursor-pointer items-center gap-1.5 border-2 px-2.5 py-1 text-xs font-semibold', on ? 'border-ink bg-ink text-bone' : 'border-line bg-paper text-ink-2 hover:border-ink')}>
      {on && <Check size={12} aria-hidden />}{label}
    </button>
  );
}

const num = (v: string) => (v.trim() === '' ? null : Math.max(1, Math.round(Number(v)) || 1));

export default function SetupEditor({ value, onChange, mode, endpoint, hide = [] }: {
  value: SetupProfile;
  onChange: (v: SetupProfile) => void;
  mode: 'client' | 'admin';
  /** /public/setup/evaluate (registro) o /platform/setup/evaluate (plataforma) */
  endpoint: string;
  /** Secciones que muestra otra pantalla (el registro elige productos en su propio paso) */
  hide?: Array<'products' | 'capabilities'>;
}) {
  const { data: catalog } = useSetupCatalog();
  const latest = useRef(value);
  latest.current = value;
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Cambio de la persona → se recalcula en el servidor (con una pausa corta). */
  const update = (patch: (v: SetupProfile) => SetupProfile) => {
    const next = patch(latest.current);
    onChange(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setEvaluating(true);
      try {
        const server = await api.post<SetupProfile>(endpoint, { setup: next });
        setError(null);
        onChange(mergeEvaluated(latest.current, server));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo recalcular');
      } finally {
        setEvaluating(false);
      }
    }, 450);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const a = value.answers;
  const setA = (p: Partial<SetupProfile['answers']>) => update((v) => ({ ...v, answers: { ...v.answers, ...p } }));
  const setS = (p: Partial<SetupProfile['signals']>) => update((v) => ({ ...v, signals: { ...v.signals, ...p } }));
  const toggleProduct = (k: ProductKey) => update((v) => {
    const has = v.products.selected.includes(k);
    const selected = has ? v.products.selected.filter((x) => x !== k) : [...v.products.selected, k];
    return { ...v, products: { ...v.products, selected: (['AUTOMATION', 'CREATIVE', 'ADS'] as ProductKey[]).filter((x) => selected.includes(x)) } };
  });
  const client = mode === 'client';
  const ov = value.complexity.override;

  return (
    <div className="space-y-5" aria-busy={evaluating}>
      {/* 1. Negocio */}
      <section>
        <p className="kicker mb-2">{client ? 'Tu negocio' : 'Perfil de negocio'}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={client ? 'Tipo de negocio' : 'Perfil (sector)'}>
            <Select value={value.business.profileKey} onChange={(e) => update((v) => ({ ...v, business: { ...v.business, profileKey: e.target.value } }))}>
              {catalog?.profiles.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label={client ? 'A qué te dedicas, en pocas palabras' : 'Actividad concreta'}>
            <Input value={value.business.activity} maxLength={100} onChange={(e) => update((v) => ({ ...v, business: { ...v.business, activity: e.target.value } }))} />
          </Field>
        </div>
      </section>

      {/* 2. Cómo trabaja */}
      <section>
        <p className="kicker mb-2">{client ? 'Cómo trabajas' : 'Operación'}</p>
        <Field label={client ? '¿Qué necesitas resolver?' : 'Necesidades'}>
          <div className="flex flex-wrap gap-1.5">
            {catalog?.needs.map((n) => (
              <Toggle key={n.key} on={a.needs.includes(n.key)} label={n.label} onClick={() => setA({ needs: a.needs.includes(n.key) ? a.needs.filter((x) => x !== n.key) : [...a.needs, n.key] })} />
            ))}
          </div>
        </Field>
        <div className="mt-3">
          <Field label={client ? '¿Por dónde te llegan los clientes?' : 'Canales de entrada'}>
            <div className="flex flex-wrap gap-1.5">
              {catalog?.intake.map((c) => (
                <Toggle key={c} on={a.intake.includes(c)} label={c} onClick={() => setA({ intake: a.intake.includes(c) ? a.intake.filter((x) => x !== c) : [...a.intake, c] })} />
              ))}
            </div>
          </Field>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={client ? '¿Cuántas personas trabajan contigo?' : 'Personas que intervienen'}>
            <Input type="number" min={1} value={value.signals.people ?? ''} onChange={(e) => setS({ people: num(e.target.value) })} />
          </Field>
          <Field label={client ? '¿Cuántos pasos tiene atender un cliente, de inicio a fin?' : 'Etapas del proceso'}>
            <Input type="number" min={1} value={value.signals.stages ?? ''} onChange={(e) => setS({ stages: num(e.target.value) })} />
          </Field>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={client ? 'Tareas que haces a mano' : 'Tareas manuales'} hint="Escribe y presiona Enter">
            <Tags label="Tareas manuales" items={a.manualTasks} onChange={(manualTasks) => setA({ manualTasks })} placeholder="+ tarea" />
          </Field>
          <Field label={client ? 'Lo que más tiempo te quita' : 'Tareas que más tiempo consumen'} hint="Escribe y presiona Enter">
            <Tags label="Tareas que más tiempo quitan" items={a.timeConsuming} onChange={(timeConsuming) => setA({ timeConsuming })} placeholder="+ tarea" />
          </Field>
          <Field label={client ? 'Lo que quieres automatizar' : 'Quiere automatizar'} hint="Escribe y presiona Enter">
            <Tags label="Qué automatizar" items={a.automate} onChange={(automate) => setA({ automate })} placeholder="+ algo" />
          </Field>
          <Field label={client ? 'Lo que siempre debe aprobar una persona' : 'Requiere aprobación humana'} hint="Escribe y presiona Enter">
            <Tags label="Aprobación humana" items={a.humanApproval} onChange={(humanApproval) => setA({ humanApproval })} placeholder="+ paso" />
          </Field>
          <Field label={client ? 'Áreas por las que pasa el trabajo' : 'Áreas (dependencias)'} hint="Ej.: compras, producción, entregas">
            <Tags label="Áreas" items={value.signals.areas} onChange={(areas) => setS({ areas })} placeholder="+ área" />
          </Field>
          <Field label={client ? 'Programas que usas' : 'Sistemas e integraciones'} hint="Ej.: Excel, Siigo, Shopify">
            <Tags label="Sistemas" items={a.integrations} onChange={(integrations) => setA({ integrations })} placeholder="+ programa" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Toggle on={a.wantsContent === true} label={client ? 'Necesito contenido o diseños para redes' : 'Necesita contenido'} onClick={() => setA({ wantsContent: a.wantsContent === true ? false : true })} />
          <Toggle on={a.wantsAds === true} label={client ? 'Hago o quiero hacer publicidad pagada' : 'Maneja publicidad pagada'} onClick={() => setA({ wantsAds: a.wantsAds === true ? false : true })} />
        </div>
      </section>

      {/* 3. Complejidad */}
      <section className="border-2 border-ink bg-bone p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="kicker">{client ? 'Qué tan complejo es tu negocio' : 'Complejidad operativa'}</p>
          <Badge tone={value.complexity.level === 'COMPLEX' ? 'warn' : value.complexity.level === 'INTERMEDIATE' ? 'info' : 'ok'}>{COMPLEXITY_LABEL[value.complexity.level]}</Badge>
          {ov && <span className="text-xs text-ink-3">(ajustada; según las respuestas sería {COMPLEXITY_LABEL[value.complexity.computed].toLowerCase()})</span>}
          {evaluating && <span className="text-xs text-ink-3">Recalculando…</span>}
        </div>
        <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">
          {value.complexity.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
        {!client && (
          <div className="mt-3 grid gap-2 sm:grid-cols-[180px_1fr]">
            <Select aria-label="Ajustar complejidad" value={ov?.level ?? ''} onChange={(e) => {
              const level = e.target.value as Complexity | '';
              update((v) => ({ ...v, complexity: { ...v.complexity, override: level ? { level, reason: v.complexity.override?.reason ?? '', by: null } : null, level: level || v.complexity.computed } }));
            }}>
              <option value="">Sin ajuste (calculada)</option>
              {(['SIMPLE', 'INTERMEDIATE', 'COMPLEX'] as Complexity[]).map((k) => <option key={k} value={k}>{COMPLEXITY_LABEL[k]}</option>)}
            </Select>
            {ov && (
              <Input aria-label="Motivo del ajuste" placeholder="¿Por qué la ajustas? (obligatorio)" value={ov.reason}
                onChange={(e) => update((v) => ({ ...v, complexity: { ...v.complexity, override: { ...v.complexity.override!, reason: e.target.value } } }))} />
            )}
          </div>
        )}
      </section>

      {/* 4. Productos */}
      {!hide.includes('products') && <section>
        <p className="kicker mb-2">{client ? 'Qué vas a usar de BackOffice' : 'Productos contratados'}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {catalog?.products.map((p) => {
            const on = value.products.selected.includes(p.key);
            const rec = value.products.recommended.includes(p.key);
            return (
              <button key={p.key} type="button" onClick={() => toggleProduct(p.key)} aria-pressed={on}
                className={clsx('cursor-pointer border-2 p-3 text-left', on ? 'border-ink bg-ink text-bone' : 'border-line bg-paper hover:border-ink')}>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{p.short}</span>
                  {on ? <Check size={16} aria-hidden /> : null}
                </span>
                {rec && <span className={clsx('mt-1 inline-block text-[10px] font-bold uppercase tracking-[0.1em]', on ? 'text-bone' : 'text-ok')}>Recomendado</span>}
                <span className={clsx('mt-1 block text-xs', on ? 'text-bone/80' : 'text-ink-3')}>
                  {value.products.reasons[p.key]?.[0] ?? p.summary}
                </span>
              </button>
            );
          })}
        </div>
        {!value.products.selected.length && <p role="alert" className="mt-2 text-sm font-semibold text-bad">Elige al menos uno.</p>}
      </section>}

      {/* 5. Capacidades */}
      {value.capabilities.length > 0 && !hide.includes('capabilities') && (
        <section>
          <p className="kicker mb-2">{client ? 'Lo que vas a tener' : 'Capacidades requeridas'}</p>
          <ul className="space-y-1.5">
            {value.capabilities.map((c) => (
              <li key={c.key} className={clsx('border-2 px-3 py-2 text-sm', c.included ? 'border-line bg-paper' : 'border-dashed border-line text-ink-3')}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{c.label}</span>
                  {c.included
                    ? <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                    : <span className="text-xs">Necesita {catalog?.products.find((p) => p.key === c.product)?.short ?? c.product}</span>}
                </div>
                <p className="text-xs text-ink-3">{c.why}{c.note ? ` — ${c.note}` : ''}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {error && <p role="alert" className="text-sm font-semibold text-bad">{error}</p>}
    </div>
  );
}
