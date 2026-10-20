import { clsx } from 'clsx';
import { Check } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * Barra de "lo estamos configurando": el porcentaje avanza solo mientras se
 * espera (sin pasar del 95 %) y llega al 100 % cuando termina de verdad.
 * Así la espera se siente como avance y no como una pantalla congelada.
 */
export function useFakeProgress(running: boolean, done = false, expectedMs = 8000) {
  const [pct, setPct] = useState(0);
  const start = useRef<number | null>(null);
  useEffect(() => {
    if (done) {
      setPct(100);
      return;
    }
    if (!running) {
      start.current = null;
      setPct(0);
      return;
    }
    start.current = Date.now();
    const t = setInterval(() => {
      const elapsed = Date.now() - (start.current ?? Date.now());
      // Curva que se frena: rápido al principio, nunca llega sola al final
      setPct(Math.min(95, Math.round(95 * (1 - Math.exp(-elapsed / (expectedMs / 2.2))))));
    }, 180);
    return () => clearInterval(t);
  }, [running, done, expectedMs]);
  return pct;
}

export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={clsx('h-3 border-2 border-ink bg-bone', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-ok transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function SetupProgress({
  steps,
  running,
  done = false,
  title = 'Configurando',
  hint,
  expectedMs = 9000,
  className,
}: {
  steps: string[];
  running: boolean;
  done?: boolean;
  title?: string;
  hint?: string;
  expectedMs?: number;
  className?: string;
}) {
  const pct = useFakeProgress(running, done, expectedMs);
  const current = done ? steps.length : Math.min(steps.length - 1, Math.floor((pct / 100) * steps.length));
  return (
    <div className={clsx('border-2 border-ink bg-paper p-4', className)} aria-live="polite">
      <div className="flex items-end justify-between gap-3">
        <p className="kicker">{title}</p>
        <p className="display text-3xl tabular-nums">{pct}%</p>
      </div>
      <ProgressBar pct={pct} className="mt-2" />
      <ol className="mt-3 space-y-1.5 text-sm">
        {steps.map((label, i) => (
          <li key={label} className={clsx('flex items-center gap-2', i > current && 'text-ink-3')}>
            <span className={clsx('flex h-5 w-5 shrink-0 items-center justify-center border-2', i < current ? 'border-ok bg-ok text-white' : i === current ? 'animate-pulse border-ink' : 'border-line')}>
              {i < current && <Check size={11} />}
            </span>
            {label}
          </li>
        ))}
      </ol>
      {hint && <p className="mt-2 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}
