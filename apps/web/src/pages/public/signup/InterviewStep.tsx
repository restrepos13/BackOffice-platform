import { clsx } from 'clsx';
import { ArrowRight, HardHat, Mic, MicOff, Pencil, RotateCcw, Shirt, Sparkles, Stethoscope, Trophy, Utensils } from 'lucide-react';
import type { RefObject } from 'react';
import SetupProgress from '../../../components/SetupProgress';
import { Button, Textarea } from '../../../components/ui';
import type { Msg } from '../signup-helpers';
import { Notice, Panel, StepTitle } from './parts';

/**
 * Paso 1: la entrevista como asistente de configuración (no como chat): una
 * pregunta a la vez, respuestas sugeridas y el historial con «Corregir».
 * El motor (IA o preguntas fijas) es el mismo de siempre; aquí solo se presenta.
 */

const STARTERS = [
  { icon: Utensils, text: 'Tengo un restaurante de almuerzos con domicilios' },
  { icon: Shirt, text: 'Vendo ropa por Instagram y WhatsApp' },
  { icon: Trophy, text: 'Tengo dos canchas de fútbol y la gente reserva por WhatsApp' },
  { icon: Stethoscope, text: 'Tengo un consultorio y agendo citas' },
  { icon: HardHat, text: 'Doy cursos de trabajo seguro en alturas' },
];

const BUILD_STEPS = ['Entendiendo tu negocio', 'Eligiendo tus herramientas', 'Armando tu catálogo', 'Creando tu asistente', 'Últimos detalles'];

/** Avance aproximado: la entrevista es adaptativa, así que no se promete un número de preguntas. */
export function interviewStage(answers: number): { label: string; pct: number } {
  if (answers === 0) return { label: 'Empezando', pct: 4 };
  if (answers <= 2) return { label: 'Conociendo tu negocio', pct: 25 + answers * 8 };
  if (answers <= 4) return { label: 'Entendiendo cómo trabajas', pct: 50 + (answers - 2) * 10 };
  return { label: 'Casi listo', pct: Math.min(92, 75 + (answers - 4) * 5) };
}

export interface AnswerItem { index: number; question: string; answer: string; note?: string }

export function answerHistory(messages: Msg[]): AnswerItem[] {
  const out: AnswerItem[] = [];
  messages.forEach((m, i) => {
    if (m.role !== 'user' || m.failed) return;
    const q = [...messages.slice(0, i)].reverse().find((x) => x.role === 'assistant');
    out.push({ index: i, question: q?.content ?? '', answer: m.content, note: m.note });
  });
  return out;
}

