import { clsx } from 'clsx';
import { X } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
} from 'react';

/* ─── Botones ──────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      className={clsx(
        'inline-flex cursor-pointer items-center justify-center gap-2 font-semibold uppercase tracking-[0.08em] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'px-3 py-1.5 text-[11px]' : 'px-5 py-2.5 text-xs',
        variant === 'primary' &&
          'border-2 border-ink bg-ink text-bone hover:bg-transparent hover:text-ink',
        variant === 'outline' &&
          'border-2 border-ink bg-transparent text-ink hover:bg-ink hover:text-bone',
        variant === 'ghost' &&
          'border-2 border-transparent text-ink-2 hover:border-line hover:text-ink',
        variant === 'danger' &&
          'border-2 border-bad bg-bad text-white hover:bg-transparent hover:text-bad',
        className,
      )}
      {...props}
    />
  );
}

/* ─── Card ─────────────────────────────────────────────────────────── */

export function Card({
  children,
  className,
  title,
  kicker,
  actions,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  kicker?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={clsx('border-2 border-ink bg-paper', className)}>
      {(title || kicker || actions) && (
        <header className="flex items-end justify-between gap-4 border-b-2 border-ink px-5 py-3">
          <div>
            {kicker && <p className="kicker">{kicker}</p>}
            {title && (
              <h2 className="display text-lg leading-tight">{title}</h2>
            )}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

/* ─── Stat (KPI) ───────────────────────────────────────────────────── */

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className="border-2 border-ink bg-paper px-4 py-3">
      <p className="kicker">{label}</p>
      <p
        className={clsx(
          'display mt-1 text-3xl',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
          tone === 'bad' && 'text-bad',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
    </div>
  );
}

/* ─── Badge ────────────────────────────────────────────────────────── */

const BADGE_TONES: Record<string, string> = {
  ok: 'bg-ok-soft text-ok border-ok',
  warn: 'bg-warn-soft text-warn border-warn',
  bad: 'bg-bad-soft text-bad border-bad',
  info: 'bg-info-soft text-info border-info',
  neutral: 'bg-bone-2 text-ink-2 border-line',
  ink: 'bg-ink text-bone border-ink',
};

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: keyof typeof BADGE_TONES;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center whitespace-nowrap border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Mapeos rápidos de estado → tono */
export function statusTone(status: string): keyof typeof BADGE_TONES {
  switch (status) {
    case 'ACTIVE':
    case 'CONNECTED':
    case 'PAID':
    case 'RESOLVED':
    case 'SUCCESS':
    case 'CLIENTE':
    case 'APPROVED':
    case 'SENT':
      return 'ok';
    case 'TRIAL':
    case 'PENDING':
    case 'PAUSED':
    case 'HANDOFF':
    case 'POTENCIAL':
    case 'QUEUED':
      return 'warn';
    case 'SUSPENDED':
    case 'CANCELLED':
    case 'ERROR':
    case 'OVERDUE':
    case 'FAILED':
    case 'DESCARTADO':
    case 'DECLINED':
    case 'VOIDED':
      return 'bad';
    case 'CALIENTE':
      return 'bad';
    case 'OPEN':
      return 'info';
    default:
      return 'neutral';
  }
}

/* ─── Formularios ──────────────────────────────────────────────────── */

export function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="kicker mb-1 block">
        {label}
        {required && <span className="text-bad"> *</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

const inputBase =
  'w-full border-2 border-ink bg-bone px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:bg-paper';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx(inputBase, props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      rows={4}
      {...props}
      className={clsx(inputBase, 'resize-y', props.className)}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={clsx(inputBase, 'cursor-pointer appearance-none', props.className)}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-6 w-11 cursor-pointer items-center border-2 border-ink transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        checked ? 'bg-ink' : 'bg-bone',
      )}
    >
      <span
        className={clsx(
          'h-3.5 w-3.5 transition-transform',
          checked ? 'translate-x-[22px] bg-bone' : 'translate-x-[3px] bg-ink',
        )}
      />
    </button>
  );
}

/* ─── Tabla ────────────────────────────────────────────────────────── */

export function Table({
  head,
  children,
}: {
  head: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-auto border-2 border-ink bg-paper">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b-2 border-ink bg-bone-2">
            {head.map((h) => (
              <th key={h} className="kicker px-4 py-2.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

/* ─── Tabs ─────────────────────────────────────────────────────────── */

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; badge?: number }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-0 border-2 border-ink bg-paper" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={clsx(
            'cursor-pointer px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition-colors',
            active === tab.id
              ? 'bg-ink text-bone'
              : 'text-ink-2 hover:bg-bone-2',
          )}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="ml-2 inline-block border border-current px-1 text-[10px]">
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ─── Modal ────────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  kicker,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  kicker?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/50 p-4 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'w-full border-2 border-ink bg-paper shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <header className="flex items-start justify-between border-b-2 border-ink px-5 py-3">
          <div>
            {kicker && <p className="kicker">{kicker}</p>}
            <h2 className="display text-xl">{title}</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="cursor-pointer border-2 border-ink p-1 hover:bg-ink hover:text-bone"
          >
            <X size={14} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ─── Estados vacíos y carga ───────────────────────────────────────── */

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center border-2 border-dashed border-line bg-paper px-6 py-14 text-center">
      <p className="display text-xl text-ink-2">{title}</p>
      {hint && <p className="mt-2 max-w-md text-sm text-ink-3">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-ink-3">
      <span className="h-3 w-3 animate-pulse bg-ink" aria-hidden />
      <span className="kicker">{label}</span>
    </div>
  );
}

/* ─── Encabezado de página ─────────────────────────────────────────── */

export function PageHeader({
  kicker,
  title,
  accent,
  actions,
}: {
  kicker: string;
  title: string;
  /** Palabra final en Playfair itálica, como la landing */
  accent?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-4">
      <div>
        <p className="kicker">{kicker}</p>
        <h1 className="display mt-1 text-4xl">
          {title}
          {accent && (
            <>
              {' '}
              <span className="serif-accent normal-case tracking-normal">
                {accent}
              </span>
            </>
          )}
        </h1>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
