import { clsx } from 'clsx';
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, ChevronDown, Eye, EyeOff, HardHat, Mic, MicOff, Plus, RotateCcw,
  Send, Shirt, Sparkles, Stethoscope, Trash2, Utensils, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError, postWithRetry } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney } from '../../lib/format';
import type { AuthUser, BusinessBlueprint, InterviewTurn, SetupProposal } from '../../lib/types';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';
import {
  ACCOUNT_FIELDS, type AccountForm, type FieldErrors, type Msg, type Preview, clearDraft, emailSuggestion, formatPhone,
  loadDraft, passwordStrength, saveDraft, sessionToken, speechSupported, startDictation, track, validateAll, validateField,
} from './signup-helpers';

/**
 * Registro en 3 pasos, pensado para que cualquiera lo use sin ayuda:
 *  1. Cuéntanos: una conversación corta (se puede hablar por voz).
 *  2. Revisa: lo que armamos, en tarjetas; cambiar es opcional.
 *  3. Tus datos: con avisos claros campo por campo.
 * Nunca se pierde lo escrito: el avance queda guardado en el navegador, los
 * errores dicen qué hacer, y si la IA no responde siguen preguntas fijas.
 */

const RUBRO_LABELS: Record<string, string> = {
  COMIDAS: 'Comidas y domicilios',
  SERVICIOS: 'Servicios, citas y cursos',
  VENTAS: 'Tiendas, ventas y comercio',
  WEBCAM: 'Webcam y creadores',
};

const TOOLS: Record<string, { title: string; desc: string }> = {
  orders: { title: 'Pedidos y catálogo', desc: 'Tus productos o servicios con precio, pedidos y ventas.' },
  agenda: { title: 'Agenda', desc: 'Citas, cupos o visitas con recordatorios automáticos.' },
  campaigns: { title: 'Mensajes a tus clientes', desc: 'Envíos por WhatsApp y recordatorio a quien no responde.' },
  production: { title: 'Cocina o taller', desc: 'Cada área ve lo que tiene que preparar, con comandas.' },
  delivery: { title: 'Domicilios en vivo', desc: 'Tus domiciliarios con GPS y link de seguimiento.' },
  menu: { title: 'Menú con QR', desc: 'Tu menú o catálogo para pedir por WhatsApp.' },
  media: { title: 'Galería con precios', desc: 'Fotos o contenido que el asistente vende por el chat.' },
  gerencia: { title: 'Resumen para el dueño', desc: 'Cómo va el negocio, en un vistazo.' },
  analytics: { title: 'Números', desc: 'Conversaciones, ventas y tiempos de respuesta.' },
  automations: { title: 'Conexiones', desc: 'Conectar con tus otros programas.' },
  marketing: { title: 'Contenido para redes', desc: 'Ideas y piezas para tus redes sociales.' },
};

const STARTERS = [
  { icon: Utensils, text: 'Tengo un restaurante de almuerzos con domicilios' },
  { icon: Shirt, text: 'Vendo ropa por Instagram y WhatsApp' },
  { icon: HardHat, text: 'Doy cursos de trabajo seguro en alturas' },
  { icon: Stethoscope, text: 'Tengo un consultorio y agendo citas' },
];

const OPENING = '¡Hola! Te voy a hacer unas preguntas cortas para armar tu cuenta. Para empezar: ¿qué hace tu negocio?';
const EXPECTED_ANSWERS = 6;

const BUILD_STEPS = ['Entendiendo tu negocio', 'Eligiendo tus herramientas', 'Armando tu catálogo', 'Creando tu asistente', 'Últimos detalles'];

const EMPTY_FORM: AccountForm = { companyName: '', city: '', name: '', email: '', phone: '', password: '', accept: false };

