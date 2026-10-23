import { clsx } from 'clsx';
import { AlertTriangle, Check, ChevronDown, Info, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/** Piezas visuales del registro (misma identidad: hueso, tinta, bordes rectos). */

export type StepNumber = 1 | 2 | 3 | 4;
export const STEP_LABELS: Record<StepNumber, string> = { 1: 'Tu negocio', 2: 'Propuesta', 3: 'Productos', 4: 'Revisión y cuenta' };

/** Pasos del registro. Se puede volver a cualquier paso ya visitado. */
export function Stepper({ step, reachable, onGo }: { step: StepNumber; reachable: (n: StepNumber) => boolean; onGo: (n: StepNumber) => void }) {
  const steps = [1, 2, 3, 4] as StepNumber[];
  return (
    <nav aria-label="Pasos del registro" className="mb-8">
      {/* Móvil: texto + barra */}
      <div className="sm:hidden">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Paso {step} de 4</p>
        <p className="text-base font-semibold">{STEP_LABELS[step]}</p>
        <div className="mt-2 grid grid-cols-4 gap-1" aria-hidden>
          {steps.map((n) => <span key={n} className={clsx('h-1', n <= step ? 'bg-ink' : 'bg-line')} />)}
        </div>
      </div>
      {/* Escritorio */}
      <ol className="hidden grid-cols-4 gap-3 sm:grid">
        {steps.map((n) => {
          const current = n === step;
          const done = n < step;
          const canGo = !current && reachable(n);
          return (
            <li key={n}>
              <button
                type="button"
                disabled={!canGo}
                aria-current={current ? 'step' : undefined}
                onClick={() => canGo && onGo(n)}
                className={clsx(
                  'group flex w-full items-center gap-3 border-t-4 pt-3 text-left',
                  current ? 'border-ink' : done ? 'border-ink-3' : 'border-line',
                  canGo ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                <span
                  className={clsx(
                    'flex h-7 w-7 shrink-0 items-center justify-center border-2 text-xs font-bold',
                    current ? 'border-ink bg-ink text-bone' : done ? 'border-ink bg-paper text-ink' : 'border-line text-ink-3',
                  )}
                >
                  {done ? <Check size={14} aria-label="completado" /> : n}
                </span>
                <span className={clsx('text-sm font-semibold', current ? 'text-ink' : done ? 'text-ink-2 group-hover:underline' : 'text-ink-3')}>
                  {STEP_LABELS[n]}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'info' ? Info : tone === 'ok' ? Check : AlertTriangle;
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={clsx(
        'flex flex-wrap items-center justify-between gap-3 border-l-4 px-4 py-3 text-sm',
        tone === 'bad' ? 'border-bad bg-bad-soft' : tone === 'warn' ? 'border-warn bg-warn-soft' : tone === 'ok' ? 'border-ok bg-ok-soft' : 'border-ink bg-paper',
      )}
    >
      <span className="flex items-start gap-2">
        <Icon size={16} className={clsx('mt-0.5 shrink-0', tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-ink-2')} aria-hidden />
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}

/** Bloque principal de cada paso. */
export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx('border-2 border-ink bg-paper', className)}>{children}</section>;
}

/** Encabezado de un paso: el h1 recibe el foco al cambiar de paso (lectores de pantalla). */
export function StepTitle({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6">
      <p className="kicker">{kicker}</p>
      <h1 id="step-title" tabIndex={-1} className="mt-1 text-3xl font-semibold leading-tight tracking-tight outline-none sm:text-4xl">{title}</h1>
      {children && <p className="mt-2 max-w-2xl text-[15px] text-ink-2">{children}</p>}
    </header>
  );
}

/** Tarjeta que se abre para editar (configuración inicial). */
export function EditableCard({ title, summary, children, defaultOpen = false }: { title: string; summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={clsx('border-2 bg-paper transition-colors', open ? 'border-ink' : 'border-line hover:border-ink-3')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full cursor-pointer items-start justify-between gap-3 p-4 text-left">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{title}</span>
          <span className="mt-0.5 block text-sm text-ink-2">{summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-ink-2">
          {open ? 'Cerrar' : 'Editar'} <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
      {open && <div className="border-t-2 border-line p-4">{children}</div>}
    </section>
  );
}

export function Chips({ items, onChange, placeholder, label }: { items: string[]; onChange: (v: string[]) => void; placeholder: string; label: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-2 border-line bg-paper p-1.5 focus-within:border-ink">
      {items.map((it) => (
        <span key={it} className="inline-flex items-center gap-1 border border-ink bg-bone px-2 py-0.5 text-xs font-semibold">
          {it}
          <button type="button" aria-label={`Quitar ${it}`} className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => onChange(items.filter((x) => x !== it))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        className="min-w-[140px] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

/** Barra inferior de acciones de cada paso (fija en móvil). */
export function StepActions({ back, next }: { back?: ReactNode; next: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 mt-8 flex items-center justify-between gap-3 border-t-2 border-ink bg-bone/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none">
      <div>{back}</div>
      <div>{next}</div>
    </div>
  );
}
