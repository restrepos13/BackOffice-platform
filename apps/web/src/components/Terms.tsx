import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button } from './ui';

/**
 * Términos y condiciones: el texto (formato simple: "## Título", párrafos y
 * listas con "- "), la puerta que pide aceptarlos al entrar al panel y la
 * página pública /terminos.
 */

export interface TermsDoc {
  version: number;
  title: string;
  body: string;
  updatedAt: string;
}

/** Negrita con **texto**; los [CORCHETES] (datos por completar) resaltados. */
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\])/g).map((part, i) => {
    if (/^\*\*.+\*\*$/.test(part)) return <b key={i}>{part.slice(2, -2)}</b>;
    if (/^\[.+\]$/.test(part)) return <mark key={i} className="bg-warn-soft px-0.5">{part}</mark>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export function TermsBody({ body, className }: { body: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(<ul key={`l${blocks.length}`} className="mb-3 list-disc space-y-1 pl-5">{list.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>);
      list = [];
    }
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      continue;
    }
    flush();
    if (line.startsWith('## ')) blocks.push(<h2 key={`h${blocks.length}`} className="mb-2 mt-5 text-base font-semibold">{inline(line.slice(3))}</h2>);
    else blocks.push(<p key={`p${blocks.length}`} className="mb-3">{inline(line)}</p>);
  }
  flush();
  return <div className={clsx('text-sm leading-relaxed text-ink-2', className)}>{blocks}</div>;
}

/** Bloquea el panel hasta que el administrador acepte la versión vigente. */
export function TermsGate() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const needsCheck = user?.role === 'COMPANY_ADMIN' || user?.role === 'COMPANY_VIEWER';
  const { data: status } = useQuery({
    queryKey: ['terms-status'],
    queryFn: () => api.get<{ required: boolean; version: number; updatedSinceAccepted?: boolean }>('/terms/status'),
    enabled: needsCheck,
  });
  const { data: doc } = useQuery({
    queryKey: ['terms-doc'],
    queryFn: () => api.get<TermsDoc>('/public/terms'),
    enabled: !!status?.required,
  });
  const [checked, setChecked] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const accept = useMutation({
    mutationFn: () => api.post('/terms/accept', { version: doc?.version }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['terms-status'] }),
  });
  if (!needsCheck || !status?.required) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/85 p-3" role="dialog" aria-modal="true" aria-labelledby="terms-title">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col border-2 border-ink bg-paper shadow-[10px_10px_0_0_rgba(0,0,0,0.6)]">
        <header className="border-b-2 border-ink px-5 py-4">
          <p className="kicker">{status.updatedSinceAccepted ? 'Actualizamos los términos' : 'Antes de empezar'}</p>
          <h1 id="terms-title" className="display text-2xl">{doc?.title ?? 'Términos y condiciones'}</h1>
          <p className="mt-1 text-xs text-ink-3">
            {status.updatedSinceAccepted
              ? 'Cambiaron algunas condiciones. Léelas y acepta para seguir usando tu panel.'
              : 'Léelos con calma. Cuando llegues al final podrás aceptarlos.'}
          </p>
        </header>
        <div
          ref={box}
          className="flex-1 overflow-y-auto px-5 py-4"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) setReadToEnd(true);
          }}
        >
          {doc ? <TermsBody body={doc.body} /> : <p className="text-sm text-ink-3">Cargando…</p>}
        </div>
        <footer className="space-y-3 border-t-2 border-ink px-5 py-4">
          {!readToEnd && (
            <button type="button" className="cursor-pointer text-xs font-semibold underline" onClick={() => box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' })}>
              Bajar hasta el final
            </button>
          )}
          <label className={clsx('flex items-start gap-3 text-sm', !readToEnd && 'opacity-50')}>
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[#1a1a1a]"
              disabled={!readToEnd}
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
            />
            <span>Leí y acepto los términos y condiciones en nombre de mi empresa (versión {doc?.version ?? status.version}).</span>
          </label>
          {accept.error && <p role="alert" className="text-sm font-semibold text-bad">{accept.error instanceof Error ? accept.error.message : 'No se pudo guardar'}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link to="/terminos" target="_blank" className="text-xs underline">Abrir en otra pestaña</Link>
            <Button disabled={!checked || !doc || accept.isPending} onClick={() => accept.mutate()}>
              {accept.isPending ? 'Guardando…' : 'Acepto y quiero seguir'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/** Página pública /terminos. */
export function PublicTerms() {
  const { data } = useQuery({ queryKey: ['terms-doc'], queryFn: () => api.get<TermsDoc>('/public/terms') });
  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5">
        <Link to="/" className="display text-2xl leading-none">BackOffice<span className="text-ok">.</span></Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16">
        {data ? (
          <article className="border-2 border-ink bg-paper p-6">
            <h1 className="display text-3xl">{data.title}</h1>
            <p className="mb-4 text-xs text-ink-3">Versión {data.version} · actualizada el {new Date(data.updatedAt).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
            <TermsBody body={data.body} />
          </article>
        ) : <p className="text-sm text-ink-3">Cargando…</p>}
      </main>
    </div>
  );
}