function messageOf(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

/* ── Piezas ─────────────────────────────────────────────────────── */

function Steps({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['Cuéntanos', 'Revisa', 'Tus datos'];
  return (
    <ol className="mb-6 flex gap-2 sm:grid sm:grid-cols-3" aria-label="Pasos">
      {labels.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        return (
          <li
            key={label}
            aria-current={step === n ? 'step' : undefined}
            className={clsx(
              'flex items-center gap-2 border-2 px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] sm:text-sm',
              step === n ? 'min-w-0 flex-1' : 'shrink-0',
              step === n ? 'border-ink bg-ink text-bone' : step > n ? 'border-ink bg-paper' : 'border-line text-ink-3',
            )}
          >
            <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center border-2', step === n ? 'border-bone' : step > n ? 'border-ink bg-ok text-white' : 'border-line')}>
              {step > n ? <Check size={13} /> : n}
            </span>
            <span className={clsx('truncate', step !== n && 'hidden sm:inline')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Notice({ tone = 'info', children, action }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode; action?: ReactNode }) {
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      className={clsx(
        'flex flex-wrap items-center justify-between gap-3 border-2 px-4 py-3 text-sm',
        tone === 'bad' ? 'border-bad bg-bad-soft text-bad' : tone === 'warn' ? 'border-warn bg-warn-soft text-ink' : 'border-ink bg-paper',
      )}
    >
      <span className="flex items-start gap-2">
        {tone !== 'info' && <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}

function Card({ title, summary, open, onToggle, children }: { title: string; summary: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={clsx('border-2 border-ink bg-paper', open && 'shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]')}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full cursor-pointer items-start justify-between gap-3 p-4 text-left">
        <span className="min-w-0">
          <span className="kicker block">{title}</span>
          <span className="mt-1 block text-[15px]">{summary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 text-xs font-semibold uppercase tracking-[0.08em]">
          {open ? 'Listo' : 'Cambiar'} <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && <div className="border-t-2 border-line p-4">{children}</div>}
    </section>
  );
}

function Chips({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => (
        <span key={it} className="inline-flex items-center gap-1 border-2 border-ink bg-bone px-2 py-1 text-xs font-semibold">
          {it}
          <button type="button" aria-label={`Quitar ${it}`} className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => onChange(items.filter((x) => x !== it))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="min-w-[140px] flex-1 border-b-2 border-line bg-transparent px-1 py-1 text-sm outline-none focus:border-ink"
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

/* ── Página ─────────────────────────────────────────────────────── */

export default function Signup() {
  const { user, loading, adopt } = useAuth();
  const navigate = useNavigate();
  const saved = useMemo(() => loadDraft(), []);
  const [resumeOffer, setResumeOffer] = useState(!!saved && (saved.step > 1 || saved.messages.length > 1));
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: OPENING }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [waking, setWaking] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [interviewDone, setInterviewDone] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildStep, setBuildStep] = useState(0);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [form, setForm] = useState<AccountForm>(EMPTY_FORM);
  const [touched, setTouched] = useState<Partial<Record<keyof AccountForm, boolean>>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [listening, setListening] = useState(false);
  const stopDictation = useRef<(() => void) | null>(null);
  const dictationBase = useRef('');
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fieldRefs = useRef<Partial<Record<keyof AccountForm, HTMLElement | null>>>({});

  useEffect(() => {
    document.title = 'Crea tu empresa · BackOffice';
    track('view', { step: 'STARTED' });
    return () => stopDictation.current?.();
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, thinking, building]);
  // Se guarda el avance (nunca la contraseña)
  useEffect(() => {
    if (resumeOffer) return;
    if (messages.length < 2 && step === 1) return;
    const { password: _p, ...safeForm } = form;
    saveDraft({ step, messages, interviewDone, preview, form: safeForm });
  }, [step, messages, interviewDone, preview, form, resumeOffer]);
  useEffect(() => {
    if (step > 1) track('view', { step: step === 2 ? 'PREVIEW' : 'ACCOUNT' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);
  // Mientras arma el plano, la lista de pasos avanza para que se note que trabaja
  useEffect(() => {
    if (!building) return;
    setBuildStep(0);
    const t = setInterval(() => setBuildStep((s) => Math.min(s + 1, BUILD_STEPS.length - 1)), 2600);
    return () => clearInterval(t);
  }, [building]);

  if (!loading && user) return <Navigate to="/" replace />;

  const answers = messages.filter((m) => m.role === 'user' && !m.failed).length;
  const transcript = (list = messages) => list.filter((m) => !m.failed).map(({ role, content }) => ({ role, content }));
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  function resume() {
    if (!saved) return;
    setMessages(saved.messages.filter((m) => !m.failed));
    setInterviewDone(saved.interviewDone);
    setPreview(saved.preview);
    setForm({ ...EMPTY_FORM, ...saved.form, password: '' });
    setStep(saved.preview ? saved.step : 1);
    setResumeOffer(false);
  }

  function restart() {
    clearDraft();
    setMessages([{ role: 'assistant', content: OPENING }]);
    setPreview(null);
    setInterviewDone(false);
    setForm(EMPTY_FORM);
    setStep(1);
    setResumeOffer(false);
    track('view', { step: 'STARTED' });
  }

  function toggleDictation() {
    if (listening) {
      stopDictation.current?.();
      return;
    }
    dictationBase.current = draft ? `${draft.trim()} ` : '';
    const stop = startDictation(
      (text) => setDraft(`${dictationBase.current}${text}`.slice(0, 1200)),
      () => {
        setListening(false);
        stopDictation.current = null;
      },
    );
    if (!stop) {
      toast.error('No pudimos usar el micrófono. Revisa que el navegador tenga permiso.');
      return;
    }
    stopDictation.current = stop;
    setListening(true);
  }

  async function answer(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    stopDictation.current?.();
    const base = messages.filter((m) => !m.failed);
    const next: Msg[] = [...base, { role: 'user', content: t }];
    setMessages(next);
    setDraft('');
    setChatError(null);
    setThinking(true);
    try {
      const turn = await postWithRetry<InterviewTurn & { mode?: string }>(
        '/public/signup/interview',
        { session: sessionToken(), messages: transcript(next) },
        { onRetry: () => setWaking(true) },
      );
      const withNote = next.map((m, i) => (i === next.length - 1 && turn.understood ? { ...m, note: turn.understood } : m));
      if (turn.done) {
        setMessages([...withNote, { role: 'assistant', content: '¡Listo! Ya entendí cómo funciona tu negocio. Ahora armo tu cuenta.' }]);
        setInterviewDone(true);
        void build(transcript(withNote));
      } else {
        setMessages([...withNote, { role: 'assistant', content: turn.question, options: turn.options }]);
      }
    } catch (e) {
      // El mensaje no se pierde: queda marcado para reintentar con un toque
      setMessages(next.map((m, i) => (i === next.length - 1 ? { ...m, failed: true } : m)));
      const msg = messageOf(e, 'No pudimos enviar tu respuesta.');
      setChatError(msg);
      track('error', { step: 'INTERVIEW', message: msg });
    } finally {
      setThinking(false);
      setWaking(false);
      setTimeout(() => input.current?.focus(), 50);
    }
  }

  function retryFailed() {
    const failed = [...messages].reverse().find((m) => m.failed);
    if (!failed) return;
    setMessages(messages.filter((m) => m !== failed));
    void answer(failed.content);
  }

  async function build(history = transcript()) {
    setBuilding(true);
    setBuildError(null);
    try {
      const r = await postWithRetry<Preview>('/public/signup/preview', { session: sessionToken(), messages: history }, { onRetry: () => setWaking(true) });
      setPreview(r);
      setForm((f) => ({ ...f, companyName: f.companyName || r.company.name, city: f.city || r.company.city }));
      setStep(2);
    } catch (e) {
      const msg = messageOf(e, 'No pudimos armar tu cuenta.');
      setBuildError(msg);
      track('error', { step: 'PREVIEW', message: msg });
      // Si faltó contar más, se vuelve a la conversación para seguir
      if (e instanceof ApiError && e.code === 'TOO_SHORT') {
        setInterviewDone(false);
        setMessages((list) => [...list, { role: 'assistant', content: 'Cuéntame un poquito más: ¿qué vendes y a quién?' }]);
        setBuildError(null);
      }
    } finally {
      setBuilding(false);
      setWaking(false);
    }
  }

  function goToAccount() {
    if (!form.companyName.trim()) {
      setNameError('Escribe el nombre de tu negocio para seguir');
      document.getElementById('company-name')?.focus();
      return;
    }
    setNameError(null);
    setStep(3);
  }

  /* ── Paso 3: validación amable ── */

  function setField<K extends keyof AccountForm>(field: K, value: AccountForm[K]) {
    const next = { ...form, [field]: value };
    setForm(next);
    if (serverError) setServerError(null);
    if (touched[field] || errors[field]) setErrors((e) => ({ ...e, [field]: validateField(field, next) }));
  }

  function blur(field: keyof AccountForm) {
    setTouched((t) => ({ ...t, [field]: true }));
    const err = validateField(field, form);
    setErrors((e) => ({ ...e, [field]: err }));
    // Contacto bien escrito → el equipo puede ayudarle si se queda a mitad
    if (!err && ['name', 'email', 'phone', 'companyName'].includes(field)) {
      track('contact', { data: { name: form.name, email: form.email, phone: form.phone, companyName: form.companyName } });
    }
  }

  function focusFirstError(errs: FieldErrors) {
    const first = ACCOUNT_FIELDS.find((f) => errs[f]);
    if (first) {
      const el = fieldRefs.current[first];
      el?.focus();
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!preview || busy) return;
    const errs = validateAll(form);
    setErrors(errs);
    setTouched(Object.fromEntries(ACCOUNT_FIELDS.map((f) => [f, true])));
    if (Object.values(errs).some(Boolean)) {
      focusFirstError(errs);
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const res = await postWithRetry<{ token: string; user: AuthUser }>(
        '/public/signup',
        {
          session: sessionToken(),
          messages: transcript(),
          rubro: preview.rubro,
          proposal: preview.proposal,
          blueprint: preview.blueprint,
          company: { name: form.companyName, city: form.city },
          admin: { name: form.name, email: form.email.trim(), phone: form.phone, password: form.password },
          acceptTerms: form.accept,
        },
        { tries: 2, onRetry: () => setWaking(true) },
      );
      clearDraft();
      adopt(res.token, res.user);
      toast.success('¡Tu empresa quedó creada!');
      navigate('/app/bienvenida', { replace: true });
    } catch (err) {
      const msg = messageOf(err, 'No pudimos crear tu cuenta. Intenta de nuevo.');
      track('error', { step: 'ACCOUNT', message: msg });
      if (err instanceof ApiError && err.field && (ACCOUNT_FIELDS as string[]).includes(err.field)) {
        const field = err.field as keyof AccountForm;
        const errs2 = { ...errors, [field]: msg };
        setErrors(errs2);
        focusFirstError(errs2);
        if (err.code === 'EMAIL_TAKEN') setServerError({ message: msg, code: err.code });
      } else {
        setServerError({ message: msg });
      }
    } finally {
      setBusy(false);
      setWaking(false);
    }
  }

  const p = preview?.proposal;
  const bp = preview?.blueprint;
  const setP = (next: Partial<SetupProposal>) => preview && setPreview({ ...preview, proposal: { ...preview.proposal, ...next } });
  const setBp = (next: Partial<BusinessBlueprint>) => preview && setPreview({ ...preview, blueprint: { ...preview.blueprint, ...next } });
  const toggle = (key: string) => setOpen((o) => (o === key ? null : key));
  const strength = passwordStrength(form.password);
  const suggestion = emailSuggestion(form.email);
  const invalid = (f: keyof AccountForm) => (errors[f] ? true : undefined);

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 md:px-6">
        <Link to="/" className="display text-2xl leading-none">
          BackOffice<span className="text-ok">.</span>
        </Link>
        <Link to="/login" className="text-xs font-semibold uppercase tracking-[0.08em] hover:underline">
          Ya tengo cuenta
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 md:px-6">
        <Steps step={step} />

        {resumeOffer && saved && (
          <div className="mb-5">
            <Notice
              action={
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={restart}><RotateCcw size={13} /> Empezar de nuevo</Button>
                  <Button size="sm" onClick={resume}>Seguir donde iba <ArrowRight size={13} /></Button>
                </span>
              }
            >
              <b>Tienes un registro a medias{saved.form.companyName ? ` de ${saved.form.companyName}` : ''}.</b> ¿Quieres seguir donde ibas?
            </Notice>
          </div>
        )}

        {waking && (
          <div className="mb-5">
            <Notice tone="warn">Estamos encendiendo el sistema. Esto pasa a veces y tarda unos segundos; no cierres la página.</Notice>
          </div>
        )}

        {/* ── 1. Cuéntanos ── */}
        {step === 1 && !resumeOffer && (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
            <section className="flex h-[min(700px,calc(100dvh-190px))] min-h-[460px] flex-col border-2 border-ink bg-paper shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]">
              <header className="border-b-2 border-ink px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} /> Tu asesora de BackOffice</p>
                  <span className="text-xs text-ink-3">{answers === 0 ? 'Unas 6 preguntas cortas' : `Pregunta ${Math.min(answers + 1, EXPECTED_ANSWERS)} de ~${EXPECTED_ANSWERS}`}</span>
                </div>
                <div className="mt-2 h-1.5 w-full bg-bone-2" aria-hidden>
                  <div className="h-full bg-ink transition-all duration-500" style={{ width: `${Math.min(100, (answers / EXPECTED_ANSWERS) * 100)}%` }} />
                </div>
              </header>

              <div ref={scroll} className="flex-1 space-y-4 overflow-y-auto bg-bone p-4 sm:p-5" aria-live="polite">
                {messages.map((m, i) => (
                  <div key={i} className={clsx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
                    <p
                      className={clsx(
                        'max-w-[88%] whitespace-pre-wrap border-2 px-4 py-3 text-base leading-snug',
                        m.role === 'user' ? (m.failed ? 'border-bad bg-bad-soft text-ink' : 'border-ink bg-ink text-bone') : 'border-ink bg-paper',
                      )}
                    >
                      {m.content}
                    </p>
                    {m.failed && (
                      <button type="button" onClick={retryFailed} disabled={thinking} className="mt-1 flex cursor-pointer items-center gap-1 text-xs font-semibold text-bad hover:underline">
                        <RotateCcw size={12} /> No se envió. Toca para reintentar
                      </button>
                    )}
                    {m.note && !m.failed && <p className="mt-1 max-w-[88%] text-right text-xs italic text-ink-3">Entendí: {m.note}</p>}
                  </div>
                ))}
                {thinking && (
                  <p className="flex items-center gap-2 text-sm text-ink-3">
                    <span className="inline-flex gap-1" aria-hidden>
                      <span className="h-2 w-2 animate-bounce bg-ink-3 [animation-delay:-0.2s]" />
                      <span className="h-2 w-2 animate-bounce bg-ink-3 [animation-delay:-0.1s]" />
                      <span className="h-2 w-2 animate-bounce bg-ink-3" />
                    </span>
                    Pensando…
                  </p>
                )}
                {building && (
                  <ol className="space-y-2 border-2 border-ink bg-paper p-4 text-sm" aria-label="Armando tu cuenta">
                    {BUILD_STEPS.map((label, i) => (
                      <li key={label} className={clsx('flex items-center gap-2', i > buildStep && 'text-ink-3')}>
                        <span className={clsx('flex h-5 w-5 items-center justify-center border-2', i < buildStep ? 'border-ok bg-ok text-white' : i === buildStep ? 'animate-pulse border-ink' : 'border-line')}>
                          {i < buildStep && <Check size={11} />}
                        </span>
                        {label}
                      </li>
                    ))}
                    <li className="pt-1 text-xs text-ink-3">Esto toma entre 10 y 40 segundos.</li>
                  </ol>
                )}
                {buildError && !building && (
                  <Notice tone="bad" action={<Button size="sm" onClick={() => build()}><RotateCcw size={13} /> Intentar otra vez</Button>}>
                    {buildError}
                  </Notice>
                )}
              </div>

              {!interviewDone && (
                <div className="border-t-2 border-ink p-3">
                  {chatError && <p role="alert" className="mb-2 text-sm font-semibold text-bad">{chatError}</p>}
                  {answers === 0 ? (
                    <div className="mb-3 grid gap-2 sm:grid-cols-2">
                      {STARTERS.map(({ icon: Icon, text }) => (
                        <button
                          key={text}
                          type="button"
                          onClick={() => {
                            setDraft(text);
                            input.current?.focus();
                          }}
                          className="flex cursor-pointer items-center gap-2 border-2 border-line bg-bone px-3 py-2.5 text-left text-sm hover:border-ink"
                        >
                          <Icon size={16} className="shrink-0" /> {text}
                        </button>
                      ))}
                    </div>
                  ) : (
                    !!lastAssistant?.options?.length && (
                      <div className="mb-3 flex flex-wrap gap-2">
                        {lastAssistant.options.map((o) => (
                          <button
                            key={o}
                            type="button"
                            disabled={thinking}
                            onClick={() => answer(o)}
                            className="cursor-pointer border-2 border-ink bg-paper px-3 py-2 text-sm font-semibold hover:bg-ink hover:text-bone disabled:opacity-40"
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    )
                  )}
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      answer(draft);
                    }}
                  >
                    <Textarea
                      ref={input}
                      rows={2}
                      value={draft}
                      maxLength={1200}
                      disabled={thinking}
                      aria-label="Tu respuesta"
                      className="!text-base"
                      placeholder={listening ? 'Te escucho… habla con calma' : answers === 0 ? 'Escríbelo como se lo contarías a una persona' : 'Escribe tu respuesta o toca una opción'}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          answer(draft);
                        }
                      }}
                    />
                    <div className="flex flex-col gap-2">
                      {speechSupported() && (
                        <Button
                          type="button"
                          variant={listening ? 'danger' : 'outline'}
                          onClick={toggleDictation}
                          aria-label={listening ? 'Dejar de escuchar' : 'Hablar en vez de escribir'}
                          title={listening ? 'Dejar de escuchar' : 'Hablar en vez de escribir'}
                        >
                          {listening ? <MicOff size={16} /> : <Mic size={16} />}
                        </Button>
                      )}
                      <Button type="submit" disabled={!draft.trim() || thinking} aria-label="Enviar"><Send size={16} /></Button>
                    </div>
                  </form>
                </div>
              )}
            </section>

            <aside className="space-y-4">
              <h1 className="display text-5xl leading-none">
                Crea tu empresa <span className="serif-accent normal-case">en 3 pasos.</span>
              </h1>
              <ol className="space-y-2 text-sm text-ink-2">
                <li><b>1.</b> Respondes unas preguntas cortas, escribiendo o hablando.</li>
                <li><b>2.</b> Revisas lo que armamos. Cambiar es opcional.</li>
                <li><b>3.</b> Pones tus datos y listo.</li>
              </ol>
              <p className="text-xs text-ink-3">Tu avance se guarda solo: si cierras la página, sigues donde ibas.</p>
              {answers >= 3 && !interviewDone && (
                <Button variant="outline" className="w-full" disabled={thinking || building} onClick={() => { setInterviewDone(true); void build(); }}>
                  <Sparkles size={14} /> Ya te conté suficiente, armarlo
                </Button>
              )}
              {messages.length > 1 && (
                <button type="button" onClick={restart} className="cursor-pointer text-xs text-ink-3 underline hover:text-ink">
                  Empezar de nuevo
                </button>
              )}
            </aside>
          </div>
        )}

        {/* ── 2. Revisa ── */}
        {step === 2 && preview && p && bp && (
          <div className="mx-auto max-w-3xl space-y-4">
            {preview.mode === 'guided' && (
              <Notice tone="warn">
                Nuestra IA está muy ocupada en este momento, así que te armamos una base sencilla. No te preocupes: te escribimos por WhatsApp y la dejamos perfecta contigo.
              </Notice>
            )}

            <section className="border-2 border-ink bg-paper p-5 shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]">
              <p className="kicker">Así quedaría tu cuenta</p>
              <label className="mt-3 block">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Nombre de tu negocio</span>
                <input
                  id="company-name"
                  className={clsx('display mt-1 w-full border-b-2 bg-transparent pb-1 text-4xl outline-none md:text-5xl', nameError ? 'border-bad' : 'border-line focus:border-ink')}
                  value={form.companyName}
                  placeholder="Escribe el nombre"
                  aria-invalid={nameError ? true : undefined}
                  onChange={(e) => {
                    setForm({ ...form, companyName: e.target.value });
                    if (e.target.value.trim()) setNameError(null);
                  }}
                />
              </label>
              {nameError && <p role="alert" className="mt-1 text-sm font-semibold text-bad">{nameError}</p>}
              {bp.businessType && <p className="serif-accent mt-2 text-xl text-ink-2">{bp.businessType}</p>}
              {bp.needs.length > 0 && (
                <ul className="mt-4 space-y-2">
                  {bp.needs.slice(0, 4).map((n, i) => (
                    <li key={i} className="flex gap-2 text-sm">
                      <Check size={16} className="mt-0.5 shrink-0 text-ok" />
                      <span><b>{n.title}.</b> {n.solution}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="pt-2 text-sm text-ink-2">Toca cualquier tarjeta si quieres cambiar algo. Si todo se ve bien, sigue al final.</p>

            <Card
              title="Tu asistente de WhatsApp"
              open={open === 'assistant'}
              onToggle={() => toggle('assistant')}
              summary={p.assistant ? <>Se llama <b>{p.assistant.name}</b> y saluda así: “{p.assistant.welcome}”</> : 'Te creamos uno después'}
            >
              {p.assistant && (
                <div className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Nombre"><Input value={p.assistant.name} onChange={(e) => setP({ assistant: { ...p.assistant!, name: e.target.value } })} /></Field>
                    <Field label="Cómo habla"><Input value={p.assistant.tone} onChange={(e) => setP({ assistant: { ...p.assistant!, tone: e.target.value } })} /></Field>
                  </div>
                  <Field label="Saludo"><Textarea rows={2} value={p.assistant.welcome} onChange={(e) => setP({ assistant: { ...p.assistant!, welcome: e.target.value } })} /></Field>
                  <Field label="Datos que le pide al cliente" hint="Escribe uno y presiona Enter">
                    <Chips items={bp.clientData} onChange={(clientData) => setBp({ clientData })} placeholder="+ agregar dato" />
                  </Field>
                  <Field label="Cómo atiende, paso a paso" hint="Un paso por línea">
                    <Textarea rows={5} value={bp.assistantFlow.join('\n')} onChange={(e) => setBp({ assistantFlow: e.target.value.split('\n').slice(0, 10) })} />
                  </Field>
                </div>
              )}
            </Card>

            <Card
              title="Tus herramientas"
              open={open === 'tools'}
              onToggle={() => toggle('tools')}
              summary={bp.modules.length ? bp.modules.map((m) => TOOLS[m]?.title).filter(Boolean).join(' · ') : 'Solo lo básico: conversaciones, contactos y asistente'}
            >
              <p className="mb-3 text-xs text-ink-3">Conversaciones, contactos, asistente, equipo y facturación siempre van incluidos.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(TOOLS).map(([key, t]) => {
                  const on = bp.modules.includes(key);
                  const needsOrders = ['production', 'delivery', 'menu'].includes(key) && !bp.modules.includes('orders');
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setBp({ modules: on ? bp.modules.filter((m) => m !== key) : [...bp.modules, key, ...(needsOrders ? ['orders'] : [])] })}
                      className={clsx('flex cursor-pointer items-start gap-3 border-2 p-3 text-left transition-colors', on ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink')}
                    >
                      <span className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2', on ? 'border-bone bg-bone text-ink' : 'border-ink')}>
                        {on && <Check size={12} />}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold">{t.title}</span>
                        <span className={clsx('block text-xs', on ? 'text-line' : 'text-ink-3')}>{t.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Card>

            <Card
              title={preview.rubro === 'SERVICIOS' ? 'Tus servicios' : preview.rubro === 'COMIDAS' ? 'Tu menú' : 'Tu catálogo'}
              open={open === 'catalog'}
              onToggle={() => toggle('catalog')}
              summary={p.products.length ? `${p.products.length} ${p.products.length === 1 ? 'producto' : 'productos'}: ${p.products.slice(0, 3).map((x) => x.name).filter(Boolean).join(', ')}${p.products.length > 3 ? '…' : ''}` : 'Vacío por ahora: lo llenas después en tu panel'}
            >
              <ul className="space-y-2">
                {p.products.map((prod, i) => (
                  <li key={i} className="grid grid-cols-[minmax(0,1fr)_120px_auto] items-center gap-2">
                    <Input value={prod.name} placeholder="Nombre" aria-label="Nombre del producto" onChange={(e) => setP({ products: p.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                    <Input
                      inputMode="numeric"
                      value={prod.price ?? ''}
                      placeholder="Precio"
                      aria-label="Precio"
                      onChange={(e) => {
                        const n = e.target.value.replace(/\D/g, '');
                        setP({ products: p.products.map((x, j) => (j === i ? { ...x, price: n ? Number(n) : null } : x)) });
                      }}
                    />
                    <button type="button" aria-label="Quitar" className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setP({ products: p.products.filter((_, j) => j !== i) })}>
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setP({ products: [...p.products, { name: '', category: null, price: null, description: null, presentations: [] }] })}>
                <Plus size={13} /> Agregar
              </Button>
            </Card>

            <Card
              title="Cómo avanza cada cliente"
              open={open === 'pipeline'}
              onToggle={() => toggle('pipeline')}
              summary={bp.pipeline ? bp.pipeline.stages.map((s) => s.label).join(' → ') : 'Curioso → Interesado → Listo para comprar → Cliente'}
            >
              {bp.pipeline ? (
                <>
                  <ol className="space-y-2">
                    {bp.pipeline.stages.map((s, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-5 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                        <Input value={s.label} aria-label={`Etapa ${i + 1}`} onChange={(e) => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
                        <Select
                          value={s.kind}
                          className="!w-32"
                          aria-label="Tipo de etapa"
                          onChange={(e) => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'OPEN' } : x)) } })}
                        >
                          <option value="OPEN">En camino</option>
                          <option value="WON">Compró</option>
                          <option value="LOST">No compró</option>
                        </Select>
                        <button type="button" aria-label="Quitar etapa" className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.filter((_, j) => j !== i) } })}>
                          <Trash2 size={15} />
                        </button>
                      </li>
                    ))}
                  </ol>
                  {bp.pipeline.stages.length < 10 && (
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => setBp({ pipeline: { ...bp.pipeline!, stages: [...bp.pipeline!.stages, { key: '', label: 'Nueva etapa', kind: 'OPEN' }] } })}>
                      <Plus size={13} /> Etapa
                    </Button>
                  )}
                </>
              ) : (
                <p className="text-sm text-ink-3">Usarás estas etapas. Las puedes cambiar después en tu panel.</p>
              )}
            </Card>

            <Card
              title="Más detalles (opcional)"
              open={open === 'more'}
              onToggle={() => toggle('more')}
              summary={`${bp.quickReplies.length} respuestas rápidas · ${p.faqs.length} preguntas frecuentes · ${bp.followUps.length} recordatorios`}
            >
              <div className="space-y-5">
                <Field label="Tus precios de BackOffice son de" hint="Solo cambia los planes que te mostramos">
                  <Select value={preview.rubro} onChange={(e) => setPreview({ ...preview, rubro: e.target.value, rubroLabel: RUBRO_LABELS[e.target.value] })}>
                    {Object.entries(RUBRO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
                <div>
                  <p className="kicker mb-2">Respuestas rápidas para tu equipo</p>
                  {bp.quickReplies.length === 0 && <p className="text-sm text-ink-3">Las creas después.</p>}
                  <ul className="space-y-1.5 text-sm">
                    {bp.quickReplies.map((r, i) => (
                      <li key={r.shortcut} className="flex items-start justify-between gap-2">
                        <span><span className="font-mono text-xs text-ink-3">/{r.shortcut}</span> {r.title}</span>
                        <button type="button" aria-label="Quitar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ quickReplies: bp.quickReplies.filter((_, j) => j !== i) })}><X size={14} /></button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="kicker mb-2">Si el cliente deja de responder</p>
                  {bp.followUps.length === 0 && <p className="text-sm text-ink-3">Sin recordatorios por ahora.</p>}
                  <ul className="space-y-1.5 text-sm">
                    {bp.followUps.map((f, i) => (
                      <li key={i} className="flex items-start justify-between gap-2">
                        <span><span className="text-xs text-ink-3">A las {f.afterHours} h:</span> {f.message}</span>
                        <button type="button" aria-label="Quitar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ followUps: bp.followUps.filter((_, j) => j !== i) })}><X size={14} /></button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="kicker mb-2">Preguntas que ya sabe responder</p>
                  {p.faqs.length === 0 && <p className="text-sm text-ink-3">Las agregas después.</p>}
                  <ul className="space-y-1.5 text-sm">
                    {p.faqs.map((f, i) => (
                      <li key={i} className="flex items-start justify-between gap-2">
                        <span>{f.question}</span>
                        <button type="button" aria-label="Quitar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setP({ faqs: p.faqs.filter((_, j) => j !== i) })}><X size={14} /></button>
                      </li>
                    ))}
                  </ul>
                  {p.schedule && (
                    <p className="mt-3 text-xs text-ink-3">
                      Horario: {p.schedule.days.map((d) => ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][d]).join(', ')} · {p.schedule.open}–{p.schedule.close}
                    </p>
                  )}
                </div>
              </div>
            </Card>

            <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t-2 border-ink bg-bone/95 px-4 py-3 backdrop-blur md:mx-0 md:border-2 md:px-5">
              <Button variant="outline" onClick={() => { setStep(1); setInterviewDone(false); }}>
                <ArrowLeft size={14} /> Volver a la conversación
              </Button>
              <Button onClick={goToAccount} className="!px-6 !py-3 !text-sm">
                Todo bien, sigamos <ArrowRight size={15} />
              </Button>
            </div>
          </div>
        )}

        {/* ── 3. Tus datos ── */}
        {step === 3 && preview && (
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <form noValidate onSubmit={create} className="space-y-5 border-2 border-ink bg-paper p-5 shadow-[8px_8px_0_0_rgba(26,26,26,0.9)] sm:p-6">
              <div>
                <h1 className="display text-4xl">Tus datos</h1>
                <p className="mt-1 text-sm text-ink-2">Último paso. Con esto entras a tu panel.</p>
              </div>

              {serverError && (
                <Notice
                  tone="bad"
                  action={serverError.code === 'EMAIL_TAKEN' ? <Link to="/login" className="text-sm font-semibold underline">Entrar con ese correo</Link> : undefined}
                >
                  {serverError.message}
                </Notice>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nombre de tu negocio" required error={errors.companyName}>
                  <Input
                    ref={(el) => { fieldRefs.current.companyName = el; }}
                    value={form.companyName}
                    maxLength={80}
                    aria-invalid={invalid('companyName')}
                    onChange={(e) => setField('companyName', e.target.value)}
                    onBlur={() => blur('companyName')}
                  />
                </Field>
                <Field label="Ciudad" hint="Opcional">
                  <Input value={form.city} maxLength={60} autoComplete="address-level2" onChange={(e) => setField('city', e.target.value)} />
                </Field>
                <Field label="Tu nombre" required error={errors.name}>
                  <Input
                    ref={(el) => { fieldRefs.current.name = el; }}
                    autoComplete="name"
                    value={form.name}
                    maxLength={80}
                    aria-invalid={invalid('name')}
                    onChange={(e) => setField('name', e.target.value)}
                    onBlur={() => blur('name')}
                  />
                </Field>
                <Field label="Tu WhatsApp" required error={errors.phone} hint="Por aquí te escribimos para dejar todo listo">
                  <Input
                    ref={(el) => { fieldRefs.current.phone = el; }}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="300 123 4567"
                    value={form.phone}
                    aria-invalid={invalid('phone')}
                    onChange={(e) => setField('phone', formatPhone(e.target.value))}
                    onBlur={() => blur('phone')}
                  />
                </Field>
                <Field
                  label="Tu correo"
                  required
                  error={errors.email}
                  hint={suggestion ? undefined : 'Con este correo entras a tu cuenta'}
                >
                  <Input
                    ref={(el) => { fieldRefs.current.email = el; }}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    placeholder="nombre@gmail.com"
                    value={form.email}
                    aria-invalid={invalid('email')}
                    onChange={(e) => setField('email', e.target.value.replace(/\s/g, ''))}
                    onBlur={() => blur('email')}
                  />
                </Field>
                <Field label="Crea una contraseña" required error={errors.password}>
                  <span className="relative block">
                    <Input
                      ref={(el) => { fieldRefs.current.password = el; }}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={form.password}
                      aria-invalid={invalid('password')}
                      className="!pr-11"
                      onChange={(e) => setField('password', e.target.value)}
                      onBlur={() => blur('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Ocultar contraseña' : 'Ver contraseña'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer p-1 text-ink-3 hover:text-ink"
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </span>
                  {form.password && !errors.password && (
                    <span className={clsx('mt-1 block text-xs font-semibold', strength.tone === 'ok' ? 'text-ok' : strength.tone === 'warn' ? 'text-warn' : 'text-bad')}>
                      {strength.label}
                    </span>
                  )}
                </Field>
              </div>

              {suggestion && (
                <button type="button" onClick={() => setField('email', suggestion)} className="cursor-pointer text-sm font-semibold underline">
                  ¿Quisiste decir {suggestion}? Toca para corregir
                </button>
              )}

              <div>
                <label className={clsx('flex cursor-pointer items-start gap-3 border-2 p-3 text-sm', errors.accept ? 'border-bad bg-bad-soft' : 'border-line')}>
                  <input
                    ref={(el) => { fieldRefs.current.accept = el; }}
                    type="checkbox"
                    className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[#1a1a1a]"
                    checked={form.accept}
                    aria-invalid={invalid('accept')}
                    onChange={(e) => {
                      setField('accept', e.target.checked);
                      if (e.target.checked) setErrors((x) => ({ ...x, accept: undefined }));
                    }}
                  />
                  <span>Acepto los términos del servicio y autorizo el tratamiento de mis datos para crear y operar mi cuenta.</span>
                </label>
                {errors.accept && <p role="alert" className="mt-1 text-xs font-semibold text-bad">{errors.accept}</p>}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <Button type="button" variant="outline" onClick={() => setStep(2)}><ArrowLeft size={14} /> Atrás</Button>
                <Button type="submit" disabled={busy} className="!px-6 !py-3 !text-sm">
                  {busy ? 'Creando tu empresa…' : <>Crear mi empresa <ArrowRight size={15} /></>}
                </Button>
              </div>
              <p className="text-xs text-ink-3">
                Guardamos tu avance mientras llenas esto, para poder ayudarte si te quedas a mitad. No te pedimos tarjeta.
              </p>
            </form>
            <aside className="space-y-3 text-sm">
              <p className="kicker">Qué pasa después</p>
              <ol className="space-y-3">
                <li className="border-l-2 border-ink pl-3"><b>Entras a tu panel</b> con todo lo que armamos.</li>
                <li className="border-l-2 border-ink pl-3"><b>Te escribimos por WhatsApp</b> para conectar tu número y mostrarte cómo funciona.</li>
                <li className="border-l-2 border-ink pl-3"><b>Eliges tu plan</b> cuando todo esté funcionando.</li>
              </ol>
              <p className="text-xs text-ink-3">Desde {fmtMoney(preview.rubro === 'SERVICIOS' ? 129000 : preview.rubro === 'COMIDAS' ? 149000 : preview.rubro === 'WEBCAM' ? 390000 : 199000)} al mes, IVA incluido.</p>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}
