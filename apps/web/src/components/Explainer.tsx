import { ChevronDown, Lightbulb } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * «Qué es y cómo funciona» en lenguaje simple, arriba de las pantallas que un
 * dueño de negocio no tiene por qué conocer. Se puede cerrar; se recuerda
 * cerrado en este navegador.
 */
export function Explainer({ id, title, summary, steps, children }: { id: string; title: string; summary: ReactNode; steps?: ReactNode[]; children?: ReactNode }) {
  const key = `bo_explainer_${id}`;
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(key) !== 'closed'; } catch { return true; }
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(key, next ? 'open' : 'closed'); } catch { /* sin almacenamiento */ }
  };
  return (
    <section className="mb-6 border-2 border-line bg-paper" data-testid={`explainer-${id}`}>
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left">
        <Lightbulb size={16} className="shrink-0 text-ink-3" />
        <span className="flex-1 text-sm font-semibold">{title}</span>
        <span className="text-xs text-ink-3">{open ? 'Ocultar' : 'Ver explicación'}</span>
        <ChevronDown size={14} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
      </button>
      {open && (
        <div className="border-t-2 border-line px-4 py-3 text-sm text-ink-2">
          <div className="max-w-3xl">{summary}</div>
          {steps && steps.length > 0 && (
            <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2 border-2 border-line bg-bone px-3 py-2 text-xs">
                  <span className="display text-base leading-none">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          )}
          {children}
        </div>
      )}
    </section>
  );
}