export default function InterviewStep(props: {
  messages: Msg[];
  draft: string;
  setDraft: (v: string) => void;
  thinking: boolean;
  building: boolean;
  buildError: string | null;
  chatError: string | null;
  interviewDone: boolean;
  correcting: boolean;
  listening: boolean;
  speech: boolean;
  inputRef: RefObject<HTMLTextAreaElement>;
  hasProposal: boolean;
  onAnswer: (text: string) => void;
  onRetryFailed: () => void;
  onBuild: () => void;
  onCorrect: (index: number) => void;
  onToggleDictation: () => void;
  onRestart: () => void;
  onReturnToProposal: () => void;
}) {
  const { messages, draft, setDraft, thinking, building, interviewDone } = props;
  const history = answerHistory(messages);
  const answers = history.length;
  const failed = [...messages].reverse().find((m) => m.failed);
  const current = messages[messages.length - 1]?.role === 'assistant'
    ? messages[messages.length - 1]
    : [...messages].reverse().find((m) => m.role === 'assistant');
  const lastNote = history[history.length - 1]?.note;
  const stage = interviewDone ? { label: 'Entrevista completa', pct: 100 } : interviewStage(answers);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <StepTitle kicker="Paso 1 · Configuración inteligente" title="Cuéntanos de tu negocio">
          Te hacemos preguntas cortas y armamos una propuesta a tu medida. Puedes escribir o hablar, y corregir cualquier respuesta.
        </StepTitle>

        <Panel>
          {/* Avance aproximado */}
          <div className="border-b-2 border-line px-5 py-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-semibold uppercase tracking-[0.1em] text-ink-2">{stage.label}</span>
              {answers > 0 && <span className="text-ink-3">{answers} {answers === 1 ? 'respuesta' : 'respuestas'}</span>}
            </div>
            <div className="mt-2 h-1 w-full bg-bone-2" role="progressbar" aria-label="Avance aproximado de la entrevista" aria-valuenow={stage.pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-ink transition-[width] duration-500" style={{ width: `${stage.pct}%` }} />
            </div>
          </div>

          <div className="p-5 sm:p-6" aria-live="polite">
            {building ? (
              <SetupProgress title="Armando tu propuesta" steps={BUILD_STEPS} running={building} expectedMs={22000} hint="Esto toma entre 10 y 40 segundos. No cierres la página." />
            ) : props.buildError ? (
              <Notice tone="bad" action={<Button size="sm" onClick={props.onBuild}><RotateCcw size={13} /> Intentar otra vez</Button>}>
                {props.buildError} Tus respuestas siguen guardadas.
              </Notice>
            ) : interviewDone && !props.hasProposal ? (
              <Notice action={<Button size="sm" onClick={props.onBuild}>Armar mi propuesta <ArrowRight size={13} /></Button>}>
                Ya tenemos tus respuestas. Falta armar la propuesta.
              </Notice>
            ) : interviewDone && props.hasProposal ? (
              <Notice tone="ok" action={<Button size="sm" onClick={props.onReturnToProposal}>Ver mi propuesta <ArrowRight size={13} /></Button>}>
                Ya tenemos lo necesario. Puedes revisar tu propuesta o corregir una respuesta abajo.
              </Notice>
            ) : (
              <>
                {props.correcting && (
                  <div className="mb-4">
                    <Notice tone="warn">Estás corrigiendo una respuesta. Las preguntas siguientes se vuelven a hacer y la propuesta se arma de nuevo.</Notice>
                  </div>
                )}
                {lastNote && !thinking && !props.correcting && (
                  <p className="mb-3 flex items-start gap-2 text-sm text-ok">
                    <span className="mt-0.5 font-semibold">Anotado:</span> <span className="text-ink-2">{lastNote}</span>
                  </p>
                )}
                <p className="kicker flex items-center gap-1.5"><Sparkles size={12} aria-hidden /> BackOffice pregunta</p>
                {thinking ? (
                  <div className="mt-2 space-y-2" aria-label="Preparando la siguiente pregunta">
                    <div className="h-6 w-3/4 animate-pulse bg-bone-2" />
                    <div className="h-6 w-1/2 animate-pulse bg-bone-2" />
                    <p className="text-xs text-ink-3">Preparando la siguiente pregunta…</p>
                  </div>
                ) : (
                  <h2 className="mt-2 whitespace-pre-wrap text-xl font-semibold leading-snug sm:text-2xl">{current?.content}</h2>
                )}

                {failed && !thinking && (
                  <div className="mt-4">
                    <Notice tone="bad" action={<Button size="sm" onClick={props.onRetryFailed}><RotateCcw size={13} /> Reintentar</Button>}>
                      {props.chatError ?? 'No pudimos enviar tu respuesta.'} No se perdió: «{failed.content.slice(0, 80)}{failed.content.length > 80 ? '…' : ''}»
                    </Notice>
                  </div>
                )}

                {/* Respuestas sugeridas */}
                {!thinking && !failed && (answers === 0 && !props.correcting ? (
                  <div className="mt-5">
                    <p className="mb-2 text-xs text-ink-3">Ejemplos para empezar (luego lo ajustas a tu caso):</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {STARTERS.map(({ icon: Icon, text }) => (
                        <button
                          key={text}
                          type="button"
                          onClick={() => { setDraft(text); props.inputRef.current?.focus(); }}
                          className="flex cursor-pointer items-center gap-2.5 border-2 border-line bg-bone px-3 py-2.5 text-left text-sm transition-colors hover:border-ink focus-visible:border-ink"
                        >
                          <Icon size={16} className="shrink-0 text-ink-2" aria-hidden /> {text}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : !!current?.options?.length && (
                  <div className="mt-5">
                    <p className="mb-2 text-xs text-ink-3">Elige una opción o escribe tu propia respuesta:</p>
                    <div className="flex flex-wrap gap-2">
                      {current.options.map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => props.onAnswer(o)}
                          className="cursor-pointer border-2 border-ink bg-paper px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-ink hover:text-bone focus-visible:bg-ink focus-visible:text-bone"
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}

                {/* Respuesta libre */}
                <form
                  className="mt-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    props.onAnswer(draft);
                  }}
                >
                  <label htmlFor="interview-answer" className="sr-only">Tu respuesta</label>
                  <Textarea
                    id="interview-answer"
                    ref={props.inputRef}
                    rows={3}
                    value={draft}
                    maxLength={1200}
                    disabled={thinking}
                    className="!text-base"
                    placeholder={props.listening ? 'Te escucho… habla con calma' : answers === 0 ? 'Escríbelo como se lo contarías a una persona' : 'Escribe tu respuesta'}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        props.onAnswer(draft);
                      }
                    }}
                  />
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-ink-3">Enter para enviar · Shift + Enter para otra línea</p>
                    <div className="flex gap-2">
                      {props.speech && (
                        <Button
                          type="button"
                          variant={props.listening ? 'danger' : 'outline'}
                          onClick={props.onToggleDictation}
                          aria-label={props.listening ? 'Dejar de escuchar' : 'Responder hablando'}
                        >
                          {props.listening ? <MicOff size={15} /> : <Mic size={15} />} {props.listening ? 'Detener' : 'Hablar'}
                        </Button>
                      )}
                      <Button type="submit" disabled={!draft.trim() || thinking}>
                        Continuar <ArrowRight size={15} />
                      </Button>
                    </div>
                  </div>
                </form>
              </>
            )}
          </div>
        </Panel>

        {/* Historial con corrección */}
        {history.length > 0 && (
          <section className="mt-6" aria-labelledby="answers-title">
            <h2 id="answers-title" className="kicker mb-2">Tus respuestas</h2>
            <ol className="divide-y divide-line border-2 border-line bg-paper">
              {history.map((h, n) => (
                <li key={h.index} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-xs text-ink-3">{n + 1}. {h.question}</p>
                    <p className="mt-0.5 text-sm font-semibold">{h.answer}</p>
                  </div>
                  <button
                    type="button"
                    disabled={thinking || building}
                    onClick={() => props.onCorrect(h.index)}
                    className="flex shrink-0 cursor-pointer items-center gap-1 text-xs font-semibold text-ink-2 underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Corregir la respuesta ${n + 1}`}
                  >
                    <Pencil size={12} aria-hidden /> Corregir
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <aside className="space-y-5 text-sm lg:pt-[92px]">
        <div className="border-2 border-line bg-paper p-4">
          <p className="kicker mb-2">Por qué te preguntamos esto</p>
          <ul className="space-y-2 text-ink-2">
            <li>Para activar solo las herramientas que tu negocio usa, sin configuraciones de más.</li>
            <li>Para que tu asistente atienda como lo harías tú.</li>
            <li>Para decirte con claridad qué está disponible hoy y qué todavía no.</li>
          </ul>
        </div>
        <div className="space-y-2 text-xs text-ink-3">
          <p>Tu avance se guarda en este navegador: si cierras la página, sigues donde ibas.</p>
          <p>No te pedimos tarjeta para crear tu empresa.</p>
        </div>
        {answers >= 3 && !interviewDone && !building && (
          <Button variant="outline" className="w-full" disabled={thinking} onClick={props.onBuild}>
            <Sparkles size={14} /> Ya conté suficiente, ver propuesta
          </Button>
        )}
        {messages.length > 1 && (
          <button type="button" onClick={props.onRestart} className={clsx('cursor-pointer text-xs text-ink-3 underline hover:text-ink')}>
            Empezar de nuevo
          </button>
        )}
      </aside>
    </div>
  );
}
