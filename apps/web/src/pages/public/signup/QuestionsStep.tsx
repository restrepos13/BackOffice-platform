import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, Check, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import SetupProgress from '../../../components/SetupProgress';
import { Button } from '../../../components/ui';
import { Notice, Panel } from './parts';
import QuickContact from './QuickContact';
import { OTHER, QUESTION_COUNT, valuePreview, type Answers, type Question } from './questions';

/**
 * Las 5 preguntas, una a la vez, pensadas para el celular: se responden
 * tocando (botones grandes), con «Pregunta X de 5» y barra de avance. Después
 * de la 2 aparece un adelanto de lo que haría su asistente.
 */

const BUILD_STEPS = ['Entendiendo tu negocio', 'Eligiendo tus herramientas', 'Armando tu catálogo', 'Creando tu asistente', 'Últimos detalles'];

const optionClass = (on: boolean) =>
  clsx(
    'flex min-h-[52px] w-full cursor-pointer items-center justify-between gap-2 border-2 px-4 py-3 text-left text-[15px] font-semibold transition-colors',
    on ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink focus-visible:border-ink',
  );

function splitMulti(value: string | undefined, options: string[]) {
  const parts = (value ?? '').split(', ').filter(Boolean);
  const picked = parts.filter((p) => options.includes(p));
  const other = parts.find((p) => p.startsWith(`${OTHER}: `))?.slice(OTHER.length + 2) ?? '';
  return { picked, other };
}

