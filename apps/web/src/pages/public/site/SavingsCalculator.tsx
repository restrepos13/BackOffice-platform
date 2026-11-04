import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * Calculadora de ahorro con los números del propio visitante. No promete
 * resultados: muestra la fórmula y deja claro que es una estimación.
 */

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const num = (n: number) => Math.round(n).toLocaleString('es-CO');

interface Field {
  key: 'chats' | 'minutes' | 'days' | 'hourCost' | 'repetitive';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  money?: boolean;
}

const FIELDS: Field[] = [
  { key: 'chats', label: 'Conversaciones por día', hint: 'Chats que tu negocio atiende en un día normal.', min: 1, max: 500, step: 1 },
  { key: 'minutes', label: 'Minutos por conversación', hint: 'Tiempo promedio que alguien dedica a cada una.', min: 1, max: 30, step: 1, suffix: 'min' },
  { key: 'days', label: 'Días que atiendes al mes', hint: 'Por ejemplo 26 si atiendes de lunes a sábado.', min: 1, max: 31, step: 1, suffix: 'días' },
  { key: 'hourCost', label: 'Costo de una hora de tu equipo', hint: 'Salario y prestaciones ÷ horas trabajadas al mes.', min: 3000, max: 100000, step: 500, money: true },
  { key: 'repetitive', label: 'Conversaciones repetitivas', hint: 'Las que siempre se responden igual (precio, horario, estado).', min: 0, max: 100, step: 5, suffix: '%' },
];

export function estimateSavings(v: Record<Field['key'], number>) {
  const hours = (v.chats * v.minutes * v.days) / 60;
  const savedHours = hours * (v.repetitive / 100);
  return { hours, cost: hours * v.hourCost, savedHours, saved: savedHours * v.hourCost };
}

export function SavingsCalculator({ compact = false }: { compact?: boolean }) {
  const id = useId();
  const [v, setV] = useState<Record<Field['key'], number>>({ chats: 40, minutes: 4, days: 26, hourCost: 10000, repetitive: 60 });
  const r = estimateSavings(v);
  const set = (k: Field['key'], raw: string, f: Field) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setV((s) => ({ ...s, [k]: Math.min(f.max, Math.max(f.min, n)) }));
  };

  return (
    <div className={`grid border-2 border-ink bg-paper ${compact ? '' : 'shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]'} lg:grid-cols-[1.25fr_1fr]`}>
      <form className="space-y-5 p-5 md:p-7" onSubmit={(e) => e.preventDefault()} aria-label="Datos de tu negocio">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`${id}-${f.key}`} className="text-sm font-semibold">{f.label}</label>
              <span className="display text-xl tabular-nums">
                {f.money ? cop(v[f.key]) : num(v[f.key])}{f.suffix && <span className="ml-1 font-sans text-xs normal-case text-ink-3">{f.suffix}</span>}
              </span>
            </div>
            <input
              id={`${id}-${f.key}`}
              type="range"
              min={f.min}
              max={f.max}
              step={f.step}
              value={v[f.key]}
              onChange={(e) => set(f.key, e.target.value, f)}
              aria-describedby={`${id}-${f.key}-hint`}
              className="mt-2 w-full cursor-pointer accent-[#1a1a1a]"
            />
            <p id={`${id}-${f.key}-hint`} className="mt-1 text-xs text-ink-3">{f.hint}</p>
          </div>
        ))}
      </form>
      <div className="flex flex-col justify-between gap-6 border-t-2 border-ink bg-ink p-5 text-bone md:p-7 lg:border-l-2 lg:border-t-0" aria-live="polite">
        <div className="space-y-5">
          <div>
            <p className="kicker !text-line">Hoy tu equipo dedica</p>
            <p className="display text-5xl tabular-nums">{num(r.hours)} <span className="text-2xl">horas/mes</span></p>
            <p className="text-sm text-line">a responder WhatsApp, unos <b className="text-bone">{cop(r.cost)}</b> al mes.</p>
          </div>
          <div className="border-t border-ink-2 pt-5">
            <p className="kicker !text-line">Automatizando lo repetitivo podrías liberar</p>
            <p className="display text-5xl tabular-nums text-wa">{num(r.savedHours)} <span className="text-2xl">horas/mes</span></p>
            <p className="text-sm text-line">equivalentes a unos <b className="text-bone">{cop(r.saved)}</b> al mes, o <b className="text-bone">{cop(r.saved * 12)}</b> al año.</p>
          </div>
        </div>
        <div className="space-y-3">
          <p className="text-xs text-line">Estimación con tus datos. No incluye las ventas que hoy se pierden por responder tarde o fuera de horario, ni el costo del plan y de los mensajes de Meta.</p>
          <Link to="/registro" className="inline-flex bg-bone px-5 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-ink hover:bg-paper">
            Automatizar mi WhatsApp
          </Link>
        </div>
      </div>
    </div>
  );
}