export default function QuestionsStep(props: {
  question: Question;
  answers: Answers;
  link: string;
  onLink: (v: string) => void;
  onAnswer: (value: string) => void;
  onBack: () => void;
  /** Adelanto de valor (después de la pregunta 2) */
  showValue: boolean;
  onContinueValue: () => void;
  building: boolean;
  buildError: string | null;
  onRetryBuild: () => void;
  phone?: string;
}) {
  const q = props.question;
  const saved = props.answers[q.id];
  const [other, setOther] = useState('');
  const [otherOpen, setOtherOpen] = useState(false);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  // Al cambiar de pregunta: lo que ya había respondido (si volvió atrás)
  useEffect(() => {
    const options = q.options ?? [];
    if (q.kind === 'multi') {
      const m = splitMulti(saved, options);
      setPicked(m.picked);
      setOther(m.other);
      setOtherOpen(!!m.other);
    } else if (q.kind === 'single') {
      const isOther = !!saved && !options.includes(saved);
      setOther(isOther ? saved!.replace(/^Otro: /, '') : '');
      setOtherOpen(isOther);
    } else {
      setText(saved && saved !== q.skip ? saved : '');
    }
    window.scrollTo?.({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id, q.n]);

  // Respondidas hasta ahora y las que quedan (contando la que está en pantalla)
  const pct = Math.round(((q.n - 1) / QUESTION_COUNT) * 100);
  const left = props.showValue ? QUESTION_COUNT - q.n + 1 : QUESTION_COUNT - q.n;

  if (props.building || props.buildError) {
    return (
      <div className="mx-auto max-w-xl">
        <Panel className="p-5 sm:p-6">
          {props.building ? (
            <SetupProgress title="Armando tu propuesta" steps={BUILD_STEPS} running={props.building} expectedMs={22000} hint="Esto toma entre 10 y 40 segundos. No cierres la página." />
          ) : (
            <Notice tone="bad" action={<Button size="sm" onClick={props.onRetryBuild}><RotateCcw size={13} /> Intentar otra vez</Button>}>
              {props.buildError} Tus respuestas siguen guardadas.
            </Notice>
          )}
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      {/* Cuánto falta */}
      <div className="mb-5">
        <p className="kicker">Tu diagnóstico · {QUESTION_COUNT} preguntas · 2 minutos</p>
        <div className="mt-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.1em] text-ink-2">
          <span>{props.showValue ? `Vas en la ${q.n - 1} de ${QUESTION_COUNT}` : `Pregunta ${q.n} de ${QUESTION_COUNT}`}</span>
          <span className="text-ink-3">{left === 0 ? 'Última pregunta' : props.showValue ? `Quedan ${left}` : `${left} más después de esta`}</span>
        </div>
        <div
          className="mt-2 h-1.5 w-full bg-bone-2"
          role="progressbar"
          aria-label="Avance de las preguntas"
          aria-valuenow={props.showValue ? q.n - 1 : q.n}
          aria-valuemin={1}
          aria-valuemax={QUESTION_COUNT}
        >
          <div className="h-full bg-ink transition-[width] duration-500" style={{ width: `${Math.max(6, pct)}%` }} />
        </div>
      </div>

      {props.showValue ? (
        <Panel className="p-5 sm:p-6">
          <p className="kicker flex items-center gap-1.5"><Sparkles size={12} aria-hidden /> Adelanto</p>
          <h2 id="step-title" tabIndex={-1} className="mt-2 text-xl font-semibold outline-none">Con lo que me contaste, tu asistente podría:</h2>
          <ul className="mt-4 space-y-2.5">
            {valuePreview(props.answers).map((b) => (
              <li key={b} className="flex items-start gap-2.5 text-[15px]">
                <Check size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden /> {b}
              </li>
            ))}
          </ul>
          <Button className="mt-6 w-full !py-3 text-base" onClick={props.onContinueValue}>
            Seguir · faltan {QUESTION_COUNT - q.n + 1} <ArrowRight size={16} />
          </Button>
        </Panel>
      ) : (
        <Panel className="p-5 sm:p-6">
          <h2 id="step-title" tabIndex={-1} className="text-xl font-semibold leading-snug outline-none sm:text-2xl">{q.text}</h2>
          {q.hint && <p className="mt-1 text-sm text-ink-3">{q.hint}</p>}

          {q.kind === 'single' && (
            <div className="mt-5 grid gap-2 sm:grid-cols-2" role="group" aria-label="Opciones">
              {(q.options ?? []).map((o) => (
                <button key={o} type="button" aria-pressed={saved === o} className={optionClass(saved === o)} onClick={() => props.onAnswer(o)}>
                  {o} {saved === o && <Check size={16} aria-hidden />}
                </button>
              ))}
              {q.other && (
                <button type="button" aria-pressed={otherOpen} className={optionClass(otherOpen)} onClick={() => setOtherOpen(true)}>
                  {OTHER}
                </button>
              )}
            </div>
          )}

          {q.kind === 'multi' && (
            <div className="mt-5 grid gap-2" role="group" aria-label="Opciones (puedes elegir varias)">
              {(q.options ?? []).map((o) => {
                const on = picked.includes(o);
                return (
                  <button key={o} type="button" aria-pressed={on} className={optionClass(on)} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== o) : [...p, o]))}>
                    {o} <span className={clsx('flex h-5 w-5 items-center justify-center border-2', on ? 'border-bone' : 'border-ink-3')} aria-hidden>{on && <Check size={13} />}</span>
                  </button>
                );
              })}
              {q.other && (
                <button type="button" aria-pressed={otherOpen} className={optionClass(otherOpen)} onClick={() => setOtherOpen((v) => !v)}>
                  {OTHER}
                </button>
              )}
            </div>
          )}

          {otherOpen && q.kind !== 'text' && (
            <div className="mt-3">
              <label htmlFor="q-other" className="sr-only">{q.placeholder ?? 'Otra respuesta'}</label>
              <input
                id="q-other"
                autoFocus
                maxLength={200}
                value={other}
                placeholder={q.placeholder ?? 'Escribe tu respuesta'}
                onChange={(e) => setOther(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && q.kind === 'single' && other.trim()) {
                    e.preventDefault();
                    props.onAnswer(`${OTHER}: ${other.trim()}`);
                  }
                }}
                className="block w-full border-2 border-ink bg-paper px-3 py-3 text-base outline-none focus:border-ok"
              />
              {q.kind === 'single' && (
                <Button className="mt-3 w-full !py-3 text-base" disabled={!other.trim()} onClick={() => props.onAnswer(`${OTHER}: ${other.trim()}`)}>
                  Continuar <ArrowRight size={16} />
                </Button>
              )}
            </div>
          )}

          {q.kind === 'multi' && (
            <Button
              className="mt-4 w-full !py-3 text-base"
              disabled={!picked.length && !other.trim()}
              onClick={() => props.onAnswer([...picked, ...(otherOpen && other.trim() ? [`${OTHER}: ${other.trim()}`] : [])].join(', '))}
            >
              Continuar <ArrowRight size={16} />
            </Button>
          )}

          {q.kind === 'text' && (
            <form
              className="mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim().length >= 3) props.onAnswer(text.trim());
              }}
            >
              <label htmlFor="q-text" className="sr-only">Tu respuesta</label>
              <textarea
                id="q-text"
                rows={3}
                maxLength={600}
                value={text}
                placeholder={q.placeholder}
                onChange={(e) => setText(e.target.value)}
                className="block w-full border-2 border-ink bg-paper px-3 py-3 text-base outline-none focus:border-ok"
              />
              <label htmlFor="q-link" className="mt-4 block text-sm font-semibold">Pega el link de tu Instagram o tu web <span className="font-normal text-ink-3">(opcional)</span></label>
              <input
                id="q-link"
                inputMode="url"
                autoCapitalize="none"
                maxLength={200}
                value={props.link}
                placeholder="instagram.com/tunegocio o tunegocio.com"
                onChange={(e) => props.onLink(e.target.value.trim())}
                className="mt-1 block w-full border-2 border-line bg-paper px-3 py-3 text-base outline-none focus:border-ink"
              />
              <p className="mt-1 text-xs text-ink-3">Si tienes web, de ahí sacamos tu rubro y lo que vendes.</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
                <Button type="submit" className="!py-3 text-base" disabled={text.trim().length < 3}>
                  Continuar <ArrowRight size={16} />
                </Button>
                {q.skip && (
                  <Button type="button" variant="outline" className="!py-3" onClick={() => props.onAnswer(q.skip!)}>
                    {q.skip}
                  </Button>
                )}
              </div>
            </form>
          )}
        </Panel>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        {q.n > 1 || props.showValue ? (
          <button type="button" onClick={props.onBack} className="flex cursor-pointer items-center gap-1 text-sm font-semibold text-ink-2 hover:text-ink">
            <ArrowLeft size={14} aria-hidden /> Atrás
          </button>
        ) : <span />}
        <p className="text-xs text-ink-3">Tu avance se guarda solo.</p>
      </div>

      <div className="mt-6">
        <QuickContact compact phone={props.phone} />
      </div>
    </div>
  );
}
